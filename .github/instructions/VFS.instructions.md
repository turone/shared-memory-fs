---
name: 'VFS Architecture'
branch: main
description: 'Use when modifying VFS kernel, SAB cache, scanner, config, places, adapters, bootstrap, or tests.'
applyTo: lib/**, index.js, test/**, doc/**
---

# VFS Architecture

`shared-memory-fs` — pooled SharedArrayBuffer virtual filesystem for Node.js
worker_threads, plus optional fs / require / import hooks.

## Module Map

```
lib/cache.js              Pool + SegmentRegistry + FilesystemCache (SAB allocator).
                          No Node.js or external deps. Reader injected from kernel.
lib/scanner.js            scan(rootPath, {ext, startPath}) → {files, dirs}; getKey().
lib/config.js             VfsConfig: defaults → app → per-place → CLI; deep-frozen.
lib/place.js              Place: logical namespace; live `files` Map updated by kernel.
lib/registry.js           PlacementRegistry + helpers mountOf / absPathOf.
                          Domain+path → place; mount → place; routeByMount(absPath).
lib/kernel.js             VFSKernel: facade + orchestrator. Owns cache, projection,
                          watcher, ACK tracking, bytecode compilation.
lib/adapters/*            fs-patch.js, require-hook.js, import-hook.mjs.
                          Each exposes install(kernel) / uninstall().
lib/bootstrap/*           preload.cjs (--require), register.mjs (--import).
lib/providers/*           [planned] memory.js (per-thread writable), sea.js (SEA assets).
index.js                  Public API: FilesystemCache, VfsConfig, Place, VFSKernel.
```

## Naming

See `/memories/naming.md`. No tautological identifiers (no `place.placement`,
`placementToPlace`, etc.). Prefer one source of truth and short field names.

## Invariants (must hold)

- **Zero-copy reads**: workers receive `Buffer.from(sab, offset, length)` views,
  never per-worker copies of file data.
- **Frozen config**: VfsConfig is deep-frozen after construction; no runtime mutation.
- **ACK-before-free**: shared entries replaced/deleted by the main thread are freed
  only after every live worker ACKs the corresponding `updateId`, or after a worker
  exits and `handleWorkerExit()` removes it from pending sets.
- **Segments stay**: empty segments are kept in `Pool.emptySegmentIds` for reuse,
  never returned to the OS.
- **Single segment type**: only `baseSegmentSize`-sized segments. Files larger than
  `maxFileSize` always become disk entries.
- **No collateral mutation during iteration**: `handleWorkerExit()` collects
  updateIds first, then frees outside the loop.
- **One source of truth per concept**: a place's mount lives in `place.config.match`;
  derive everything else through `mountOf(place)` / `absPathOf()` / `registry.byMount`.

## Cache (lib/cache.js)

- Self-contained, no Node.js built-in or external deps.
- `baseSegmentSize = ceil(maxFileSize / configured) * configured`.
- `load()` sorts files by descending size before allocating (pack large first).
- `SegmentRegistry.allocate()` order: best-fit free extent → tail of partial segment
  → new segment → null (caller decides disk fallback).
- Entries are internal records; do not leak shape to consumers — use Place API.
- `compact(threshold)` may legitimately return null. Threshold is supplied by caller.

## Kernel (lib/kernel.js)

- Consumer-facing class. Construct with frozen `VfsConfig`, then `await initialize()`.
- Injects a Node.js reader using `fs.open()` + `fh.read()` into a Buffer view over SAB.
- Watcher uses metawatch `before` / `change` / `delete` / `after` epoch events.
- Watch routing goes through `registry.routeByMount(absPath)` — no duplicate logic.
- `#processChange(ep, ...)` receives the epoch by reference; never close over a mutable
  `epoch` variable from async code.
- `#flushEpoch()` emits at most one `file-update` and one `file-delete` per mount per
  epoch. Old entries are tracked against the last `updateId` of the epoch.
- No timeout-based forced free.
- `#trackUpdate()` frees immediately when no workers are registered.
- `#tryCompact()` runs after freeing entries; tracks `oldEntries` only against the
  last `updateId` of the compaction batch.
- `#broadcast()` isolates projection errors from consumer-callback errors via
  separate try/catch.
- `pathIndex` (`absPath → {place, key, fileKey}`) is built automatically by
  `initialize()` and `fromSnapshot()`. No manual seal step. Companion `.cache` keys
  are excluded.
- Projection is incremental: built once on init via `#projectMount()`, mutated
  thereafter via `#projectInto()` / `#applyUpdate()` / `#applyDelete()`. No full
  rebuild after compile.
- `close()` stops the watcher and clears all internal maps.

### Worker side

- `VFSKernel.fromSnapshot(snapshot, config, options)` returns a read-only kernel:
  no cache, no watcher, no ACK tracking. Builds segmentsMap, projects filesystems,
  registers places, builds pathIndex.
- `handleDelta(msg)` applies `file-update` / `file-delete` incrementally
  (segments, projected files, pathIndex).
- Workers send `{ name: 'ack-update', updateId }` after each delta.

## Config (lib/config.js)

- Cascade: hardcoded `DEFAULTS` → `raw.defaults` → per-place → CLI overrides.
- Sizes parsed by `metautil.sizeToBytes()` (binary and decimal units).
- `fromArgv()` uses a `SKIP` sentinel to avoid double construction.
- `compile: true` auto-adds `'require'` to `domains`. Main-thread-only flag —
  workers ignore it.
- Validation: domain, provider, match-type, dir/prefix overlap.

Live config keys (Phase 1 baseline; Phases 3+ may extend):

```
defaults.memory.{limit, segmentSize, maxFileSize}
defaults.compaction.threshold
defaults.hooks.{fs, require, import}
defaults.watchTimeout
places.<name>.{enabled, domains, match, provider, ext, maxFileSize, compile}
```

Removed in Phase 1 (do not reintroduce without a real consumer):
`mode`, `gc.*`, `policy.*`, `readonly`, `writeNamespace`, `sab-write`, `hooks.diagnostics`.

## Place (lib/place.js)

- Constructor `(name, config)`. No provider parameter.
- `files` is a live Map set by VFSKernel.
- Read methods return `Buffer | null`, `stat | null`, `boolean`, `string | null`,
  `string[]`, `Readable | null`.
- `createReadStream(key, {start, end})` streams SAB data in 64 KB zero-copy chunks
  (each chunk is `Buffer.from(sab, offset, chunkSize)`). Returns `null` for disk
  entries or unknown keys.
- Bytecode read: `place.getCachedData(key)` returns the companion `.cache` entry
  buffer or null. Exact public name may evolve in Phase 2.

## Adapters

- Adapters use `kernel.resolveFsPath(absPath)` for fs routing and
  `kernel.dispatchModuleResolve / dispatchModuleLoad` for module routing.
- `fs-patch.js` — patches read APIs; passthrough when `resolveFsPath` returns null
  or the entry is disk-backed (`data === null`). Writable APIs not yet implemented.
- `require-hook.js` — patches `Module._resolveFilename` and
  `Module.prototype._compile`. When `place.getCachedData(key)` returns a buffer,
  uses `vm.Script({ cachedData })` and falls back to original `_compile` on
  rejection or error.
- `import-hook.mjs` — `resolve` shortcuts to a `vfs:` URL when VFS owns the file;
  `load` returns source for `vfs:` URLs.
- Each adapter exports `install(kernel) / uninstall()` and stores the kernel in
  module scope.

## Bootstrap

- `preload.cjs` (--require): synchronous; creates kernel, installs CJS hooks, does
  NOT call `initialize()`. Consumer must initialize before spawning workers.
- `register.mjs` (--import): top-level await; creates, initializes, installs all
  hooks, logs ready count.

## Required Behavior (do not break)

- No per-worker file copies.
- No mutation of frozen config at runtime.
- `snapshot()`, delta broadcasting, ACK flow, disk fallback semantics.
- `handleWorkerExit()` removes the dead worker from all pending ACK sets.
- `close()` releases watcher and clears state.

## Tests And Docs

- Update tests in the same change as allocator / projection / ACK / watch / placement
  changes.
- Keep `doc/` and `README.md` aligned with current branch.
- Update this file when a stated invariant or a module's responsibilities change.
- Do not document implementation details that are likely to drift; describe
  contracts and invariants.
