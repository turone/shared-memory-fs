---
name: 'VFS Architecture'
branch: main
description: 'Use when modifying VFS kernel, SAB cache, scanner, config, places, adapters, bootstrap, or tests.'
applyTo: lib/**, index.js, test/**, doc/**
---

# VFS Architecture

`shared-memory-fs` — pooled SharedArrayBuffer virtual filesystem for Node.js
worker_threads, plus fs / module hooks. Engines:
`>=22.22.3 <23 || >=24.12.0 <25 || >=26` (`module.registerHooks`).
Node 22 from 22.22.3; Node 24 from 24.12.0. Early Node 24 bypasses
registerHooks for nested require() from CJS executed by the ESM
translator (Linux and Windows alike). ESM and disk-backed CommonJS could
work on earlier 24.x; those releases are outside the supported matrix.

## Module Map

```
lib/config.js             VfsConfig: raw → deep-frozen { global, places }. Place = one
                          directory under appRoot; domains fs / require / import.
lib/cache.js              Pool + SegmentRegistry + FilesystemCache (SAB allocator).
                          No Node deps; reader injected. Companion-aware only via keys.
lib/scanner.js            scan(root, { ext, startPath, followSymlinks }) → Map<key, FileInput>.
lib/watcher.js            DirWatcher: recursive fs.watch → debounced 'epoch' Map<path, event>.
lib/place.js              Place (internal): files projection, entry(), visible(), isDirectory().
lib/place-fs.js           PlaceFs: public per-place facade returned by kernel.fs(name).
lib/memory-store.js       MemoryStore: mutations of a memory place (owned Buffers + bytecode).
lib/registry.js           PlaceRegistry (path → place, key) + FsRouter (read / mutate decisions).
lib/module-cache.js       ModuleCache: V8 cached data companions. Deps injected.
lib/compression-cache.js  CompressionCache: gzip/deflate/br/zstd companions. Deps injected.
lib/companion.js          bytecodeKey(src) = src\0require:bytecode; compressedKey(src, enc) = src\0fs:enc.
lib/stats.js              VfsStats / VfsBigIntStats / VfsDirent — lazy facades over { size, mtimeMs }.
lib/errors.js             fsError(code, syscall, path) — node:fs-shaped errors.
lib/kernel.js             VfsKernel: lifecycle, providers, projection, watcher pipeline,
                          vfs-update broadcast, ACK-before-free, link(), worker projection.
lib/adapters/fs-patch.js  Table-driven node:fs patch executing FsRouter decisions.
lib/adapters/module-hook.js  module.registerHooks resolve/load (CJS + ESM) + _compile bytecode.
lib/bootstrap/register.mjs   `node --import shared-memory-fs/register` (main thread only).
lib/bootstrap/attach.js      attach(link) for worker threads (preloads do not run in workers).
index.js                  VfsConfig, VfsKernel, PlaceFs, FilesystemCache, VfsStats, VfsDirent,
                          attach, `kernel` getter (= VfsKernel.current).
```

Removed for good: `domains`, `dir`, root-level `ext/compile/compress/extOnExtra`,
`preload.cjs`, `require-hook.js`, `import-hook.mjs`, `vfs:` URL scheme, metawatch.

## Naming

See `/memories/naming.md`. No tautologies, no owner-type prefixes in fields.
Classes: `VfsConfig`, `VfsKernel`, `PlaceFs`, `PlaceRegistry`, `FsRouter`.

## Place / Domain Model

- `places.<name>` — name **is** the directory under appRoot, the mount, the cache
  namespace and the snapshot/delta key. ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, no
  trailing dot, no Windows reserved names, no two names equal after lowercasing.
- One provider per place: `sab` (default), `memory`, `sea`, `disk`, `node-default`.
  `INDEXED` = sab | memory | sea (have a files Map); `SHARED` = sab | sea (bytes in SAB).
- Domains: `fs`, `require`, `import` — each `false`/absent, `true` (defaults) or object.
  - `fs: { ext, writable, zeroCopy, compress }`; `require: { ext, compile }` (compile
    default **true**); `import: { ext }`. Defaults: require ext `js,cjs,json`; import
    ext `js,mjs,json`; fs ext null = everything.
- `scanExt` (resolved, internal): null when fs is on without ext, else ordered union
  fs → require → import. Scanner loads a raw file once; each domain re-checks its ext.
- Provider rules (config errors): sea+writable; disk|node-default + compile:true (must
  write `require: { compile: false }`); zeroCopy needs INDEXED; compress needs SHARED;
  retainRaw:false needs sab and no compile; node-default fs takes no options;
  `place.maxFileSize <= segmentSize` for SHARED; `maxFileSize <= segmentSize <= limit`.
- Global: `memory.{limit,segmentSize,maxFileSize}`, `compaction.threshold` (0 = off),
  `hooks.{fs,module}`, `watch`, `watchTimeout`, `strict`. Booleans must be booleans;
  CLI (`--vfs.defaults.*`, `--vfs.places.<n>.*`, `--vfs.enable/disable`) coerces
  "true"/"false"/numbers only. `setNested` rejects `__proto__|prototype|constructor`.
- `config.raw` — the (merged) input, frozen and cloneable; workers rebuild from it.

## Invariants (must hold)

- **Zero-copy internally**: projections are `Buffer.from(sab, offset, length)` views.
  Publicly, `readFile*` returns owned copies; `*View` methods and stream chunks are
  borrowed views **only** when `fs.zeroCopy: true`, else ENOTSUP / copies.
- **Frozen config**: deep-frozen after construction; never mutated at runtime.
- **ACK-before-free**: bytes replaced/removed by the main thread are freed only after
  every live worker (`getWorkerIds()` ∪ `link()` ports) ACKs the `updateId`, or exits.
- **Compaction never overwrites ACK-pending bytes**: the emptied segment is _closed_
  (no allocations) until `used === 0`; only then it joins `emptySegmentIds`.
- **Segments stay**: emptied segments are reused, never returned to the OS. One
  segment size; files above `maxFileSize` become disk entries; companions are bounded
  by the segment size only and always `fallback: false`.
- **Stable source reads**: `readInto` verifies size+mtime before and after a looped
  read. Init: any failure aborts `initialize()` (kernel → closed). Watcher: failed
  source is not published, old source and companions stay, exactly one deferred
  recheck, then only a real event retries.
- **No mixed versions**: source + companions of one file are published in one
  `vfs-update`; a companion that fails to rebuild is listed in `removals` of that same
  message. Syntax-invalid sources are still published (VFS mirrors current state).
- **Companions are internal**: `<source>\0…` keys never appear in readdir/exists/
  routing/patched fs; `compressed API` accepts configured encodings only; bytecode is
  reachable only through `kernel.bytecode(absPath)`.
- **Kernel-internal disk I/O bypasses the patch**: scanner/kernel/watcher destructure
  `node:fs` functions at load time so a strict sandbox never blocks the kernel.
- **`watchPath` is a load-bearing workaround, not tidy-up material**: on Windows an
  8.3 alias in the watched path makes libuv abort the process (nodejs/node#63638).
  It expands aliases through `fs.realpathSync.native` and never rewrites a path by
  pattern — resolve or return untouched. Remove only when the engines floor clears
  every affected release.
- **Router decides, adapters execute**: fs-patch and module-hook never read config.
- **Unpatched fs stays unpatched**: `install()` records every replaced property;
  `uninstall()` restores them in reverse; `.native` variants are preserved.

## Kernel (lib/kernel.js)

- States `new → initializing → ready → closed` (final). `fs()`, `snapshot()`,
  `watch()`, `link()` require `ready`. `initialize()` failure closes the kernel.
- Init per place: sab → scan + `cache.load` + project; sea → assets `<name>/…` → load;
  memory → `MemoryStore`; disk/node-default → nothing. Then bytecode and compression
  passes for SHARED places.
- `watch()` starts when `defaults.watch` or any sab place has `fs.writable` (writes go
  to disk; the watcher brings them into SAB — eventual consistency, no waitForUpdate).
- Epoch pipeline (`#handleEpoch`): route each event; `delete` → `#unpublish` (source +
  companions, prefix for dirs); `scan` → `#rescan` (new keys only); `change` →
  `#refresh` → `#publish` (allocate raw → bytecode → compression → stage). Duplicate
  publishes within an epoch are dropped (`ep.seen`). One `vfs-update` per epoch.
- `resolveModule(absPath, domain)` → `{ place, key, file } | { denied } | null`:
  node-default → null; domain off → denied/null; disk → null; unpublished/invisible/
  disk-backed → denied (strict) or null.
- `link()` → `{ vfs: { snapshot, config: raw, appRoot, port }, transferList }`; the
  kernel posts every `vfs-update` to link ports, reads `ack-update`, and treats port
  `close` as worker exit.
- `close()` is final: it stops the watcher, drops deferred work, projections and the
  caches themselves, so the SAB pool becomes collectable.
- Adapter API (`routeRead`, `routeMutation`, `resolveModule`, `bytecode`) is for
  `lib/adapters/*` only: raw routing decisions and borrowed views, without the
  ownership and ext policies PlaceFs applies. Application code uses `fs(name)`.
  Do not grow it into a user-facing surface.
- Worker: `VfsKernel.fromSnapshot(snapshot, config, { appRoot })`; `handleDelta(msg)`.

## Protocol

```
snapshot   { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } } }
vfs-update { name, updateId, places: { <name>: { entries: [[key, entry]], removals: [key] } },
             newSegments: [{ id, sab }] }
ack-update { name: 'ack-update', updateId }
entry      shared { kind, segmentId, offset, length, stat } | disk { kind, path, stat }
stat       { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
```

## FS Routing (lib/registry.js)

- `PlaceRegistry.route(abs)` → `null` (outside appRoot), `{ place: null }` (under
  appRoot, owned by nobody — a managed denial at any depth), or `{ place, key }`
  ('' = mount root). The router never stats the disk.
- `FsRouter.read` → `file` (published, visible, in memory) | `dir` (implicit) |
  `passthrough` (outside, node-default, disk, disk-backed entry, non-strict miss) |
  `deny EACCES` (strict: unowned path, no fs domain, unpublished/invisible in indexed).
- `FsRouter.mutate` → `memory` | `passthrough` (node-default, writable sab/disk) |
  `deny EROFS` (writable false, sea) | `deny EACCES` (strict unowned / no fs domain).
- Every path-taking node:fs API falls into one of three groups; anything outside
  them is untouched and full node:fs compatibility is not promised.
  1. **Served** for virtual entries (sync/callback/promises): readFile, stat, lstat,
     access, realpath, readdir, existsSync, createReadStream, writeFile,
     appendFile, unlink, mkdir, rm, rename (cross-place → EXDEV).
  2. **Recognized but unsupported**: `open` on a virtual entry → ENOTSUP — SAB and
     memory entries have no descriptor, so fd-based calls stay unreachable rather
     than falling through to the OS.
  3. **Guarded passthrough**: copyFile, cp, opendir, rmdir, chmod/lchmod,
     chown/lchown, utimes/lutimes, truncate, link, symlink, readlink, statfs,
     watch, watchFile, glob. They enforce the routing decision and otherwise call
     through, so an unimplemented API can never bypass or probe the sandbox.
     `watch` / `watchFile` / `promises.watch` are patched with the sync wrapper:
     they hand back their result (FSWatcher, async iterator) synchronously.

## PlaceFs (lib/place-fs.js)

- Reads return `null` when missing; `readdir` throws ENOENT/ENOTDIR. Keys: exact, then
  `'/' + key`; no other normalization. Mutations take `canonicalKey` (leading slash
  added; NUL, `..`, backslash rejected).
- `stat` → lazy `VfsStats` (dirs implicit, `{ bigint }` supported); never cached.
- `createReadStream(key, { start, end, encoding, highWaterMark, signal })`: explicit
  ranges are validated (RangeError), end inclusive, default hwm 64 KiB.
- Memory mutations: write/append/unlink/mkdir(no-op)/rm(recursive, force)/rename
  (companions follow). Writable sab/disk → `node:fs` sync ops on `pathOf(key)`.

## Module Hooks (lib/adapters/module-hook.js)

- `module.registerHooks({ resolve, load })` — sync, in-thread, one chain for
  `require()` and `import`. Domain = `context.conditions.includes('require')`.
- VFS modules keep **plain `file:` URLs**: identity equals the disk path, so
  `import.meta.url`, `__filename`, `require.cache` behave normally.
- require: LOAD_AS_FILE (`exact, .js, .cjs, .json`) then LOAD_AS_DIRECTORY
  (`package.json` main, `index.*`) over published entries; no exports/imports maps.
  import: extension mandatory; `.js` in the import domain is ESM, `.cjs` CommonJS;
  JSON requires `with { type: 'json' }` (validated in `load`).
- Strict: all candidates denied → `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND`, never
  a disk read. Non-strict miss → default resolver.
- `_compile` patch: `vm.Script` with `cachedData`; `cachedDataRejected` or any
  preparation error → original compiler once; the wrapper runs **outside** the guard
  (a throwing module body never re-executes). `module.loaded` is left to Node.
  `require` for the wrapper mirrors `makeRequireFunction` (`mod.require`, resolve,
  paths, main, extensions, cache).
- V8's per-isolate compilation cache masks `cachedDataRejected` for a source already
  compiled in that isolate — prove acceptance in a worker, not in the compiling thread.

## Bootstrap

- `node --import shared-memory-fs/register app.js -- --vfs.config=… --vfs.*=…`
  Config file: `--vfs.config` or `vfs.config.{js,cjs,mjs,json}` in cwd. Order: load
  config → `initialize()` → install hooks (`hooks.fs`, `hooks.module`) → publish
  `VfsKernel.current`. Failure: uninstall, close, rethrow → entry never runs.
- Preloads (`--import`/`--require`) do **not** run in worker threads: workers call
  `attach()` (reads `workerData.vfs` from `kernel.link()`), which projects the
  snapshot, installs hooks, applies `vfs-update` deltas from the port and ACKs
  those — and only those — back.

## Strict Sandbox

**`strict: true` makes appRoot the sandbox boundary.** Every path under appRoot that
no place owns is denied with EACCES — at every depth, file or directory alike, and
without the router ever touching the disk. Consequences to design around:

- A trusted entry point and its package metadata (`package.json`, lockfiles) must
  live **outside appRoot**, or inside an explicitly configured `node-default` /
  `disk` place. Under strict, appRoot should contain place directories and nothing
  else. See `test/fixtures/sandbox` + `strict-app.cjs` for the canonical layout.
- Indexed mounts: only published, fs-visible entries are readable; unpublished or
  excluded-ext paths → EACCES, no disk fallback (disk-backed entries excepted).
- `disk` → managed passthrough with writable policy; `node-default` → ordinary Node.
  Paths outside appRoot → ordinary Node. Scanner does not follow symlinks.
- The denial is enforced for every routed API, including the guarded ones: reads,
  listings (`readdir`, `opendir`, `glob`), copies (`copyFile`, `cp -r`), metadata
  writes and `watch` / `watchFile`, so a denied path cannot even be probed.
- Same-process places are not firewalled from each other; isolation = one worker per
  tenant with its own link.

## Tests And Docs

- `node --test test/*.test.js` (176 tests; one symlink test skips where links are
  unavailable, the 8.3-alias tests skip off Windows). `npm run lint` = eslint +
  prettier. Bootstrap and hooks tests use
  child processes / workers — never install hooks in the runner process without
  uninstalling in `after`.
- CI runs both on Linux and Windows across Node 22.22.3 / 22.x / 24.12.0 /
  24.x / 26.x.
  Dependencies must stay installable by a bare `npm ci` — no git or SSH access, so
  git deps are pinned as HTTPS tarball URLs with lockfile integrity, never as
  `github:` shorthand (npm rewrites that to `git+ssh` in `resolved`).
- Update tests in the same change as allocator / projection / ACK / watch / routing
  changes. Keep README, `doc/` and this file aligned with the code.
