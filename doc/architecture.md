# Architecture and decisions

How shared-memory-fs is built and **why**. Each section states the
decisions in force together with the reasons behind them; [Rejected
designs](#rejected-designs) lists what was considered and turned down, so it
is not reintroduced without new evidence. Keep this file aligned with the
code: a change that alters a decision updates it in the same commit.

Contents: [Purpose](#purpose) · [Module map](#module-map) ·
[Places and configuration](#places-and-configuration) ·
[Storage](#storage) · [Publication](#publication) ·
[Lifetime of shared bytes](#lifetime-of-shared-bytes) ·
[Preparation](#preparation) ·
[Virtual places and worker mutations](#virtual-places-and-worker-mutations) ·
[Routing and strict mode](#routing-and-strict-mode) ·
[Patched `node:fs`](#patched-nodefs) ·
[Hooks and bootstrap](#hooks-and-bootstrap) ·
[Rejected designs](#rejected-designs) · [Invariants](#invariants) ·
[Protocol](#protocol) · [Testing](#testing)

## Purpose

Node.js servers that run several `worker_threads` over the same files —
static assets, templates, handler sources, modules. Files are loaded once on
the main thread into pooled `SharedArrayBuffer` segments; every thread reads
zero-copy views of the same bytes. Live changes are published to all threads
atomically; V8 cached data and compressed representations are built once and
shared the same way.

It is deliberately **not** a general-purpose virtual filesystem (see
[alternatives.md](alternatives.md) for `node:vfs`), not a sandbox for
untrusted code and not a persistence layer.

Engines: `>=22.22.3 <23 || >=24.12.0 <25 || >=26` — the floor of
`module.registerHooks` with CommonJS `--import` bootstrap of memory-only
modules. Early Node 24 bypasses `registerHooks` for nested `require()` from
CommonJS executed by the ESM translator.

```
Main thread                                  Worker threads
┌───────────────────────────────────┐        ┌──────────────────────────────┐
│ VfsKernel                         │ link() │ attach() → VfsKernel         │
│ ├─ VfsConfig (frozen)             │ ─────► │ ├─ projected Maps (zero-copy)│
│ ├─ FilesystemCache (SAB pool)     │        │ ├─ per-thread map places     │
│ ├─ publication pipeline + epochs  │ update │ └─ Pins: streams and leases  │
│ ├─ DirWatcher → SerialQueue       │ ─────► │                              │
│ ├─ retirement: acks + retired     │ ◄───── │ vfs-ack (+ retained)         │
│ └─ Pins (main-thread consumers)   │ ◄───── │ vfs-release / vfs-mutate     │
└───────────────────────────────────┘        └──────────────────────────────┘
SAB segments ──────────── one physical copy ──────────── views in every thread
```

## Module map

| Module                          | Role                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/config.js`                 | `VfsConfig`: raw → deep-frozen `{ global, places }`; domains, `prepare` index, `fs.fallback` normalization                                                |
| `lib/cache.js`                  | `Pool` + `SegmentRegistry` + `FilesystemCache`: SAB allocator; `allocate()` places bytes privately, `put()` / `remove()` publish, `compact()` plans moves |
| `lib/kernel.js`                 | `VfsKernel`: lifecycle, the publication pipeline, epochs (`#flush`), retirement, watcher FIFO, mutation queue + RPC server, `link()`, worker side         |
| `lib/pipeline.js`               | What a file is: `Preparers`, `prepareInput()`, `bytecodeFor()`                                                                                            |
| `lib/compressor.js`             | `Compressor`: codec work only                                                                                                                             |
| `lib/pins.js`                   | `Pins`: per-thread direct consumers of shared versions                                                                                                    |
| `lib/serial-queue.js`           | `SerialQueue`: one task at a time, arrival order                                                                                                          |
| `lib/place.js`                  | `Place`: projection, `visible()`, `cached()`, `scripted()`, `prepared()`, `preparerOf()`, `companions()`                                                  |
| `lib/place-fs.js`               | `PlaceFs` facade, `VfsReadStream`, view leases, disk territory of `fs.fallback: 'disk'`                                                                   |
| `lib/registry.js`               | `PlaceRegistry` (path → place, key) + `FsRouter` (read / mutate / copy decisions)                                                                         |
| `lib/map-store.js`              | `MapStore`: the per-thread Map sink, atomic publish                                                                                                       |
| `lib/sab-store.js`              | `SabStore`: main-thread mutations of a `sab + virtual` place                                                                                              |
| `lib/mutation-queue.js`         | `MutationQueue`: per-(place, key) ordering, exclusive place barrier                                                                                       |
| `lib/mutation-rpc.js`           | `MutationClient` + `RemoteStore`: worker → main mutations                                                                                                 |
| `lib/scanner.js`                | `scan()`: directory walk → `Map<key, FileInput>`                                                                                                          |
| `lib/watcher.js`                | `DirWatcher`: recursive `fs.watch` → debounced epochs; `watchPath()`                                                                                      |
| `lib/companion.js`              | companion keys: `src\0require:bytecode`, `src\0script:bytecode`, `src\0fs:<enc>`                                                                          |
| `lib/stats.js`, `lib/errors.js` | `VfsStats` / `VfsDirent`; node:fs-shaped errors                                                                                                           |
| `lib/adapters/fs-patch.js`      | table-driven `node:fs` patch executing router decisions                                                                                                   |
| `lib/adapters/module-hook.js`   | `module.registerHooks` resolve/load + `_compile` cached data                                                                                              |
| `lib/bootstrap/*`               | `register.mjs` (main thread, `--import`), `attach.js` (workers)                                                                                           |

## Places and configuration

**A place is one directory under `appRoot`; its name is also the mount, the
cache namespace and the snapshot/delta key.** _Why:_ one identifier and no
mapping table; the router maps any path to its place with one lookup on the
first path segment; a place is enabled or disabled without rewriting paths.

**Provider (where bytes live) and origin (where content comes from) are
independent axes.** `sab` / `sea` keep bytes in the SAB pool, `map` in a
per-thread Map, `disk` / `node-default` are passthrough mounts; `sab` and
`map` read a directory (`origin: 'disk'`) or take application writes
(`origin: 'virtual'`). _Why:_ the four `sab`/`map` × `disk`/`virtual`
combinations cover a worker-shared cache, shared scratch state, a per-thread
cache and per-thread scratch space with one code path each.

**Domains `fs`, `require`, `import` each filter by extension; the scanner
reads the union once.** _Why:_ the patched `node:fs` and the module hooks see
the same files under different policies (a place may serve html to fs and
only js to require), and a file is read from disk once.

**Configuration is resolved and validated once, then deep-frozen;
`config.raw` is the structured-cloneable input workers rebuild from;
functions (preparers) never enter it.** _Why:_ workers receive the config by
structured clone and must resolve exactly the same places; a frozen config
cannot drift between threads; invalid combinations fail at construction,
before anything is read — e.g. `compress.retainRaw: false` on a virtual
place (no raw file to serve) or `prepare` on a passthrough provider. Every
resolved value is explicit (origin, `fs.fallback`), so a resolved config
describes itself.

## Storage

**Pooled SAB segments (default 64 MiB), a best-fit allocator; emptied
segments are reused, never returned to the OS.** _Why:_ one SAB per file
would exhaust mmap regions and fragment the address space; returning a
segment would require every thread to drop its views, which cannot be
coordinated cheaply; reuse is enough.

**Companions — bytecode flavors and compressed representations — are
separate entries under NUL-separated keys.** _Why:_ every entry stays one
contiguous extent, companions travel through snapshot, delta, retirement and
compaction without special cases, and a NUL cannot occur in a file name, so
companions never collide with files nor leak into listings.

**Files above `maxFileSize` stay disk entries; companions are bounded by the
segment size only and never fall back to disk.** _Why:_ large media do not
belong in the pool; a companion exists only in memory — a disk entry would
point at the raw source.

## Publication

**One pipeline for every source of content: raw input → the preparer of
its extension (once) → canonical content → bytecode flavors → compressed
representations → one epoch.** Initial scan, watcher, SEA assets, virtual
writes from any thread and Map writes all use it. _Why:_ what a file _is_
cannot differ between init and live updates or between origins, and
atomicity and failure semantics are enforced in one place.

**Index-at-flush: allocations are private until `#flush` commits an epoch
to the index in one synchronous step.** _Why:_ `snapshot()`, `link()` and
compaction only ever see published state; a failed or abandoned attempt
frees only its own bytes; the entry a change replaces is read at commit
time, so two publications can never retire the same version twice.
Consequence: there is no global commit lock — virtual publications of
different keys may overlap.

**One `vfs-update` per epoch or accepted mutation; a file's source and
companions travel together, a companion that failed to rebuild is listed in
`removals` of the same message.** _Why:_ V8 accepts cached data by source
length, not content — a same-length edit next to a stale companion would run
old bytecode silently.

**Watcher epochs run strictly one at a time, in arrival order
(`SerialQueue`); rechecks use the same queue.** _Why:_ epochs processed in
parallel let an older epoch publish over a newer one (new content on disk,
old in the VFS); a FIFO is the simplest correct order, and the debounce
already batches events. The queue is deliberately separate from the per-key
`MutationQueue` of virtual places, which never share a key with a watched
place.

**Stable source reads: stat before and after a looped read; a failed
publication keeps the previous version and gets one deferred recheck.**
_Why:_ a file that changes while being read must never be published half
written, and a flapping file must not loop.

**Failure policy.** Init aborts on any unreadable source, preparer error,
failing `fs.script.compile` or path-less input that does not fit. Live
updates keep the previous version and companions. `require.compile` is
best-effort. _Why:_ startup is all or nothing; live traffic keeps serving the
last good version; Node's CommonJS loader compiles fine without cached data,
while a script bundle promises its cached data.

## Lifetime of shared bytes

**A replaced or removed shared version is retired, not freed: it gets a
temporary `retireId` and its bytes return to the pool only after every linked
worker has ACKed the update and no thread still reads it — never on a
timeout.** _Why:_ a freed extent is reused at once; a stream, lease or socket
write queue still holding it would read another file's bytes. An ACK only
means a projection dropped the version, not that its consumers finished; a
timeout would bring the bug back under load.

**The `retireId` exists only from retirement until the free — no permanent
allocation id per entry.** Records keep place, key, size and time for
diagnostics (`kernel.retirements()`, labels like `static:/a.mp4 [fs:br]#17`,
never parsed back). _Why:_ current entries are identified by (place, key);
a permanent id would bloat every entry and message for the rare case.

**Each thread pins direct consumers by the projected entry object; IPC
happens only when a pinned version is retired: its id in the ACK
(`retained`), then one `vfs-release`.** _Why:_ the projected object is the
identity of a physical version for free; pinning a current version happens
per stream and view and must stay local; reporting the hold inside the ACK
registers it before the ACK can free anything.

**Streams emit owned chunks by default and release with the stream;
zero-copy chunks are released only by `stream.release()`.** node:fs callers
(the fs patch) always get owned chunks. _Why:_ a socket keeps chunks in its
write queue after the source stream ended — releasing on `'end'` would free
bytes still being written; third-party code never calls `release()`.

**Views are explicit leases `{ view, release, [Symbol.dispose] }`, with no
GC backstop.** _Why:_ a Buffer has no lifecycle to observe; a GC-driven
release could free memory while a destructured view or a `subarray` of it is
still in use — use-after-free is worse than a visible leak.

**`close()` stops active streams (`ERR_VFS_CLOSED`); a worker kernel's
`close()` also closes its link.** _Why:_ after close nothing guards shared
bytes — a worker's streams would otherwise read memory the main thread reuses
once the link is gone.

**Compaction moves published entries only and closes the segment it
empties; retired extents never move.** _Why:_ moving a retired extent would
invalidate its readers; the closed segment returns to the pool when its last
retired bytes are freed. Publishing into a closed segment reopens it.

## Preparation

**`prepare` is declared by a domain but prepares the file: one declaration
per extension per place; a second declaration — even of the same preparer —
is a config error, with no domain priority and no merging.** _Why:_ a file
has one canonical content shared by every domain; two declarations would be
ambiguous, and silent priority rules hide configuration mistakes.

**The short form `prepare: 'name'` covers the domain's own finite `ext`; an
unrestricted fs takes only the object form; `fs.script.ext` is never its
scope.** _Why:_ "every file" is not a meaningful preparation target, and the
script extensions are a consumer filter, not a declaration.

**Preparers are synchronous, run once per publication attempt and never on
read; returned bytes are copied, `meta` / `scriptOptions` cloned and
deep-frozen.** _Why:_ they run inside synchronous Map writes and the watcher
pipeline; running on read would multiply the CPU cost per thread and
request; cloned, frozen results travel to workers and cannot change after
publication.

**Workers never prepare shared places; `attach({ preparers })` serves only
local writes to a worker's own `map` places, and a missing preparer fails
that write, not the attach.** _Why:_ functions cannot cross threads; the main
kernel owns every shared publication; a worker that only reads never needs
them.

**Appending to or moving away a prepared key is `ENOTSUP`; renaming raw
content onto an extension with a preparer publishes it through that
preparer.** _Why:_ the raw input is not retained and a bundle may embed its
old key — refusing beats publishing a stale bundle.

**`fs.script.compile` and `require.compile` are independent flavors built
from the same canonical source.** _Why:_ different consumers, wrappers and
options — the bare source under the preparer's `scriptOptions` for
`vm.Script`, `Module.wrap(source)` under the module filename for Node's
loader. The library invents no `scriptOptions`.

## Virtual places and worker mutations

**The main kernel alone owns the allocator, preparation, publication,
retirement and compaction; workers mutate `sab + virtual` places through an
RPC over their link port.** The response follows publication — the update is
posted first on the same port — and the payload travels as a detached copy.
_Why:_ one writer keeps allocation single-threaded without locks inside SAB;
a worker sees its own write before its Promise settles.

**Mutations of shared places are asynchronous; `*Sync` forms are `ENOTSUP`;
no `Atomics.wait()`.** _Why:_ blocking a worker on the main thread invites
deadlocks and stalls both.

**Per-key ordering with an exclusive place barrier for subtree operations;
one update per accepted mutation, no coalescing.** _Why:_ each Promise
corresponds to its own publication; validation and publication see the same
state without serializing unrelated keys.

**`link()` / `attach()` is the only worker transport.** _Why:_ one
implementation of the protocol — ACKs, retained versions, releases,
mutations — instead of every integration re-implementing retirement.

**`map` places are per-thread and never part of a snapshot.** _Why:_ fast,
synchronous scratch space without coordination; shared writable state goes
through `sab + virtual`.

## Routing and strict mode

**The router decides, the adapters execute; `fs-patch` and `module-hook`
never read the config.** _Why:_ one chokepoint, uniform across sync,
callback, promise and guarded APIs.

**Containment is lexical: only a real `..` component leaves `appRoot`; the
router never stats or resolves paths.** _Why:_ `..private` is a legal name
and must route like any other; the router sits on the hot path of every fs
call. Symlink / realpath containment is out of scope.

**Strict mode is a routing policy, not isolation.** _Why:_ code can reach
the OS by other means (native addons, child processes, its own hooks) and
worker threads share one process; isolating untrusted code needs OS-level
boundaries.

**Under strict, `appRoot` itself is a managed root: it lists the enabled
places (`readdir`, `opendir`), stats as a directory and refuses native
access (`watch`, writes).** _Why:_ passing the root through listed the
names of unmanaged entries.

**`fs.fallback` belongs to disk-origin places and is always explicit once
resolved: `'deny'` under strict, `'disk'` otherwise.** `'deny'` serves
published canonical entries only; `'disk'` also serves, from disk and inside
that place only, the files its cache filters do not select, and merges them
into listings (the facade serves the same territory). Cached extensions stay
VFS-only under strict; module hooks never fall back. Its disk territory is a
route of its own (`'disk'`): native for reads, but a listing (`readdir`,
`opendir`) is always the place's — disk directories and uncached files
only, cached extensions from the published collection — even for a
directory that exists only on disk. _Why:_ partial disk caches — html and
js in SAB, media from disk — under strict routing, without a raw file ever
standing in for canonical (prepared) content or an unpublished version; a
native listing of a disk-only directory showed such raw files. The
non-strict default keeps its permissive reads.

## Patched `node:fs`

**One rule decides what a native `node:fs` operation may do: it runs only
once every path it touches has been routed.** A single-path operation runs
after the routing of its source and destination allows it; a recursive or
compound operation whose routing could check only its top path is refused;
the raw disk file of an entry the places serve (published, prepared,
virtual) is never copied or linked in place of its content; a virtual
destination is never changed by a native disk operation; a recursive
operation from outside `appRoot` is refused when its walk would enter
`appRoot`; unrelated paths outside `appRoot` stay native. What the kernel
cannot guarantee fails with `ENOTSUP` before anything is read or written.
_Why:_ every bypass found had one shape — a native operation checked one
path, then read, listed or changed many: `opendir` listed hidden files, a
recursive `cp` of a place or of a directory above `appRoot` carried denied
files out, `copyFile` into a virtual place left a stray disk file, a
directory `watch` reported hidden names, a recursive `rm` from above deleted
read-only places. A rule per shape closes the class, not the instance.
`ENOTSUP` keeps the contract honest until a VFS-aware implementation exists
(`TASKS.md`); an approximation such as `cp` with a `filter` would still copy
raw bytes and miss virtual entries.

**Every path-taking API is in one of three groups.**

- _Implemented_, served by the places: `readFile`, `stat`, `lstat`,
  `access`, `realpath`, `existsSync`, `readdir`, `opendir`,
  `createReadStream`, `writeFile`, `appendFile`, `unlink`, `mkdir`, `rm`,
  `rename`.
- _Recognized but unsupported for managed territory_ (`ENOTSUP`): `open` of
  a virtual entry; `cp` / `copyFile` / `link` from a source the places
  serve; `watch` of a managed directory and a recursive `watch` of managed
  territory; recursive walks (`readdir`, `opendir`, `watch`, `rm`, `rmdir`,
  `cp`) and `rename` of a tree that holds places; guarded mutations in a
  virtual place.
- _Native passthrough outside managed territory_: unrelated paths outside
  `appRoot`, `disk` / `node-default` places, disk-territory files,
  unmanaged paths without strict; and the guarded APIs (`chmod`, `chown`,
  `utimes`, `truncate`, `symlink`, `readlink`, `statfs`, `watchFile`,
  `rmdir`, `glob`) once every path argument is routed.

_Why:_ an application must be able to tell which calls the VFS serves, which
it refuses and which belong to the operating system — and a new API must
join a group deliberately, never by default.

**Every listing comes from the places: `opendir` is implemented, not
guarded — a `Dir` over the entries `readdir` lists, taken when it is
opened, with the `node:fs` close semantics.** _Why:_ a guarded native
`opendir` was a second listing path: it showed raw disk files a place hides
(unpublished cached extensions, the disk behind `fallback: 'deny'`) and
missed virtual entries. A snapshot keeps it synchronous and simple;
`node:fs` does not promise to show entries changed during an iteration
either.

**`glob` results are filtered by route, relative ones against its `cwd`
option.** _Why:_ glob walks with the `node:fs` functions it captured on first
use — native ones if it ran before the patch — so the filter is the only
boundary; resolving results against `process.cwd()` let a glob with a `cwd`
list what strict routing hides.

**Copies and hard links from what the places serve are `ENOTSUP`: a
published, prepared or virtual entry, a place directory, the strict
`appRoot`, and — recursively — any disk territory and any tree that holds
places, on either side of a `cp` (`FsRouter.copy`).** _Why:_ `node:fs`
copies or links the raw disk file: raw bytes in place of canonical
(prepared) content, no virtual entries, and a recursive copy walks past the
filtered listings — a recursive copy of a place, or of a directory above
`appRoot`, carried files strict routing denies to a readable destination.
Disk-territory files, passthrough places and unrelated paths keep native
copies: their disk bytes are what reads return.

**`watch` of a managed directory, recursive or not, is `ENOTSUP`; a single
managed file keeps a native watcher; `fs.promises.watch` reports a refusal
when it is iterated.** _Why:_ a directory watcher reports the name of every
entry that changes, those a place hides included, and it reports disk
events, not publications; a watcher of one routed file reveals nothing
else. `node:fs` reports the errors of `fs.promises.watch` from its iterator,
so a synchronous throw would differ from native behavior.

**A recursive walk, and a `rename`, of a tree that holds places — `appRoot`
passed through without strict, or a directory above it — is `ENOTSUP`; one
level stays native.** _Why:_ such a walk enters the places natively: a
recursive `readdir` from above listed hidden names, a recursive `rm`
deleted the files of read-only places, and a `rename` carried the whole tree
out of `appRoot`, where strict routing no longer reaches it. Only geometry
is checked (`PlaceRegistry.encloses`), so unrelated paths pay nothing.

**APIs the patch does not implement are guarded passthrough; a guarded
mutation in a virtual place is `ENOTSUP`, and so is `open()` of a virtual
entry.** _Why:_ an unimplemented API must not become a bypass; only its
store changes a virtual place — a native `copyFile` into one left a stray
disk file the place never showed; SAB / Map entries have no file
descriptor.

**A wrapper calls its original once no kernel is installed, and each
`install()` wraps the restored originals.** _Why:_ a reference taken while
the patch was installed — a module's destructured `node:fs`, the functions
glob keeps from its first use — outlives `uninstall()`; it threw a
`TypeError` on the kernel that was gone, which glob swallowed into an empty
result. Wrapping the restored originals keeps repeated install / uninstall
from stacking wrappers.

**Listings sort and deduplicate the string names, then encode them as
asked; a recursive `encoding: 'buffer'` listing works in places.** _Why:_
the encoding must not change order or duplicates, and a Buffer name cannot
be compared with a string key. Native `node:fs` (22.22.3 to 26.x) fails
`recursive` with `encoding: 'buffer'` — its callback form even crashes the
process — which is a defect, not a documented contract.

## Hooks and bootstrap

**One `module.registerHooks` chain for `require()` and `import`; modules
keep plain `file:` URLs; a `_compile` patch applies cached data and falls
back to the original compiler once.** _Why:_ in-thread synchronous hooks,
the same identity as files on disk (`import.meta.url`, `__filename`,
`require.cache`), bytecode reuse without changing module semantics; a
throwing module body is never re-executed.

**`load` returns the source decoded to a string.** _Why:_ the ESM loader
may compile after an async gap, when the shared bytes could already belong
to a newer version.

**`--import shared-memory-fs/register` bootstraps the main thread;
workers call `attach()`.** _Why:_ preloads do not run in worker threads.

## Rejected designs

| Design                                                                                                          | Why not                                                           |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Preparer functions inside `VfsConfig`                                                                           | the config must stay structured-cloneable for workers             |
| Async preparers                                                                                                 | they run inside synchronous Map writes and one atomic publication |
| Domain priority or merging of `prepare` declarations                                                            | hides mistakes; one extension, one declaration                    |
| `fs.script.prepare`                                                                                             | preparation belongs to the file, not to the script consumer       |
| Synchronous worker mutations via `Atomics.wait()`                                                               | deadlock- and stall-prone                                         |
| Workers allocating in SAB                                                                                       | one writer keeps the allocator lock-free                          |
| Echoing file bytes in mutation responses                                                                        | the bytes are already in SAB; the update carries metadata         |
| Provisional entries in the index                                                                                | snapshots and compaction would observe unpublished state          |
| Parallel watcher epochs                                                                                         | an older epoch could publish over a newer one                     |
| A permanent allocation id in every entry                                                                        | retirement needs an identity only while a version is retired      |
| IPC per chunk or per pin                                                                                        | pins of current versions must stay local                          |
| Freeing a retired version on a timeout                                                                          | reuse under a slow reader returns another file's bytes            |
| GC-driven release of views                                                                                      | use-after-free for destructured views and subarrays               |
| Releasing zero-copy streams on `'end'`                                                                          | sockets still hold the last chunks                                |
| Manual worker transports (`broadcast`, `getWorkerIds`)                                                          | every one would have to re-implement retirement                   |
| `startsWith('..')` containment, `realpath` in the router                                                        | misroutes `..private`; disk access on the hot path                |
| Native `cp` with a routing `filter` for managed trees                                                           | raw disk bytes, no virtual entries, no canonical content          |
| Standalone place-level `script` domain, provider `memory`, `vfs:` URLs, metawatch, root-level `ext` / `compile` | superseded by the place / domain model; no aliases                |

## Invariants

- Projections are `Buffer.from(sab, offset, length)` views; `readFile*`
  returns owned copies; direct access goes through leases and streams that
  pin their version.
- The config is deep-frozen and never mutated at runtime.
- The index holds published entries only; every publication commits in one
  synchronous `#flush`.
- A retired version is freed only after all linked workers ACKed its update
  and no thread holds it; nothing is freed on a timeout.
- Compaction never moves or overwrites retired bytes; emptied segments are
  reused, never returned to the OS.
- Source and companions of a file are published in one `vfs-update`.
- Watcher epochs never overlap.
- Companions never appear in `readdir`, `exists`, routing or the patched fs;
  `Place.companions(key)` enumerates them — never hand-roll key lists.
- Kernel-internal disk I/O (kernel, scanner, watcher, disk territory in
  `PlaceFs`) uses `node:fs` functions captured at load time, so the patch
  never blocks the kernel.
- `watchPath()` is a load-bearing workaround (nodejs/node#63638: an 8.3
  alias in a watched path aborts libuv on Windows); remove it only when the
  engines floor clears every affected release.
- `install()` records every replaced `node:fs` property and `uninstall()`
  restores them in reverse; `.native` variants are preserved; with no
  kernel installed a wrapper is its original.
- Listings are sorted and deduplicated by string name before any encoding.

## Protocol

```
snapshot    { segments: [{ id, sab }], places: { <name>: { entries: [[key, entry]] } } }
vfs-update  { name, updateId, places: { <name>: { entries, removals, retired: [[key, retireId]] } },
              newSegments: [{ id, sab }] }                                    main → worker
vfs-ack     { name: 'vfs-ack', updateId, retained?: [retireId] }              worker → main
vfs-release { name: 'vfs-release', retireIds: [retireId] }                    worker → main
vfs-mutate  { name, id, place, op, key, to?, options?, data? }                worker → main
vfs-mutated { name, id, error?: { code, message, syscall, path } }            main → worker
entry       shared { kind, segmentId, offset, length, stat, scriptOptions?, meta? }
            | disk { kind, path, stat, scriptOptions?, meta? }
stat        { size, mtimeMs } (+ sourceSize, encoding for compressed companions)
```

## Testing

- `npm test` runs `test/*.test.js`; `npm run test:examples` runs the
  example smoke suite; `npm run lint` is eslint + prettier. CI covers Linux
  and Windows on Node 22.22.3 / 22.x / 24.12.0 / 24.x / 26.x.
- Concurrency tests are deterministic: gate the injected reader
  (`k.cache.reader`), emit watcher epochs by hand and await
  `k.watchQueue.idle`, observe publication on the main side
  (`k.nextUpdateId`, `k.acks`, `k.retired`, `k.retirements()`), and use
  in-thread links (`test/helpers.js`: `tap`, `worker`, `nextMessage`)
  instead of timers.
- Hooks are installed only inside a test and uninstalled in `after` /
  `finally`; bootstrap tests run child processes.
- glob keeps the `node:fs` functions of its first use, and a `node --test`
  child has already used it: a glob that kept the patched functions is
  tested in a plain node process (`test/fixtures/glob-kept.cjs`).
- A refused operation is tested for its error (`code`, `syscall`, `path`,
  `dest`) and for leaving nothing behind — no copy, no deletion, no move.
- Prove V8 cached-data acceptance in a worker: the per-isolate compilation
  cache masks `cachedDataRejected` in the compiling thread.
- `npm ci` must work without git or SSH access: git dependencies are pinned
  as HTTPS tarball URLs with lockfile integrity.
