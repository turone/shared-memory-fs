---
name: "SAB Limit Cache Architecture"
branch: main
description: "Use when modifying the pooled SharedArrayBuffer cache: FilesystemCache, PlacementSource, SharedCache, allocation, compaction, ACK handling, delta broadcasting, tests, or shared-cache documentation."
applyTo: lib/**, index.js, test/**, doc/**
---

# SAB Limit Cache Architecture

This file contains the branch-specific architecture for the `main` implementation
of shared-memory-fs using a pooled SharedArrayBuffer with a configurable size limit.
When this file conflicts with older docs or top-level instructions, current branch
code and this file win.

## Current Scope

- `lib/FilesystemCache.js` — pooled SAB segment allocator. Self-contained, no Node.js
  built-in or external dependencies.
- `lib/PlacementSource.js` — directory scanning and filesystem watching per named placement.
- `lib/SharedCache.js` — orchestration: config parsing, placement lifecycle, watcher setup,
  delta broadcasting to workers, ACK-based compaction.
- `index.js` — public API surface; re-exports all three modules.

## FilesystemCache Rules

- `FilesystemCache` is self-contained and has no Node.js built-in or external dependencies.
- There is only one segment type: base segments.
- There are no oversize dedicated segments.
- `Pool` retains empty segments in `cleanSegmentIds` and reuses them; segments are not
  returned to the OS.
- `baseSegmentSize = Math.ceil(maxFileSize / configured) * configured`.
- `limit` should be evenly divisible by the effective `baseSegmentSize`; otherwise the
  remainder is wasted.
- `load()` sorts candidates by descending size before allocation.
- `Registry.allocate()` does: best-fit free extent, then tail append, then new segment,
  else disk fallback.
- Shared entries are internal metadata objects: `{ kind: 'shared', segmentId, offset, length, stat }`.
- Disk entries are internal metadata objects: `{ kind: 'disk', path, stat, data: null }`.
- `size > maxFileSize` always means disk entry.

## Projection Rules

- Worker-side projection is eager, not lazy.
- `FilesystemCache.projectEntry()` creates `Buffer.from(segmentsMap.get(segmentId), offset, length)`
  once at projection time.
- Public shared files exposed through `this.files` are `{ data, stat }`.
- Disk-backed files exposed through `this.files` are `{ data: null, stat, path }`.
- Buffer views are lightweight descriptors over SAB and are garbage-collected when
  projected file objects are removed.

## SharedCache Rules

- `SharedCache` parses `limit`, `baseSegmentSize`, and `maxFileSize` via `sizeToBytes()`
  and supports both binary and decimal units.
- Placements come from constructor options and default to `static` and `resources`.
- `SharedCache` injects a Node.js reader using `fs.open()` and `fh.read()` into a
  Buffer view over SAB.
- `watch()` uses metawatch `before` / `change` / `delete` / `after` events to build an epoch.
- Placement routing in `watch()` is based on the first segment of the path relative to
  the monitored directory root, not on absolute-path prefix matching.
- `processChange(ep, ...)` must receive the epoch explicitly; do not close over the
  mutable `epoch` variable from async code.
- `#flushEpoch()` emits at most one `file-update` and one `file-delete` per placement per epoch.
- Old entries are tracked against the last `updateId` produced in the epoch.
- There is no timeout-based forced free in this branch.
- Old entries are freed only after all workers ACK or after `handleWorkerExit(workerId)`
  removes a dead worker from pending sets.
- `#tryCompact()` runs after freeing entries.
- `#tryCompact()` is batch-first: it may broadcast one `file-update` per placement, but
  tracks `oldEntries` only once against the last `updateId` of the compaction batch.
- `compact()` may legitimately return `null`; this is not an error.

## PlacementSource Rules

- `PlacementSource` stores only `{ stat, path }` during scanning; data is read into SAB
  by the reader injected from `SharedCache`.
- Path normalization produces forward-slash keys on all platforms (including Windows).
- `getKey()` must continue to return forward-slash keys for Windows paths.

## Public API

- `SharedCache` is the primary consumer-facing class. Consumers instantiate it and call
  `initialize()`, `snapshot()`, `handleWorkerAck()`, and `handleWorkerExit()`.
- `FilesystemCache` and `PlacementSource` are exported for advanced consumers but their
  internal APIs are not part of the public contract.
- Do not add Node.js built-in dependencies to `FilesystemCache.js`.
- Keep placements configurable.

## Required Behavior

- Do not reintroduce per-worker file copies.
- Do not break `snapshot()`, delta broadcasting, ACK flow, or disk fallback semantics.
- Keep `this.files` consumer-visible behavior unchanged across refactors.
- Keep `handleWorkerExit()` removing the dead worker from all pending ACK sets.

## Tests And Docs

- Update tests when changing allocator, projection, ACK flow, watch batching, or
  placement behavior.
- Keep `doc/` documentation aligned with this branch implementation.
- If architecture changes in this branch, update this file in the same change.
