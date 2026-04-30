---
name: "VFS Architecture"
branch: main
description: "Use when modifying VFS kernel, SAB cache, scanner, config, places, adapters, bootstrap, allocation, compaction, ACK handling, delta broadcasting, tests, or documentation."
applyTo: lib/**, index.js, test/**, doc/**
---

# VFS Architecture

Architecture for `shared-memory-fs` — a pooled SharedArrayBuffer virtual filesystem
for Node.js worker_threads. When this file conflicts with older docs or top-level
instructions, current branch code and this file win.

## Module Map

- `lib/cache.js` — Pool + SegmentRegistry + FilesystemCache (SAB allocator).
  Self-contained, no Node.js built-in or external dependencies.
- `lib/scanner.js` — pure async directory scanner. `scan(rootPath, {ext, startPath})`
  returns `{ files: Map<key,{stat,path}>, dirs: Set }`. `getKey(filePath, basePath)`
  produces forward-slash keys.
- `lib/config.js` — VfsConfig class. Config cascade (hardcoded defaults → app config →
  per-place → CLI overrides), validation, deep freeze. SKIP sentinel for `fromArgv()`.
- `lib/place.js` — Place class. Logical namespace that owns cached file data.
  `files` Map is a live reference updated by kernel.
- `lib/registry.js` — PlacementRegistry. Stores places, resolves domain+path → place.
- `lib/policy.js` — PolicyEngine. Readonly enforcement, write deny, diagnostics logging.
- `lib/kernel.js` — VFSKernel. Top-level facade and cache orchestrator. Directly owns
  FilesystemCache, segmentsMap, projected Maps, watcher, ACK tracking.
- `lib/adapters/fs-patch.js` — monkey-patches node:fs for VFS-managed files.
- `lib/adapters/require-hook.js` — patches Module._resolveFilename for CJS require.
- `lib/adapters/import-hook.mjs` — ESM loader hooks (resolve + load) via module.register.
- `lib/bootstrap/preload.cjs` — CJS bootstrap entry point (--require).
- `lib/bootstrap/register.mjs` — ESM bootstrap entry point (--import).
- `index.js` — public API surface; re-exports FilesystemCache, VfsConfig, Place, VFSKernel.

## FilesystemCache Rules (lib/cache.js)

- `FilesystemCache` is self-contained and has no Node.js built-in or external dependencies.
- There is only one segment type: base segments.
- There are no oversize dedicated segments.
- `Pool` retains empty segments in `emptySegmentIds` and reuses them; segments are not
  returned to the OS.
- `baseSegmentSize = Math.ceil(maxFileSize / configured) * configured`.
- `limit` should be evenly divisible by the effective `baseSegmentSize`; otherwise the
  remainder is wasted.
- `load()` sorts candidates by descending size before allocation.
- `SegmentRegistry.allocate()` does: best-fit free extent, then tail append, then new
  segment, else disk fallback.
- Shared entries are internal metadata objects: `{ kind: 'shared', segmentId, offset, length, stat }`.
- Disk entries are internal metadata objects: `{ kind: 'disk', path, stat, data: null }`.
- `size > maxFileSize` always means disk entry.
- Do not add Node.js built-in dependencies to this file.

## Projection Rules

- Worker-side projection is eager, not lazy.
- `FilesystemCache.projectEntry()` creates `Buffer.from(segmentsMap.get(segmentId), offset, length)`
  once at projection time.
- Public shared files exposed through Place `files` are `{ data, stat }`.
- Disk-backed files exposed through Place `files` are `{ data: null, stat, path }`.
- Buffer views are lightweight descriptors over SAB and are garbage-collected when
  projected file objects are removed.

## Scanner Rules (lib/scanner.js)

- `scan()` stores only `{ stat, path }` per file; data is read into SAB by the reader
  injected from VFSKernel.
- `startPath` option allows scanning a subdirectory with keys relative to `rootPath`.
- Path normalization produces forward-slash keys on all platforms (including Windows).
- `getKey()` must continue to return forward-slash keys for Windows paths.
- Extension filtering uses `metautil.fileExt()` (returns without dot: `'html'` not `'.html'`).

## VFSKernel Rules (lib/kernel.js)

- VFSKernel is the primary consumer-facing class. Consumers instantiate it with a
  frozen VfsConfig and call `initialize()`, `snapshot()`, `handleAck()`,
  `handleWorkerExit()`, `watch()`, `close()`.
- VFSKernel injects a Node.js reader using `fs.open()` and `fh.read()` into a
  Buffer view over SAB.
- Config is parsed by VfsConfig; VFSKernel receives it frozen.
- `watch()` uses metawatch `before` / `change` / `delete` / `after` events to build epochs.
- Placement routing in `watch()` is based on the first segment of the path relative to
  the monitored directory root, not on absolute-path prefix matching.
- `#processChange(ep, ...)` must receive the epoch explicitly; do not close over the
  mutable `epoch` variable from async code.
- `#flushEpoch()` emits at most one `file-update` and one `file-delete` per placement per epoch.
- Old entries are tracked against the last `updateId` produced in the epoch.
- There is no timeout-based forced free.
- Old entries are freed only after all workers ACK or after `handleWorkerExit(workerId)`
  removes a dead worker from pending sets.
- `handleWorkerExit()` collects entries to free first, then processes them outside the
  iteration loop (no Map mutation during iteration).
- `#trackUpdate()` frees immediately when `getWorkerIds()` returns empty (single-process fix).
- `#tryCompact()` runs after freeing entries.
- `#tryCompact()` is batch-first: it may broadcast one `file-update` per placement, but
  tracks `oldEntries` only once against the last `updateId` of the compaction batch.
- `compact()` may legitimately return `null`; this is not an error.
- `#broadcast()` isolates projection errors from consumer callback errors via separate
  try/catch blocks.
- `pathIndex` is built automatically by `initialize()` and `fromSnapshot()`; there is
  no manual `seal()` step.
- `pathIndex` maps absolute OS paths to `{ place, key, fileKey }` for O(1) dispatch.
- `#handleUpdate()` and `#handleDelete()` incrementally update pathIndex via
  `#addToPathIndex()` / `#removeFromPathIndex()`.
- `close()` stops the watcher, clears all internal maps, resets state.

### Worker-side kernel (fromSnapshot + handleDelta)

- `VFSKernel.fromSnapshot(snapshot, config, options)` creates a read-only worker-side
  kernel. It has no cache, no watcher, no ACK tracking.
- `fromSnapshot()` builds `segmentsMap` from snapshot segments, projects filesystems via
  `FilesystemCache.project()`, registers places via registry.
- Worker-side kernel supports `resolveFsPath()`, `dispatchFsRead()`,
  `dispatchModuleResolve()`, `dispatchModuleLoad()`.
- `handleDelta(msg)` applies `file-update` or `file-delete` messages on the worker side.
- `handleDelta` with `file-update`: registers new segments, projects entries via
  `FilesystemCache.projectEntry()`, updates place `files` Map. Updates pathIndex.
- `handleDelta` with `file-delete`: removes keys from projected files and pathIndex.
- Workers must send `{ name: 'ack-update', updateId }` back to main thread after
  processing each delta.

## Config Rules (lib/config.js)

- VfsConfig parses `limit`, `baseSegmentSize`, and `maxFileSize` via `sizeToBytes()` and
  supports both binary and decimal units.
- `fromArgv()` uses a SKIP sentinel to avoid double construction; `_setFromArgv` does not exist.
- Config is deep-frozen after construction. No runtime mutation.
- Per-place `compile: true` enables V8 bytecode generation for JS files in that place.
- `compile: true` automatically adds `'require'` to `domains` if not already present.

## Place Rules (lib/place.js)

- Place constructor takes `(name, config)` — no provider parameter.
- `files` Map is a live reference set by VFSKernel after projection.
- Methods: `readFile(key)`, `stat(key)`, `exists(key)`, `filePath(key)`, `list(prefix)`,
  `createReadStream(key, options)`, `readBytecode(key)`.
- `createReadStream(key, options)` returns a chunked `Readable` over SAB data (64KB chunks).
  Supports `{ start, end }` for HTTP Range requests. Returns `null` for disk entries or
  unknown keys. Zero-copy: each chunk is `Buffer.from(sab, offset, chunkSize)`.
- `readBytecode(key)` returns the `data` Buffer from the companion `.cache` entry, or `null`.

## Adapter Rules

- Adapters have no internal path dependencies — they only import Node.js built-ins.
- `fs-patch.js` imports `node:fs`, `node:path`.
- `fs-patch.js` `patchedCreateReadStream` delegates to `Place.createReadStream()` for
  chunked SAB streaming with range support.
- `require-hook.js` imports `node:module`, `node:path`, `node:vm`.
- `require-hook.js` patches both `Module._resolveFilename` and `Module.prototype._compile`.
  If `place.readBytecode(key)` returns a Buffer, `_compile` wraps the source via
  `Module.wrap()`, creates `vm.Script({ cachedData })`, and runs it. Falls back to
  original `_compile` if `cachedDataRejected` or on error.
- `import-hook.mjs` imports `node:url`, `node:path`, reads kernel from `process[Symbol.for('shared-memory-fs')]`.
- Each adapter exposes `install(kernel)` and `uninstall()`.

## Public API

- `VFSKernel` is the primary consumer-facing class.
- `FilesystemCache` and scanner are exported for advanced consumers but their internal
  APIs are not part of the public contract.
- Keep placements configurable.

## Required Behavior

- Do not reintroduce per-worker file copies.
- Do not break `snapshot()`, delta broadcasting, ACK flow, or disk fallback semantics.
- Keep Place `files` consumer-visible behavior unchanged across refactors.
- Keep `handleWorkerExit()` removing the dead worker from all pending ACK sets.
- Keep `close()` releasing the watcher and clearing state.

## Bytecode Cache Rules

- V8 bytecode caching is opt-in per place via `compile: true` in place config.
- `compile: true` automatically adds `'require'` to `domains` if missing — prevents
  silent misconfiguration where bytecode is generated but never applied.
- `compile` is a main-thread-only flag. `fromSnapshot()` ignores it — workers never
  compile, they only consume projected bytecode from snapshot/delta.
- Main thread compiles JS files via `vm.Script` + `Module.wrap()` + `createCachedData()`.
- Bytecode is stored as companion SAB entries: source at `key`, bytecode at `key + '.cache'`.
- `compileModules()` is called by `initialize()` after projection; it rebuilds projection
  and updates place `files` Maps to include companion entries.
- Companion `.cache` keys are excluded from `pathIndex` (no fs dispatch for `.cache`).
- `#isCompilable(placementName, key)` checks `place.config.compile === true` and
  `fileExt(key) === 'js'`.
- Watch `#processChange`: after allocating updated source, reads source directly from
  `cache.getSegment(entry.segmentId).sab` (not via `segmentsMap`, which isn't updated yet),
  compiles bytecode, allocates companion entry, adds to epoch updates.
- Watch `#processDelete`: removes companion `.cache` entry alongside source entry.
- `snapshot()` naturally includes companion entries — workers receive bytecode via
  `fromSnapshot()` and `handleDelta()`.
- Bytecode is invalidated only by source change (recompile) or Node.js version change
  (restart). Within a single process run, `cachedDataRejected` never occurs.

## Tests And Docs

- Update tests when changing allocator, projection, ACK flow, watch batching, or
  placement behavior.
- Keep `doc/` documentation aligned with this branch implementation.
- If architecture changes in this branch, update this file in the same change.
