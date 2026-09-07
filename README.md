# shared-memory-fs

Pooled SharedArrayBuffer virtual filesystem for Node.js `worker_threads`,
plus `node:fs` and `module.registerHooks` adapters.

Files are loaded once on the main thread into pooled SAB segments. Workers
get zero-copy `Buffer` views over the same memory — no per-worker copies,
no serialization, no IPC for reads. Optional V8 bytecode
(`require.compile`) is compiled once and stored in SAB so workers skip
parse + compile. There is no ESM bytecode cache.

Requires Node.js ≥ 22.22.3 (`module.registerHooks`; CJS `--import`
bootstrap of memory-only modules).

## Contents

[Features](#features) · [Install](#install) · [Quick start](#quick-start) ·
[Providers](#providers) · [Compression](#compression) ·
[Strict sandbox](#strict-sandbox) · [API](#api) ·
[Patched `node:fs`](#patched-nodefs) · [Errors](#errors) ·
[Protocol](#protocol) · [Examples](#examples) ·
[Architecture](#architecture) · [Support](#support)

## Features

- **Zero-copy sharing** — internal projections are
  `Buffer.from(sab, offset, length)` views.
- **Pooled segments** — files packed into 64 MiB SAB segments; emptied
  segments are reused, never returned to the OS.
- **V8 bytecode (CJS only)** — `require: { compile: true }` (default when
  the require domain is on). ESM has no bytecode cache.
- **Pre-compressed representations** — `gzip`, `deflate`, `br`, `zstd`
  built once and shared from SAB. HTTP negotiation stays in your server.
- **Live reload** — watcher batches disk events into epochs, one
  `vfs-update` per epoch, ACK-before-free.
- **Five providers** — `sab`, `memory`, `sea`, `disk`, `node-default`.
- **Strict sandbox** — `strict: true` makes `appRoot` the boundary.
- **Hooks** — `hooks.fs` patches `node:fs`; `hooks.module` is one
  `module.registerHooks` chain for `require()` and `import`.
- **Chunked streaming** — `PlaceFs.createReadStream()` with HTTP Range.

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
      fs: { ext: ['html', 'css', 'js', 'png', 'svg'] },
    },
    lib: {
      fs: { ext: ['js'] },
      require: { ext: ['js'], compile: true },
    },
    scratch: {
      provider: 'memory',
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
domain (`sab` / `memory` / `sea`). Disk and node-default places are
plain `node:fs` territory.

`readFile*` returns owned copies. `*View` methods and stream chunks are
borrowed views **only** when `fs.zeroCopy: true`; otherwise they throw
`ENOTSUP` or copy. Never mutate a borrowed view; never keep it past the
current operation; `Buffer.from(view)` to retain.

Bytecode is not on `PlaceFs` — it is [adapter API](#adapter-api).

## Providers

| Provider       | Storage             | VFS index | Writable                  | Shared across workers |
| -------------- | ------------------- | --------- | ------------------------- | --------------------- |
| `sab`          | SAB pool            | yes       | `fs.writable` writes disk | yes, zero-copy        |
| `memory`       | per-thread `Map`    | yes       | yes                       | no, per-thread        |
| `sea`          | SAB from SEA assets | yes       | no                        | yes, zero-copy        |
| `disk`         | OS filesystem       | no        | `fs.writable`             | n/a, managed mount    |
| `node-default` | OS filesystem       | no        | n/a                       | n/a, ordinary Node    |

`INDEXED` = sab | memory | sea (have a files Map). `SHARED` = sab | sea
(bytes in SAB). `disk` and `node-default` are passthrough mounts: they
are never scanned and hold no VFS entries. `disk` differs from
`node-default` only in being _managed_ — the router applies the fs
domain's writable policy and the strict sandbox to it.

Writable SAB is **eventual consistency**: mutations go to disk; the
watcher brings them into SAB. There is no `waitForUpdate`. The watcher
also starts when `defaults.watch` is on.

### Memory provider

Per-thread writable namespace. Each thread owns an empty instance after
`fromSnapshot()` / `attach()`. Writes via `PlaceFs` or patched
`fs.writeFileSync` are local to that thread. JS is compiled to V8
bytecode when `require.compile` is on (the default if `require` is
enabled).

```js
places: {
  agent: {
    provider: 'memory',
    fs: { writable: true },
    require: true, // compile defaults to true
  },
}

const agent = kernel.fs('agent');
agent.writeFile('/tool.js', 'module.exports = () => 42;');
const tool = require('/abs/path/agent/tool.js');
```

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
stays a disk entry. Requires provider `sab` and no `require.compile`.
`place.readFile()` then returns `null` for it; patched `fs` reads disk.

Failures are per representation: a codec that does not fit is skipped
with a warning; `storedEncodings()` reports what actually exists.

## Strict sandbox

```js
new VfsConfig({ defaults: { strict: true }, places: { ... } });
```

**`strict: true` makes `appRoot` the sandbox boundary.** Every path under
`appRoot` that no place owns is `EACCES` — at every depth, file or
directory, without the router touching the disk.

- A trusted entry point and `package.json` must live **outside
  `appRoot`**, or inside an explicit `node-default` / `disk` place.
  Under strict, `appRoot` should contain place directories and nothing
  else. See `test/fixtures/sandbox` + `strict-app.cjs`.
- Indexed mounts: only published, fs-visible entries are readable.
  Unpublished or excluded-ext paths → `EACCES` (disk-backed entries
  excepted).
- Paths outside `appRoot` → ordinary Node. Scanner does not follow
  symlinks.
- Guarded (unimplemented) APIs still enforce the routing decision, so a
  denied path cannot be probed via `copyFile`, `opendir`, `glob`,
  `watch`, …
- Same-process places are not firewalled from each other. Isolation =
  one worker per tenant with its own `link()`.

## API

### `VfsConfig`

`new VfsConfig(raw)` — hardcoded defaults → `raw.defaults` → per-place.
Deep-frozen after construction. `config.raw` is the merged input,
cloneable so workers rebuild from it.

| `defaults.*`           | Type   | Default    | Description                         |
| ---------------------- | ------ | ---------- | ----------------------------------- |
| `memory.limit`         | size   | `'1 gib'`  | Total SAB pool budget               |
| `memory.segmentSize`   | size   | `'64 mib'` | SAB segment size                    |
| `memory.maxFileSize`   | size   | `'10 mb'`  | Larger files become disk entries    |
| `compaction.threshold` | number | `0.3`      | 0 = off; else compact below this    |
| `hooks.fs`             | bool   | `true`     | Patch `node:fs`                     |
| `hooks.module`         | bool   | `true`     | `module.registerHooks` + `_compile` |
| `watch`                | bool   | `false`    | Watch sab places                    |
| `watchTimeout`         | number | `1000`     | Watcher debounce (ms)               |
| `strict`               | bool   | `false`    | `appRoot` sandbox                   |

Sizes accept `metautil.sizeToBytes` strings or numbers. Booleans must be
booleans.

| `places.<name>.*` | Type   | Default       | Description                                         |
| ----------------- | ------ | ------------- | --------------------------------------------------- |
| `provider`        | string | `'sab'`       | `sab`, `memory`, `sea`, `disk`, `node-default`      |
| `enabled`         | bool   | `true`        | Drop a place without removing it                    |
| `maxFileSize`     | size   | from defaults | SAB/sea only                                        |
| `fs`              | domain | off           | `true` or `{ ext, writable, zeroCopy, compress }`   |
| `require`         | domain | off           | `true` or `{ ext, compile }` (compile default true) |
| `import`          | domain | off           | `true` or `{ ext }`                                 |

Place name: ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, no trailing dot, no
Windows reserved names, unique after lowercasing.

Domain defaults: require ext `js,cjs,json`; import ext `js,mjs,json`;
fs ext `null` = everything. At least one domain must be on.

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

| Option         | Default              | Description                    |
| -------------- | -------------------- | ------------------------------ |
| `appRoot`      | `process.cwd()`      | Root for place directories     |
| `console`      | `globalThis.console` | Logger                         |
| `broadcast`    | no-op                | Extra fan-out besides `link()` |
| `getWorkerIds` | `() => []`           | Extra ACK set besides links    |
| `seaModule`    | `node:sea` if any    | Inject for tests               |

States: `new → initializing → ready → closed` (final). `fs()`,
`snapshot()`, `watch()`, `link()` require `ready`. `initialize()`
failure closes the kernel.

| Method                          | Description                                     |
| ------------------------------- | ----------------------------------------------- |
| `await initialize()`            | Scan / SEA / memory, bytecode, compression      |
| `fs(name)`                      | `PlaceFs` for an indexed fs place               |
| `snapshot()`                    | `{ segments, places }`                          |
| `link()`                        | `{ vfs, transferList }` for a worker            |
| `watch()`                       | Start `DirWatcher` (also auto if writable sab)  |
| `handleAck(updateId, workerId)` | ACK-before-free                                 |
| `handleWorkerExit(workerId)`    | Drop that worker from pending frees             |
| `close()`                       | Stop watcher, drop projections, collectable SAB |

`link()` returns `{ vfs: { snapshot, config: raw, appRoot, port },
transferList }`. The kernel posts every `vfs-update` to the port, reads
`ack-update`, and treats port `close` as worker exit.

#### Adapter API

`routeRead(absPath)`, `routeMutation(absPath)`,
`resolveModule(absPath, domain)` and `bytecode(absPath)` exist for
`lib/adapters/*`, not for application code: they hand back raw routing
decisions and borrowed views without the ownership and ext policies
`PlaceFs` applies. `bytecode()` in particular returns a borrowed SAB
view that the compile hook passes straight to `vm.Script`. Application
code should use `kernel.fs(name)`.

### `VfsKernel` (worker)

Prefer `attach()`. Manual: `VfsKernel.fromSnapshot(snapshot, config, {
appRoot })` then `handleDelta(msg)` for `vfs-update`.

`attach()` projects the snapshot, installs hooks the config asks for,
applies `vfs-update` from the link port and ACKs **those — and only
those** — back. Publishes `VfsKernel.current` (also the `kernel` getter
on the package).

### `PlaceFs`

Returned by `kernel.fs(name)`. Reads return `null` when missing;
`readdir` throws `ENOENT` / `ENOTDIR`. Keys: exact, then `'/' + key`.
Mutations take a canonical key (leading slash; NUL, `..`, backslash
rejected).

| Method                                       | Returns                  | Description                         |
| -------------------------------------------- | ------------------------ | ----------------------------------- |
| `readFile(key, opts)`                        | Buffer \| string \| null | Owned copy                          |
| `readFileView(key)`                          | Buffer \| null           | Borrowed; needs `zeroCopy`          |
| `stat(key, opts)`                            | `VfsStats` \| null       | Lazy; `{ bigint }` ok               |
| `exists(key)`                                | bool                     | File or implicit directory          |
| `readdir(key, opts)`                         | string[] \| Dirent[]     | Implicit dirs; lex order            |
| `createReadStream(key, opts)`                | Readable \| null         | `{ start, end }` inclusive          |
| `storedEncodings(key)`                       | string[]                 | `'raw'` plus configured codecs      |
| `readFileCompressed(key, enc)`               | Buffer \| null           | Owned copy                          |
| `readFileCompressedView(key, enc)`           | Buffer \| null           | Borrowed; needs `zeroCopy`          |
| `statCompressed(key, enc)`                   | object \| null           | `{ size, sourceSize, encoding, … }` |
| `createReadStreamCompressed(key, enc, opts)` | Readable \| null         | Range is compressed bytes           |
| `pathOf(key)`                                | string                   | Absolute OS path                    |
| `writeFile` / `appendFile` / `unlink`        | void                     | Memory Map or disk (`writable`)     |
| `mkdir` / `rm` / `rename`                    | void                     | Memory mkdir is a no-op             |

Cross-place `rename` through patched `fs` is `EXDEV`.

## Patched `node:fs`

With `hooks.fs` on, `node:fs` routes through the kernel. Every path-taking
API falls into one of three groups; anything outside them is untouched.
Full `node:fs` compatibility is not promised.

**1. Served for virtual entries** — sync, callback and promises forms:
`readFile`, `stat`, `lstat`, `access`, `realpath`, `readdir`,
`existsSync`, `createReadStream`, `writeFile`, `appendFile`, `unlink`,
`mkdir`, `rm`, `rename`.

**2. Recognized but unsupported** — routed, then rejected rather than
silently falling through: `open` on a virtual entry returns `ENOTSUP`,
because SAB and memory entries have no file descriptor. Descriptor-based
calls (`read`, `write`, `fstat`, …) are therefore unreachable for virtual
files and are left alone.

**3. Guarded passthrough** — not implemented, but the routing decision is
enforced before the call reaches the OS: `copyFile`, `cp`, `opendir`,
`rmdir`, `chmod` / `lchmod`, `chown` / `lchown`, `utimes` / `lutimes`,
`truncate`, `link`, `symlink`, `readlink`, `statfs`, `watch`,
`watchFile`, `glob`. This is what keeps a denied path from being read,
listed, copied or probed through an API the VFS does not implement.

## Errors

| Code      | Meaning                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `EACCES`  | Strict sandbox denial: unowned path under `appRoot`, place with no fs domain, or an unpublished / excluded-ext entry in an indexed mount |
| `EROFS`   | Place has `fs.writable: false` (or provider `sea`)                                                                                       |
| `ENOTSUP` | No file descriptor for a virtual entry (`open`); `*View` without `fs.zeroCopy`; compressed API for an unconfigured encoding              |
| `ENOENT`  | Missing key in a writable place; `readdir` of a missing directory                                                                        |
| `ENOTDIR` | `readdir` of a file                                                                                                                      |
| `EXDEV`   | `rename` across places                                                                                                                   |
| `EISDIR`  | `readFile` / `createReadStream` of an implicit directory                                                                                 |

Errors carry the same `code`, `errno`, `syscall` and `path` fields as
`node:fs`.

## Protocol

```
snapshot   { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } } }
vfs-update { name, updateId, places: { <name>: { entries, removals } }, newSegments }
ack-update { name: 'ack-update', updateId }
entry      shared { kind, segmentId, offset, length, stat } | disk { kind, path, stat }
stat       { size, mtimeMs }
```

One `vfs-update` per watcher epoch. Source + companions of one file go
in that same message. Bytes are freed only after every live worker
(`getWorkerIds()` ∪ `link()` ports) ACKs the `updateId`, or exits.

## Examples

Runnable demos under [examples/](examples/):

- [hot-reload-routes/](examples/hot-reload-routes/) — HTTP server whose
  route handlers are written into a memory place and `require()`d.
- [sea-static/](examples/sea-static/) — same static server as `sab` or
  Node SEA (`provider: 'sea'`).
- [multi-tenant/](examples/multi-tenant/) — two memory places +
  `strict: true`.

See [doc/integration.md](doc/integration.md) and
[doc/comparison.md](doc/comparison.md).

## Streaming and HTTP Range

```js
const stream = place.createReadStream('/video.mp4', { start, end });
res.writeHead(206, {
  'Content-Range': `bytes ${start}-${end}/${stat.size}`,
  'Content-Length': end - start + 1,
  'Accept-Ranges': 'bytes',
});
stream.pipe(res);
```

With `zeroCopy`, each chunk is a borrowed view. Without it, chunks are
copies. `createReadStreamCompressed` ranges address compressed bytes.

## Architecture

```
Main thread                             Worker threads
┌──────────────────────────┐            ┌─────────────────────────┐
│ VfsKernel                │  link()    │ attach() / fromSnapshot │
│ ├─ VfsConfig (frozen)    │ ─────────► │ ├─ projected Maps       │
│ ├─ FilesystemCache       │  vfs + SAB │ ├─ per-thread memory    │
│ │  └─ Pool+Registry      │            │ └─ handleDelta()        │
│ ├─ PlaceRegistry/FsRouter│  vfs-update│                         │
│ ├─ scanner + DirWatcher  │ ─────────► │                         │
│ └─ ACK-before-free       │ ◄───────── │ ack-update              │
└──────────────────────────┘            └─────────────────────────┘
         SAB segments  ←  shared physical memory  →  zero-copy views
```

Companions are internal keys `<source>\0require:bytecode` and
`<source>\0fs:<enc>`. They never appear in `readdir` / `exists` /
patched `fs`.

## Tests

```
npm test        # node --test "test/*.test.js"
npm run lint    # eslint + prettier
```

172 tests covering config, cache, scanner, place, kernel, module hooks,
fs-patch, compression, SEA, watcher, bootstrap. One symlink test skips
where links are unavailable.

## Support

CI runs the suite and the linter on every push:

|         | Node 22.22.3 | Node 22.x | Node 24.x | Node 26.x |
| ------- | ------------ | --------- | --------- | --------- |
| Linux   | ✓            | ✓         | ✓         | ✓         |
| Windows | ✓            | ✓         | ✓         | ✓         |

22.22.3 is the floor: `module.registerHooks` must resolve `require()` of
modules that exist only in memory. macOS is expected to work (same
`fs.watch` capabilities as Linux and Windows) but is not in the matrix.

The watcher relies on `fs.watch(dir, { recursive: true })`. That is
unavailable on AIX and IBM i, where the live-reload features do not
work; everything else does.

`npm ci` needs no git or SSH access: dependencies resolve over HTTPS
with lockfile integrity hashes.

## License

MIT
