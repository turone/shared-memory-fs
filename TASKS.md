# Backlog

Future project work. Priority: **P1** — strict boundary or correctness,
**P2** — policy gaps and missing implementations, **P3** — improvements.

## P2 — VFS-aware versions of the operations refused today

**Problem.** For managed territory, native operations that walk a tree or
report raw disk events are recognized but unsupported (`ENOTSUP`), so an
application cannot copy a tree, watch, walk from above, or remove or move a
tree of managed content through `node:fs`. Single-file copies and renames
are implemented: they hand on the raw input.

**Cause.** A native operation checks only its top path. The rule in
`doc/architecture.md` (Patched `node:fs`) refuses whatever the kernel cannot
route path by path.

**Done when**, for each operation below, an implementation replaces its
`ENOTSUP` only if it:

- walks only through the filtered listing;
- hands on each source's raw input (`FsRouter.copy`), never a prepared
  result or a companion, and refuses a source without one;
- writes through each destination's mutation policy, its preparer running
  once;
- supports virtual entries and directories;
- leaves no raw disk bypass;
- holds the strict boundary for every descendant;
- follows a defined symlink policy;
- cleans up atomically after a partial failure;

and regression tests cover the sync, callback and promises forms, strict and
non-strict routing, and both fallbacks.

- Recursive `cp` of or into managed territory, with `force`,
  `errorOnExist` and `filter` per descendant.
- `watch` of managed territory: publication-level events for disk and
  virtual updates, never a hidden raw name; a defined outcome for a
  preparation that fails; a recursive watch bounded by the filtered
  listing; `AbortSignal`, `close()` and backpressure as in `node:fs`.
- Recursive `readdir` / `opendir` / `watch` from above `appRoot`, or from
  `appRoot` without strict: native levels outside, place listings inside.
- Recursive `rm` / `rmdir` of a tree that holds places: every descendant
  through its own place's mutation policy.
- A directory renamed into or out of a place: every descendant through the
  routing of both ends.
- `rename` of a tree that holds places: likely refused for good — moving
  `appRoot` under a running kernel has no consistent meaning; decide first.

Hard links into or out of a place stay refused by decision
(`doc/architecture.md`): one physical file cannot carry two canonical
contents.

## P2 — Symbolic links

**Problem.** Routing is lexical, and native reads follow links: a link
inside the disk territory of a place (`fs.fallback: 'disk'`,
`provider: 'disk'`) can point outside `appRoot`, and a link created outside
`appRoot` to a managed entry — or to a directory above `appRoot` — reads its
raw disk content past the routing. Not reproduced here yet (creating links
on Windows needs a privilege).

**Cause.** The router never touches the disk — it sits on the hot path of
every fs call — and `symlink` targets are resolved only when read.

**Done when.** A decided policy (refuse links whose target the kernel
serves or that enclose `appRoot`, refuse links in disk territory, or check
the real path of passthrough reads) is implemented with tests on Linux and
Windows.

## P3 — Separators of recursive listings on Windows

**Problem.** A managed recursive `readdir` returns `/`-separated names on
every platform; native `node:fs` returns `path.sep` (`sub\b.txt` on
Windows).

**Cause.** Place keys are `/`-separated and listings reuse them.

**Done when.** Listings either use `path.sep` like native `node:fs` or
document `/` as the contract, with a test pinning the choice on Windows.

## P3 — Benchmarks

**Problem.** Memory savings and startup / per-request costs are stated as
copy counts, not measured (`doc/alternatives.md`).

**Done when.** A reproducible benchmark compares worker pools of several
sizes against plain `node:fs` and against a Buffer cache in every worker:
memory, startup, throughput, p95 / p99 request latency, and the cost of an
update and of compression. The docs cite its results.

## P3 — One copy fewer for `Uint8Array` preparer results

**Problem.** A `Uint8Array` a preparer returns is copied twice: into an
owned canonical Buffer, then into its provisional SAB allocation.

**Cause.** The first copy takes ownership — the caller may still change the
array, and a view may cover part of an `ArrayBuffer` with a lifetime of
its own; the second is the one publication path of strings, Buffers and
arrays, which rollback, index-at-flush, `fs.script` compilation,
companions and atomic publication rely on.

**Done when.** A benchmark measures the publication of large `Uint8Array`
results; only if it justifies it, they are written straight into the
provisional allocation, with rollback and ownership guarantees kept and no
regression for Buffer and string results.

## P3 — Public diagnostics

**Problem.** Only the internal `retirements()` shows what the kernel holds.
Pool usage and fragmentation, bytes waiting to be freed, ACK age (a stuck
worker), disk-fallback counts and preparation failures are not observable.

**Cause.** A public `stats()` was deliberately left out of the lifetime
work.

**Done when.** A documented, read-only API reports these metrics, a test
shows a stuck worker through it, and the API never frees or changes
anything.

## P3 — Preparation regression tests

**Problem.** Two guarantees hold by construction but have no test: a new
file in a new directory gets its prepared source and its bytecode in one
`vfs-update`, and compaction keeps a prepared source and its companions
together.

**Done when.** Both are pinned in `test/prepare.test.js`, driven by manual
watcher epochs and a forced compaction.

## P3 — Diagnostics of `prepare` conflicts inside one domain

**Problem.** When one domain's object form assigns an extension to several
preparers, the config error names only the first two; across domains it
names every declaration.

**Done when.** The error lists every declaration of the extension, with a
test for three or more.

## P3 — `fs.fallback: 'disk'` on a place without `fs.ext`

**Problem.** Without strict, a disk-origin place with no `fs.ext` resolves
`fs.fallback` to `'disk'` (its permissive reads), yet the same value set
explicitly is a config error ("needs a finite ext list"). A resolved config
should be valid input.

**Done when.** Either the explicit value is accepted with that meaning, or
the default resolves to another value — decided, documented and tested.

## P3 — glob and virtual entries

**Problem.** glob captures the `node:fs` functions it walks with when it is
loaded: loaded after the patch it walks the places (virtual entries show,
filtered by route); loaded before, it walks the disk natively (they never
show). Which one an application gets depends on load order.

**Done when.** One behavior is chosen and documented — e.g. glob always
lists through the places — with a test for both load orders.

## P3 — TypeScript declarations

**Problem.** The public API has no type declarations.

**Done when.** Declarations cover the public API (`VfsConfig`, `VfsKernel`,
`PlaceFs`, `attach`) and a type check runs in CI.

## After the next Node.js 26.x release — `doc/alternatives.md`

**Problem.** The comparison describes Node v26.10.0; `main` already removes
`--vfs-mount` (nodejs/node#66162) and adds SEA `vfsArchive`
(nodejs/node#65810).

**Done when.** The page matches the released documentation.
