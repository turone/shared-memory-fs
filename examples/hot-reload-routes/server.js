'use strict';

// hot-reload-routes — minimal HTTP server whose route handlers live in a
// memory-backed VFS place. An "AI agent" (here: a setInterval) writes new
// route files via `place.writeFile`. The patched fs + require-hook make
// them immediately requirable; old require-cache entries are evicted via
// `delete require.cache[absPath]` so each request picks up fresh code.
//
// Run:
//   node examples/hot-reload-routes/server.js
//
// In another terminal:
//   curl http://localhost:3000/hello   # served by initial route
//   curl http://localhost:3000/time    # written 2 s after start
//   curl http://localhost:3000/echo?x=1  # written 4 s after start

const http = require('node:http');
const path = require('node:path');
const { VfsConfig, VFSKernel } = require('../..');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const requireHook = require('../../lib/adapters/require-hook.js');

const APP_ROOT = __dirname;
const ROUTES_DIR = path.join(APP_ROOT, 'routes');

const config = new VfsConfig({
  defaults: {
    memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
    hooks: { fs: false, require: false, import: false },
  },
  places: {
    routes: {
      domains: ['fs', 'require'],
      match: { dir: 'routes' },
      provider: 'memory',
    },
  },
});

const kernel = new VFSKernel(config, { appRoot: APP_ROOT });

const writeRoute = (name, source) => {
  const place = kernel.getPlace('routes');
  place.writeFile(`/${name}.js`, Buffer.from(source));
  // Evict Node's require cache so the next require() recompiles.
  const abs = path.join(ROUTES_DIR, `${name}.js`);
  delete require.cache[abs];
};

const loadRoute = (name) => {
  const abs = path.join(ROUTES_DIR, `${name}.js`);
  try {
    return require(abs);
  } catch {
    return null;
  }
};

(async () => {
  await kernel.initialize();
  fsPatch.install(kernel);
  requireHook.install(kernel);

  // Seed initial route.
  writeRoute(
    'hello',
    `'use strict';
module.exports = (req, res) => {
  res.end('hello from hot-reloaded route\\n');
};`,
  );

  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '') || 'hello';
    const handler = loadRoute(name);
    if (!handler) {
      res.statusCode = 404;
      return res.end('no such route\n');
    }
    return handler(req, res);
  });

  server.listen(3000, () => {
    console.log('listening on http://localhost:3000');
    console.log('routes directory (virtual): ' + ROUTES_DIR);
  });

  // Simulated AI agent: drop new routes into the VFS at runtime.
  setTimeout(() => {
    writeRoute(
      'time',
      `'use strict';
module.exports = (req, res) => {
  res.end('server time: ' + new Date().toISOString() + '\\n');
};`,
    );
    console.log('[agent] wrote /time route');
  }, 2000);

  setTimeout(() => {
    writeRoute(
      'echo',
      `'use strict';
const url = require('node:url');
module.exports = (req, res) => {
  const q = url.parse(req.url, true).query;
  res.end(JSON.stringify(q) + '\\n');
};`,
    );
    console.log('[agent] wrote /echo route');
  }, 4000);

  // Hot-update an existing route.
  setTimeout(() => {
    writeRoute(
      'hello',
      `'use strict';
module.exports = (req, res) => {
  res.end('updated hello! ' + Date.now() + '\\n');
};`,
    );
    console.log('[agent] updated /hello route');
  }, 6000);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
