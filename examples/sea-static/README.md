# sea-static

Static HTTP server whose assets live in a `provider: 'sab'` place when
running with plain `node`, and in `provider: 'sea'` (assets baked into a
single executable) when packaged with Node SEA.

## Run from source (sab provider)

```
node examples/sea-static/server.js
curl http://localhost:3000/
```

The place reads `pub/index.html`, `pub/style.css`, `pub/app.js` from disk into
SAB segments at startup. After that, every HTTP request is served zero-copy
from the SAB.

## Build a single-executable application (sea provider)

Reference: [Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html).

```
# 1. Generate the blob with assets included
node --experimental-sea-config examples/sea-static/sea-config.json

# 2. Copy the node binary
cp $(which node) examples/sea-static/sea-static.exe

# 3. Inject the blob (Linux/macOS — see Node docs for Windows / signing)
npx postject examples/sea-static/sea-static.exe NODE_SEA_BLOB \
  examples/sea-static/sea-static.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 4. Run
./examples/sea-static/sea-static.exe
```

The same `server.js` detects `node:sea`'s `isSea()` and switches the place
to `provider: 'sea'`, which loads assets from `sea.getAsset(key)` into SAB
at init. The HTTP handler is unchanged.

## What this shows

- One config, two providers — package without rewriting your server code.
- `ext` whitelist (`html, css, js, svg, json`) keeps the `pub/` mount strict
  even on disk; `extOnExtra: 'warn'` reports any drift.
- SEA assets are copied into SAB once at boot, then served zero-copy via the
  same `place.readFile()` API.
