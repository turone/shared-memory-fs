# Backlog

Future project work. Priority: **P1** — strict boundary or correctness,
**P2** — policy gaps and missing implementations, **P3** — improvements.

## P2 — VFS-aware versions of the operations refused today

**Problem.** For managed territory, native operations that walk a tree or
reuse the raw disk file are recognized but unsupported (`ENOTSUP`), so an
application cannot copy, link, watch, walk from above, remove or move
managed content through `node:fs`.

**Cause.** A native operation checks only its top path. The rule in
`doc/architecture.md` (Patched `node:fs`) refuses whatever the kernel cannot
route path by path.

**Done when**, for each operation below, an implementation replaces its
`ENOTSUP` only if it:

- walks only through the filtered listing;
- reads canonical VFS bytes, never the raw disk file;
- writes through the destination's mutation policy;
- supports virtual entries;
- leaves no raw disk bypass;
- holds the strict boundary for every descendant;
- cleans up atomically after a partial failure;

and regression tests cover the sync, callback and promises forms, strict and
non-strict routing, and both fallbacks.

- `cp` / `copyFile` from a managed source, and a recursive `cp` into a tree
  that holds places.
- `link` from a managed source — or a decision that it stays refused, since
  a hard link cannot carry canonical content.
- `watch` of a managed directory and a recursive `watch`: report
  publications or route-filtered events, never hidden names.
- Recursive `readdir` / `opendir` / `watch` from above `appRoot`, or from
  `appRoot` without strict: native levels outside, place listings inside.
- Recursive `rm` / `rmdir` of a tree that holds places: every descendant
  through its own place's mutation policy.
- `rename` of a tree that holds places: likely refused for good — moving
  `appRoot` under a running kernel has no consistent meaning; decide first.

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

**Done when.** A reproducible benchmark compares worker pools of several sizes
against plain `node:fs` (memory, startup, request latency) and the docs cite
its results.

## P3 — TypeScript declarations

**Problem.** The public API has no type declarations.

**Done when.** Declarations cover the public API (`VfsConfig`, `VfsKernel`,
`PlaceFs`, `attach`) and a type check runs in CI.

## After the next Node.js 26.x release — `doc/alternatives.md`

**Problem.** The comparison describes Node v26.10.0; `main` already removes
`--vfs-mount` (nodejs/node#66162) and adds SEA `vfsArchive`
(nodejs/node#65810).

**Done when.** The page matches the released documentation.
