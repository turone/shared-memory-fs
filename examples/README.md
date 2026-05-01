# Examples

Runnable demos covering the main shared-memory-fs use cases. Each subfolder
is self-contained — no extra build steps unless explicitly noted.

| Example                                  | What it shows                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [hot-reload-routes/](hot-reload-routes/) | `provider: 'memory'` + `require()` hook; HTTP server whose route handlers are written/replaced at runtime by an "AI agent".            |
| [sea-static/](sea-static/)               | One config, two providers: `'sab'` when running with `node`, `'sea'` when packaged with Node SEA. Same HTTP handler in both modes.     |
| [multi-tenant/](multi-tenant/)           | Two memory places under one appRoot + global `strict: true` whitelist; demonstrates the boundary `strict` enforces and where it stops. |

These examples are docs-grade — they are not part of `npm test`. They are
verified manually against the public API.

## Common setup

All examples import shared-memory-fs as a sibling of this folder:

```js
const { VfsConfig, VFSKernel } = require('../..');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const requireHook = require('../../lib/adapters/require-hook.js');
```

If you copy an example out of the repo, replace those two paths with
`require('shared-memory-fs')` and `require('shared-memory-fs/lib/adapters/...')`
or expose the adapters from your own preset module.
