'use strict';

// A worker of worker-static: attaches to the kernel of the main thread and
// serves the shared bytes over HTTP. Nothing is copied into the worker:
// responses are written straight from SharedArrayBuffer views, so each one
// holds a lease (or a pinned stream) until the socket is done with it.

const http = require('node:http');
const { finished, pipeline } = require('node:stream');
const { parentPort, workerData } = require('node:worker_threads');
const { attach } = require('../..');

const kernel = attach();
const { id, port } = workerData;

const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

// `/live/...` is the virtual place; everything else is `public/`.
const resolve = (url) => {
  const key = decodeURIComponent(url.split('?')[0]);
  if (key.startsWith('/live/')) return [kernel.fs('live'), key.slice(5)];
  return [kernel.fs('public'), key === '/' ? '/index.html' : key];
};

// The first encoding the client accepts among those actually stored.
const encodingFor = (files, key, accept = '') => {
  const stored = files.storedEncodings(key);
  return ['br', 'gzip'].find(
    (enc) => accept.includes(enc) && stored.includes(enc),
  );
};

// `bytes=start-end` / `bytes=start-` / `bytes=-suffix` → [start, end] or null.
const rangeOf = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || size === 0) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;
  const start = from === '' ? Math.max(0, size - Number(to)) : Number(from);
  const end =
    from === '' || to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start <= end && start < size ? [start, end] : null;
};

// A zero-copy stream holds its version until release(): the socket may
// still be writing its last chunks when the stream itself has ended.
const sendRange = (files, key, res, [start, end], size) => {
  res.writeHead(206, {
    'content-range': `bytes ${start}-${end}/${size}`,
    'content-length': end - start + 1,
  });
  const stream = files.createReadStream(key, { start, end });
  pipeline(stream, res, () => stream.release());
};

// A lease keeps the view stable until the response is finished or the
// client is gone.
const sendView = (lease, res, headers) => {
  finished(res, () => lease.release());
  res.writeHead(200, { ...headers, 'content-length': lease.view.length });
  res.end(lease.view);
};

const server = http.createServer((req, res) => {
  const [files, key] = resolve(req.url);
  const stat = files.stat(key);
  if (!stat || stat.isDirectory()) {
    res.writeHead(404);
    return void res.end('not found\n');
  }
  const ext = key.split('.').pop();
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('x-worker', String(id));
  const range = rangeOf(req.headers.range, stat.size);
  if (range) return void sendRange(files, key, res, range, stat.size);
  const encoding = encodingFor(files, key, req.headers['accept-encoding']);
  if (encoding) {
    const lease = files.readFileCompressedView(key, encoding);
    const headers = { 'content-encoding': encoding, vary: 'Accept-Encoding' };
    return void sendView(lease, res, headers);
  }
  const lease = files.readFileView(key);
  if (lease) return void sendView(lease, res, {});
  // Larger than maxFileSize: kept on disk, streamed from there.
  res.writeHead(200, { 'content-length': stat.size });
  const stream = files.createReadStream(key);
  pipeline(stream, res, () => stream.release());
});

server.listen(port, '127.0.0.1', () => {
  parentPort.postMessage(`http://127.0.0.1:${server.address().port}`);
});
