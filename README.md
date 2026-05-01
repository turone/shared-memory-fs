# shared-memory-fs

SharedArrayBuffer-backed virtual filesystem for Node.js worker_threads.

Files are loaded once on the main thread into pooled SAB segments. Workers get
zero-copy `Buffer` views over the same memory — no per-worker copies, no
serialization, no IPC for reads. Optional V8 bytecode cache compiles JS once
and stores bytecode in SAB so workers skip parse + compile entirely.

## Features

- **Zero-copy sharing across workers** — `Buffer.from(sab, offset, length)`
  views, not copies.
- **Pooled segments** — files packed into 64 MiB SAB segments with best-fit
  allocation; segments recycled, never returned to OS.
- **V8 bytecode cache** — `compile: true` per place, bytecode stored in SAB
  next to source, workers skip V8 parse + compile (including lazy functions).
- **Live reload** — watcher batches changes into epochs, broadcasts deltas,
  ACK-before-free guarantees no worker reads freed memory.
- **Four providers** — `sab` (read-only shared cache), `memory` (per-thread
  writable), `sea` (assets from a Single Executable Application),
  `node-default` (passthrough).
- **Strict sandbox mode** — deny disk reads under `appRoot` not owned by any
  place; safe for AI agents, plugins, untrusted scripts.
- **Transparent hooks** — patches `node:fs`, `Module._resolveFilename`/
  `_compile`, and the ESM loader. No app code changes required.
- **Chunked streaming** — `Place.createReadStream()` streams 64 KB zero-copy
  chunks from SAB, with HTTP Range support.

## Install

```
npm install shared-memory-fs
```

Requires Node.js ≥ 20.6.

## Quick start

### Main thread

```js
const { VFSKernel, VfsConfig } = require('shared-memory-fs');
const { Worker } = require('node:worker_threads');

const config = new VfsConfig({
  defaults: {
    memory: { limit: '1 gib', segmentSize: '64 mib', maxFileSize: '10 mb' },
  },
  places: {
    static: {
      domains: ['fs'],
      match: { dir: 'static' },
      provider: 'sab',
      ext: ['html', 'css', 'js', 'png', 'svg'],
    },
    lib: {
      domains: ['fs'], // 'require' added automatically by compile
      match: { dir: 'lib' },
      provider: 'sab',
      ext: ['js'],
      compile: true, // V8 bytecode cache
    },
    scratch: {
      domains: ['fs'],
      match: { dir: 'scratch' },
      provider: 'memory', // per-thread writable, isolated
    },
  },
});

const threads = new Map();
const kernel = new VFSKernel(config, {
  appRoot: process.cwd(),
  broadcast: (msg) => {
    for (const t of threads.values()) t.postMessage(msg);
  },
  getWorkerIds: () => threads.keys(),
});

await kernel.initialize();
kernel.watch();

const snapshot = kernel.snapshot();
for (let i = 0; i < 4; i++) {
  const w = new Worker('./worker.js', { workerData: { snapshot } });
  threads.set(w.threadId, w);
  w.on('message', (m) => {
    if (m.name === 'ack-update') kernel.handleAck(m.updateId, w.threadId);
  });
  w.on('exit', () => {
    kernel.handleWorkerExit(w.threadId);
    threads.delete(w.threadId);
  });
}
```

### Worker thread

```js
const { VFSKernel, VfsConfig } = require('shared-memory-fs');
const { parentPort, workerData } = require('node:worker_threads');

const config = new VfsConfig({
  /* same shape as main */
});
const kernel = VFSKernel.fromSnapshot(workerData.snapshot, config, {
  appRoot: process.cwd(),
});

const place = kernel.getPlace('static');
const html = place.readFile('/index.html'); // Buffer (zero-copy)
const stat = place.stat('/index.html'); // { size, mtime, ... }
const stream = place.createReadStream('/big.mp4'); // chunked Readable

const lib = kernel.getPlace('lib');
const bytecode = lib.getCachedData('/utils.js'); // V8 bytecode Buffer

const scratch = kernel.getPlace('scratch');
scratch.writeFile('/note.txt', Buffer.from('hello'));
const note = scratch.readFile('/note.txt'); // local to this worker

parentPort.on('message', (m) => {
  if (m.name === 'file-update' || m.name === 'file-delete') {
    kernel.handleDelta(m);
    parentPort.postMessage({ name: 'ack-update', updateId: m.updateId });
  }
});
```

## Providers

| Provider       | Storage                             | Writable | Shared across workers    | Use case                                                                |
| -------------- | ----------------------------------- | -------- | ------------------------ | ----------------------------------------------------------------------- |
| `sab`          | SharedArrayBuffer                   | no       | yes (zero-copy)          | Static assets, modules — the primary use case.                          |
| `memory`       | Per-thread Map                      | yes      | no — isolated per thread | Tests, AI agent sandboxes, scratch space, hot reload of generated code. |
| `sea`          | SAB (loaded from `node:sea` assets) | no       | yes                      | Single-Executable Application bundling.                                 |
| `node-default` | OS filesystem                       | n/a      | n/a                      | Passthrough for paths that should hit real disk.                        |

### Memory provider

Per-thread writable namespace with the same `Place` API as `sab`. Each thread
owns its own empty instance after `fromSnapshot()`. Writes via
`place.writeFile()`/`place.unlink()` or via patched `fs.writeFileSync` are
local to that thread. JS files are auto-compiled to V8 bytecode if the place
has `compile: true`.

```js
places: {
  agent: { domains: ['fs', 'require'], match: { dir: 'agent' },
           provider: 'memory', compile: true },
}

// In any thread:
const agent = kernel.getPlace('agent');
agent.writeFile('/tool.js', Buffer.from('module.exports = () => 42;'));
const tool = require('/abs/path/agent/tool.js'); // bytecode-cached
```

### SEA provider

Loads `node:sea` assets matching `match.dir` into SAB at `initialize()`, then
behaves exactly like a `sab` place — included in `snapshot()`, propagated to
workers zero-copy, no watcher.

```js
places: {
  bundle: { domains: ['fs'], match: { dir: 'public' }, provider: 'sea' },
}
```

A SEA built with `assets: { 'public/index.html': './dist/index.html', ... }`
exposes those assets to the worker pool with zero per-worker copy.

For testing without an actual SEA, inject a compatible module:

```js
new VFSKernel(config, { seaModule: { isSea: () => true,
  getAssetKeys: () => [...], getAsset: (k) => arrayBuffer } });
```

## Strict sandbox mode

```js
new VfsConfig({ defaults: { strict: true }, places: { ... } });
```

When `strict: true`, the patched `fs` raises `EACCES` for any path under
`appRoot` not owned by any place. Memory mounts remain writable. Paths outside
`appRoot` (Node internals, `node_modules` in parent dirs, OS) pass through.

Use cases: untrusted plugins, AI tool execution, multi-tenant workers — give
each tenant its own `memory` place and fail-closed on everything else.

## API

### `VfsConfig`

`new VfsConfig(raw)` — config cascade: hardcoded defaults → `raw.defaults` →
per-place. Frozen after construction.

| `defaults.*`           | Type   | Default    | Description                                         |
| ---------------------- | ------ | ---------- | --------------------------------------------------- |
| `memory.limit`         | size   | `'1 gib'`  | Total SAB pool budget                               |
| `memory.segmentSize`   | size   | `'64 mib'` | Base SAB segment size                               |
| `memory.maxFileSize`   | size   | `'10 mb'`  | Files larger than this are stored as `disk` entries |
| `compaction.threshold` | number | `0.3`      | Compact a segment when free ratio exceeds this      |
| `hooks.fs`             | bool   | `true`     | Patch `node:fs`                                     |
| `hooks.require`        | bool   | `true`     | Patch CJS module resolution                         |
| `hooks.import`         | bool   | `true`     | Register ESM loader                                 |
| `watchTimeout`         | number | `1000`     | Watcher debounce (ms)                               |
| `strict`               | bool   | `false`    | Sandbox mode (see above)                            |

Sizes accept `metautil.sizeToBytes` strings (`'10 mb'`, `'1 gib'`, …) or numbers.

| `places.<name>.*` | Type     | Default         | Description                                                                    |
| ----------------- | -------- | --------------- | ------------------------------------------------------------------------------ |
| `domains`         | string[] | `[]`            | `'fs'`, `'require'`, `'import'`                                                |
| `match`           | object   | `{ any: true }` | Exactly one of `{ dir }`, `{ prefix }`, `{ any: true }`                        |
| `provider`        | string   | `'sab'`         | `'sab'`, `'memory'`, `'sea'`, `'node-default'`, `'disk'`                       |
| `ext`             | string[] | `null`          | Filter by extension (no dots): `['html','css']`                                |
| `extOnExtra`      | string   | `'silent'`      | What to do with files outside `ext` whitelist: `'silent'`, `'warn'`, `'error'` |
| `maxFileSize`     | size     | from defaults   | Per-place override                                                             |
| `compile`         | bool     | `false`         | V8 bytecode cache; auto-adds `'require'` to `domains`                          |
| `enabled`         | bool     | `true`          | Disable a place without removing it                                            |

`VfsConfig.fromArgv(argv, appConfig)` — parse `--vfs.*` CLI flags after `--`
and merge with `appConfig`. Examples:

```
node app.js -- --vfs.defaults.memory.limit=512mib \
               --vfs.defaults.strict=true \
               --vfs.enable=static,lib \
               --vfs.disable=scratch
```

### `VFSKernel` (main thread)

`new VFSKernel(config, options)`

| Option         | Default                            | Description                               |
| -------------- | ---------------------------------- | ----------------------------------------- |
| `appRoot`      | `process.cwd()`                    | Root directory for `match.dir` resolution |
| `console`      | `globalThis.console`               | Logger                                    |
| `broadcast`    | no-op                              | `(msg) => {}` — send to all workers       |
| `getWorkerIds` | `() => []`                         | Iterable of active worker IDs             |
| `seaModule`    | `require('node:sea')` if available | Inject for tests                          |

| Method                           | Description                                                   |
| -------------------------------- | ------------------------------------------------------------- |
| `await initialize()`             | Scan dirs / load SEA / set up memory places, compile bytecode |
| `snapshot()`                     | `{ segments, filesystems }` to pass via `workerData`          |
| `watch()`                        | Start watcher, broadcast deltas                               |
| `handleAck(updateId, workerId)`  | ACK from worker                                               |
| `handleWorkerExit(workerId)`     | Cleanup                                                       |
| `close()`                        | Stop watcher, clear state                                     |
| `getPlace(name)` / `getPlaces()` | Place access                                                  |
| `resolveFsPath(absPath)`         | `{ place, fileKey }` or `null` (read routing)                 |
| `routeWrite(absPath)`            | `{ place, fileKey }` for memory mounts only, else `null`      |
| `isStrictDenied(absPath)`        | `true` if strict mode would deny this path                    |

### `VFSKernel` (worker thread)

`VFSKernel.fromSnapshot(snapshot, config, options)` — read-only kernel:
projects SAB/SEA segments, instantiates per-thread `memory` places empty.

`kernel.handleDelta(msg)` — apply `file-update`/`file-delete` from main.

### `Place`

| Method                        | Returns          | Description                              |
| ----------------------------- | ---------------- | ---------------------------------------- |
| `readFile(key)`               | Buffer \| null   | SAB zero-copy view, or memory-place data |
| `stat(key)`                   | object \| null   | File stat                                |
| `exists(key)`                 | bool             | Key present                              |
| `list(prefix)`                | string[]         | Keys under prefix                        |
| `getCachedData(key)`          | Buffer \| null   | V8 bytecode from `<key>.cache` companion |
| `createReadStream(key, opts)` | Readable \| null | 64 KB chunked, supports `{start,end}`    |
| `filePath(key)`               | string \| null   | Disk path (disk entries only)            |
| `writeFile(key, data)`        | void             | Memory places only; throws on read-only  |
| `unlink(key)`                 | bool             | Memory places only; returns existed      |

## Examples

Runnable demos under [examples/](examples/):

- [hot-reload-routes/](examples/hot-reload-routes/) — HTTP server whose route
  handlers are written into a memory place at runtime and served via patched
  `require()`.
- [sea-static/](examples/sea-static/) — same static-server code in two
  packaging modes: plain `node` (`provider: 'sab'`) and Node SEA single
  executable (`provider: 'sea'`).
- [multi-tenant/](examples/multi-tenant/) — two memory places + global
  `strict: true`; shows what the strict whitelist actually enforces.

See also [doc/comparison.md](doc/comparison.md) for a sober comparison
with `@platformatic/vfs`, `memfs`, and plain `node:fs`.

## Bootstrap (zero-integration)

```
node --require shared-memory-fs/preload   app.js
node --import  shared-memory-fs/register   app.mjs
```

Bootstrap reads `vfs.config.{js,json}` from `cwd` (or `--vfs.config=...`),
constructs the kernel, installs requested hooks, and exposes the kernel as
`globalThis.__vfsKernel`. Pair with worker_threads by passing
`globalThis.__vfsKernel.snapshot()` via `workerData`.

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

Each chunk is `Buffer.from(sab, offset, chunkSize)` — zero allocation per
chunk. Returns `null` for disk entries; fall back to `fs.createReadStream`.

## Architecture

```
Main thread                          Worker threads
┌─────────────────────┐              ┌────────────────────────┐
│ VFSKernel           │  snapshot()  │ VFSKernel.fromSnapshot │
│ ├─ FilesystemCache  │ ──────────►  │ ├─ projected Maps      │
│ │  └─ Pool+Registry │  workerData  │ ├─ per-thread memory   │
│ ├─ scanner          │              │ │  places              │
│ ├─ compileModules() │   broadcast  │ └─ handleDelta()       │
│ ├─ watcher (epochs) │ ──────────►  │                        │
│ └─ ACK tracking     │   ◄────────  │ postMessage(ack)       │
└─────────────────────┘              └────────────────────────┘
         │
    SAB segments  ←  shared physical memory  →  zero-copy views
```

- **`FilesystemCache`** — pooled SAB allocator (best-fit, free-extent reuse).
- **`Scanner`** — async directory scanner with extension filtering.
- **`VfsConfig`** — cascade + validation + deep freeze.
- **`Place`** — logical namespace; `files` Map of `{data, stat[, path]}`.
- **`PlacementRegistry`** — domain+path → place; `routeByMount(absPath)`.
- **`VFSKernel`** — facade: orchestrates init, projection, watch, ACK, dispatch.

## Tests

```
node --test
```

121 tests covering config, cache, scanner, place, kernel, memory provider,
SEA provider, strict sandbox, bytecode compilation, streaming, snapshot,
delta application, ACK flow.

See [doc/integration.md](doc/integration.md) for architecture deep-dive,
message protocol, recipes (metavm, AI agents, SEA, Platformatic-style use
cases), and comparison with `node:vfs` / `@platformatic/vfs`.

## License

MIT
