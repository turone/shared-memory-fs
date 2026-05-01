# Integration Guide

In-depth notes that complement the [README](../README.md): worker protocol,
hooks model, recipes, and design rationale.

## Architecture in one screen

```
Main thread                                Worker threads
┌──────────────────────────────────┐       ┌──────────────────────────────┐
│ VFSKernel (full)                 │       │ VFSKernel.fromSnapshot()     │
│ ├─ VfsConfig (frozen)            │       │ ├─ same VfsConfig            │
│ ├─ FilesystemCache               │       │ ├─ projected Maps (zero-copy)│
│ │  └─ Pool + SegmentRegistry     │       │ ├─ per-thread memory places  │
│ ├─ PlacementRegistry             │       │ ├─ pathIndex                 │
│ ├─ Scanner                       │       │ └─ handleDelta()             │
│ ├─ DirectoryWatcher (epochs)     │       └──────────────────────────────┘
│ ├─ pathIndex                     │
│ └─ pendingAcks: updateId→Set     │  snapshot()  ┐
└──────────────────────────────────┘  ──────────► │ workerData
                                       broadcast()│
                                       ──────────►│ parentPort.on('message')
                                       ◄────────  │ ack-update
SAB segments ─────────── shared physical memory ─────────── zero-copy views
```

Invariants:

- Workers never write SAB.
- ACK-before-free: stale entries are freed only after every active worker has
  ACK'd the update that supersedes them.
- Empty segments are recycled, never returned to the OS.
- Config is deep-frozen at construction.
- File keys start with `/` and use forward slashes on all platforms.
- `compile` is main-thread-only; workers ignore it.

## Provider matrix

|                       | `sab`       | `memory`             | `sea`             | `node-default` | `disk`             |
| --------------------- | ----------- | -------------------- | ----------------- | -------------- | ------------------ |
| Source                | scanned dir | empty per-thread     | `node:sea` assets | OS fs          | scanned dir        |
| Storage               | SAB pool    | per-thread `Map`     | SAB pool          | OS fs          | OS fs (path entry) |
| Writable              | no          | yes                  | no                | passthrough    | no                 |
| Shared across workers | yes         | no                   | yes               | n/a            | metadata only      |
| In `snapshot()`       | yes         | no (recreated empty) | yes               | n/a            | yes (paths)        |
| Watched               | yes         | no                   | no                | n/a            | yes                |
| `getCachedData()`     | yes         | yes (auto on write)  | yes               | n/a            | no                 |

## Worker message protocol

Main → worker:

```js
// File update (created or modified)
{
  name: 'file-update',
  target: 'static',                   // place name
  updateId: 7,                        // monotonic
  updates: [
    ['/index.html', { kind:'shared', segmentId:3, offset:0, length:42, stat }],
    ['/index.html.cache', { kind:'shared', segmentId:3, offset:64, length:128, stat }],
  ],
  newSegments: [{ id: 3, sab: SharedArrayBuffer }],   // any newly-allocated
}

// File delete
{ name: 'file-delete', target: 'static', updateId: 8, keys: ['/old.html'] }
```

Worker → main:

```js
{ name: 'ack-update', updateId: 7 }
```

Workers must apply the delta with `kernel.handleDelta(msg)` _before_ sending
the ACK, otherwise the main thread might free SAB regions still in use.

## Hooks

Three independent hook layers, all controlled by `defaults.hooks`:

| Layer     | Patches                                                               | Reads                                                                                                       | Writes                                                                                                                   |
| --------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `fs`      | `node:fs` (sync, callback, promises)                                  | `readFile`, `readFileSync`, `stat`, `statSync`, `existsSync`, `realpathSync`, `createReadStream` + promises | `writeFile`, `writeFileSync`, `unlink`, `unlinkSync`, `mkdirSync` (no-op for memory) + promises — only for memory mounts |
| `require` | `Module._resolveFilename`, `Module.prototype._compile`                | resolves via VFS, compiles with `cachedData` when available                                                 | —                                                                                                                        |
| `import`  | ESM loader (`register('shared-memory-fs/adapters/import-hook', ...)`) | resolves + reads source via VFS                                                                             | —                                                                                                                        |

In strict mode, every patched read/write checks `kernel.isStrictDenied(path)`
first and raises `EACCES` for unowned paths under `appRoot`.

Manual install (when not using bootstrap):

```js
const fsPatch = require('shared-memory-fs/adapters/fs-patch');
const requireHook = require('shared-memory-fs/adapters/require-hook');
fsPatch.install(kernel);
requireHook.install(kernel);

// ESM:  await register('shared-memory-fs/adapters/import-hook',
//                     pathToFileURL('./'), { data: { kernel } });
```

## Recipes

### V8 bytecode for a hot module path

```js
places: {
  domain: { domains: ['fs'], match: { dir: 'domain' },
            provider: 'sab', ext: ['js'], compile: true },
}
```

`initialize()` compiles every `.js` once, stores bytecode as `<key>.cache` in
the same SAB segments, and projects both source and bytecode to workers via
`snapshot()`. Workers `require('/abs/domain/x.js')` and the patched
`_compile` calls `new vm.Script(wrapped, { cachedData: bytecode })`. V8 skips
parse + compile for all functions, including lazy ones.

When the watcher detects a source change, it recompiles bytecode in the same
epoch as the source update, and broadcasts both in one delta.

### Sharing bytecode with `metavm`

`Place.getCachedData(key)` returns the same `Buffer` shape that
`metavm.createScript(source, { cachedData })` expects:

```js
const metavm = require('metavm');
const place = kernel.getPlace('domain');

const source = place.readFile('/handler.js').toString('utf8');
const cachedData = place.getCachedData('/handler.js');

const script = metavm.createScript(source, {
  filename: '/handler.js',
  cachedData,
});
const handler = script.exports;
```

This works in any thread that holds the snapshot — the bytecode lives in SAB
and is shared zero-copy. If `cachedData` is `null` (place has no `compile` or
file is non-JS), `metavm` will create cached data on first run as usual.

### AI agent / plugin sandbox

Pattern: one writable `memory` place per agent (or per session), strict mode
on, optional `sab` place for read-only tooling.

```js
const config = new VfsConfig({
  defaults: { strict: true },
  places: {
    tools: {
      domains: ['fs', 'require'],
      match: { dir: 'tools' },
      provider: 'sab',
      ext: ['js'],
      compile: true,
    },
    workspace: {
      domains: ['fs'],
      match: { dir: 'workspace' },
      provider: 'memory',
    },
  },
});

// In any thread (main or worker — each has its own workspace):
const ws = kernel.getPlace('workspace');
ws.writeFile('/notes.md', Buffer.from('# scratch'));
fs.writeFileSync('/abs/workspace/code.js', 'console.log(1)'); // also routed
fs.readFileSync('/etc/passwd'); // EACCES
fs.readFileSync('/abs/elsewhere/file'); // EACCES if under appRoot
```

Memory places are per-thread, so concurrent agents in different workers
cannot see each other's scratch state — true isolation without IPC.

### Single-Executable Application bundling

```js
// Build with sea-config.json:
//   "assets": { "public/index.html": "./dist/index.html",
//               "public/app.js":     "./dist/app.js" }

const config = new VfsConfig({
  places: {
    app: { domains: ['fs'], match: { dir: 'public' }, provider: 'sea' },
  },
});
```

At runtime the kernel calls `sea.getAssetKeys()`, copies each matching asset
into SAB once, and projects to workers via snapshot. Outside an SEA build the
provider stays empty and logs a warning — the same code runs unmodified
during development.

### Generated code with hot reload (no disk)

```js
places: {
  gen: { domains: ['fs', 'require'], match: { dir: 'gen' },
         provider: 'memory', compile: true },
}

// Generate, write, require — all in memory:
gen.writeFile('/route.js', Buffer.from(generateRouteHandler(spec)));
const handler = require('/abs/gen/route.js');  // bytecode-cached on write

// Replace at any time:
gen.writeFile('/route.js', Buffer.from(generateRouteHandler(newSpec)));
delete require.cache['/abs/gen/route.js'];
const next = require('/abs/gen/route.js');
```

### Testing with virtual fixtures

```js
const fs = require('node:fs');
const fsPatch = require('shared-memory-fs/adapters/fs-patch');

beforeEach(async () => {
  kernel = new VFSKernel(testConfig, { appRoot: '/test' });
  await kernel.initialize();
  fsPatch.install(kernel);
  kernel.getPlace('fixtures').writeFile('/data.json', Buffer.from('{"a":1}'));
});

afterEach(() => {
  fsPatch.uninstall();
  kernel.close();
});

it('reads via patched fs', () => {
  const data = JSON.parse(fs.readFileSync('/test/fixtures/data.json'));
  assert.equal(data.a, 1);
});
```

## CLI overrides

```
node app.js -- \
  --vfs.defaults.memory.limit=512mib \
  --vfs.defaults.strict=true \
  --vfs.hooks.fs=false \
  --vfs.enable=tools,workspace \
  --vfs.disable=static
```

Use `VfsConfig.fromArgv(process.argv, appConfig)` to apply them.

## Comparison with alternatives

See [comparison.md](comparison.md) for a detailed comparison with
`@platformatic/vfs` (the direct extraction of the `node:vfs` core
proposal), `memfs`, and plain `node:fs`.

## Design notes

**Why SAB.** A single physical copy of cached files, projected zero-copy into
N workers. With 100 MiB of cached files and 8 workers, that's ~800 MiB saved
versus per-worker MemoryProvider.

**Why pooled segments.** One SAB per file would exhaust mmap regions quickly.
A best-fit allocator over 64 MiB segments amortizes the cost; free extents are
recycled and empty segments stay around to be reused, never returned to the OS.

**Why companion `.cache` keys.** V8 bytecode could be a second region inside
each entry, but companion entries (`/x.js` + `/x.js.cache`) keep the
allocator simple — every entry is one contiguous region — and bytecode flows
through snapshot, delta, and ACK without special handling.

**Why main-thread-only compilation.** N workers compiling the same source is
N× wasted CPU. The main thread compiles once during `initialize()`, stores
bytecode in SAB, and workers consume it via `cachedData`. Workers stay
read-only with respect to SAB.

**Why per-thread memory places.** Concurrent agents/sessions in different
workers must not see each other's scratch state. Memory places are
deliberately not shared — `fromSnapshot()` instantiates each one empty.
Cross-worker writable state would require ACK-before-free coordination on
every write, which defeats the purpose of a fast scratch space.

**Why strict mode at the kernel layer.** The patched `fs` is the only
chokepoint that sees every read attempt; gating there is cheap (one Map
lookup) and uniform across sync, async, and promises. Application-level
sandboxing is bypassed by code that imports `node:fs` directly — kernel-level
sandboxing is not.

## Integration checklist

- [ ] Build `VfsConfig` matching your directory layout and provider mix.
- [ ] Main: `new VFSKernel(config, { appRoot, broadcast, getWorkerIds })`.
- [ ] Main: `await kernel.initialize()` _before_ spawning workers.
- [ ] Main: pass `kernel.snapshot()` via `workerData`.
- [ ] Main: `kernel.watch()` after workers are up.
- [ ] Main: forward `ack-update` → `kernel.handleAck`.
- [ ] Main: forward worker exit → `kernel.handleWorkerExit`.
- [ ] Main: `kernel.close()` on shutdown.
- [ ] Worker: `VFSKernel.fromSnapshot(snapshot, config, { appRoot })`.
- [ ] Worker: forward `file-update`/`file-delete` → `kernel.handleDelta`,
      then post `{ name: 'ack-update', updateId }`.
- [ ] Optional: install hooks (`fs-patch`, `require-hook`, `import-hook`) or
      use the bootstrap `--require` / `--import` shortcuts.
- [ ] Optional: enable `defaults.strict` for sandboxed workers.
- [ ] Optional: add `compile: true` to JS places for V8 bytecode cache.
