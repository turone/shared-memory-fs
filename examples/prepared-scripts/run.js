'use strict';

// prepared-scripts — `prepare` + `fs.script` across threads.
//
// A handler is a bare function body in a `.handler` file. The `handler`
// preparer turns it, once, into a function expression — the canonical
// content every thread sees — and `fs.script.compile` builds V8 cached data
// from that prepared source. A worker runs the handlers with `vm.Script`
// and the shared cached data, then writes a new handler into a
// `sab + virtual` place: the main thread prepares and compiles it and
// publishes it to every thread before the worker's write resolves.
//
// Run:
//   node examples/prepared-scripts/run.js

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsConfig, VfsKernel } = require('../..');

const APP_ROOT = __dirname;

// Handler sources, prepared: the extension stays `.handler`, the content
// becomes `(function (name) { … })`, V8 gets a filename for stack traces.
const handler = (raw, file) => ({
  source: `(function (name) {\n${raw.toString().trim()}\n})`,
  scriptOptions: { filename: file.path },
  meta: { handler: path.basename(file.key, '.handler') },
});

const script = { ext: ['handler'], compile: true };

const config = new VfsConfig({
  defaults: {
    memory: { limit: '4 mib', segmentSize: '1 mib', maxFileSize: '256 kib' },
  },
  places: {
    // Read from disk at start.
    handlers: { fs: { ext: ['handler'], prepare: 'handler', script } },
    // Written by the application — here, by the worker.
    rules: {
      origin: 'virtual',
      fs: { writable: true, ext: ['handler'], prepare: 'handler', script },
    },
  },
});

const kernel = new VfsKernel(config, {
  appRoot: APP_ROOT,
  preparers: { handler },
});

(async () => {
  await kernel.initialize();
  const { vfs, transferList } = kernel.link();
  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { vfs },
    transferList,
  });
  worker.on('message', (line) => console.log(line));
  const [code] = await new Promise((resolve, reject) => {
    worker.once('exit', (exitCode) => resolve([exitCode]));
    worker.once('error', reject);
  });
  // The worker's write went through the main thread's pipeline.
  const greet = kernel.fs('rules').script('/greet.handler');
  console.log(
    `main thread sees rules/greet.handler as ${greet.source.split('\n')[0]}…`,
  );
  kernel.close();
  process.exitCode = code;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
