'use strict';

// worker-static — static HTTP served by several worker threads from ONE copy
// of the files in shared memory. The main thread owns the kernel: it loads
// `public/` into SAB, builds br / gzip representations once, watches the
// directory and publishes every change to all workers; it also writes a
// small virtual file, `/live/stats.json`, every half second. Each worker
// attaches to the same memory and runs its own HTTP server (see worker.js).
//
// Run:
//   node examples/worker-static/server.js
// then open the URLs it prints, or:
//   curl -H 'Accept-Encoding: br' http://127.0.0.1:<port>/app.js | brotli -d
//   curl -H 'Range: bytes=0-15' http://127.0.0.1:<port>/app.js
//   curl http://127.0.0.1:<port>/live/stats.json

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsConfig, VfsKernel } = require('../..');

const APP_ROOT = __dirname;
const WORKERS = Number(process.env.WORKERS || 2);
const PORT = Number(process.env.PORT || 3000);

const config = new VfsConfig({
  defaults: {
    memory: { limit: '8 mib', segmentSize: '1 mib', maxFileSize: '512 kib' },
    watch: true,
    watchTimeout: 100,
  },
  places: {
    // origin 'disk': scanned at start, republished by the watcher.
    public: {
      fs: {
        ext: ['html', 'css', 'js', 'svg', 'txt'],
        zeroCopy: true,
        compress: { encodings: ['br', 'gzip'], ext: 'compressible' },
      },
    },
    // origin 'virtual': content written by the application only.
    live: {
      origin: 'virtual',
      fs: { writable: true, ext: ['json'], zeroCopy: true },
    },
  },
});

const kernel = new VfsKernel(config, { appRoot: APP_ROOT });
const workers = [];
let ticker = null;

const shutdown = async () => {
  clearInterval(ticker);
  await Promise.all(workers.map((worker) => worker.terminate()));
  kernel.close();
  process.exit(0);
};

(async () => {
  await kernel.initialize();
  const live = kernel.fs('live');
  let tick = 0;
  const publish = () =>
    live.writeFile(
      '/stats.json',
      JSON.stringify({ tick: tick++, time: new Date().toISOString() }),
    );
  await publish();
  ticker = setInterval(publish, 500);

  for (let id = 1; id <= WORKERS; id++) {
    // One link per worker: snapshot, config and a private port for updates.
    const { vfs, transferList } = kernel.link();
    const port = PORT === 0 ? 0 : PORT + id - 1;
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { vfs, id, port },
      transferList,
    });
    worker.on('message', (url) => {
      console.log(`worker ${id} listening on ${url}`);
    });
    worker.on('error', (err) => {
      console.error(`worker ${id}:`, err);
      process.exitCode = 1;
    });
    workers.push(worker);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
