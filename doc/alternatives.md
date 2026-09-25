# Alternatives

shared-memory-fs is a narrow tool: a **shared, read-mostly file cache for
Node.js servers that run several `worker_threads`**, with live updates,
shared V8 cached data, pre-compressed representations and a preparation
pipeline. Its main neighbour is **`node:vfs`**, the virtual file system now
in Node.js core; this page compares the two and places the userland options
around them.

Facts about `node:vfs` reflect September 25, 2026: the documentation of
Node.js v26.10.0 (the latest release, September 22, 2026) and, where marked,
changes merged into `main` but not released yet. `node:vfs` is experimental
and still changing — check the current docs before relying on a detail
below.

## At a glance

|                         | shared-memory-fs                                                             | `node:vfs`                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Status                  | userland; Node 22.22.3+, 24.12+, 26                                          | core, Node 26 only (not backported to 22 / 24); Stability 1 (experimental), behind `--experimental-vfs` |
| Built for               | many threads reading the same files                                          | self-contained file trees: tests, fixtures, embedded assets, archives, SEA                              |
| Paths                   | the real paths under `appRoot`, one place per directory                      | a reserved mount namespace (e.g. `/dev/null/vfs/0`) that never shadows real paths; no overlay           |
| Across `worker_threads` | one SAB copy, zero-copy views in every thread, deltas to all                 | not described; startup mounts are re-created in each worker                                             |
| Updates                 | watcher / writes → atomic epochs to every thread; readers keep their version | memory writes are local to the instance; `RealFSProvider` reads through to disk                         |
| Content sources         | disk directories, application writes, SEA assets                             | memory, a real directory, ZIP archives, custom providers, SEA assets (`useVfs`)                         |
| `node:fs` surface       | a subset: reads, stat, readdir, streams, mutations; no descriptors           | broad: sync, callback and promises, descriptors, streams, watch, symlinks                               |
| Modules                 | `require` / `import` of published files; no `exports` maps                   | full CommonJS / ESM resolution from the mount, `node_modules`, native addons                            |
| V8 cached data          | built once, shared (`require.compile`, `fs.script.compile`)                  | none; SEA `useVfs` cannot be combined with `useCodeCache` or `useSnapshot`                              |
| Compression             | gzip / deflate / br / zstd representations built once, shared                | none                                                                                                    |
| Content preparation     | `prepare`: one canonical content per file, once per publication              | none                                                                                                    |
| Access policy           | `strict` routing under `appRoot` (a policy, not isolation)                   | none (not a sandbox); under `--permission`, mounting needs `--allow-fs-vfs`                             |

## `node:vfs` in short

- **v26.4.0** — the module, behind `--experimental-vfs`:
  `vfs.create([provider])` returns a `VirtualFileSystem` with an fs-like API
  of its own. Providers: `MemoryProvider` (default: in-memory tree,
  symlinks, watch), `RealFSProvider(rootPath)`, and custom subclasses of
  `VirtualProvider`.
- **v26.9.0** — `mount()` (no arguments) returns a mount point in a
  reserved namespace, after which `node:fs`, `require()` and `import()`
  reach the tree under that path: "any given path is served either by
  exactly one VFS or by the real file system, never both." Also
  `ZipProvider` (over an open `zlib.ZipBuffer` / `zlib.ZipFile`), SEA
  `"useVfs": true` (the bundled assets mounted read-only, the main script
  run from the mount root) and `--allow-fs-vfs`, without which the
  permission model refuses to mount.
- **v26.10.0** — `--vfs-mount=<dir|zip>` mounts a source at startup and
  `--vfs-load` also runs the entry point from it; `vfs.registerProvider()`
  lets them mount a format Node has no provider for. A worker inherits these
  mounts, mounting each source again, and runs its own entry point.
- It is documented as not a sandbox, permission system or access-control
  mechanism.

## Status and outlook

As of September 25, 2026:

- **Released.** v26.10.0 is the newest release. `node:vfs` exists only in
  Node 26 — it is not backported to the 24 or 22 LTS lines — and remains
  Stability 1 behind `--experimental-vfs`: outside semantic versioning,
  incompatible changes may come in any release.
- **Merged into `main`, not released yet:**
  - `--vfs-mount` is removed; `--vfs-load` alone mounts and runs its single
    source, at the same mount point in every thread. A worker created with
    its own `execArgv` inherits no mount and must be given
    `--experimental-vfs --vfs-load` again (nodejs/node#66162).
  - SEA `"vfsArchive"`: the assets come from a prebuilt ZIP archive served
    by `ZipProvider` (nodejs/node#65810).
- **Open pull requests.**
  - `ComposableProvider`: several providers layered in one mount — reads by
    priority, copy-up on write, whiteouts for deletions
    (nodejs/node#66235). The layers stay inside the mount; real paths are
    still never overlaid.
  - A readable reserved root listing the mounts, and `vfs.vfsBase()`
    (nodejs/node#66140).
- **Release schedule.** Node 26 enters LTS on October 28, 2026 — the first
  LTS line with `node:vfs`. It is the last line of the two-majors-a-year
  model: from Node 27 there is one major a year, in April, preceded by an
  alpha channel (27 alpha from October 2026, 27.0.0 in April 2027, LTS in
  October 2027).

None of these changes — released, merged or proposed — shares a VFS
between threads, builds cached data, compresses content or overlays real
paths, so the differences below should hold in the near term.

## Where they differ

**Purpose.** `node:vfs` gives a program a file tree that does not exist on
disk. shared-memory-fs keeps files that do exist (or that the application
writes) in one shared copy for many threads. The first is about _where
files come from_; the second is about _how many copies of them a process
holds and how they change_.

**Path model.** A `node:vfs` mount lives in its own namespace: code has to
use the mount point (or be started from it with `--vfs-load`). A place of
shared-memory-fs is a real directory under `appRoot`: existing code keeps
reading `appRoot/static/index.html` and gets the cached bytes, with the
patched `node:fs` and the module hooks deciding per path.

**Threads.** The `node:vfs` documentation does not describe sharing an
instance between threads; a `MemoryProvider` tree is ordinary JavaScript
state, and a startup source is mounted again in each worker (on `main`, at
the same mount point in every thread). shared-memory-fs keeps every byte
once in `SharedArrayBuffer` segments: each worker projects the same memory
from a snapshot, receives each change as one delta, and a replaced version
is freed only after every worker has moved on and no stream or view still
reads it. With `n` workers and `m` MiB of files that is `m` MiB instead of
up to `n × m`.

**Live updates.** `RealFSProvider` always reads the disk, so it is current
but not cached. shared-memory-fs watches disk-origin places and publishes
each batch of changes atomically — a source with its bytecode and
compressed companions — to every thread, while readers that started before
finish the version they began with.

**API surface.** `node:vfs` aims at the whole `node:fs` contract, including
file descriptors and symlinks. shared-memory-fs implements what hot read
paths need and guards the rest: an unimplemented API can refuse a path, but
it is never served from the VFS; `open()` of a cached file is `ENOTSUP`.

**Modules.** `node:vfs` mounts take part in the full CommonJS and ESM
resolution, `node_modules` and native addons included. shared-memory-fs
resolves files and directories of its places (no `exports` / `imports`
maps) and adds what `node:vfs` does not: V8 cached data built once on the
main thread and reused by every worker's `require()`.

**Work done once.** Preparation (`prepare`), bytecode flavors and
compressed representations are computed at publication and shared. With
`node:vfs` each of those stays the application's job, in every thread.

**SEA.** `useVfs` mounts the assets and excludes `useCodeCache` and
`useSnapshot`; on `main`, `vfsArchive` serves them from an embedded ZIP
archive. `provider: 'sea'` copies the assets into SAB once, shares them
across workers and can build cached data for them.

**Access policy.** Neither is a sandbox. `strict: true` makes `appRoot` a
managed root that refuses unowned paths for code going through `node:fs`
and the module hooks — useful discipline, not a security boundary.

## Choosing

Use **`node:vfs`** when you need a virtual tree: test fixtures without
touching disk, packaging an application or its assets (ZIP, SEA), code that
needs the full `node:fs` contract, descriptors or native addons from
memory, or a single-threaded program.

Use **shared-memory-fs** when several worker threads read the same files
and memory, startup time or per-request CPU matter: static servers, template
and handler caches, modules with cached data, live reload across a worker
pool, runtime-generated code shared through `sab + virtual`.

They can coexist: a `node:vfs` mount and the places of shared-memory-fs
never overlap. A `VirtualProvider` backed by a shared-memory-fs place would
give the full fs contract over shared bytes; it is **not built**.

## Userland options

**`@platformatic/vfs`** — a userland shim of the `node:vfs` API for
Node 22+. Its README: use the built-in `node:vfs` where Node provides it;
the shim remains useful on Node 22+ and for its `SqliteProvider`. Overlay
and virtual-cwd modes are shim-only. As a monkey-patching layer it cannot
load native addons or FFI libraries from virtual bytes, integrate with SEA,
or transparently intercept Node's internal module-resolution file system
calls. Same trade-offs as `node:vfs` against shared-memory-fs.

**memfs** — an in-memory `node:fs` implementation, excellent for tests and
mocks; one volume per thread, no module loading of its own, no sharing.

**Plain `node:fs` in each worker** — the baseline. The OS page cache is
shared, but every thread reads, parses and compiles the same files again
and keeps its own copies; compression and preparation run per request or
per thread. Still the right choice for a single thread, a handful of small
files, or code that needs nothing but the disk.

## What this page does not claim

There are no benchmark numbers here: the repository has no benchmark suite
yet, so savings are stated as copy counts, not measurements. Statements about
`node:vfs` follow its documentation, not measurements either; unreleased
changes and open pull requests are reported as such and may change before a
release.

Sources:

- Node.js documentation: [`node:vfs`](https://nodejs.org/api/vfs.html),
  [`--vfs-load` / `--vfs-mount`](https://nodejs.org/api/cli.html#--vfs-loadsource),
  [single executable applications](https://nodejs.org/api/single-executable-applications.html)
- nodejs/node: [#65748](https://github.com/nodejs/node/pull/65748) (startup
  mounts, workers), [#66162](https://github.com/nodejs/node/pull/66162)
  (`--vfs-mount` removed), [#65810](https://github.com/nodejs/node/pull/65810)
  (`vfsArchive`), [#66235](https://github.com/nodejs/node/pull/66235)
  (`ComposableProvider`), [#66140](https://github.com/nodejs/node/pull/66140)
  (`vfs.vfsBase()`)
- Release plans:
  [Evolving the Node.js release schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule),
  [nodejs/Release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
- [platformatic/vfs](https://github.com/platformatic/vfs)
