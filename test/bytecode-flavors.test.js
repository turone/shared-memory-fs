'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { bytecodeKey } = require('../lib/companion.js');
const { tmpDir, rm, kernel } = require('./helpers.js');

// Bytecode flavors: fs.script.compile (bare vm.Script, PlaceFs.script()) and
// require.compile (Module.wrap flavor, consumed by the _compile hook) are
// two independent companions of the same canonical source. See
// /memories/repo/script-domain-handoff.md §"Bytecode flavors".

const wrap = {
  id: (raw, file) => ({
    source: `(${raw.toString().trim()})`,
    scriptOptions: { filename: file.path },
  }),
};

const runInWorker = (code, workerData, transferList) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData, transferList });
    worker.once('message', resolve);
    worker.once('error', reject);
  });

describe('bytecode flavors: coexistence', () => {
  it('only fs.script.compile is configured: only the script companion exists', async () => {
    const root = tmpDir('bc-script-only');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, script: { prepare: 'id', compile: true } },
        },
      },
      {},
      { preparers: wrap },
    );
    await k.fs('v').writeFile('/h.js', '({ user }) => `hi ${user}`');
    const place = k.registry.get('v');
    assert.notEqual(place.bytecode('/h.js', 'script'), null);
    assert.equal(place.bytecode('/h.js', 'require'), null);
    assert.equal(place.files.has(bytecodeKey('/h.js', 'require')), false);
    k.close();
    rm(root);
  });

  it('only require.compile is configured: only the require companion exists', async () => {
    const root = tmpDir('bc-require-only');
    const k = await kernel(root, {
      v: {
        origin: 'virtual',
        fs: { writable: true },
        require: { compile: true },
      },
    });
    await k.fs('v').writeFile('/h.js', 'module.exports = 1;');
    const place = k.registry.get('v');
    assert.equal(place.bytecode('/h.js', 'script'), null);
    assert.notEqual(place.bytecode('/h.js', 'require'), null);
    assert.equal(place.files.has(bytecodeKey('/h.js', 'script')), false);
    k.close();
    rm(root);
  });

  it('both flags on one prepared source: two distinct companions, one canonical entry', async () => {
    const root = tmpDir('bc-both');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, script: { prepare: 'id', compile: true } },
          require: { compile: true },
        },
      },
      {},
      { preparers: wrap },
    );
    await k.fs('v').writeFile('/h.js', '({ user }) => `hi ${user}`');
    const place = k.registry.get('v');
    const scriptCode = place.bytecode('/h.js', 'script');
    const requireCode = place.bytecode('/h.js', 'require');
    assert.notEqual(scriptCode, null);
    assert.notEqual(requireCode, null);
    assert.equal(
      Buffer.from(scriptCode).equals(Buffer.from(requireCode)),
      false,
      'script and require bytecode are different bytes',
    );
    const sourceKeys = [...place.files.keys()].filter((key) => key === '/h.js');
    assert.equal(sourceKeys.length, 1, 'canonical source stored once');

    // Both cached data are accepted by their own consumer in another isolate.
    const bundle = k.fs('v').script('/h.js');
    const scriptResult = await runInWorker(
      `
      const vm = require('node:vm');
      const { parentPort, workerData } = require('node:worker_threads');
      const s = new vm.Script(workerData.source, { ...workerData.scriptOptions, cachedData: workerData.cachedData });
      parentPort.postMessage({ rejected: s.cachedDataRejected, result: s.runInThisContext()({ user: 'ann' }) });
      `,
      {
        source: bundle.source,
        scriptOptions: bundle.scriptOptions,
        cachedData: bundle.cachedData,
      },
    );
    assert.equal(scriptResult.rejected, false);
    assert.equal(scriptResult.result, 'hi ann');

    const { vfs, transferList } = k.link();
    const requireResult = await runInWorker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
      const kern = attach();
      const Module = require('node:module');
      const vm = require('node:vm');
      const filePath = kern.fs('v').pathOf('/h.js');
      const src = kern.fs('v').readFile('/h.js', 'utf8');
      const s = new vm.Script(Module.wrap(src), { filename: filePath, cachedData: kern.bytecode(filePath) });
      parentPort.postMessage({ rejected: s.cachedDataRejected });
      `,
      { vfs },
      transferList,
    );
    assert.equal(
      requireResult.rejected,
      false,
      'cachedDataRejected === false for the require flavor',
    );

    k.close();
    rm(root);
  });

  // No cross-feed assertion on purpose. In a clean isolate V8 *does* reject
  // cached data built from a differently wrapped source — but only because
  // the wrapper changes the source length, which is the heuristic
  // test/script.test.js ("V8 cached data facts") pins down: acceptance is
  // not a content check, and it is masked entirely once the same isolate has
  // already compiled the source. Such a test would therefore assert V8's
  // behaviour, not the library's. The real guard is structural: the flavors
  // are separate companions (`\0script:bytecode` / `\0require:bytecode`) and
  // `PlaceFs.script()` / the `_compile` hook each read only their own,
  // proven above ("only … exists", "both flags").
});

describe('bytecode flavors: failure and rollback', () => {
  it('require.compile failure leaves a valid fs.script bundle published', async () => {
    const root = tmpDir('bc-require-fail');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, script: { prepare: 'id', compile: true } },
          require: { compile: true },
        },
      },
      {},
      {
        preparers: {
          // `let exports` redeclares the CommonJS wrapper's own `exports`
          // parameter (Module.wrap embeds the source in a function whose
          // first parameter is `exports`) — a SyntaxError only once wrapped.
          // As a bare vm.Script (fs.script, no wrapper) it compiles fine.
          id: () => 'let exports = 1;',
        },
      },
    );
    await k.fs('v').writeFile('/h.js', 'anything');
    const place = k.registry.get('v');
    assert.notEqual(place.bytecode('/h.js', 'script'), null);
    assert.equal(place.bytecode('/h.js', 'require'), null);
    assert.equal(k.fs('v').readFile('/h.js', 'utf8'), 'let exports = 1;');
    k.close();
    rm(root);
  });

  it('fs.script.compile failure rejects the whole publication and keeps the previous version', async () => {
    const root = tmpDir('bc-script-fail');
    let broken = false;
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, script: { prepare: 'id', compile: true } },
        },
      },
      {},
      {
        preparers: {
          id: (raw) =>
            broken ? '{ not valid js (((' : `(${raw.toString().trim()})`,
        },
      },
    );
    const v = k.fs('v');
    await v.writeFile('/h.js', '({ user }) => `hi ${user}`');
    const before = k.cache.stats().totalUsed;
    broken = true;
    await assert.rejects(v.writeFile('/h.js', 'x => x'));
    const after = k.cache.stats().totalUsed;
    assert.equal(after, before, 'no leaked allocation from the failed attempt');
    assert.equal(
      v.readFile('/h.js', 'utf8'),
      '(({ user }) => `hi ${user}`)',
      'previous version still served',
    );
    // The queue recovers: a following good write succeeds.
    broken = false;
    await v.writeFile('/h.js', 'x => x * 2');
    assert.equal(v.readFile('/h.js', 'utf8'), '(x => x * 2)');
    k.close();
    rm(root);
  });
});
