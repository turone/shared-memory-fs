'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { createBytecode } = require('../lib/pipeline.js');
const { bytecodeKey } = require('../lib/companion.js');
const { tmpDir, writeTree, rm, kernel, until, tap } = require('./helpers.js');

// Facts about V8 cached data fs.script relies on (doc/architecture.md,
// "Publication" and "Preparation"); if any of these ever fails on a new
// Node line, those decisions must be revisited.

const SOURCE = [
  '// leading comment keeps positions non-trivial',
  '(function handler({ user }) {',
  '  const greet = (name) => `hello ${name}`;',
  '  return greet(user);',
  '})',
].join('\n');

// Consume `cachedData` for `source` under `options` in a fresh isolate;
// resolves { rejected, result }.
const consumeInWorker = (source, cachedData, options) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const vm = require('node:vm');
      const { parentPort, workerData } = require('node:worker_threads');
      const { source, cachedData, options } = workerData;
      const script = new vm.Script(source, { ...options, cachedData });
      parentPort.postMessage({
        rejected: script.cachedDataRejected,
        result: script.runInThisContext()({ user: 'ann' }),
      });
      `,
      { eval: true, workerData: { source, cachedData, options } },
    );
    worker.once('message', resolve);
    worker.once('error', reject);
  });

describe('V8 cached data facts (script domain)', () => {
  it('is accepted across isolates regardless of filename/line/column offsets', async () => {
    const produced = createBytecode(SOURCE, {
      filename: 'D:/app/api/users/get.js',
      lineOffset: 0,
      columnOffset: 0,
    });
    assert.ok(Buffer.isBuffer(produced) && produced.length > 0);

    const variants = [
      {},
      { filename: 'evalmachine.<anonymous>' },
      { filename: '/srv/other/place/renamed.js' },
      { filename: 'x.js', lineOffset: 17 },
      { filename: 'x.js', columnOffset: 9 },
      { filename: 'y.js', lineOffset: -1, columnOffset: 3 },
    ];
    for (const options of variants) {
      const { rejected, result } = await consumeInWorker(
        SOURCE,
        produced,
        options,
      );
      assert.equal(rejected, false, JSON.stringify(options));
      assert.equal(result, 'hello ann');
    }
  });

  // V8 validates cached data against the source *length* (plus version and
  // flags), not its content: a same-length divergent source is silently
  // accepted. That is why the VFS publishes the prepared source as the
  // canonical content and never lets source and companion drift apart.
  it('is rejected for a source of a different length (control)', async () => {
    const produced = createBytecode(SOURCE, {});
    const other = SOURCE.replace('hello', 'good evening');
    const { rejected, result } = await consumeInWorker(other, produced, {});
    assert.equal(rejected, true);
    assert.equal(result, 'good evening ann');
  });

  it('createBytecode honours scriptOptions in the same isolate', () => {
    const options = { filename: 'z.js', lineOffset: 3 };
    const data = createBytecode(SOURCE, options);
    const script = new vm.Script(SOURCE, { ...options, cachedData: data });
    assert.equal(script.cachedDataRejected, false);
    const bad = createBytecode('syntax error here (', options);
    assert.equal(bad, null);
  });
});

// Live reload through the real pipeline: preparer → SAB → script bytecode →
// one vfs-update → linked worker. Two versions of identical length are the
// hard case: V8 would accept the stale cached data for the new source, so
// only the epoch discipline (source and companion replaced together)
// guarantees the worker runs the new code.
describe('script domain: live reload in a linked worker', () => {
  const V1 = '({ user }) => `hello ${user}`';
  const V2 = '({ user }) => `howdy ${user}`';
  assert.equal(V1.length, V2.length);

  const WORKER = `
    const vm = require('node:vm');
    const { parentPort } = require('node:worker_threads');
    const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
    const kernel = attach();
    parentPort.on('message', (key) => {
      const bundle = kernel.fs('api').script(key);
      const script = new vm.Script(bundle.source, {
        ...bundle.scriptOptions,
        cachedData: bundle.cachedData,
      });
      parentPort.postMessage({
        source: bundle.source,
        hasCachedData: bundle.cachedData !== null,
        rejected: script.cachedDataRejected,
        result: script.runInThisContext()({ user: 'ann' }),
      });
    });
    parentPort.postMessage('ready');
  `;

  let root;
  let k;
  let worker;
  let observer;
  const at = (...p) => path.join(root, 'api', ...p);

  const ask = (key) =>
    new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage(key);
    });

  before(async () => {
    root = writeTree(tmpDir('script-live'), { 'api/h.js': V1 });
    k = await kernel(
      root,
      { api: { fs: { ext: ['js', 'cjs'], prepare: 'wrap', script: true } } },
      { watch: true, watchTimeout: 60 },
      {
        preparers: {
          wrap: (raw, file) => ({
            source: `(${raw.toString().trim()})`,
            scriptOptions: { filename: file.path },
          }),
        },
      },
    );
    observer = tap(k);
    const { vfs, transferList } = k.link();
    worker = new Worker(WORKER, {
      eval: true,
      workerData: { vfs },
      transferList,
    });
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  });

  after(async () => {
    await worker.terminate();
    k.close();
    rm(root);
  });

  // `/h.js` itself holds the prepared source; raw bytes exist only on disk.
  const assertPrepared = (raw, bundleSource) => {
    const prepared = `(${raw})`;
    assert.equal(fs.readFileSync(at('h.js'), 'utf8'), raw, 'disk keeps raw');
    assert.equal(k.fs('api').readFile('/h.js', 'utf8'), prepared, 'SAB entry');
    assert.equal(bundleSource, prepared, 'worker bundle');
    assert.notEqual(bundleSource, raw);
  };

  it('runs the initial prepared bundle with accepted cached data', async () => {
    const r = await ask('/h.js');
    assertPrepared(V1, r.source);
    assert.equal(r.hasCachedData, true);
    assert.equal(r.rejected, false, 'cache compatible with this V8');
    assert.equal(r.result, 'hello ann');
  });

  it('same-length edit: worker runs the new code after the epoch', async () => {
    fs.writeFileSync(at('h.js'), V2);
    await until(
      () => k.fs('api').readFile('/h.js', 'utf8') === `(${V2})`,
      4000,
    );
    // The worker has applied the delta once its ACK released the old bytes.
    await until(() => k.acks.size === 0 && k.retired.size === 0, 4000);

    const msg = observer.updates().at(-1);
    const keys = msg.places.api.entries.map(([key]) => key).sort();
    assert.deepEqual(keys, ['/h.js', bytecodeKey('/h.js', 'script')].sort());

    const r = await ask('/h.js');
    assertPrepared(V2, r.source);
    assert.equal(r.hasCachedData, true);
    assert.equal(r.rejected, false, 'compatibility only, not a source check');
    assert.equal(r.result, 'howdy ann');
  });
});
