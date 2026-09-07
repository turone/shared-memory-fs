'use strict';

// sea-static — HTTP server that serves static files from a SEA-bundled VFS
// place when running as a Single Executable Application, OR from a regular
// directory (`pub/`) when running with plain `node`. The point: same code,
// same place config, swap the provider only when packaging.
//
// Modes:
//   node examples/sea-static/server.js        # provider auto-falls back to disk via sab
//   <built-sea-binary>                         # uses provider:'sea', assets in node:sea
//
// Build SEA binary: see README in this directory.

const http = require('node:http');
const { VfsConfig, VfsKernel } = require('../..');

const APP_ROOT = __dirname;
let isSea = false;
try {
  isSea = require('node:sea').isSea();
} catch {
  isSea = false;
}

const config = new VfsConfig({
  defaults: {
    memory: { limit: '512 kib', segmentSize: '64 kib', maxFileSize: '64 kib' },
  },
  places: {
    pub: {
      provider: isSea ? 'sea' : 'sab',
      fs: { ext: ['html', 'css', 'js', 'svg', 'json'], zeroCopy: true },
    },
  },
});

const kernel = new VfsKernel(config, { appRoot: APP_ROOT });

const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
};

(async () => {
  await kernel.initialize();

  // zeroCopy: the response body is a borrowed view over shared memory —
  // consumed immediately by res.end(), never mutated or retained.
  const pub = kernel.fs('pub');

  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const key = urlPath === '/' ? '/index.html' : urlPath;
    const data = pub.readFileView(key);
    if (!data) {
      res.statusCode = 404;
      return res.end('not found\n');
    }
    const ext = key.split('.').pop();
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
    res.setHeader('content-length', data.length);
    return res.end(data);
  });

  server.listen(3000, () => {
    const mode = isSea ? 'SEA' : 'disk (sab)';
    console.log(`listening on http://localhost:3000 [${mode}]`);
    console.log(`pub entries: ${pub.readdir('/', { recursive: true }).length}`);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
