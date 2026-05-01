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
-- 2. strict: path under appRoot but outside any place --
  read stray -> EACCES (strict mode working)
-- 3. paths OUTSIDE appRoot are unaffected by strict --
  stat(os.tmpdir()) -> ok (passthrough)
```

## What this shows

- **Multiple memory places coexist** under one `VFSKernel`. Each gets its own
  writable Map and its own mount under `appRoot`.
- **`strict: true` whitelist behaviour:** any path under `appRoot` that no
  place owns gets `EACCES` from the patched fs. This catches accidental
  reads of build artefacts, `.env` files, or stray dev fixtures.
- **Strict does NOT firewall same-process places from each other.** In one
  process, tenant-A's code calling `fs.readFileSync('/.../tenant-b/x')` will
  succeed — both mounts belong to the kernel. For real cross-tenant isolation
  spawn each tenant in its own worker_thread and pass only that tenant's
  place via `kernel.snapshot()`.
- **Paths outside `appRoot` pass through unchanged**, so workers can still
  hit `/tmp`, system libraries, etc.
