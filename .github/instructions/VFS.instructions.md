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
                          directory under appRoot; provider × origin; domains fs
                          (with nested fs.script) / require / import.
lib/cache.js              Pool + SegmentRegistry + FilesystemCache (SAB allocator).
                          No Node deps; reader injected. Companion-aware only via keys.
lib/scanner.js            scan(root, { ext, startPath, followSymlinks }) → Map<key, FileInput>.
lib/watcher.js            DirWatcher: recursive fs.watch → debounced 'epoch' Map<path, event>.
lib/place.js              Place (internal): files projection, entry(), visible(), scripted(),
                          prepared(), companions(), isDirectory(), keysUnder().
lib/place-fs.js           PlaceFs: public per-place facade returned by kernel.fs(name).
lib/pipeline.js           The one preparation pipeline: Preparers (registry of
                          fs.script.prepare callbacks), prepareInput(...) → canonical
                          FileInput, bytecodeFor(...) → cached data companions.
                          createBytecode is internal — never exported from index.js.
lib/map-store.js          MapStore: the Map sink (owned Buffers) for provider "map";
                          synchronous mutations, node:fs-shaped errors.
lib/sab-store.js          SabStore: main-thread mutations of a sab+virtual place;
                          validates, then hands raw input to the kernel. Async.
lib/mutation-queue.js     MutationQueue: per-(place, key) ordering of virtual mutations,
                          plus an exclusive place barrier for subtree operations.
lib/mutation-rpc.js       MutationClient + RemoteStore: worker→main mutations over the
                          link port; payload transferred, response after publication.
lib/registry.js           PlaceRegistry (path → place, key) + FsRouter (read / mutate decisions).
lib/compression-cache.js  CompressionCache: gzip/deflate/br/zstd companions. Deps injected.
lib/companion.js          bytecodeKey(src, domain='require') = src\0<domain>:bytecode;
                          compressedKey(src, enc) = src\0fs:enc.
lib/stats.js              VfsStats / VfsBigIntStats / VfsDirent — lazy facades over { size, mtimeMs }.
lib/errors.js             fsError(code, syscall, path) — node:fs-shaped errors.
lib/kernel.js             VfsKernel: lifecycle, providers × origins, projection, watcher
                          pipeline, virtual publication, mutation queue + RPC server,
                          vfs-update broadcast, ACK-before-free, link(), worker projection.
lib/adapters/fs-patch.js  Table-driven node:fs patch executing FsRouter decisions.
lib/adapters/module-hook.js  module.registerHooks resolve/load (CJS + ESM) + _compile bytecode.
lib/bootstrap/register.mjs   `node --import shared-memory-fs/register` (main thread only).
lib/bootstrap/attach.js      attach(link) for worker threads (preloads do not run in workers).
index.js                  VfsConfig, VfsKernel, PlaceFs, FilesystemCache, VfsStats, VfsDirent,
                          attach, `kernel` getter (= VfsKernel.current).
```

Removed for good: `domains`, `dir`, root-level `ext/compile/compress/extOnExtra`,
`preload.cjs`, `require-hook.js`, `import-hook.mjs`, `vfs:` URL scheme, metawatch,
`module-cache.js` / `bytecode-cache.js` / `prepare.js` (now `pipeline.js`),
provider `memory` (now `map`, no alias — an unknown provider is a config error),
the standalone place-level `script` domain (now `fs.script`).
Rejected designs (do not reintroduce): preparer functions inside `VfsConfig`
(raw must stay cloneable), async preparers, synchronous worker→main mutations
through `Atomics.wait()`, direct worker access to the allocator, echoing file
bytes back to workers in a mutation response.

## Naming

See `/memories/naming.md`. No tautologies, no owner-type prefixes in fields.
Classes: `VfsConfig`, `VfsKernel`, `PlaceFs`, `PlaceRegistry`, `FsRouter`.

## Place / Domain Model

- `places.<name>` — name **is** the directory under appRoot, the mount, the cache
  namespace and the snapshot/delta key. ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, no
  trailing dot, no Windows reserved names, no two names equal after lowercasing.
- **provider** = where bytes live: `sab` (default), `map`, `sea`, `disk`,
  `node-default`. `INDEXED` = sab | map | sea (have a files Map);
  `SHARED` = sab | sea (bytes in SAB segments).
- **origin** = where content comes from: `disk` | `virtual`, for `sab` and `map`
  only (default `disk`, always explicit in the resolved config). Forbidden for
  sea / disk / node-default, which have a fixed origin. The four combinations:

  | provider + origin | content                          | mutations                    | sharing             |
  | ----------------- | -------------------------------- | ---------------------------- | ------------------- |
  | sab + disk        | scanner + watcher                | to disk, watcher republishes | snapshot/delta      |
  | sab + virtual     | application writes               | main thread or worker RPC    | snapshot/delta      |
  | map + disk        | scanner + watcher, owned Buffers | to disk, watcher republishes | none (thread-local) |
  | map + virtual     | application writes               | local Map, synchronous       | none (thread-local) |

  `origin: 'virtual'` requires the fs domain with `writable: true` — nothing else
  can ever give the place content. A virtual place is legitimately empty after
  `initialize()`; workers project it from the snapshot and receive its first file
  as an ordinary update. Map places never touch the cache, so they cannot leak
  into a snapshot.

- Domains: `fs`, `require`, `import` — each `false`/absent, `true` (defaults) or
  object.
  - `fs: { ext, writable, zeroCopy, compress, script }`;
    `fs.script: { ext, prepare, compile }` (ext default `js,cjs` — **never** `mjs`;
    `prepare` = preparer **identifier** string or absent; `compile` default **true**);
    `require: { ext, compile }` (compile default **true**); `import: { ext }`.
    Defaults: require ext `js,cjs,json`; import ext `js,mjs,json`.
  - Resolved `fs.ext` is the **union** of the user's `fs.ext` and `fs.script.ext`,
    in that order; null (everything) only when neither is set. A script-only fs
    domain is therefore restricted to its script extensions, never unrestricted.
    Where the two lists overlap the script pipeline wins: the file is prepared.
- `scanExt` (resolved, internal): null when fs is on without ext, else ordered union
  fs (incl. script) → require → import. Scanner loads a raw file once; each domain
  re-checks its ext.
- Provider rules (config errors): sea+writable; disk|node-default + compile:true (must
  write `require: { compile: false }`); `fs.script` needs INDEXED; zeroCopy needs
  INDEXED; compress needs SHARED; retainRaw:false needs sab, no require.compile and
  no fs.script; node-default fs takes no options; `place.maxFileSize <= segmentSize`
  for SHARED; `maxFileSize <= segmentSize <= limit`.
- Global: `memory.{limit,segmentSize,maxFileSize}` (the SAB budget — unrelated to
  provider `map`), `compaction.threshold` (0 = off), `hooks.{fs,module}`, `watch`,
  `watchTimeout`, `strict`. Booleans must be booleans; CLI (`--vfs.defaults.*`,
  `--vfs.places.<n>.*`, `--vfs.enable/disable`) coerces "true"/"false"/numbers only.
  `setNested` rejects `__proto__|prototype|constructor`.
- `config.raw` — the (merged) input, frozen and cloneable; workers rebuild from it.
  Preparer functions live in kernel options, never here.

## fs.script, Preparers And The One Pipeline

`fs.script` marks the sources the VFS treats as JavaScript it may transform and
compile. It serves consumers that build their own `vm.Script`
(`PlaceFs.script(key)`) and is orthogonal to `require.compile` (which serves
Node's CJS loader); the two may cover one file with independent companions.

Every source of raw input — disk scan, watcher, SEA assets, virtual mutations —
goes through **one** pipeline; only the storage sink differs (SAB segments,
or a per-thread Map):

```
raw input → fs.script applicability → optional prepare → canonical source
          → optional script bytecode → optional require bytecode
          → optional compression → atomic publication
```

- `fs.script.prepare: '<id>'` names a callback passed once as
  `new VfsKernel(config, { preparers: { '<id>': fn } })`. `Preparers.resolve()` binds
  ids to places at `initialize()`; a dangling id fails startup. Workers never receive
  preparers — only published bundles.
- `fn(raw: Buffer, file)` → `null` (publish raw) | `string` | `Uint8Array` |
  `{ source, scriptOptions?, meta? }`. `file` is frozen `{ place, key, path, ext, stat }`.
  The callback is **synchronous** (a thenable is a TypeError): it runs inside the
  scanner/watcher pipeline and inside synchronous Map writes. It sees no
  allocator, registry, ports or ACK state.
- **Canonical content**: a plain file publishes its raw bytes; a prepared script
  publishes the preparer's output, and that version _is_ the file in every domain —
  `readFile`, views, streams, `require`/`import` (`load` hook), compression,
  `script()` and the cached data all refer to it. Raw and prepared bytes are never
  both kept: for a disk origin the raw file stays on disk only, for a virtual
  origin the raw input is dropped after preparation. Hence `appendFile` on a
  prepared key is ENOTSUP, and so is renaming one (its bundle may embed the old
  key and cannot be re-prepared) — a disk-origin append edits the raw file and the
  watcher re-prepares it.
- `fs.script.compile` (default true) produces the `\0script:bytecode` companion:
  cached data of the **bare** canonical source under the preparer's
  `scriptOptions`. `require.compile` produces `\0require:bytecode`, cached data of
  `Module.wrap(canonicalSource)` under `{ filename: pathOf(key) }` — user
  `scriptOptions` are deliberately **not** applied to the CommonJS wrapper, whose
  filename and offsets belong to Node's loader contract. One `bytecodeFor()`
  builds both from the same published bytes (never from anything a callback
  returned separately), but the two artifacts are independent: each flavor is
  created only when its own flag is on, they never substitute for each other
  (`place.bytecode(key, 'script')` vs the `_compile` hook's default `'require'`),
  and the canonical source is stored once whatever the flavors are.
  With `compile: false` the bundle's `cachedData` is null.
  A script flavor that does not compile or does not fit **invalidates the whole
  publication** (init aborts; live, the previous version and companions stay and
  only this attempt's provisional allocations are rolled back — never the active
  version). A require flavor stays best-effort: its stale companion is retired
  and the source, and any valid script bundle, are published anyway.
- `scriptOptions` are the `vm.Script` options (`filename`, `lineOffset`, `columnOffset`,
  …) the library passes as-is to `new vm.Script(source, scriptOptions).createCachedData()`
  for the script flavor (never the deprecated `produceCachedData`) and ships in the
  bundle. **The library invents none of them** — no `pathOf(key)` default; without
  `scriptOptions` V8 defaults apply. `cachedData`, `produceCachedData`,
  `importModuleDynamically` are reserved (TypeError). The require flavor keeps the
  module filename: that is Node's loader contract, not a library choice.
- `scriptOptions` and `meta` are `structuredClone`d (validates cloneability, detaches
  the copy), deep-frozen and stored as `entry.scriptOptions` / `entry.meta`; they travel
  in snapshot/delta/compaction with the entry (`withExtras`) and come back from
  `script()` / `PlaceFs.meta(key)`. The library never interprets `meta`.
- V8 cached-data facts (proved cross-isolate by `test/script.test.js`): acceptance does
  **not** depend on `filename` / `lineOffset` / `columnOffset`; it is checked against
  source **length** (plus V8 version/flags), not content — a same-length divergent
  source is silently accepted and would run stale bytecode. This is why source and
  companion are always built from the same published bytes and replaced in one epoch
  (the watcher test "same-length edit runs the new code" guards it). Treat
  `cachedDataRejected` only as a cache-compatibility signal (V8 version/flags), never
  as a source-match check.
- Prepared inputs are `{ data, stat, scriptOptions?, meta? }` without `path`, hence
  **no disk fallback**: one that does not fit in SAB fails `initialize()` (like any
  unreadable source) or, live, is not published (previous version and companions stay,
  one recheck). `cache.load` throws for any path-less input it cannot place (also
  covers SEA assets).
- Map places: `MapStore.write` prepares when the thread has the preparer
  (`place.prepare`, main only); a worker writing a prepared key gets ENOTSUP rather than
  publishing raw bytes as prepared.
- `PlaceFs.script(key)` → `{ source: string, cachedData: Buffer|null, scriptOptions, meta }`
  as owned copies (`new vm.Script(source, { ...scriptOptions, cachedData })`), or null
  when the key is not a published script source; ENOTSUP when the place has no
  `fs.script`. Internal bytecode helpers are never exported from `index.js`.
- Prove cached-data acceptance in a worker (V8 per-isolate cache masks rejection in
  the compiling thread). `test/script.test.js` and `test/bytecode-flavors.test.js`
  hold the end-to-end shape.

## Virtual Places And Worker Mutations

A `sab + virtual` place has no disk backing: the application creates its content
and the main kernel remains the only owner of the allocator, preparation,
publication order, ACK-before-free and compaction.

- Main thread: `PlaceFs` mutations route to `SabStore`, which validates node:fs
  semantics against the live projection and calls the kernel. Publication crosses
  the allocator (and, when configured, the compression threadpool), so these
  methods return a **Promise**; every other place mutates synchronously and
  returns undefined. `await` is correct for both.
- Workers: `RemoteStore` sends `{ name: 'vfs-mutate', id, place, op, key, to?,
options?, data? }` over the same private link port and resolves on
  `{ name: 'vfs-mutated', id, error? }`. The payload is a **detached copy**
  transferred with the message (a caller-owned Buffer is never detached). Errors
  cross as cloneable `{ code, message, syscall, path }`.
- The response arrives after the new version is published — one `vfs-update` for
  every thread — **not** after every worker ACKs. ACKs only govern when the
  replaced bytes are released. Bytes are never echoed back: they are in SAB and
  the delta carries projection metadata and new segments only.
- `kernel.enqueueMutation(place, keys, fn)` orders mutations **per
  `(place, key)`**, in the order the main kernel accepted them; unrelated keys
  never wait. All locks a task needs are taken in one shot, so there is no
  hold-and-wait: `rename` lists both keys, `rm` may collect a subtree and takes
  an **exclusive place barrier** instead. A failed task never blocks the ones
  behind it (predecessors are awaited with `allSettled`), and lock records live
  only while a task is queued or running (`mutations.size` returns to 0).
- Preparation runs outside the lock; the allocator, the index and epoch
  publication stay single-threaded through a short commit section
  (`#commit`: allocate → companions → stage → flush). They are never turned
  into concurrent structures.
- One accepted mutation, one `vfs-update`: virtual publication has **no**
  debounce or coalescing, because each Promise must correspond to its own
  publication. Disk-origin writes keep the opposite contract — the native
  operation may complete before the watcher republishes, and the existing
  watcher timeout / epoch batching remain the only collapsing mechanism
  (there is no second refresh path).
- Main re-validates place, provider, origin, writability and key for every
  request: a worker's projection is never authoritative. Because the check
  runs inside the key's lock, the state validated is the state published.
- No synchronous worker mutation: `*Sync` on a virtual place is ENOTSUP
  (`fs-patch` refuses when `place.store.sync === false`); `Atomics.wait()` RPC is
  rejected by design. Callback and promise forms work.
- Lifecycle: a worker that exits leaves its queued requests to run, but the
  response is dropped and its ACKs are released by `handleWorkerExit`. A closing
  kernel clears the queue bookkeeping and closes the ports; tasks already queued
  reject on the closed kernel, and every request still pending in a worker is
  rejected by `MutationClient.close`. Nothing may stay pending across a close,
  and provisional allocations are always rolled back.
- `map + virtual` is the same semantics without sharing: synchronous `MapStore`
  mutations of a thread-local Map, no snapshot, no ACK, no watcher.
- `map + disk` is a single-threaded RAM cache: the scanner fills owned Buffers,
  mutations go to disk and the watcher republishes them (a writable disk-origin
  place always starts the watcher). It never touches the SAB pool.

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
  reachable only through `kernel.bytecode(absPath)` (require flavor) and
  `PlaceFs.script(key).cachedData` (script flavor). `Place.companions(key)` enumerates
  every companion a place may hold for a source — use it, do not hand-roll key lists.
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
  `watch()`, `link()` and mutations require `ready`. `initialize()` failure closes
  the kernel.
- Init per place (`#initPlace`): sab+disk → scan + prepare + `cache.load` + project;
  sab+virtual → empty index + `SabStore`; map+disk → scan + prepare + `MapStore`
  publish; map+virtual → `MapStore` only; sea → assets `<name>/…` → prepare → load;
  disk/node-default → nothing. Then bytecode (`#initBytecode`) and compression
  passes for SHARED places.
- Options: `{ appRoot, console, broadcast, getWorkerIds, seaModule, preparers }`
  (worker side additionally `port`, set by `attach`).
- `watch()` starts when `defaults.watch` or any **disk-origin** place has
  `fs.writable` (writes go to disk; the watcher brings them back — eventual
  consistency, no waitForUpdate). Virtual places are never watched.
- Epoch pipeline (`#handleEpoch`): route each event; `delete` → `#unpublish` (source +
  companions, prefix for dirs); `scan` → `#rescan` (new keys only); `change` →
  `#refresh` → `#publish` → `#publishEntry` (prepare → allocate → bytecode →
  compression → stage). Duplicate publishes within an epoch are dropped (`ep.seen`).
  One `vfs-update` per epoch. `#publish` warns and reschedules; `#publishEntry`
  throws, which is what lets virtual mutations reject and roll back provisional
  allocations (`cache.rollback`).
- Virtual publication: `enqueueMutation` (arrival-order queue) → `publishVirtual` /
  `unpublishVirtual` / `renameVirtual`, each emitting one `vfs-update`.
  `#serveMutation` / `#mutate` answer worker requests over link ports.
- `resolveModule(absPath, domain)` → `{ place, key, file } | { denied } | null`:
  node-default → null; domain off → denied/null; disk → null; unpublished/invisible/
  disk-backed → denied (strict) or null.
- `link()` → `{ vfs: { snapshot, config: raw, appRoot, port }, transferList }`; the
  kernel posts every `vfs-update` to link ports, reads `ack-update` and `vfs-mutate`,
  and treats port `close` as worker exit.
- `close()` is final: it stops the watcher, drops deferred work, projections and the
  caches themselves, so the SAB pool becomes collectable.
- Adapter API (`routeRead`, `routeMutation`, `resolveModule`, `bytecode`) is for
  `lib/adapters/*` only: raw routing decisions and borrowed views, without the
  ownership and ext policies PlaceFs applies. Application code uses `fs(name)`.
  Do not grow it into a user-facing surface.
- Worker: `VfsKernel.fromSnapshot(snapshot, config, { appRoot, port })`;
  `handleDelta(msg)`; `mutationClient` routes `vfs-mutated`.

## Protocol

```
snapshot   { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } } }
vfs-update { name, updateId, places: { <name>: { entries: [[key, entry]], removals: [key] } },
             newSegments: [{ id, sab }] }
ack-update { name: 'ack-update', updateId }
vfs-mutate { name, id, place, op, key, to?, options?, data? }   worker → main
vfs-mutated { name, id, error?: { code, message, syscall, path } }  main → worker
entry      shared { kind, segmentId, offset, length, stat, scriptOptions?, meta? }
           | disk { kind, path, stat, scriptOptions?, meta? }
stat       { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
scriptOptions  frozen cloneable vm.Script options from a preparer; absent otherwise
meta       frozen structured-cloneable object from a preparer; absent otherwise
```

## FS Routing (lib/registry.js)

- `PlaceRegistry.route(abs)` → `null` (outside appRoot), `{ place: null }` (under
  appRoot, owned by nobody — a managed denial at any depth), or `{ place, key }`
  ('' = mount root). The router never stats the disk.
- `FsRouter.read` → `file` (published, visible, in memory) | `dir` (implicit) |
  `passthrough` (outside, node-default, disk, disk-backed entry, non-strict miss) |
  `deny EACCES` (strict: unowned path, no fs domain, unpublished/invisible in indexed).
- `FsRouter.mutate` → `store` (virtual place: Map or main-kernel RPC) |
  `passthrough` (node-default, writable disk-origin, disk) |
  `deny EROFS` (writable false, sea) | `deny EACCES` (strict unowned / no fs domain).
- Every path-taking node:fs API falls into one of three groups; anything outside
  them is untouched and full node:fs compatibility is not promised.
  1. **Served** for virtual entries (sync/callback/promises): readFile, stat, lstat,
     access, realpath, readdir, existsSync, createReadStream, writeFile,
     appendFile, unlink, mkdir, rm, rename (cross-place → EXDEV).
  2. **Recognized but unsupported**: `open` on a virtual entry → ENOTSUP — SAB and
     Map entries have no descriptor, so fd-based calls stay unreachable rather
     than falling through to the OS. `*Sync` mutations of a shared virtual place
     are ENOTSUP too: they would have to block on the main thread.
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
- Virtual-place mutations delegate to `place.store` (write/append/unlink/mkdir(no-op)/
  rm(recursive, force)/rename; companions follow; the store throws the node:fs-shaped
  errors). `MapStore` is synchronous, `SabStore` / `RemoteStore` return Promises
  (`store.sync` tells them apart). Writable disk-origin → `node:fs` sync ops on
  `pathOf(key)`.
- `script(key)` / `meta(key)` — see “fs.script, Preparers And The One Pipeline”.

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

- Use `npm test` for the complete suite. A symlink test may skip where test
  symlinks are unavailable; the 8.3-alias tests skip off Windows.
  `npm run lint` = eslint + prettier. Bootstrap and hooks tests use
  child processes / workers — never install hooks in the runner process without
  uninstalling in `after`.
- CI runs both on Linux and Windows across Node 22.22.3 / 22.x / 24.12.0 /
  24.x / 26.x.
  Dependencies must stay installable by a bare `npm ci` — no git or SSH access, so
  git deps are pinned as HTTPS tarball URLs with lockfile integrity, never as
  `github:` shorthand (npm rewrites that to `git+ssh` in `resolved`).
- Update tests in the same change as allocator / projection / ACK / watch / routing
  changes. Keep README, `doc/` and this file aligned with the code.
