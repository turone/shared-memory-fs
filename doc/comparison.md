# Comparison with alternatives

`shared-memory-fs` is **not** a general-purpose VFS for Node.js. It is a
purpose-built preset that solves a narrow set of real production problems:

- worker_threads paying repeated parse/IO cost on the same files
- single-executable applications (Node SEA) needing to serve embedded assets
- runtime code generation (AI agents, hot-reload) that must be `require`-able
- multi-tenant runtimes that need a hard `appRoot` whitelist

Below is a sober comparison with the closest alternatives in the npm
ecosystem as of 2026.

## TL;DR

| Concern                                | shared-memory-fs                                   | @platformatic/vfs                  | memfs                    |
| -------------------------------------- | -------------------------------------------------- | ---------------------------------- | ------------------------ |
| Cross-thread shared bytes (SAB)        | **Yes**                                            | No                                 | No                       |
| V8 bytecode cache shared between WTs   | **Yes** (`compile: true`)                          | No                                 | No                       |
| `provider: 'sea'` (node:sea assets)    | **Yes**                                            | No                                 | No                       |
| Multiple mounts in one instance        | **Yes** (`places: {...}`)                          | No (one `mount(prefix)` at a time) | n/a (no mount concept)   |
| Per-mount ext whitelist + policy       | **Yes** (`ext` + `extOnExtra`)                     | No                                 | No                       |
| Strict appRoot sandbox (EACCES)        | **Yes** (`strict: true`)                           | Partial via `overlay: false`       | No                       |
| `node:vfs` core API surface (FD, etc.) | Minimal                                            | **Full (extraction of core PR)**   | Partial                  |
| Sqlite persistence provider            | No (deferred)                                      | **Yes**                            | No                       |
| LOC                                    | ~3000                                              | ~10k+ (full fs surface)            | ~5k                      |
| Target use cases                       | Multi-thread server, SEA, hot-reload, multi-tenant | Future `node:vfs` reference impl   | Test mocks, in-memory fs |

## vs `@platformatic/vfs`

`@platformatic/vfs` is the **direct extraction** of the
[Node.js core `node:vfs` proposal](https://github.com/nodejs/node/pull/61478).
That positioning explains both its strengths and where we deliberately go a
different direction.

### What @platformatic/vfs does well

- Full `fs` API surface — `openSync/readSync/closeSync`, `readdirSync`,
  `lstatSync`, `symlinkSync`, `realpathSync`, `watchFile/unwatchFile`,
  virtual `cwd`, `Symbol.dispose`. Anything Node core has, they have.
- Pluggable `VirtualProvider` base class — write 6 primitives, get the
  whole high-level API (`readFile`, `copyFile`, `appendFile`) for free.
- `MemoryProvider` (default), `RealFSProvider` (sandbox to a real dir),
  `SqliteProvider` (persistent via `node:sqlite`).
- `Module.registerHooks` on Node 23.5+, fallback to legacy
  `Module._resolveFilename` patching for older versions.
- Aligns with `node:vfs` proposal — when core lands, drop-in upgrade.

### Where it leaves real problems unsolved

These are the gaps that motivated this library:

#### 1. No cross-thread sharing

`MemoryProvider` is a per-process Map. Spawn `n` workers and you get `n`
independent copies; either you re-read from disk in each worker, or you
serialise buffers across `postMessage`. The whole point of
`SharedArrayBuffer` — one allocation, `n` zero-copy views — is missing.

In our case: `cache.allocate(name, key, file)` writes into a SAB segment
once on the main thread. Each worker's `kernel.snapshot()` carries the SAB
handle; reads are `Buffer.from(sab, offset, length)` — no copy, no IPC.
Hot path tested under [test/cache.test.js](../test/cache.test.js) and
[test/kernel.test.js](../test/kernel.test.js).

#### 2. No V8 bytecode cache

`@platformatic/vfs` hooks `require()`, but every worker still calls
`vm.Script(source)` from scratch — no `cachedData` reuse, no
`createCachedData`, no companion storage. For an impress-style app with
dozens of `application/lib/*.js` × `n` workers that's literal milliseconds
per file × n on every spawn.

Our [`compile: true`](../README.md#bytecode--compile-true) per-place
generates V8 bytecode at init, stores it as a `<key>.cache` companion
entry in the same SAB segment. Workers `vm.Script({ cachedData })` it
zero-copy; `script.cachedDataRejected === false` confirmed in
[test/adapter-require.test.js](../test/adapter-require.test.js).

#### 3. No SEA provider

There is no `provider: 'sea'` analogue. Their `RealFSProvider` sandboxes
to a real directory; `MemoryProvider` is empty at boot. Loading
`node:sea` assets into a VFS requires custom glue.

We do it in one step: `provider: 'sea'` iterates `sea.getAssetKeys()`,
maps each prefix-matched key to a Place file key, copies the asset bytes
into SAB. Tested in [test/sea.test.js](../test/sea.test.js); demoed in
[examples/sea-static/](../examples/sea-static/).

#### 4. Single-mount model

`vfs.mount('/prefix')` activates one prefix at a time; multi-tenant
deployments need multiple `create()` instances and multiple mount points
managed externally. There is no built-in routing between them.

We model mounts as **first-class config**:

```js
new VfsConfig({
  places: {
    'tenant-a': { match: { dir: 'tenant-a' }, provider: 'memory', ... },
    'tenant-b': { match: { dir: 'tenant-b' }, provider: 'memory', ... },
    'static':   { match: { dir: 'public'  }, provider: 'sab',    ... },
  },
});
```

A single `PlacementRegistry` routes any path to the right place via
`routeByMount(absPath)` — used by fs-patch, require-hook, import-hook,
and watcher uniformly.

#### 5. No per-mount extension whitelist

If `MemoryProvider` is fed `.bak`, `.tmp`, or `.swp` files, they live in
the VFS forever. There is no policy for "this mount serves only `.html`
and `.css`; warn me about anything else."

Our `ext: ['html', 'css']` + `extOnExtra: 'silent' | 'warn' | 'error'`
applies uniformly across scanner init, SEA loader init, memory
`writeFile`, and watcher single-file changes — see
[test/ext-whitelist.test.js](../test/ext-whitelist.test.js).

#### 6. Strict sandbox is coarse

Their `overlay: false` mode means "fall through to real fs only for what
exists in the VFS." Anything outside the VFS gets passed to real fs
unconditionally. There is no notion of "the project root is a closed
world; warn me when code reads outside the registered mounts."

Our `strict: true` makes `appRoot` a whitelist by mounts: paths under
`appRoot` not owned by any place return `EACCES` from the patched fs;
paths outside `appRoot` pass through untouched. See
[examples/multi-tenant/](../examples/multi-tenant/) and
[test/strict.test.js](../test/strict.test.js).

#### 7. Persistent SqliteProvider is a separate axis

`@platformatic/vfs` ships `SqliteProvider` for persistence across
process restarts. We do not have an equivalent today. For our target
sce­narios (worker startup speed, SEA bundles, runtime-generated code)
persistence is orthogonal — file content lives either on real disk
(where we mirror via `provider: 'sab'`) or in a build artefact (SEA).
If a use case ever demands `node:sqlite` persistence we will revisit;
for now it stays out of scope.

### Where @platformatic/vfs is the right choice

- You need the full `fs` API including FDs, symlinks, virtual `cwd`,
  watchFile/unwatchFile.
- You need persistence (SqliteProvider) without writing your own.
- You want to track / target the future `node:vfs` core API directly.
- Single-process app, no worker_threads, no SEA, no need for shared
  bytes.

For those cases use `@platformatic/vfs`. We do not aim to compete on the
breadth of fs surface.

## vs `memfs`

`memfs` is excellent for **unit tests and mocking**. It implements an
in-memory `fs` that you patch in for the duration of a test. It is not
meant to be a runtime production VFS for a multi-thread server, which is
exactly the gap we fill.

| Concern                       | shared-memory-fs  | memfs                |
| ----------------------------- | ----------------- | -------------------- |
| Cross-thread shared bytes     | Yes               | No                   |
| Bytecode cache                | Yes               | No                   |
| SEA / single-executable       | Yes               | No                   |
| Per-mount routing + whitelist | Yes               | No                   |
| Module hooks (require/import) | Yes               | Via `unionfs`/manual |
| Use as test mock              | Possible (memory) | **Designed for it**  |

If you need a quick test fixture, `memfs` is a one-liner and we are
overkill. If you need to ship a multi-worker production server with
shared cache, the SAB story is what makes the difference.

## vs plain `node:fs` + worker_threads

The do-nothing baseline. Each worker reads the same files from disk on
boot and recompiles them. For a server with 4 workers and 50 application
files, that is 200 file reads and 200 V8 compiles per restart instead of
50 reads + 50 compiles + 4 zero-copy projections.

Use plain `fs` when you have:

- a single thread (CLI tool, Lambda handler);
- a tiny number of files where the parse/IO cost is negligible;
- no need for in-memory writable code (no AI-agent-style flow).

## Strategic positioning

We are intentionally **narrower** than `@platformatic/vfs`.

`@platformatic/vfs` is becoming `node:vfs`; its job is to expose the full
filesystem contract. Our job is to be a focused **multi-thread / SEA /
bytecode preset** that solves the four real problems listed at the top
of this document, with as little code as possible (~3000 LOC,
167 tests).

When `node:vfs` lands (or for users of `@platformatic/vfs` today), the
natural integration shape is a thin adapter:

```
class SABProvider extends VirtualProvider {
  // ~50 LOC: openSync/readSync/closeSync wrap place.readFile + cursor
  // statSync/readdirSync use place.stat / place.list
}
```

Our kernel becomes the backing store; the `VirtualProvider` base class
gives us the rest of the fs surface for free. That keeps our codebase
small while making us callable from any `node:vfs`-using application.

This adapter is **not built yet** — it is the next planned milestone
once core `node:vfs` ships. See `/memories/session/plan.md` for the
roadmap.
