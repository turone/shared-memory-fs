# worker-static

Static HTTP served by several worker threads from **one** copy of the files
in shared memory.

The main thread owns the kernel: it loads `public/` into SAB segments,
builds `br` and `gzip` representations once, watches the directory, and
publishes every change to all workers. It also rewrites a virtual file,
`/live/stats.json`, every half second. Each worker calls `attach()` on its
own link and runs an HTTP server over the same memory.

## Run

```
node examples/worker-static/server.js
```

It prints one URL per worker (`WORKERS=2`, ports from `PORT=3000`; `PORT=0`
picks free ports). Then:

```
curl -i http://127.0.0.1:3000/
curl -H 'Accept-Encoding: br' -o app.js.br http://127.0.0.1:3000/app.js
curl -i -H 'Range: bytes=0-15' http://127.0.0.1:3001/app.js
curl http://127.0.0.1:3001/live/stats.json
```

Edit a file under `public/` while the server runs: after the watcher
debounce every worker serves the new version (and its new compressed
representations) — a request that was already streaming the old version
finishes with it.

## What this shows

- `kernel.link()` per worker, `attach()` inside it: one physical copy of the
  files, zero-copy views in every thread.
- **Leases**: `readFileView()` / `readFileCompressedView()` hand out a
  direct SAB view; the worker releases it with `finished(res, …)`, because
  the socket may still be writing it after `res.end()` returns.
- **Zero-copy streams** for `Range` requests: `pipeline(stream, res, …)`
  releases the stream only once the response is done.
- **Pre-compressed representations**: negotiation stays in the server —
  `storedEncodings()` says what exists.
- **Live updates**: the watcher republishes `public/`, and the main thread
  writes `live` (a `sab + virtual` place) — every worker sees the same
  version at the same moment.
