# multi-tenant

Two memory-backed places (`tenant-a`, `tenant-b`) under one appRoot, plus
global `strict: true`.

## Run

```
node examples/multi-tenant/run.js
```

Expected output:

```
-- 1. each tenant runs and reads its own file --
  [A] own data.txt: tenant-a secret
  [B] own data.txt: tenant-b secret
-- 2. strict: appRoot is the sandbox boundary --
  read config.local.json -> EACCES
  read README.md -> EACCES
-- 3. paths OUTSIDE appRoot are unaffected by strict --
  stat(os.tmpdir()) -> ok (passthrough)
```

## What this shows

- **Multiple memory places coexist** under one `VfsKernel`. Each gets its own
  writable Map and its own directory under `appRoot`.
- **`strict: true` makes appRoot the boundary:** every path under `appRoot`
  that no place owns gets `EACCES` from the patched fs — at any depth, file or
  directory alike, for reads, listings, copies and `watch` alike. Put the entry
  point and `package.json` outside `appRoot`, or in an explicit
  `node-default` / `disk` place.
- **Strict does NOT firewall same-process places from each other.** In one
  process, tenant-A's code calling `fs.readFileSync('/.../tenant-b/x')` will
  succeed — both mounts belong to the kernel. For real cross-tenant isolation
  spawn each tenant in its own worker_thread and pass only that tenant's
  place via `kernel.link()`.
- **Paths outside `appRoot` pass through unchanged**, so workers can still
  hit `/tmp`, system libraries, etc.
