# shared-memory-fs — Integration Guide

## Overview

`shared-memory-fs` caches files in SharedArrayBuffer segments shared across
Node.js worker_threads. Main thread scans directories, loads files into SAB,
and broadcasts deltas. Workers project SAB segments into zero-copy Buffer
views. No file copies per worker.

## Architecture

```
Main thread                          Worker threads
┌─────────────────────┐              ┌─────────────────────┐
│ VFSKernel (full)    │  snapshot()  │ VFSKernel (worker)   │
│ ├─ FilesystemCache  │ ──────────► │ ├─ projected Maps    │
│ ├─ scanner          │  workerData │ ├─ registry + policy │
│ ├─ watcher          │              │ └─ handleDelta()    │
│ ├─ ACK tracking     │  broadcast  │                      │
│ └─ broadcast()      │ ──────────► │ handleDelta(msg)     │
│                     │  ◄───────── │ postMessage(ack)     │
└─────────────────────┘              └─────────────────────┘
```

## Quick Start

### 1. Install

```
npm install shared-memory-fs
```

### 2. Config

```js
const { VfsConfig } = require('shared-memory-fs');

const config = new VfsConfig({
  defaults: {
    memory: {
      limit: '1 gib',           // total SAB limit
      segment: '64 mib',        // base segment size
      maxFileSize: '10 mb',     // files > this go to disk fallback
    },
    hooks: { fs: false, require: false, import: false },
    watchTimeout: 1000,
  },
  places: {
    static: {
      domains: ['fs'],
      match: { dir: 'static' }, // maps to <appRoot>/static/
      provider: 'sab',
      ext: ['html', 'css', 'js', 'png', 'jpg', 'svg', 'woff2'],
    },
    resources: {
      domains: ['fs'],
      match: { dir: 'resources' },
      provider: 'sab',
      ext: ['json', 'yaml', 'csv'],
    },
  },
});
```

### 3. Main thread

```js
const { VFSKernel, VfsConfig } = require('shared-memory-fs');
const { Worker } = require('node:worker_threads');

const config = new VfsConfig({ /* ... */ });
const threads = new Map();

const kernel = new VFSKernel(config, {
  appRoot: process.cwd(),
  broadcast: (data) => {
    for (const thread of threads.values()) thread.postMessage(data);
  },
  getWorkerIds: () => threads.keys(),
});

await kernel.initialize();   // scan dirs, load files into SAB
kernel.watch();              // start watching for file changes

// Spawn workers
const snapshot = kernel.snapshot();
for (let i = 0; i < 4; i++) {
  const worker = new Worker('./worker.js', {
    workerData: { sharedCache: snapshot, /* ...other data */ },
  });
  const id = worker.threadId;
  threads.set(id, worker);

  worker.on('message', (msg) => {
    if (msg.name === 'ack-update') kernel.handleAck(msg.updateId, id);
  });
  worker.on('exit', () => {
    kernel.handleWorkerExit(id);
    threads.delete(id);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  kernel.close();
});
```

### 4. Worker thread

```js
const { VFSKernel, VfsConfig, FilesystemCache } = require('shared-memory-fs');
const { parentPort, workerData } = require('node:worker_threads');

// Reconstruct worker-side kernel from snapshot
const config = new VfsConfig({ /* same config as main */ });
const kernel = VFSKernel.fromSnapshot(workerData.sharedCache, config, {
  appRoot: process.cwd(),
});

// Access cached files
const place = kernel.getPlace('static');
const html = place.readFile('/index.html');     // Buffer (zero-copy SAB view)
const stat = place.stat('/index.html');          // { size, mtime, ... }
const exists = place.exists('/style.css');       // boolean
const keys = place.list('/');                    // ['/index.html', ...]

// Handle live updates from main thread
parentPort.on('message', (msg) => {
  if (msg.name === 'file-update' || msg.name === 'file-delete') {
    kernel.handleDelta(msg);
    parentPort.postMessage({ name: 'ack-update', updateId: msg.updateId });
  }
});
```

## API Reference

### VfsConfig

```js
new VfsConfig(raw)
```

Config cascade: hardcoded defaults → `raw.defaults` → per-place. Frozen after
construction. Options:

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `defaults.memory.limit` | string/number | `'1 gib'` | Total SAB memory limit |
| `defaults.memory.segment` | string/number | `'64 mib'` | Base segment size |
| `defaults.memory.maxFileSize` | string/number | `'10 mb'` | Max file size for SAB (larger → disk) |
| `defaults.gc.enabled` | boolean | `true` | Enable GC/compaction |
| `defaults.gc.threshold` | number | `0.3` | Compaction utilization threshold |
| `defaults.hooks.fs` | boolean | `true` | Patch node:fs |
| `defaults.hooks.require` | boolean | `true` | Patch Module._resolveFilename |
| `defaults.hooks.import` | boolean | `true` | Register ESM loader |
| `defaults.hooks.diagnostics` | boolean | `false` | Log route decisions |
| `defaults.policy.allowWrite` | boolean | `false` | Allow write operations |
| `defaults.mode` | string | `'overlay'` | `'overlay'` or `'strict'` |
| `defaults.watchTimeout` | number | `1000` | Watcher debounce ms |

**Place config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `domains` | string[] | `[]` | `'fs'`, `'require'`, `'import'` |
| `match` | object | — | `{ dir: 'name' }`, `{ prefix: '/path' }`, or `{ any: true }` |
| `provider` | string | `'sab'` | `'sab'`, `'disk'`, `'node-default'`, `'sab-write'` |
| `ext` | string[]|null | `null` | File extensions without dots: `['html', 'css']` |
| `readonly` | boolean | `true` | Readonly enforcement |
| `writeNamespace` | string|null | `null` | Required if `readonly: false` |

```js
VfsConfig.fromArgv(argv, appConfig)
```

Parse `--vfs.*` CLI flags after `--` separator and merge with app config.
Supports: `--vfs.defaults.memory.limit=512mib`, `--vfs.hooks.fs=false`,
`--vfs.enable=static,api`, `--vfs.disable=resources`.

### VFSKernel — Main thread

```js
new VFSKernel(config, options)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appRoot` | string | `process.cwd()` | Root directory for place resolution |
| `console` | object | `globalThis.console` | Logger instance |
| `broadcast` | function | no-op | `(data) => {}` — send to all workers |
| `getWorkerIds` | function | `() => []` | Returns iterable of active worker IDs |

**Methods:**

| Method | Description |
|--------|-------------|
| `await initialize()` | Scan directories, load files into SAB |
| `snapshot()` | Returns `{ segments, filesystems }` for workerData |
| `watch()` | Start DirectoryWatcher, broadcast deltas on file changes |
| `handleAck(updateId, workerId)` | Worker acknowledged update, free old entries when all ACK'd |
| `handleWorkerExit(workerId)` | Remove dead worker from all pending ACK sets |
| `close()` | Stop watcher, clear all state |
| `getPlace(name)` | Get Place by name |
| `getPlaces()` | Get all registered places |
| `resolveFsPath(filePath)` | Resolve absolute path → `{ place, key, fileKey }` or null |
| `dispatchFsRead(op, filePath)` | Resolve + policy check for read |
| `dispatchFsWrite(op, filePath)` | Resolve + policy check for write |
| `dispatchModuleResolve(specifier, parentPath)` | CJS require resolution |
| `dispatchModuleLoad(specifier, parentPath)` | ESM import resolution |

### VFSKernel — Worker thread

```js
VFSKernel.fromSnapshot(snapshot, config, options)
```

Creates a read-only worker-side kernel from a main-thread snapshot. No cache,
no watcher, no ACK tracking. Places are registered with projected files.

| Parameter | Type | Description |
|-----------|------|-------------|
| `snapshot` | object | From `kernel.snapshot()` on main thread |
| `config` | VfsConfig | Same config as main thread |
| `options` | object | Same as constructor (appRoot, console) |

```js
kernel.handleDelta(msg)
```

Apply a `file-update` or `file-delete` message from the main thread.
Incrementally updates projected files and sealIndex (if sealed).

| Field | Type | Description |
|-------|------|-------------|
| `msg.name` | string | `'file-update'` or `'file-delete'` |
| `msg.target` | string | Placement name (e.g. `'static'`) |
| `msg.updateId` | number | Monotonic update ID for ACK |
| `msg.updates` | Array | `[[key, entry], ...]` (file-update only) |
| `msg.newSegments` | Array | `[{id, sab}, ...]` (file-update only) |
| `msg.keys` | Array | `[key, ...]` (file-delete only) |

### Place

```js
const place = kernel.getPlace('static');
```

| Method | Returns | Description |
|--------|---------|-------------|
| `readFile(key)` | Buffer\|null | SAB zero-copy view, or null for disk/missing |
| `stat(key)` | object\|null | File stat |
| `exists(key)` | boolean | Key exists in files Map |
| `filePath(key)` | string\|null | Disk path (disk entries only) |
| `list(prefix)` | string[] | Keys matching prefix |
| `createReadStream(key, options)` | Readable\|null | Chunked stream over SAB data (64 KB chunks) |
| `readBytecode(key)` | Buffer\|null | V8 bytecode from companion `.cache` entry |

### FilesystemCache

Low-level SAB allocator. Exported for advanced use (worker-side projection).

```js
FilesystemCache.project(index, segmentsMap)    // → Map<key, {data, stat}>
FilesystemCache.projectEntry(entry, segmentsMap) // → {data, stat} or {data:null, stat, path}
```

## Bootstrap (no code integration)

For apps that don't manage workers directly:

**CJS:** `node --require shared-memory-fs/preload app.js -- --vfs.config=vfs.config.js`
**ESM:** `node --import shared-memory-fs/register app.mjs -- --vfs.config=vfs.config.js`

Bootstrap auto-installs hooks based on config and patches fs/require/import transparently.

## Message Protocol

Main → Worker broadcasts:

```js
// File update
{ name: 'file-update', target: 'static', updateId: 1,
  updates: [['/index.html', { kind:'shared', segmentId:1, offset:0, length:42, stat }]],
  newSegments: [{ id: 1, sab: SharedArrayBuffer }] }

// File delete
{ name: 'file-delete', target: 'static', updateId: 2,
  keys: ['/old.html'] }
```

Worker → Main ACK:

```js
{ name: 'ack-update', updateId: 1 }
```

## Streaming

`Place.createReadStream(key, options)` returns a chunked `Readable` that streams
SAB data in 64 KB chunks. Each chunk is a zero-copy `Buffer.from(sab, offset, size)` —
no memory allocation per chunk.

Returns `null` for disk entries or unknown keys. For disk entries, fall back to
`fs.createReadStream(place.filePath(key))`.

### Basic usage

```js
const place = kernel.getPlace('static');
const stream = place.createReadStream('/video.mp4');
if (stream) {
  stream.pipe(res);
} else {
  // Disk fallback
  const diskPath = place.filePath('/video.mp4');
  if (diskPath) fs.createReadStream(diskPath).pipe(res);
}
```

### HTTP Range requests (206 Partial Content)

```js
const stat = place.stat(key);
const total = stat.size;

// Parse Range header: "bytes=1024-2047"
const [start, end] = parseRange(req.headers.range, total);

const stream = place.createReadStream(key, { start, end });
res.writeHead(206, {
  'Content-Range': `bytes ${start}-${end}/${total}`,
  'Content-Length': end - start + 1,
  'Accept-Ranges': 'bytes',
});
stream.pipe(res);
```

### Large file threshold

For small files (e.g. < 64 KB) streaming adds overhead vs a single `readFile()`.
Use a threshold to decide:

```js
const STREAM_THRESHOLD = 65536;
const data = place.readFile(key);
if (data && data.byteLength > STREAM_THRESHOLD) {
  place.createReadStream(key).pipe(res);
} else if (data) {
  res.end(data);
}
```

### Migration from custom SAB streaming

If you have a custom `createSABStream()` helper that manually walks
`data.buffer` / `data.byteOffset` in chunks — replace it with
`place.createReadStream(key, options)`. The library implementation handles
SAB offset math, chunk sizing, and range support identically.

For `fs.createReadStream` patches: the `fs-patch` adapter already delegates
to `Place.createReadStream()` for SAB-backed files, so patched code gets
chunked streaming automatically.

## V8 Bytecode Caching

Main thread compiles JS files via `vm.Script` + `Module.wrap()` +
`createCachedData()`, stores bytecode in SAB as companion entries alongside
source. Workers receive bytecode via snapshot and skip V8 parse + compile
for all functions (including lazy ones).

### Enabling

Add `compile: true` to place configs that contain `require()`-able JS modules.
`compile: true` automatically adds `'require'` to `domains` if not already
present — no need to specify it manually:

```js
const config = new VfsConfig({
  places: {
    api: {
      domains: ['fs'],         // 'require' added automatically
      match: { dir: 'api' },
      provider: 'sab',
      ext: ['js'],
      compile: true,
    },
    lib: {
      domains: ['fs'],         // 'require' added automatically
      match: { dir: 'lib' },
      provider: 'sab',
      ext: ['js'],
      compile: true,
    },
    static: {
      domains: ['fs'],
      match: { dir: 'static' },
      provider: 'sab',
      ext: ['html', 'css', 'png'],
      // No compile — static assets are not require()'d
    },
  },
});
```

No code changes needed — `initialize()` calls `compileModules()` automatically,
snapshot includes bytecode, and `require-hook` uses it transparently.

> **Note:** `compile` is a main-thread-only flag. `fromSnapshot()` ignores it —
> workers never compile, they only consume projected bytecode from snapshot/delta.

### How it works

```
initialize()
  → scan dirs, load source into SAB
  → compileModules()
      → for each .js in places with compile: true:
          Module.wrap(source) → vm.Script → createCachedData()
          → bytecode stored as /key.js.cache in same SAB
  → snapshot includes source + bytecode

Worker (fromSnapshot):
  place.readFile('/handler.js')      → Buffer (source, zero-copy)
  place.readBytecode('/handler.js')  → Buffer (bytecode, zero-copy)

require('./handler.js'):
  _resolveFilename  → resolves via VFS
  fs.readFileSync   → returns source from SAB (fs-patch)
  _compile          → vm.Script(wrapped, { cachedData: bytecode })
                    → cachedDataRejected === false
                    → V8 skips parse + compile for ALL functions
```

### Storage model

Bytecode is stored as companion entries in the same SAB segments:

| Key | Content | Typical size |
|-----|---------|--------------|
| `/handler.js` | Source code | N bytes |
| `/handler.js.cache` | V8 bytecode | 2–5× N bytes |

Companion `.cache` keys are excluded from `pathIndex` — they don't appear in
`resolveFsPath()` and are invisible to `fs.*` patches.

### Watch / live reload

When a `.js` file changes in a compilable place, the watcher:
1. Allocates updated source in SAB
2. Recompiles bytecode from the new source
3. Broadcasts both source and bytecode entries in the same delta
4. Workers receive updated bytecode via `handleDelta()`

When a `.js` file is deleted, the companion `.cache` entry is removed
automatically.

### Manual bytecode access

For custom module loaders or advanced use cases:

```js
const place = kernel.getPlace('api');
const source = place.readFile('/handler.js');      // Buffer
const bytecode = place.readBytecode('/handler.js'); // Buffer or null

if (bytecode) {
  const wrapped = Module.wrap(source.toString('utf8'));
  const script = new vm.Script(wrapped, {
    filename: '/handler.js',
    cachedData: bytecode,
  });
  // script.cachedDataRejected === false (same Node.js version)
}
```

### When bytecode is invalidated

- **Source changed** → watcher recompiles automatically
- **Node.js version changed** → `cachedDataRejected === true` on next run;
  `require-hook` falls back to original `_compile`. Restart regenerates
  fresh bytecode matching the new V8 version
- **Within a single process run** → `cachedDataRejected` never occurs

## Key Invariants

- **Workers never write SAB** — all writes happen on main thread
- **ACK-before-free** — old entries freed only after all workers ACK
- **Segments never returned to OS** — empty segments recycled via `emptySegmentIds`
- **Zero-copy projection** — `Buffer.from(sab, offset, length)` creates a view, not a copy
- **Config frozen** — no runtime mutation after construction
- **Extensions without dots** — `['html', 'css']` not `['.html', '.css']`
- **Keys start with /** — forward slashes on all platforms: `/sub/file.js`

## Integration Checklist

- [ ] Create VfsConfig with places matching your directory structure
- [ ] Main thread: `new VFSKernel(config, { broadcast, getWorkerIds })`
- [ ] Main thread: `await kernel.initialize()` before spawning workers
- [ ] Main thread: pass `kernel.snapshot()` via workerData
- [ ] Main thread: call `kernel.watch()` after all workers started
- [ ] Main thread: handle `ack-update` messages → `kernel.handleAck()`
- [ ] Main thread: handle worker exit → `kernel.handleWorkerExit()`
- [ ] Main thread: `kernel.close()` on shutdown
- [ ] Worker: `VFSKernel.fromSnapshot(snapshot, config, { appRoot })`
- [ ] Worker: handle `file-update`/`file-delete` → `kernel.handleDelta(msg)`
- [ ] Worker: send `{ name: 'ack-update', updateId }` after handleDelta
- [ ] Optional: add `compile: true` to JS places for V8 bytecode caching

## Design Decisions

### Why SharedArrayBuffer, not MemoryProvider

`node:vfs` / `@platformatic/vfs` use a `MemoryProvider` — each VFS instance
holds its own in-memory file tree. When you spawn workers, each one gets a
separate copy of the data (or re-reads it). `shared-memory-fs` uses
`SharedArrayBuffer` as the single backing store. Files are loaded once on the
main thread; workers get zero-copy `Buffer` views over the same memory.
No per-worker duplication, no serialization, no IPC for file reads.

### Why pooled segments, not per-file SABs

Creating a `SharedArrayBuffer` per file would exhaust OS resources quickly
(each SAB is an mmap region). Instead, files are packed into large pooled
segments (default 64 MiB). A segment registry handles allocation, free-extent
tracking, and best-fit reuse. Empty segments are recycled, never returned to
the OS.

### Why companion entries, not extended entry format

V8 bytecode could be stored as a second region inside each entry
(`{ sourceOffset, sourceLength, bytecodeOffset, bytecodeLength }`). Instead,
bytecode lives as a separate companion entry (`/handler.js.cache` alongside
`/handler.js`). This keeps the allocator simple — every entry is one
contiguous SAB region — and companion entries flow through snapshot, delta,
and ACK without any special handling.

### Why main-thread compilation

Workers never compile. The main thread runs `vm.Script` + `createCachedData()`
once during `initialize()`. Bytecode is stored in SAB and projected to workers
via snapshot. This avoids duplicate compilation across N workers and keeps
workers read-only with respect to SAB.

## Comparison with `node:vfs` / `@platformatic/vfs`

Both projects solve "virtual filesystem for Node.js" but at different layers
and with different trade-offs.

| | `shared-memory-fs` | `node:vfs` / `@platformatic/vfs` |
|---|---|---|
| **Storage** | SharedArrayBuffer (shared across threads) | Per-instance in-memory tree (MemoryProvider) |
| **Worker data sharing** | Zero-copy — workers read same SAB | Each worker gets its own VFS instance or serialized copy |
| **Memory per worker** | O(1) — Buffer views only | O(N) — full copy per worker |
| **V8 bytecode cache** | Built-in — `compile: true`, bytecode in SAB, workers skip parse+compile | Not available |
| **Chunked streaming** | `Place.createReadStream()` — 64 KB zero-copy chunks from SAB | Standard `fs.createReadStream` over virtual tree |
| **Live reload** | Watcher → epoch batching → delta broadcast → ACK-before-free | `writeFileSync` + re-mount |
| **Module loading** | Patches `_resolveFilename` + `_compile` (with bytecode) | Full module resolution re-implementation (960+ lines) |
| **fs coverage** | Targeted: readFile, stat, exists, realpath, createReadStream | Full fs API (sync, callback, promises, streams, dirs, symlinks, glob) |
| **Scope** | Server framework cache (impress worker_threads) | General-purpose VFS (SEA, testing, sandboxing, AI agents) |
| **Write support** | Read-only SAB + optional write namespaces | Full read-write |
| **Persistence** | In-memory only (process lifetime) | SqliteProvider for cross-restart persistence |
| **Path model** | Place-based namespaces (`match: { dir }`) | Mount points (`vfs.mount('/virtual')`) |
| **Core integration** | Userland, hooks into Module + fs | PR to land as `node:vfs` in core |

### Key improvements over `node:vfs` for the worker_threads use case

**Zero-copy across workers.** `node:vfs` MemoryProvider stores file content in
JS strings/Buffers that must be copied to each worker. `shared-memory-fs` uses
SAB — all workers share the same physical memory. For 100 MB of cached files
and 8 workers, that's ~800 MB saved.

**V8 bytecode caching.** `node:vfs` loads source and V8 parses + compiles it
in every worker. `shared-memory-fs` compiles once on main thread, stores
bytecode in SAB, and workers load pre-compiled code via `cachedData`. This
eliminates parse + compile time for all functions (including lazy ones) across
all workers.

**Safe live updates.** File changes in `node:vfs` require manual
`writeFileSync` + potential re-mount. `shared-memory-fs` watches the real
filesystem, batches changes into epochs, broadcasts deltas, and uses
ACK-before-free to ensure no worker reads freed memory. Workers get live
updates without restart.

**Chunked SAB streaming.** `Place.createReadStream()` produces 64 KB chunks
directly from SAB via `Buffer.from(sab, offset, chunkSize)` — zero allocation
per chunk. Supports HTTP Range requests. `node:vfs` streams through its virtual
tree, which involves standard Buffer allocation.

### When to use `node:vfs` instead

- You need full `fs` API coverage (dirs, symlinks, glob, write, fd)
- You need mount-point semantics visible to all code in the process
- You need SEA asset integration
- You need cross-restart persistence (SqliteProvider)
- You're not using worker_threads or don't need shared memory
