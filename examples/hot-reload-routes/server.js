'use strict';

// hot-reload-routes — minimal HTTP server whose route handlers live in a
// memory-backed VFS place. An "AI agent" (here: a setInterval) writes new
// route files via `kernel.fs('routes').writeFile`. The module hook makes
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
const { VfsConfig, VfsKernel } = require('../..');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const moduleHook = require('../../lib/adapters/module-hook.js');

const APP_ROOT = __dirname;
const ROUTES_DIR = path.join(APP_ROOT, 'routes');
const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1';

const config = new VfsConfig({
  defaults: {
    memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
  },
  places: {
    routes: { provider: 'memory', fs: { writable: true }, require: true },
  },
});

const kernel = new VfsKernel(config, { appRoot: APP_ROOT });
const timers = [];
let server;

const writeRoute = (name, source) => {
  kernel.fs('routes').writeFile(`/${name}.js`, source);
  // Evict Node's require cache so the next require() recompiles.
  const abs = path.join(ROUTES_DIR, `${name}.js`);
  delete require.cache[abs];
};

const loadRoute = (name) => {
  const abs = path.join(ROUTES_DIR, `${name}.js`);
  try {
    return require(abs);
  } catch (error) {
    void error;
    return null;
  }
};

const closeKernel = () => {
  try {
    fsPatch.uninstall();
  } catch (error) {
    void error;
  }
  try {
    moduleHook.uninstall();
  } catch (error) {
    void error;
  }
  try {
    kernel.close();
  } catch (error) {
    void error;
  }
};

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    closeKernel();
    process.exit(0);
  };
  if (!server) {
    done();
    return;
  }
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  server.close(done);
  setTimeout(done, 1000).unref();
};

(async () => {
  await kernel.initialize();
  fsPatch.install(kernel);
  moduleHook.install(kernel);

  // Seed initial route.
  writeRoute(
    'hello',
    `'use strict';
module.exports = (req, res) => {
  res.end('hello from hot-reloaded route\\n');
};`,
  );

  server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/^\//, '') || 'hello';
    const handler = loadRoute(name);
    if (!handler) {
      res.statusCode = 404;
      return res.end('no such route\n');
    }
    return handler(req, res);
  });

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  server.listen(PORT, HOST, () => {
    const port = server.address().port;
    console.log(`listening on http://${HOST}:${port}`);
    console.log('routes directory (virtual): ' + ROUTES_DIR);
  });

  // Simulated AI agent: drop new routes into the VFS at runtime.
  timers.push(
    setTimeout(() => {
      writeRoute(
        'time',
        `'use strict';
module.exports = (req, res) => {
  res.end('server time: ' + new Date().toISOString() + '\\n');
};`,
      );
      console.log('[agent] wrote /time route');
    }, 2000),
  );

  timers.push(
    setTimeout(() => {
      writeRoute(
        'echo',
        `'use strict';
module.exports = (req, res) => {
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  res.end(JSON.stringify(q) + '\\n');
};`,
      );
      console.log('[agent] wrote /echo route');
    }, 4000),
  );

  // Hot-update an existing route.
  timers.push(
    setTimeout(() => {
      writeRoute(
        'hello',
        `'use strict';
module.exports = (req, res) => {
  res.end('updated hello! ' + Date.now() + '\\n');
};`,
      );
      console.log('[agent] updated /hello route');
    }, 6000),
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
