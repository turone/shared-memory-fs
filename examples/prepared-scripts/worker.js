'use strict';

// The worker of prepared-scripts: never prepares or compiles anything
// itself. `PlaceFs.script()` hands it the prepared source, the V8 cached
// data built from exactly that source, and the preparer's scriptOptions.

const vm = require('node:vm');
const { parentPort } = require('node:worker_threads');
const { attach } = require('../..');

const kernel = attach();

// Build a function from a prepared bundle and call it.
const run = (place, key, name) => {
  const { source, cachedData, scriptOptions, meta } = kernel
    .fs(place)
    .script(key);
  const script = new vm.Script(source, { ...scriptOptions, cachedData });
  const cache = script.cachedDataRejected ? 'rejected' : 'accepted';
  const result = script.runInThisContext()(name);
  parentPort.postMessage(
    `${place}${key} (${meta.handler}) -> ${result} (cached data ${cache})`,
  );
};

(async () => {
  for (const file of kernel.fs('handlers').readdir('/')) {
    run('handlers', `/${file}`, 'world');
  }
  // A write from a worker: the main thread prepares, compiles and publishes
  // it; the update reaches this thread before the Promise resolves.
  await kernel.fs('rules').writeFile('/greet.handler', 'return `hi ${name}`;');
  run('rules', '/greet.handler', 'world');
})().catch((err) => {
  parentPort.postMessage(`error: ${err.message}`);
  process.exitCode = 1;
});
