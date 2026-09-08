# Integration Guide

In-depth notes that complement the [README](../README.md): worker protocol,
hooks model, recipes, and design rationale.

## Architecture in one screen

```
Main thread                                Worker threads
┌──────────────────────────────────┐       ┌──────────────────────────────┐
│ VfsKernel (full)                 │       │ attach() / fromSnapshot()    │
│ ├─ VfsConfig (frozen)            │       │ ├─ same VfsConfig from raw   │
│ ├─ FilesystemCache               │       │ ├─ projected Maps (zero-copy)│
│ │  └─ Pool + SegmentRegistry     │       │ ├─ per-thread memory places  │
│ ├─ PlaceRegistry + FsRouter      │       │ └─ handleDelta()             │
│ ├─ scanner                       │       └──────────────────────────────┘
│ ├─ DirWatcher (epochs)           │  link() → workerData.vfs
│ └─ pendingFrees: updateId→Set    │  vfs-update ──────────►
└──────────────────────────────────┘  ack-update  ◄──────────
SAB segments ─────────── shared physical memory ─────────── zero-copy views
```

Invariants:

- Workers never write SAB.
- ACK-before-free: stale entries are freed only after every live worker
  (`getWorkerIds()` ∪ `link()` ports) ACKs the `updateId`, or exits.
- Empty segments are recycled, never returned to the OS. Compaction
  _closes_ a segment until ACK-pending bytes are gone.
- Config is deep-frozen at construction. Workers rebuild from `config.raw`.
- Place name **is** the directory under `appRoot`, the mount and the
  snapshot/delta key.
- `require.compile` is main-thread-only; there is no ESM bytecode.

## Provider matrix

|                       | `sab`                   | `memory`             | `sea`             | `node-default` | `disk`                |
| --------------------- | ----------------------- | -------------------- | ----------------- | -------------- | --------------------- |
| Source                | scanned dir             | empty per-thread     | `node:sea` assets | OS fs          | OS path entries       |
| Storage               | SAB pool                | per-thread `Map`     | SAB pool          | OS fs          | OS fs                 |
| Writable              | disk + watch            | yes                  | no                | passthrough    | `fs.writable`         |
| Shared across workers | yes                     | no                   | yes               | n/a            | metadata only         |
| In `snapshot()`       | yes                     | no (recreated empty) | yes               | n/a            | no                    |
| Watched               | if watch / writable sab | no                   | no                | n/a            | no                    |
| Bytecode              | `kernel.bytecode`       | auto on write        | `kernel.bytecode` | n/a            | no (`compile: false`) |

Writable sab writes go to disk; the watcher brings them into SAB
(eventual consistency, no `waitForUpdate`).

## Worker message protocol

Main → worker (`link()` port):

```js
{
  name: 'vfs-update',
  updateId: 7,
  places: {
    static: {
      entries: [
        ['/index.html', { kind:'shared', segmentId:3, offset:0, length:42, stat }],
      ],
      removals: ['/old.html'],
    },
  },
  newSegments: [{ id: 3, sab: SharedArrayBuffer }],
}
```

Worker → main:

```js
{ name: 'ack-update', updateId: 7 }
```

`attach()` applies `vfs-update` then ACKs **those — and only those** —
messages. Manual `handleDelta(msg)` must run before the ACK, otherwise
the main thread may free SAB still in use.

There is no `file-update` / `file-delete`. One `vfs-update` per epoch.
Source + companions of one file are published together; a companion that
fails to rebuild is listed in `removals` of the same message.

## Hooks

Two layers, `defaults.hooks.{fs,module}`:

| Layer    | Mechanism                                              | Notes                                                                                      |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `fs`     | table-driven `node:fs` patch (sync/callback/promises)  | Executes `FsRouter` decisions. Implemented vs guarded lists: see README.                   |
| `module` | `module.registerHooks({ resolve, load })` + `_compile` | One chain for `require()` and `import`. Domain = `context.conditions.includes('require')`. |

Manual install (when not using `--import shared-memory-fs/register`):

```js
const fsPatch = require('shared-memory-fs/adapters/fs-patch');
const moduleHook = require('shared-memory-fs/adapters/module-hook');
fsPatch.install(kernel);
moduleHook.install(kernel);
```

Workers: `attach()` installs whatever the config asks for. Preloads do
not run in worker threads.

## Recipes

### V8 bytecode for a hot module path

```js
places: {
  domain: {
    fs: { ext: ['js'] },
    require: { ext: ['js'], compile: true },
  },
}
```

`initialize()` compiles every matching `.js` once, stores bytecode as an
internal companion (`<source>\0require:bytecode`) in the same SAB
segments, and projects both source and bytecode to workers via
`snapshot()`. Workers `require('/abs/domain/x.js')` and the patched
`_compile` calls `new vm.Script(wrapped, { cachedData })`. V8 skips
parse + compile for all functions, including lazy ones. There is no ESM
bytecode cache.

When the watcher detects a source change, it recompiles bytecode in the
same epoch and publishes both in one `vfs-update`.

### Sharing bytecode with `metavm`

`kernel.bytecode(absPath)` returns the same `Buffer` shape that
`metavm.createScript(source, { cachedData })` expects:

```js
const metavm = require('metavm');
const abs = path.join(kernel.appRoot, 'domain', 'handler.js');
const source = kernel.fs('domain').readFile('/handler.js', 'utf8');
const cachedData = kernel.bytecode(abs);

const script = metavm.createScript(source, {
  filename: abs,
  cachedData,
});
const handler = script.exports;
```

This works in any thread that holds the snapshot — the bytecode lives in
SAB and is shared zero-copy. If `cachedData` is `null` (place has no
compile, or the file is non-JS), `metavm` creates cached data on first
run as usual. Prove `cachedDataRejected === false` in a worker, not in
the compiling thread: V8's per-isolate cache masks rejection there.

### AI agent / plugin sandbox

Pattern: one writable `memory` place per agent (or per session), strict
mode on, optional `sab` place for read-only tooling. The trusted entry
and `package.json` live **outside `appRoot`**.

```js
const config = new VfsConfig({
  defaults: { strict: true },
  places: {
    tools: {
      fs: { ext: ['js'] },
      require: { ext: ['js'], compile: true },
    },
    workspace: {
      provider: 'memory',
      fs: { writable: true },
    },
  },
});

const ws = kernel.fs('workspace');
ws.writeFile('/notes.md', '# scratch');
fs.writeFileSync(path.join(appRoot, 'workspace', 'code.js'), 'console.log(1)');
fs.readFileSync('/etc/passwd'); // ordinary Node (outside appRoot)
fs.readFileSync(path.join(appRoot, 'elsewhere', 'file')); // EACCES
```

Memory places are per-thread, so concurrent agents in different workers
cannot see each other's scratch state. Same-process places are **not**
firewalled from each other.

### Static server with pre-compressed assets

```js
const config = new VfsConfig({
  places: {
    public: {
      fs: {
        compress: {
          encodings: ['br', 'gzip'],
          options: { br: { level: 11 }, gzip: { level: 9 } },
          ext: 'compressible',
        },
      },
    },
  },
});
```

Every worker then answers from the same SAB bytes:

```js
const place = kernel.fs('public');

const pick = (key, accept) => {
  const stored = place.storedEncodings(key); // ['raw', 'br', 'gzip']
  for (const encoding of ['br', 'gzip']) {
    if (accept.includes(encoding) && stored.includes(encoding)) {
      return encoding;
    }
  }
  return 'raw';
};

const serve = (req, res, key) => {
  const accept = req.headers['accept-encoding'] || '';
  const encoding = pick(key, accept);
  if (encoding === 'raw') {
    const body = place.readFile(key);
    res.writeHead(200, { 'Content-Length': body.length });
    return void res.end(body);
  }
  const body = place.readFileCompressed(key, encoding);
  res.writeHead(200, {
    'Content-Encoding': encoding,
    'Content-Length': body.length,
    Vary: 'Accept-Encoding',
  });
  res.end(body);
};
```

Parsing `Accept-Encoding` is the server's job. With `retainRaw: false`
the `'raw'` branch has no SAB bytes — use
`fs.createReadStream(place.pathOf(key))` instead.

### Single-Executable Application bundling

```js
// Build with sea-config.json:
//   "assets": { "pub/index.html": "./dist/index.html",
//               "pub/app.js":     "./dist/app.js" }

const config = new VfsConfig({
  places: {
    pub: { provider: 'sea', fs: true },
  },
});
```

At runtime the kernel copies each matching `node:sea` asset into SAB
once and projects to workers via snapshot. Outside an SEA build the
provider stays empty and logs a warning — the same code runs unmodified
during development. See [examples/sea-static/](../examples/sea-static/).

### Generated code with hot reload (no disk)

```js
places: {
  gen: {
    provider: 'memory',
    fs: { writable: true },
    require: true,
  },
}

const gen = kernel.fs('gen');
gen.writeFile('/route.js', generateRouteHandler(spec));
const handler = require(path.join(appRoot, 'gen', 'route.js'));

gen.writeFile('/route.js', generateRouteHandler(newSpec));
delete require.cache[path.join(appRoot, 'gen', 'route.js')];
const next = require(path.join(appRoot, 'gen', 'route.js'));
```

### Testing with virtual fixtures

```js
const fs = require('node:fs');
const fsPatch = require('shared-memory-fs/adapters/fs-patch');

beforeEach(async () => {
  kernel = new VfsKernel(testConfig, { appRoot: '/test' });
  await kernel.initialize();
  fsPatch.install(kernel);
  kernel.fs('fixtures').writeFile('/data.json', '{"a":1}');
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

Never leave hooks installed on the test runner: uninstall in `after`.

## CLI overrides

```
node --import shared-memory-fs/register app.js -- \
  --vfs.defaults.memory.limit=512mib \
  --vfs.defaults.strict=true \
  --vfs.hooks.fs=false \
  --vfs.enable=tools,workspace \
  --vfs.disable=static
```

`VfsConfig.fromArgv(process.argv, appConfig)` applies the same flags
when you construct the kernel yourself.

## Comparison with alternatives

See [comparison.md](comparison.md) for a detailed comparison with
`@platformatic/vfs` (the direct extraction of the `node:vfs` core
proposal), `memfs`, and plain `node:fs`.

## Design notes

**Why SAB.** A single physical copy of cached files, projected zero-copy
into N workers. With 100 MiB of cached files and 8 workers, that's
~800 MiB saved versus per-worker copies.

**Why pooled segments.** One SAB per file would exhaust mmap regions
quickly. A best-fit allocator over 64 MiB segments amortizes the cost;
free extents are recycled and empty segments stay around to be reused,
never returned to the OS.

**Why companion NUL keys.** V8 bytecode could be a second region inside
each entry, but companions (`src\0require:bytecode`, `src\0fs:br`) keep
the allocator simple — every entry is one contiguous region — and they
flow through snapshot, delta and ACK without special handling. They
never appear in `readdir` / patched `fs`.

**Why main-thread-only compilation.** N workers compiling the same source
is N× wasted CPU. The main thread compiles once during `initialize()`,
stores bytecode in SAB, and workers consume it via `cachedData`. Workers
stay read-only with respect to SAB. ESM has no bytecode cache.

**Why per-thread memory places.** Concurrent agents in different workers
must not see each other's scratch state. Memory places are deliberately
not shared — `fromSnapshot()` / `attach()` instantiates each one empty.
Cross-worker writable state would require ACK-before-free on every
write, which defeats a fast scratch space.

**Why strict mode at the router.** `FsRouter` is the chokepoint that sees
every routed path; gating there is cheap and uniform across sync,
callback, promises, and the guarded APIs. Application-level sandboxing
is bypassed by `require('node:fs')` — kernel-level sandboxing is not.

## Integration checklist

- [ ] Build `VfsConfig` matching your directory layout (place name =
      folder = mount).
- [ ] Main: `new VfsKernel(config, { appRoot })` (or
      `--import shared-memory-fs/register`).
- [ ] Main: `await kernel.initialize()` _before_ spawning workers.
- [ ] Main: `const { vfs, transferList } = kernel.link()`.
- [ ] Worker: `new Worker(file, { workerData: { vfs }, transferList })`.
- [ ] Worker: `attach()` first thing (preloads do not run in workers).
- [ ] Main: `kernel.close()` on shutdown.
- [ ] Optional: `defaults.strict` — entry + `package.json` outside
      `appRoot`.
- [ ] Optional: `require: { compile: true }` for CJS bytecode (default
      when the require domain is on).
- [ ] Optional: `fs.compress` for pre-compressed SAB representations.
