# shared-memory-fs

SharedArrayBuffer-backed filesystem cache for Node.js worker_threads.

Files are loaded once on the main thread into pooled SAB segments. Workers get
zero-copy `Buffer` views over the same memory — no per-worker copies, no
serialization, no IPC for file reads. Optional V8 bytecode caching compiles JS
once and stores bytecode in SAB so workers skip parse + compile entirely.

## Features

- **Zero-copy sharing** — workers read `Buffer.from(sab, offset, length)` views,
  not copies
- **Pooled segments** — files packed into large SAB segments (default 64 MiB)
  with best-fit allocation
- **V8 bytecode cache** — `compile: true` per place, bytecode in SAB, workers
  skip V8 parse + compile for all functions including lazy ones
- **Chunked streaming** — `Place.createReadStream()` streams SAB data in 64 KB
  zero-copy chunks with HTTP Range support
- **Live reload** — watcher batches changes into epochs, broadcasts deltas,
  ACK-before-free guarantees no worker reads freed memory
- **fs / require / import hooks** — transparent patching of `node:fs`,
  `Module._resolveFilename`, `Module._compile`, and ESM loader

## Install

```
npm install shared-memory-fs
```

Requires Node.js ≥ 20.6.

## Quick Start

### Main thread

```js
const { VFSKernel, VfsConfig } = require('shared-memory-fs');
const { Worker } = require('node:worker_threads');

const config = new VfsConfig({
  defaults: {
    memory: { limit: '1 gib', segment: '64 mib', maxFileSize: '10 mb' },
  },
  places: {
    static: {
      domains: ['fs'],
      match: { dir: 'static' },
      provider: 'sab',
      ext: ['html', 'css', 'js', 'png', 'svg'],
    },
    lib: {
      domains: ['fs'],
      match: { dir: 'lib' },
      provider: 'sab',
      ext: ['js'],
      compile: true, // V8 bytecode cache, auto-adds 'require' to domains
    },
  },
});

const threads = new Map();
const kernel = new VFSKernel(config, {
  appRoot: process.cwd(),
  broadcast: (data) => {
    for (const t of threads.values()) t.postMessage(data);
  },
  getWorkerIds: () => threads.keys(),
});

await kernel.initialize();
kernel.watch();

const snapshot = kernel.snapshot();
for (let i = 0; i < 4; i++) {
  const w = new Worker('./worker.js', { workerData: { snapshot } });
  threads.set(w.threadId, w);
  w.on('message', (msg) => {
    if (msg.name === 'ack-update') kernel.handleAck(msg.updateId, w.threadId);
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

const config = new VfsConfig({ /* same config */ });
const kernel = VFSKernel.fromSnapshot(workerData.snapshot, config, {
  appRoot: process.cwd(),
});

const place = kernel.getPlace('static');
const html = place.readFile('/index.html');       // Buffer (zero-copy SAB view)
const stat = place.stat('/index.html');            // { size, mtime, ... }
const stream = place.createReadStream('/big.mp4'); // chunked Readable

const lib = kernel.getPlace('lib');
const bytecode = lib.readBytecode('/utils.js');    // V8 bytecode Buffer

// Handle live updates
parentPort.on('message', (msg) => {
  if (msg.name === 'file-update' || msg.name === 'file-delete') {
    kernel.handleDelta(msg);
    parentPort.postMessage({ name: 'ack-update', updateId: msg.updateId });
  }
});
```

## API

### `VfsConfig`

```js
new VfsConfig(raw)
```

Config cascade: hardcoded defaults → `raw.defaults` → per-place. Frozen after
construction.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaults.memory.limit` | string/number | `'1 gib'` | Total SAB memory limit |
| `defaults.memory.segment` | string/number | `'64 mib'` | Base segment size |
| `defaults.memory.maxFileSize` | string/number | `'10 mb'` | Max file for SAB (larger → disk) |
| `defaults.hooks.fs` | boolean | `true` | Patch `node:fs` |
| `defaults.hooks.require` | boolean | `true` | Patch `Module._resolveFilename` |
| `defaults.hooks.import` | boolean | `true` | Register ESM loader |
| `defaults.watchTimeout` | number | `1000` | Watcher debounce ms |

**Place config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `domains` | string[] | `[]` | `'fs'`, `'require'`, `'import'` |
| `match` | object | — | `{ dir: 'name' }` or `{ prefix: '/path' }` |
| `provider` | string | `'sab'` | `'sab'`, `'disk'`, `'node-default'` |
| `ext` | string[] | `null` | Extensions without dots: `['html', 'css']` |
| `compile` | boolean | `false` | Enable V8 bytecode generation |

### `VFSKernel`

**Main thread:**

| Method | Description |
|--------|-------------|
| `await initialize()` | Scan dirs, load into SAB, compile bytecode |
| `snapshot()` | Returns `{ segments, filesystems }` for workerData |
| `watch()` | Start watcher, broadcast deltas on changes |
| `handleAck(updateId, workerId)` | Worker ACK'd update |
| `handleWorkerExit(workerId)` | Clean up dead worker |
| `close()` | Stop watcher, clear state |
| `getPlace(name)` | Get Place by name |
| `resolveFsPath(filePath)` | Resolve abs path → `{ place, key, fileKey }` |

**Worker thread:**

| Method | Description |
|--------|-------------|
| `VFSKernel.fromSnapshot(snapshot, config, options)` | Create worker kernel |
| `handleDelta(msg)` | Apply file-update / file-delete |

### `Place`

| Method | Returns | Description |
|--------|---------|-------------|
| `readFile(key)` | Buffer \| null | Zero-copy SAB view |
| `readBytecode(key)` | Buffer \| null | V8 bytecode from companion `.cache` entry |
| `stat(key)` | object \| null | File stat |
| `exists(key)` | boolean | Key exists |
| `filePath(key)` | string \| null | Disk path (disk entries only) |
| `list(prefix)` | string[] | Keys matching prefix |
| `createReadStream(key, options)` | Readable \| null | 64 KB chunked stream, `{start, end}` for ranges |

## V8 Bytecode Cache

Add `compile: true` to places containing JS modules. Main thread compiles
source via `vm.Script` + `Module.wrap()` + `createCachedData()` during
`initialize()`. Bytecode is stored as companion entries (`/handler.js.cache`)
in the same SAB segments.

Workers receive bytecode via snapshot. The `require-hook` adapter patches
`Module.prototype._compile` to use `vm.Script({ cachedData })` — V8 skips
parse and compile for all functions, including lazy ones.

`compile: true` automatically adds `'require'` to `domains` if not present.
`compile` is a main-thread-only flag — `fromSnapshot()` ignores it.

Bytecode is recompiled automatically when the watcher detects source changes.
Invalid bytecode (Node.js version change) falls back to normal `_compile`.

## Streaming

```js
const stream = place.createReadStream('/video.mp4');
stream.pipe(res);

// HTTP Range
const stream = place.createReadStream('/video.mp4', { start: 1024, end: 2047 });
```

64 KB chunks via `Buffer.from(sab, offset, chunkSize)` — zero allocation per
chunk. Returns `null` for disk entries (fall back to `fs.createReadStream`).

## Adapters

Transparent hooks — no application code changes needed:

```js
// fs-patch: readFile, readFileSync, stat, statSync, existsSync,
//           realpathSync, createReadStream, promises.readFile, promises.stat
const fsPatch = require('shared-memory-fs/adapters/fs-patch');
fsPatch.install(kernel);

// require-hook: _resolveFilename + _compile (with bytecode)
const requireHook = require('shared-memory-fs/adapters/require-hook');
requireHook.install(kernel);
```

**Bootstrap** (no code integration):

```
node --require shared-memory-fs/preload app.js
node --import shared-memory-fs/register app.mjs
```

## Architecture

```
Main thread                          Worker threads
┌─────────────────────┐              ┌─────────────────────┐
│ VFSKernel           │  snapshot()  │ VFSKernel (worker)   │
│ ├─ FilesystemCache  │ ──────────► │ ├─ projected Maps    │
│ │  └─ Pool+Registry │  workerData │ ├─ pathIndex         │
│ ├─ scanner          │              │ └─ handleDelta()    │
│ ├─ compileModules() │  broadcast  │                      │
│ ├─ watcher (epochs) │ ──────────► │ handleDelta(msg)     │
│ └─ ACK tracking     │  ◄───────── │ postMessage(ack)     │
└─────────────────────┘              └─────────────────────┘
         │
    SAB segments ← shared physical memory → zero-copy views
```

- **FilesystemCache** — pooled SAB allocator with best-fit free-extent reuse
- **Scanner** — async directory scanner with extension filtering
- **VfsConfig** — config cascade, validation, deep freeze
- **Place** — logical namespace with cached file data
- **PolicyEngine** — readonly enforcement, write deny
- **PlacementRegistry** — domain+path → place resolution

## Tests

```
node --test
```

91 tests covering cache, config, scanner, place, kernel (including bytecode
compilation, streaming, fromSnapshot, handleDelta, ACK flow).

## License

MIT
