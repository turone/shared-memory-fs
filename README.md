# shared-memory-fs

Pooled SharedArrayBuffer virtual filesystem for Node.js `worker_threads`,
plus `node:fs` and `module.registerHooks` adapters.

Files are loaded once on the main thread into pooled SAB segments. Workers
get zero-copy `Buffer` views over the same memory — no per-worker copies,
no serialization, no IPC for reads. Optional V8 bytecode
(`require.compile`) is compiled once and stored in SAB so workers skip
parse + compile. There is no ESM bytecode cache.

Requires Node.js 22.22.3+ or 24.12.0+ or 26+ (`module.registerHooks`;
CJS `--import` bootstrap of memory-only modules). Node 24 below 24.12.0
is unsupported.

## Contents

[Features](#features) · [Install](#install) · [Quick start](#quick-start) ·
[Providers](#providers) · [Preparation](#preparation-prepare) ·
[Compression](#compression) · [Strict routing](#strict-routing) ·
[Lifetime of shared bytes](#lifetime-of-shared-bytes) · [API](#api) ·
[Patched `node:fs`](#patched-nodefs) · [Errors](#errors) ·
[Protocol](#protocol) · [Examples](#examples) ·
[Architecture](#architecture) · [Support](#support) ·
[Design decisions](doc/architecture.md) · [Alternatives](doc/alternatives.md)

## Features

- **Zero-copy sharing** — internal projections are
  `Buffer.from(sab, offset, length)` views.
- **Pooled segments** — files packed into 64 MiB SAB segments; emptied
  segments are reused, never returned to the OS.
- **Two content origins** — `origin: 'disk'` (scanner + watcher fill the
  place) or `origin: 'virtual'` (the application writes the content —
  from the main thread or, for `sab`, from a worker over the link port).
- **`prepare`** — a synchronous callback, declared by the `fs`,
  `require` or `import` domain per extension, turns a raw input into the
  file's one canonical content (bundling, wrapping, templating…), shared by
  every domain. Runs once per publication, never on read.
- **`fs.script`** — V8 bytecode companion of the canonical source for
  callers that build their own `vm.Script` (`PlaceFs.script()`),
  independent of `require.compile`.
- **V8 bytecode** — `require: { compile: true }` (CJS, default when the
  require domain is on) and/or `fs.script.compile` (bare source, default
  true when `fs.script` is on). ESM has no bytecode cache.
- **Pre-compressed representations** — `gzip`, `deflate`, `br`, `zstd`
  built once and shared from SAB. HTTP negotiation stays in your server.
- **Live reload** — watcher batches disk events into epochs processed
  strictly in order, one `vfs-update` per epoch; a replaced version is
  freed after every worker ACKs and no stream or view still reads it.
- **Five providers** — `sab`, `map`, `sea`, `disk`, `node-default`.
- **Strict routing** — `strict: true` makes `appRoot` the routing
  boundary (a policy, not OS-level isolation).
- **Hooks** — `hooks.fs` patches `node:fs`; `hooks.module` is one
  `module.registerHooks` chain for `require()` and `import`.
- **Chunked streaming** — `PlaceFs.createReadStream()` with HTTP Range;
  a stream always finishes the version it started with.

## Install

```
npm install shared-memory-fs
```

Package exports: `.`, `./register`, `./adapters/fs-patch`,
`./adapters/module-hook`.

## Quick start

Bootstrap (main thread only):

```
node --import shared-memory-fs/register app.js -- --vfs.config=./vfs.config.cjs
```

Config file: `--vfs.config=…` or `vfs.config.{js,cjs,mjs,json}` in cwd.
Order: load config → `initialize()` → install hooks → publish
`VfsKernel.current`. Failure uninstalls, closes the kernel and rethrows —
the entry never runs.

Workers do **not** run `--import` / `--require` preloads. Pass
`kernel.link()` as `workerData.vfs` and call `attach()`:

```js
const { attach } = require('shared-memory-fs');
const kernel = attach(); // reads workerData.vfs
```

### Manual wiring

Place **name is the directory under `appRoot`**, the mount, the cache
namespace and the snapshot/delta key. There is no separate `dir` field.

```js
const { VfsConfig, VfsKernel } = require('shared-memory-fs');
const { Worker } = require('node:worker_threads');

const config = new VfsConfig({
  defaults: {
    memory: { limit: '1 gib', segmentSize: '64 mib', maxFileSize: '10 mb' },
  },
  places: {
    static: {
      // origin defaults to 'disk': scanner + watcher fill it.
      fs: { ext: ['html', 'css', 'js', 'png', 'svg'] },
    },
    lib: {
      fs: { ext: ['js'] },
      require: { ext: ['js'], compile: true },
    },
    scratch: {
      provider: 'map',
      origin: 'virtual', // content comes only from application writes
      fs: { writable: true },
    },
  },
});

const kernel = new VfsKernel(config, { appRoot: process.cwd() });
await kernel.initialize();

const { vfs, transferList } = kernel.link();
const w = new Worker('./worker.js', {
  workerData: { vfs },
  transferList,
});
```

Worker:

```js
const { attach } = require('shared-memory-fs');
const kernel = attach();

const site = kernel.fs('static');
const html = site.readFile('/index.html'); // owned copy
const stream = site.createReadStream('/big.mp4');

const scratch = kernel.fs('scratch');
scratch.writeFile('/note.txt', 'hello');
```

`kernel.fs(name)` returns a `PlaceFs` for an indexed place with an fs
domain (`sab` / `map` / `sea`). Disk and node-default places are
plain `node:fs` territory.

`readFile*` returns owned copies. Direct access to shared bytes goes
through leases and streams that pin the version they read — see
[Lifetime of shared bytes](#lifetime-of-shared-bytes).

Mutations of a `sab + virtual` place cross the allocator (and, when
configured, the compression threadpool), so they return a **Promise**
that settles once the new version is published — `await` it. Every other
place (disk-origin, and `map`, including `map + virtual`) mutates
synchronously and returns `undefined`; `await` is still correct for both.

Bytecode is not on `PlaceFs` — it is [adapter API](#adapter-api), except
for `fs.script` bundles, which are `PlaceFs.script(key)` (below).

## Providers

| Provider       | Storage             | VFS index | Origin              | Shared across workers |
| -------------- | ------------------- | --------- | ------------------- | --------------------- |
| `sab`          | SAB pool            | yes       | `disk` \| `virtual` | yes, zero-copy        |
| `map`          | per-thread `Map`    | yes       | `disk` \| `virtual` | no, per-thread        |
| `sea`          | SAB from SEA assets | yes       | fixed (SEA assets)  | yes, zero-copy        |
| `disk`         | OS filesystem       | no        | fixed (disk)        | n/a, managed mount    |
| `node-default` | OS filesystem       | no        | fixed (disk)        | n/a, ordinary Node    |

`INDEXED` = sab | map | sea (have a files Map). `SHARED` = sab | sea
(bytes in SAB). `disk` and `node-default` are passthrough mounts: they
are never scanned and hold no VFS entries. `disk` differs from
`node-default` only in being _managed_ — the router applies the fs
domain's writable policy and strict routing to it.

**`origin`** applies only to `sab` and `map`, defaults to `'disk'`, and is
always explicit in the resolved config:

| provider + origin | content                          | mutations                    | sharing             |
| ----------------- | -------------------------------- | ---------------------------- | ------------------- |
| `sab` + `disk`    | scanner + watcher                | to disk, watcher republishes | snapshot/delta      |
| `sab` + `virtual` | application writes               | main thread or worker RPC    | snapshot/delta      |
| `map` + `disk`    | scanner + watcher, owned Buffers | to disk, watcher republishes | none (thread-local) |
| `map` + `virtual` | application writes               | local `Map`, synchronous     | none (thread-local) |

`origin: 'virtual'` requires the fs domain with `writable: true` —
nothing else can ever give the place content. A virtual place is
legitimately empty right after `initialize()`; workers project it from
the snapshot and receive its first file like any other update.

Writable disk-origin SAB/map is **eventual consistency**: mutations go
to disk; the watcher brings them into the index. There is no
`waitForUpdate`. A `sab + virtual` mutation, in contrast, resolves its
Promise only once the new version is already published. The watcher
also starts when `defaults.watch` is on.

### Map provider

Per-thread writable namespace (`origin: 'disk'` or `'virtual'`). Each
thread owns its own instance after `fromSnapshot()` / `attach()` — it is
never in the snapshot and mutations of one thread are invisible to
others. Writes via `PlaceFs` are local to that thread and synchronous.
JS is compiled to V8 bytecode when `require.compile` and/or
`fs.script.compile` are on.

```js
places: {
  agent: {
    provider: 'map',
    origin: 'virtual',
    fs: { writable: true },
    require: true, // compile defaults to true
  },
}

const agent = kernel.fs('agent');
agent.writeFile('/tool.js', 'module.exports = () => 42;');
const tool = require('/abs/path/agent/tool.js');
```

### `fs.script`

`fs.script` marks the sources the library compiles for callers that build
their own `vm.Script` (`PlaceFs.script(key)`) — orthogonal to
`require.compile`, which serves Node's CJS loader. Both may cover the same
file with independent companions, both built from the one canonical
(prepared) source.

- `fs.script.compile` (default `true`) builds `\0script:bytecode` —
  cached data of the **bare** canonical source under the preparer's
  `scriptOptions`. `require.compile` builds `\0require:bytecode` —
  cached data of `Module.wrap(source)`. Neither substitutes for the
  other. A script-compile failure invalidates the whole publication
  (previous version kept); a require-compile failure is best-effort (only
  its own companion is dropped).
- `kernel.fs(name).script(key)` →
  `{ source, cachedData, scriptOptions, meta } | null`; `ENOTSUP` when the
  place has no `fs.script`. It never prepares or compiles anything itself.

### SEA provider

Loads `node:sea` assets matching `<name>/…` into SAB at `initialize()`,
then behaves like a `sab` place — in `snapshot()`, projected to workers,
no watcher.

```js
places: {
  pub: { provider: 'sea', fs: true },
}
```

A SEA built with `assets: { 'pub/index.html': './dist/index.html', … }`
exposes those assets with zero per-worker copy.

For tests, inject a compatible module:

```js
new VfsKernel(config, {
  seaModule: {
    isSea: () => true,
    getAssetKeys: () => [...],
    getAsset: (k) => arrayBuffer,
  },
});
```

## Preparation (`prepare`)

A preparer turns the raw input of a file into its **canonical content**:
the one version every domain serves. It is declared by one domain — `fs`,
`require` or `import` — next to its `ext`, but it prepares the file
itself, once, for all of them.

```js
const config = new VfsConfig({
  places: {
    application: {
      fs: {
        ext: ['js', 'css'],
        prepare: { api: ['js'], styles: ['css'] },
        script: { ext: ['js'], compile: true },
      },
      require: { ext: ['js'], compile: true },
    },
  },
});
const kernel = new VfsKernel(config, {
  appRoot,
  preparers: {
    // Synchronous; the functions never enter the (cloneable) config.
    api: (raw, file) => ({
      source: `(${raw.toString().trim()})`,
      scriptOptions: { filename: file.path },
      meta: { key: file.key },
    }),
    styles: (raw) => minifyCss(raw.toString()),
  },
});
```

Here `.js` goes through `api` once; that one prepared source is what
`fs` reads, `fs.script.compile` and `require.compile` compile and
`require()` loads. `.css` goes through `styles`.

- **Forms.** `prepare: 'name'` covers every extension of the domain's own
  finite `ext` (for `require` / `import` including the defaults — so
  `require: { prepare }` also covers `json`). An unrestricted `fs` (no
  `ext`) takes only the object form; `fs.script.ext` is never the scope of
  a short `fs.prepare`. `prepare: { name: [ext, …] }` routes extensions
  explicitly; with a finite domain `ext` each one must be in it. Neither
  form adds extensions to a domain or removes any.
- **One declaration per extension per place.** Declaring the same
  extension in two domains — even with the same preparer — is a config
  error naming the place, the extension and every declaration. No domain
  priority, no merging.
- **Providers.** `prepare` applies to `sab`, `map` and `sea` places;
  `disk` and `node-default` places pass files through untouched, so
  declaring it there is a config error, and so is combining it with
  `compress.retainRaw: false` (reads would come from the raw disk file,
  not the prepared content).
  `fs.script.prepare` of earlier versions is gone: declare `prepare` in a
  domain.
- **Contract.** `prepare(raw: Buffer, file)` → `null` / `undefined`
  (publish raw) | `string` | `Uint8Array` |
  `{ source, scriptOptions?, meta? }`. `file` is frozen
  `{ place, key, path, ext, stat }`. Synchronous only: a Promise or
  thenable is a `TypeError`. Returned bytes are copied; `meta` and
  `scriptOptions` are cloned and deep-frozen. `scriptOptions` never turn
  `fs.script` on by themselves. The library ships no Babel, CSS, HTML,
  SVG or image preparers — only the mechanism.
- **Same file.** Key, path, extension and type do not change; only the
  content (and `meta` / `scriptOptions`) does. No extra files or
  representations are created.
- **Once per publication, never on read.** Initial scan, watcher
  updates, SEA assets, virtual writes (main thread or worker RPC) and
  `map` writes all run the same pipeline. The raw disk file stays the
  source of truth; the raw input is not kept next to the prepared content.
- **All or nothing.** A preparer that throws, or a required
  `fs.script.compile` that fails, publishes nothing: the previous version
  and its companions stay.
- **Mutations and copies.** In a virtual place `appendFile`, `rename` and
  copies of a prepared key are `ENOTSUP`: its raw input is not kept, and
  its bundle may embed the old key. Renaming or copying an unprepared entry
  onto an extension with a preparer publishes it through that preparer,
  once. In a disk-origin place mutations edit the raw file and the watcher
  re-prepares it; a copy or a rename hands on that raw file, never the
  prepared content (see [Copies and renames](#copies-and-renames)).
  `readFile` gives the prepared content: writing it elsewhere with
  `writeFile` is a new publication the destination may prepare again, not
  a raw-preserving copy.
- **Threads.** The main kernel prepares everything shared (`sab`, `sea`).
  A worker's own `map` places prepare locally with
  `attach({ preparers })`; without the preparer such a write fails with
  `ENOTSUP`, while reading published content never needs one.

## Compression

Representations are built once during `initialize()` and stored in SAB
next to the source. HTTP negotiation stays in your server.

```js
places: {
  static: {
    fs: {
      ext: ['html', 'css', 'js', 'svg', 'png', 'mp4'],
      compress: {
        encodings: ['br', 'gzip'],
        options: { br: { level: 5 } },
        ext: 'compressible',
        retainRaw: true,
      },
    },
  },
}
```

`fs.ext` decides what the place contains; `compress.ext` narrows that
set. `'compressible'` expands to a built-in list of text-ish formats;
already-compressed media is excluded.

```js
const place = kernel.fs('static');
place.storedEncodings('/app.css'); // ['raw', 'br', 'gzip']
const body = place.readFileCompressed('/app.css', 'br');
const { size, sourceSize } = place.statCompressed('/app.css', 'br');
```

A codec listed in `encodings` but missing from `options` runs with native
zlib defaults (brotli quality 11, gzip/deflate 6, zstd 3).

**`retainRaw: false`** keeps only compressed bytes in SAB; the source
stays a disk entry. Requires provider `sab` with `origin: 'disk'` (a
virtual place has no raw file to serve), and no `require.compile`,
`fs.script` or `prepare`. `place.readFile()` and the patched `fs` then
read the source from disk; `readFileView()` has no view of it.

A compressed representation is never content of its own: a copy or a
rename hands on the raw input — from disk with `retainRaw: false` — and
the destination builds its own representations.

Failures are per representation: a codec that does not fit is skipped
with a warning; `storedEncodings()` reports what actually exists.

## Strict routing

```js
new VfsConfig({ defaults: { strict: true }, places: { ... } });
```

**`strict: true` makes `appRoot` the routing boundary.** Every path under
`appRoot` that no place owns is `EACCES` — at every depth, file or
directory, without the router touching the disk.

Strict is a **routing and access policy inside `appRoot`** for code that
goes through the patched `node:fs` and the module hooks: unmanaged
territory is refused, and the disk territory that stays reachable is
exactly what the configured places and their `fs.fallback` allow. It is
not an OS sandbox: worker threads share one process, and neither they nor
the patched `node:fs` replace the operating system's isolation.

- Containment is lexical: only a real `..` component leaves `appRoot`.
  `..private`, `...data` or `file..js` are ordinary names — an unowned
  `appRoot/..private/x` is denied like any other unowned path, and
  `appRoot/api/..private/x` belongs to place `api`.
- `appRoot` itself is a **managed root**: `readdir(appRoot)` and
  `opendir(appRoot)` list the enabled places and nothing else, and
  `stat(appRoot)` is a directory. `watch` of it — as of any managed
  territory — is `ENOTSUP` (recognized but unsupported); writes to it and
  the other guarded calls on it (`rmdir`, `statfs`, `watchFile`, …) are
  `EACCES`.
- A trusted entry point and `package.json` must live **outside
  `appRoot`**, or inside an explicit `node-default` / `disk` place.
  Under strict, `appRoot` should contain place directories and nothing
  else. See `test/fixtures/sandbox` + `strict-app.cjs`.
- Indexed mounts: only published, fs-visible entries are readable;
  unpublished or excluded-ext paths → `EACCES` (disk-backed entries
  excepted) — unless a disk-origin place sets `fs.fallback: 'disk'`
  (below).
- Paths outside `appRoot` → ordinary Node, except operations whose walk
  would enter `appRoot` from above: recursive listings, watches, copies and
  removals, and `rename`, of a directory above it. Scanner does not follow
  symlinks.
- Listings (`readdir`, `opendir`) always come from the places. A copy or a
  rename routes both of its paths and hands on the raw input, so a hidden
  source stays `EACCES`; recursive copies, hard links and watches of
  managed territory are refused (see [Patched `node:fs`](#patched-nodefs)).
  Guarded APIs still enforce the routing decision, so a denied path cannot
  be probed via `glob`, `readlink`, `statfs`, …
- Same-process places are not firewalled from each other, and a linked
  worker receives the whole config and snapshot.

### Partial disk cache: `fs.fallback`

A disk-origin place (`sab` / `map`, `origin: 'disk'`) decides what happens
to a path it does not serve. The resolved value is always explicit:
`'deny'` under strict, `'disk'` otherwise.

```js
places: {
  public: { fs: { ext: ['html', 'css', 'js'], fallback: 'disk' } },
}
```

- `'deny'` — only published canonical VFS entries are served.
- `'disk'` — the files its cache filters do not select (here: images,
  video, …) are served from disk, inside this place only. Cached
  extensions stay VFS-only under strict, so a raw or unpublished file
  never stands in for canonical (prepared) content. `readdir` merges
  published entries with disk directories and files of the other
  extensions (no companions, no duplicates) — also in a directory that
  exists only on disk, and in either mode: a file of a cached extension is
  listed only once published. The `PlaceFs` facade serves the same disk
  territory.
- The fallback never reaches another place or an unmanaged sibling;
  `fs.writable` stays independent; `require` / `import` never fall back.
- Virtual, `sea`, `disk` and `node-default` places have no directory to
  fall back to: `fs.fallback` is `null` there and setting it is a config
  error.

## Lifetime of shared bytes

Shared places (`sab`, `sea`) replace files in place: an update publishes
the new version for new readers and **retires** the old one. Its bytes go
back to the pool only after every linked worker has ACKed the update and
no stream or view in any thread still reads them — never on a timeout.

| API                                           | What you get                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `readFile()`                                  | Owned `Buffer`: keep it, mutate it                                                               |
| `readFileView()` / `readFileCompressedView()` | Lease `{ view, release, [Symbol.dispose] }` — needs `fs.zeroCopy`                                |
| `withFileView(key, fn)`                       | `fn(view)` under a lease released when `fn` settles; `null` when missing                         |
| `createReadStream()`, `zeroCopy: false`       | `Readable` of owned chunks; the version is released when the stream ends, errors or is destroyed |
| `createReadStream()`, `zeroCopy: true`        | `Readable` of borrowed SAB chunks; the version is released only by `stream.release()`            |

- A **lease view** is a direct, mutable SAB `Buffer`: stable until
  `release()`, never to be mutated, never to be used afterwards (nor any
  `subarray` of it). `Buffer.from(view)` to keep the bytes. `release()`
  is synchronous, idempotent and safe after any update.
- A **stream** always finishes the version it started with, while new
  readers see the new one. Owned chunks stay valid forever. Borrowed
  chunks (`zeroCopy: true`) can still sit in a socket's write queue after
  the stream ends, so the stream itself holds the version until
  `release()` (idempotent, also `[Symbol.dispose]`; on a still-active
  stream it stops it first). Borrowed chunks are views of shared memory,
  like a lease view: never mutate them, never use them after `release()`;
  `Buffer.from(chunk)` keeps the bytes. Without an option a stream follows
  the place's `fs.zeroCopy`; per call, `{ zeroCopy: false }` asks for owned
  chunks even in a `zeroCopy` place, and `{ zeroCopy: true }` in a place
  without it is `ENOTSUP`.
- Use `pipeline()`. It destroys the source when the destination fails;
  a manual `pipe()` does not — destroy the source yourself when the
  destination closes or aborts.
- A compressed consumer pins only its representation; source and
  companions are held independently.
- `kernel.close()` stops active streams (`ERR_VFS_CLOSED`); a lease still
  held afterwards is a caller error. `map` places hold owned Buffers the
  GC keeps alive: their leases and releases are no-ops.

```js
const stream = files.createReadStream('/video.mp4', { start, end });
try {
  await pipeline(stream, res);
} finally {
  stream.release(); // required for zeroCopy chunks, harmless otherwise
}

const lease = files.readFileView('/index.html');
finished(res, () => lease.release()); // the socket may still be writing
res.end(lease.view);
```

## API

### `VfsConfig`

`new VfsConfig(raw)` — hardcoded defaults → `raw.defaults` → per-place.
Deep-frozen after construction. `config.raw` is the merged input,
cloneable so workers rebuild from it.

| `defaults.*`           | Type   | Default    | Description                         |
| ---------------------- | ------ | ---------- | ----------------------------------- |
| `memory.limit`         | size   | `'1 gib'`  | Total SAB pool budget               |
| `memory.segmentSize`   | size   | `'64 mib'` | SAB segment size                    |
| `memory.maxFileSize`   | size   | `'10 mb'`  | Larger disk files stay on disk      |
| `compaction.threshold` | number | `0.3`      | 0 = off; else compact below this    |
| `hooks.fs`             | bool   | `true`     | Patch `node:fs`                     |
| `hooks.module`         | bool   | `true`     | `module.registerHooks` + `_compile` |
| `watch`                | bool   | `false`    | Watch disk-origin places            |
| `watchTimeout`         | number | `1000`     | Watcher debounce (ms)               |
| `strict`               | bool   | `false`    | Routing policy inside `appRoot`     |

Sizes accept `metautil.sizeToBytes` strings or numbers. Booleans must be
booleans.

`memory.maxFileSize` keeps large disk files out of the pool: they stay
disk entries, read from disk. Content without a disk file of its own —
prepared, virtual or SEA — cannot fall back to disk: if it does not fit,
its publication is refused, and at startup `initialize()` fails.

`watch` starts the kernel's own watcher: it republishes disk changes of
the disk-origin cached places — `sab` + `disk` and `map` + `disk` alike;
virtual places have no disk to watch. It is unrelated to the patched
`fs.watch`, which refuses managed territory with `ENOTSUP` (see
[Patched `node:fs`](#patched-nodefs)). `strict` is described in
[Strict routing](#strict-routing); it is not an OS sandbox.

| `places.<name>.*` | Type   | Default       | Description                                                                  |
| ----------------- | ------ | ------------- | ---------------------------------------------------------------------------- |
| `provider`        | string | `'sab'`       | `sab`, `map`, `sea`, `disk`, `node-default`                                  |
| `origin`          | string | `'disk'`      | `disk` \| `virtual`; sab/map only                                            |
| `enabled`         | bool   | `true`        | Drop a place without removing it                                             |
| `maxFileSize`     | size   | from defaults | SAB/sea only                                                                 |
| `fs`              | domain | off           | `true` or `{ ext, writable, zeroCopy, compress, script, prepare, fallback }` |
| `require`         | domain | off           | `true` or `{ ext, compile, prepare }` (compile default true)                 |
| `import`          | domain | off           | `true` or `{ ext, prepare }`                                                 |

Place name: ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, no trailing dot, no
Windows reserved names, unique after lowercasing.

Domain defaults: require ext `js,cjs,json`; import ext `js,mjs,json`;
fs ext `null` = everything (resolved `fs.ext` is the union of `fs.ext`
and `fs.script.ext`). At least one domain must be on.

`<domain>.prepare` is `'name'` or `{ name: [ext, …] }` — see
[Preparation](#preparation-prepare). The resolved place carries one index,
`place.prepare = { [ext]: name } | null`.

| `places.<name>.fs.script.*` | Type     | Default        | Description                             |
| --------------------------- | -------- | -------------- | --------------------------------------- |
| `ext`                       | string[] | `['js','cjs']` | Never `mjs`                             |
| `compile`                   | bool     | `true`         | Build the `\0script:bytecode` companion |

| `places.<name>.fs.compress.*` | Type               | Default | Description                     |
| ----------------------------- | ------------------ | ------- | ------------------------------- |
| `encodings`                   | string[]           | —       | `gzip`, `deflate`, `br`, `zstd` |
| `options.<codec>.level`       | number             | native  | Codec level                     |
| `ext`                         | string[] \| string | all     | Or `'compressible'`             |
| `retainRaw`                   | bool               | `true`  | Keep uncompressed source in SAB |

`VfsConfig.fromArgv(argv, appConfig)` parses `--vfs.*` after `--`:
`--vfs.defaults.*`, `--vfs.places.<n>.*`, `--vfs.enable` /
`--vfs.disable`. Coerces `"true"` / `"false"` / numbers only.
`setNested` rejects `__proto__` | `prototype` | `constructor`.

```
node app.js -- --vfs.defaults.memory.limit=512mib \
               --vfs.defaults.strict=true \
               --vfs.enable=static,lib \
               --vfs.disable=scratch
```

### `VfsKernel` (main thread)

`new VfsKernel(config, options)`

| Option      | Default              | Description                                                                                                                 |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `appRoot`   | `process.cwd()`      | Root for place directories                                                                                                  |
| `console`   | `globalThis.console` | Logger                                                                                                                      |
| `seaModule` | `node:sea` if any    | Inject for tests                                                                                                            |
| `preparers` | `{}`                 | `{ name: (raw, file) => ... }` named by the domains' `prepare` — synchronous; every name an enabled place uses must be here |

States: `new → initializing → ready → closed` (final). `fs()`,
`snapshot()`, `watch()`, `link()` require `ready`. `initialize()`
failure closes the kernel.

| Method               | Description                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `await initialize()` | Scan / SEA / map through the publication pipeline: preparers, bytecode, compression                                                  |
| `fs(name)`           | `PlaceFs` for an indexed fs place                                                                                                    |
| `snapshot()`         | `{ segments, places }` — published entries only                                                                                      |
| `link()`             | `{ vfs, transferList }` for a worker — the only worker transport                                                                     |
| `watch()`            | Start `DirWatcher` (also auto if writable disk-origin)                                                                               |
| `retirements()`      | Internal diagnostics (debugging, tests; not a stable API): retired versions still held — representation, bytes, age, ACKs or holders |
| `close()`            | Stop watcher and streams, reject queued mutations, drop projections, collectable SAB                                                 |

`link()` returns `{ vfs: { snapshot, config: raw, appRoot, port },
transferList }`. The kernel posts every `vfs-update` to the port, reads
`vfs-ack`, `vfs-release` and mutation requests, and treats port `close`
as worker exit.

#### Adapter API

`routeRead(absPath)`, `routeMutation(absPath)`,
`resolveModule(absPath, domain)` and `bytecode(absPath)` exist for
`lib/adapters/*`, not for application code: they hand back raw routing
decisions and borrowed views without the ownership and ext policies
`PlaceFs` applies. `bytecode()` in particular returns a borrowed SAB
view that the compile hook passes straight to `vm.Script`. Application
code should use `kernel.fs(name)`.

### `VfsKernel` (worker)

`attach({ link = workerData.vfs, preparers } = {})` projects the
snapshot, installs hooks the config asks for, applies `vfs-update` from
the link port and ACKs **those — and only those** — back, with the
retired versions its streams and leases still read. Publishes
`VfsKernel.current` (also the `kernel` getter on the package).
`preparers` serve local writes to the worker's own `map` places; a
worker never prepares shared places. The options object replaces the
positional `attach(link)` of earlier versions.

### `PlaceFs`

Returned by `kernel.fs(name)`. Reads return `null` when missing;
`readdir` throws `ENOENT` / `ENOTDIR`. Keys: exact, then `'/' + key`.
Mutations take a canonical key (leading slash; NUL, `..`, backslash
rejected).

| Method                                       | Returns                                               | Description                                                                           |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `readFile(key, opts)`                        | Buffer \| string \| null                              | Owned copy                                                                            |
| `readFileView(key)`                          | lease \| null                                         | `{ view, release, [Symbol.dispose] }`; needs `zeroCopy`; null when missing or on disk |
| `withFileView(key, fn)`                      | Promise                                               | `fn(view)` under a lease; `null` without calling `fn` when missing                    |
| `stat(key, opts)`                            | `VfsStats` \| null                                    | Lazy; `{ bigint }` ok                                                                 |
| `exists(key)`                                | bool                                                  | File or implicit directory                                                            |
| `readdir(key, opts)`                         | string[] \| Buffer[] \| Dirent[]                      | Implicit dirs; lex order; `{ withFileTypes, recursive, encoding }` or an encoding     |
| `createReadStream(key, opts)`                | `VfsReadStream` \| null                               | `{ start, end }` inclusive, `zeroCopy`; `release()`                                   |
| `storedEncodings(key)`                       | string[]                                              | `'raw'` plus configured codecs                                                        |
| `readFileCompressed(key, enc)`               | Buffer \| null                                        | Owned copy                                                                            |
| `readFileCompressedView(key, enc)`           | lease \| null                                         | Pins that representation only; needs `zeroCopy`                                       |
| `statCompressed(key, enc)`                   | object \| null                                        | `{ size, sourceSize, encoding, … }`                                                   |
| `createReadStreamCompressed(key, enc, opts)` | `VfsReadStream` \| null                               | Range is compressed bytes                                                             |
| `pathOf(key)`                                | string                                                | Absolute OS path                                                                      |
| `script(key)`                                | `{ source, cachedData, scriptOptions, meta }` \| null | `ENOTSUP` when no `fs.script`                                                         |
| `meta(key)`                                  | object \| null                                        | Frozen preparer metadata                                                              |
| `writeFile` / `appendFile` / `unlink`        | void \| Promise                                       | Sync for map/disk; Promise for `sab + virtual`                                        |
| `mkdir` / `rm` / `rename`                    | void \| Promise                                       | `mkdir` is a no-op; prepared keys reject `appendFile` / moving away with `ENOTSUP`    |

Through patched `fs`, a `rename` across a virtual place's boundary is
`EXDEV` (see [Copies and renames](#copies-and-renames)).

## Patched `node:fs`

With `hooks.fs` on, `node:fs` routes through the kernel. Every path-taking
API falls into one of three groups below. Full `node:fs` compatibility is
not promised.

**The rule.** A native `node:fs` operation runs only once every path it
touches has been routed:

- a single-path operation runs after the routing of its source and
  destination allows it;
- a copy or a rename hands on the source's raw input — the raw disk file
  of a disk-origin place, prepared or not, or the canonical bytes of an
  unprepared virtual entry — never a prepared result or a companion, and
  the destination publishes it through its own pipeline;
- a recursive or compound operation whose routing could check only its top
  path is refused;
- a virtual destination is never changed by a native disk operation;
- a recursive operation from outside `appRoot` is refused when its walk
  would enter `appRoot`;
- unrelated paths outside `appRoot` stay native.

Where the kernel cannot guarantee that, the operation fails with `ENOTSUP`
before anything is read or written; it is not approximated. Under strict
routing every compound native operation stays within these limits; strict
is a routing and access boundary, not an OS sandbox.

**1. Implemented** — served by the places; sync, callback and promises
forms: `readFile`, `stat`, `lstat`, `access`, `realpath`, `readdir`,
`opendir`, `existsSync`, `createReadStream`, `writeFile`, `appendFile`,
`unlink`, `mkdir`, `rm`, `rename`, `copyFile` and a non-recursive `cp`
(see [Copies and renames](#copies-and-renames)).

`opendir` returns a `Dir` over exactly what `readdir` lists there (the
strict `appRoot`, a place directory, the disk territory of
`fs.fallback: 'disk'`), taken when it is opened; it is not an `fs.Dir`
instance. It supports `read()` / `read(callback)` / `readSync()`, `close()`
/ `close(callback)` / `closeSync()`, async iteration (which closes the
handle), `recursive` and `encoding`. As in `node:fs`, reading or closing a
closed handle fails with `ERR_DIR_CLOSED`, while `[Symbol.dispose]()` /
`[Symbol.asyncDispose]()` of a closed handle do nothing.

Listings (`readdir`, `opendir`) give names in the requested `encoding`
(an options object or an encoding string): `'buffer'` gives Buffer names,
`Dirent.name` included; any other encoding re-encodes the UTF-8 name.
Entries are deduplicated and sorted by their string names first, so every
encoding lists them in the same order. Unlike native `node:fs` (22.22.3 to
26.x), which fails `recursive` together with `encoding: 'buffer'`, a
managed recursive listing gives Buffer names too; `parentPath` stays a
string.

A reference to a patched function taken while the patch is installed
(`const { readFile } = require('node:fs')`, or glob's own walk) keeps
working after `uninstall()`: with no kernel installed it is the original
`node:fs` function again.

**2. Recognized but unsupported for managed territory** — `ENOTSUP` with
`syscall`, `path` and, for copies, links and renames, `dest`; nothing is
read or written:

- `open` of a virtual entry: SAB and map entries have no file descriptor,
  so descriptor-based calls (`read`, `write`, `fstat`, …) never reach
  them.
- `cp` / `copyFile` / `rename` of a prepared virtual (or SEA) entry: there
  is no raw input to hand on. A copy of a place directory, too.
- A recursive `cp` whose source or destination is in a place, or that
  encloses `appRoot`: a native walk reads and writes raw files past the
  routing and misses virtual entries.
- A hard link into or out of a place: one physical file under two names,
  while a place gives each name its own canonical content, preparation and
  companions — and a second name would escape the place's mutation policy.
- `watch` of managed territory — a place directory, a published file, the
  strict `appRoot`, any recursive watch of a place: a native watcher
  reports raw disk events, hidden names included, not publications. A file
  of the disk territory keeps a native watcher: it is its own content.
  `fs.promises.watch` reports the refusal when iterated, as `node:fs`
  reports its errors.
- Recursive `readdir`, `opendir`, `watch`, `rm` and `rmdir`, and `rename`,
  of a tree that holds places — `appRoot` passed through without strict,
  or a directory above it: the walk would enter the places natively. One
  level (`readdir(parent)`) stays native.
- A directory renamed into or out of a place: every descendant would
  change policy at once.
- A guarded mutation (below) in a virtual place: only its store changes its
  entries.

**3. Native passthrough outside managed territory** — plain `node:fs`:

- unrelated paths outside `appRoot`, `disk` and `node-default` places,
  files of the disk territory (`fs.fallback: 'disk'`), and — without
  strict — unmanaged paths under `appRoot`;
- the guarded APIs, once the routing of every path argument allows them:
  `chmod` / `lchmod`, `chown` / `lchown`, `utimes` / `lutimes`,
  `truncate`, `symlink`, `readlink`, `statfs`, `watchFile`, `rmdir`
  (without `recursive`), `glob`. A denied path stays `EACCES` / `EROFS`,
  so it cannot be read, listed, copied or probed through them, and the
  strict `appRoot` itself is refused. `glob` takes patterns, not paths, so
  its results are filtered instead — relative results against its `cwd`
  option.

### Copies and renames

`copyFile` and a non-recursive `cp` route the source as a read and the
destination as a mutation, then hand the destination the source's **raw
input** — what a publication consumes:

| Source                                                   | Raw input                                       |
| -------------------------------------------------------- | ----------------------------------------------- |
| Disk-origin place: a published entry, prepared or not    | its raw disk file, never the prepared content   |
| Disk territory, `disk` / `node-default` place, elsewhere | the file on disk                                |
| Unprepared virtual (or SEA) entry                        | its canonical bytes — they are its raw input    |
| Prepared virtual (or SEA) entry                          | none, it is not kept: `ENOTSUP`                 |
| Hidden source (unpublished, unmanaged, `fallback: deny`) | `EACCES`, before anything is read               |
| Compression or bytecode companion                        | never: derived from the content, rebuilt anyway |

The destination publishes the bytes through its own pipeline — its
preparer runs once, the source's never runs again:

| Destination                | Result                                                         |
| -------------------------- | -------------------------------------------------------------- |
| Outside `appRoot`          | the raw bytes, as `node:fs` copies them                        |
| Writable disk-origin place | the raw bytes on disk; its watcher prepares and publishes them |
| Writable virtual place     | written through its store; no file appears on disk             |
| Read-only place, denied    | `EROFS` / `EACCES`, nothing written                            |

A `sab + virtual` place mutates asynchronously, so `copyFileSync` /
`cpSync` into it are `ENOTSUP`. Options keep their `node:fs` meaning for
one file (`COPYFILE_EXCL`, `COPYFILE_FICLONE`, `force`, `errorOnExist`,
`dereference`); one the VFS cannot honor (`COPYFILE_FICLONE_FORCE`,
`filter`, `preserveTimestamps`) is `ENOTSUP`, never ignored. A recursive
`cp` of or into managed territory is `ENOTSUP`.

A `rename` routes both paths as mutations and its source as a read:

- On disk it moves the raw file. A published disk-origin file may leave
  `appRoot` — it arrives as its raw source — or change its extension; the
  watchers drop the old canonical entry and publish the new key by the
  policy of its place and extension: its preparer, or the disk territory
  for an extension the place does not cache. Disk-origin places share the
  disk, so a file moves between them natively.
- A hidden source is `EACCES`: no new name makes it readable.
- A directory never enters or leaves a place (`ENOTSUP`); within its place,
  or outside any, it moves natively.
- In a virtual place the store moves an ordinary entry atomically and keeps
  its mtime; the preparer of a new extension runs once. A prepared entry
  has no raw input to move: `ENOTSUP`.
- Across a virtual place's boundary it is `EXDEV` — never a copy and a
  delete.

`readFile` returns the canonical (prepared) content: writing it elsewhere
with `writeFile` is a new publication the destination may prepare again,
not a raw-preserving copy.

## Errors

| Code      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EACCES`  | Strict routing denial: unowned path under `appRoot`, place with no fs domain, or an unpublished / excluded-ext entry in an indexed mount; any unpublished entry of a place with `fs.fallback: 'deny'`, strict or not; the hidden source of a copy, rename or link                                                                                                                                                                                                                                                                                                                                                                            |
| `EROFS`   | Place has `fs.writable: false` (or provider `sea`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ENOTSUP` | No file descriptor for a virtual entry (`open`); `*View` or a `{ zeroCopy: true }` stream without `fs.zeroCopy`; compressed API for an unconfigured encoding; `appendFile`, `rename` or a copy of a prepared virtual key; a write whose preparer is not registered in this thread; a `*Sync` mutation or copy into a `sab + virtual` place; a copy option the VFS cannot honor; a recursive `cp` of or into managed territory; a hard link into or out of a place; `watch` of managed territory; a recursive walk or `rename` of a tree that holds places; a directory renamed into or out of a place; a guarded mutation in a virtual place |
| `ENOENT`  | Missing key in a writable place; `readdir` of a missing directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ENOTDIR` | `readdir` of a file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXDEV`   | `rename` across a virtual place's boundary: between two places, or between one and the disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EISDIR`  | `readFile` / `createReadStream` of an implicit directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Errors carry the same `code`, `errno`, `syscall` and `path` fields as
`node:fs`, and `dest` for copies, links and renames. A stream stopped by
`kernel.close()` errors with `ERR_VFS_CLOSED`.

## Protocol

```
snapshot    { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } } }
vfs-update  { name, updateId, places: { <name>: { entries, removals, retired: [[key, retireId]] } },
              newSegments: [{ id, sab }] }                                    main → worker
vfs-ack     { name: 'vfs-ack', updateId, retained?: [retireId] }              worker → main
vfs-release { name: 'vfs-release', retireIds: [retireId] }                    worker → main
vfs-mutate  { name, id, place, op, key, to?, options?, data? }                worker → main
vfs-mutated { name, id, error?: { code, message, syscall, path, dest } }      main → worker
entry       shared { kind, segmentId, offset, length, stat, scriptOptions?, meta? }
            | disk { kind, path, stat, scriptOptions?, meta? }
stat        { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
```

One `vfs-update` per watcher epoch or accepted virtual mutation. Source
and companions of one file go in the same message. Every shared version
an update replaces or removes is `retired` under a `retireId` that exists
only until it is freed. A worker ACKs each update; `retained` lists the
retired versions its streams or leases still read, and one `vfs-release`
follows when the last of them is done. Bytes are freed once every linked
worker has ACKed (or exited) and no thread holds them.

## Examples

Runnable demos under [examples/](examples/):

- [hot-reload-routes/](examples/hot-reload-routes/) — HTTP server whose
  route handlers are written into a `map + virtual` place and `require()`d.
- [sea-static/](examples/sea-static/) — same static server as `sab` or
  Node SEA (`provider: 'sea'`).
- [multi-tenant/](examples/multi-tenant/) — two `map + virtual` places +
  `strict: true`.
- [worker-static/](examples/worker-static/) — static HTTP served by
  several worker threads from one SAB copy: Range streams, pre-compressed
  representations, live reload.
- [prepared-scripts/](examples/prepared-scripts/) — `prepare` +
  `fs.script`: handlers prepared once, run in a worker with V8 cached
  data, updated from the worker through `sab + virtual`.

Further reading: [doc/integration.md](doc/integration.md) (integration
notes and recipes), [doc/architecture.md](doc/architecture.md) (design
decisions and their reasons), [doc/alternatives.md](doc/alternatives.md)
(`node:vfs` and other alternatives).

## Streaming and HTTP Range

```js
const stream = place.createReadStream('/video.mp4', { start, end });
res.writeHead(206, {
  'Content-Range': `bytes ${start}-${end}/${stat.size}`,
  'Content-Length': end - start + 1,
  'Accept-Ranges': 'bytes',
});
try {
  await pipeline(stream, res);
} finally {
  stream.release();
}
```

With `zeroCopy`, each chunk is a borrowed view held until `release()`.
Without it, chunks are copies and the stream releases itself.
`createReadStreamCompressed` ranges address compressed bytes. See
[Lifetime of shared bytes](#lifetime-of-shared-bytes).

## Architecture

```
Main thread                             Worker threads
┌──────────────────────────┐            ┌─────────────────────────┐
│ VfsKernel                │  link()    │ attach()                │
│ ├─ VfsConfig (frozen)    │ ─────────► │ ├─ projected Maps       │
│ ├─ FilesystemCache       │  vfs + SAB │ ├─ per-thread map       │
│ │  └─ Pool+Registry      │            │ └─ Pins (streams/views) │
│ ├─ PlaceRegistry/FsRouter│  vfs-update│                         │
│ ├─ scanner + DirWatcher  │ ─────────► │                         │
│ └─ retirement: ACK +     │ ◄───────── │ vfs-ack (+ retained)    │
│    release before free   │ ◄───────── │ vfs-release             │
└──────────────────────────┘            └─────────────────────────┘
         SAB segments  ←  shared physical memory  →  zero-copy views
```

Companions are internal keys `<source>\0require:bytecode`,
`<source>\0script:bytecode` and `<source>\0fs:<enc>`. They never appear
in `readdir` / `exists` / patched `fs`.

## Tests

```
npm test        # node --test "test/*.test.js"
npm run lint    # eslint + prettier
```

Run the complete test suite with `npm test`. The suite covers
configuration, cache allocation, scanner, places, routing, module hooks,
compression, SEA, watcher, bootstrap, workers and strict routing
behavior. The symlink test may be skipped on platforms where test
symlinks are unavailable.

## Support

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull
requests to `main`: `npm ci`, `npm test`, `npm run test:examples` and
`npm run lint`, on each combination below:

|         | Node 22.22.3 | Node 22.x | Node 24.12.0 | Node 24.x | Node 26.x |
| ------- | ------------ | --------- | ------------ | --------- | --------- |
| Linux   | ✓            | ✓         | ✓            | ✓         | ✓         |
| Windows | ✓            | ✓         | ✓            | ✓         | ✓         |

Engines: `>=22.22.3 <23 || >=24.12.0 <25 || >=26`. Node 22 is supported
from 22.22.3; Node 24 from 24.12.0. Early Node 24 bypasses
`registerHooks` for nested `require()` from CJS executed by the ESM
translator. The limitation is the same on Linux and Windows. ESM and
disk-backed CommonJS could work on earlier 24.x, but those releases are
outside the library's supported matrix. macOS is expected to work (same
`fs.watch` capabilities as Linux and Windows) but is not in the matrix.

The watcher relies on `fs.watch(dir, { recursive: true })`. That is
unavailable on AIX and IBM i, where the live-reload features do not
work; everything else does.

On Windows the watcher resolves a place root through
`fs.realpathSync.native` when the path contains an 8.3 alias segment
(`C:\Users\RUNNER~1\...`). Node 24.16.0 through at least 24.20.0 abort
the process otherwise ([nodejs/node#63638][63638], fixed upstream in
libuv and being backported). Watch events keep the path form the place
was configured with, so this is invisible to place keys.

[63638]: https://github.com/nodejs/node/issues/63638

`npm ci` needs no git or SSH access: dependencies resolve over HTTPS
with lockfile integrity hashes.

## License

MIT
