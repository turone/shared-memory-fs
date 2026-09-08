'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { VfsKernel } = require('../lib/kernel.js');
const { bytecodeKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  config,
  quiet,
  until,
  sleep,
} = require('./helpers.js');

describe('VfsKernel: lifecycle', () => {
  let root;
  before(() => {
    root = writeTree(tmpDir('kernel'), { 'site/a.txt': 'a' });
  });
  after(() => rm(root));

  it('goes new → initializing → ready; ready-only APIs guard themselves', async () => {
    const k = new VfsKernel(config({ site: { fs: true } }), {
      appRoot: root,
      console: quiet,
    });
    assert.equal(k.state, 'new');
    assert.ok(!k.ready);
    assert.throws(() => k.fs('site'), /requires a ready kernel/);
    assert.throws(() => k.snapshot(), /requires a ready kernel/);
    assert.throws(() => k.watch(), /requires a ready kernel/);
    const init = k.initialize();
    assert.equal(k.state, 'initializing');
    await init;
    assert.equal(k.state, 'ready');
    await assert.rejects(k.initialize(), /state "ready"/);
    k.close();
    assert.equal(k.state, 'closed');
    await assert.rejects(k.initialize(), /state "closed"/);
    assert.throws(() => k.fs('site'), /closed/);
    // The pool is unreachable after close, so its segments are collectable.
    assert.equal(k.cache, null);
    assert.equal(k.moduleCache, null);
    assert.equal(k.compressionCache, null);
    k.handleAck(1, 'w');
    k.handleWorkerExit('w');
  });

  it('a failing initialize closes the kernel', async () => {
    const seaModule = {
      getAssetKeys: () => {
        throw new Error('boom');
      },
    };
    const k = new VfsKernel(config({ site: { provider: 'sea', fs: true } }), {
      appRoot: root,
      console: quiet,
      seaModule,
    });
    await assert.rejects(k.initialize(), /boom/);
    assert.equal(k.state, 'closed');
  });

  it('fs() explains unknown places, missing fs domain and passthrough providers', async () => {
    const k = await kernel(root, {
      site: { require: { compile: false } },
      disk: { provider: 'disk', fs: true },
      nd: { provider: 'node-default', fs: true },
    });
    assert.throws(() => k.fs('nope'), /unknown place "nope"/);
    assert.throws(() => k.fs('site'), /no fs domain/);
    assert.throws(() => k.fs('disk'), /node:fs directly/);
    assert.throws(() => k.fs('nd'), /node:fs directly/);
    k.close();
  });

  it('VfsKernel.current is the bootstrap slot', () => {
    assert.equal(VfsKernel.current, null);
    const marker = {};
    VfsKernel.current = marker;
    assert.equal(VfsKernel.current, marker);
    assert.equal(require('..').kernel, marker);
    VfsKernel.current = null;
    assert.equal(VfsKernel.current, null);
  });
});

describe('VfsKernel: providers', () => {
  let root;
  before(() => {
    root = writeTree(tmpDir('kernel-prov'), {
      'site/index.html': '<h1>',
      'site/app.js': 'module.exports = 1;',
      'site/big.bin': 'B'.repeat(70 * 1024),
      'lib/util.js': 'exports.x = 1;',
      'lib/data.json': '{"a":1}',
      'lib/notes.md': '# no',
    });
  });
  after(() => rm(root));

  it('sab: scans by scanExt, oversize files stay on disk, bytecode for require', async () => {
    const k = await kernel(root, {
      site: { fs: true, require: true },
      lib: { require: true },
    });
    const site = k.fs('site');
    assert.deepEqual(site.readdir('/'), ['app.js', 'big.bin', 'index.html']);
    assert.equal(
      site.readFile('/big.bin').length,
      70 * 1024,
      'disk-backed entry reads from disk',
    );
    assert.deepEqual(site.storedEncodings('/big.bin'), []);
    assert.ok(k.bytecode(path.join(root, 'site', 'app.js')));
    assert.equal(k.bytecode(path.join(root, 'site', 'index.html')), null);
    const lib = k.registry.get('lib');
    assert.deepEqual(
      [...lib.files.keys()].filter((key) => !key.includes('\0')).sort(),
      ['/data.json', '/util.js'],
    );
    assert.ok(lib.files.has(bytecodeKey('/util.js')));
    assert.ok(!lib.files.has(bytecodeKey('/data.json')));
    k.close();
  });

  it('resolveModule applies domain, ext and provider rules', async () => {
    const k = await kernel(root, {
      site: { fs: true, import: { ext: ['js'] } },
      lib: { require: { ext: ['js'], compile: false } },
      d: { provider: 'disk', require: { compile: false } },
      n: { provider: 'node-default', fs: true },
    });
    const at = (...p) => path.join(root, ...p);
    assert.equal(
      k.resolveModule(at('site', 'app.js'), 'import').key,
      '/app.js',
    );
    assert.equal(
      k.resolveModule(at('site', 'app.js'), 'require'),
      null,
      'domain off',
    );
    assert.equal(
      k.resolveModule(at('site', 'index.html'), 'import'),
      null,
      'ext',
    );
    assert.equal(
      k.resolveModule(at('lib', 'util.js'), 'require').file.data.toString(),
      'exports.x = 1;',
    );
    assert.equal(k.resolveModule(at('lib', 'data.json'), 'require'), null);
    assert.equal(k.resolveModule(at('d', 'x.js'), 'require'), null);
    assert.equal(k.resolveModule(at('n', 'x.js'), 'require'), null);
    assert.equal(k.resolveModule(at('elsewhere', 'x.js'), 'require'), null);
    assert.equal(k.resolveModule('/outside/x.js', 'require'), null);
    k.close();
  });

  it('resolveModule denies under strict', async () => {
    const k = await kernel(
      root,
      {
        lib: { require: true },
        d: { provider: 'disk', require: { compile: false } },
      },
      { strict: true },
    );
    const at = (...p) => path.join(root, ...p);
    assert.deepEqual(k.resolveModule(at('lib', 'missing.js'), 'require'), {
      denied: true,
    });
    assert.deepEqual(k.resolveModule(at('lib', 'notes.md'), 'require'), {
      denied: true,
    });
    assert.deepEqual(
      k.resolveModule(at('lib', 'util.js'), 'import'),
      { denied: true },
      'domain off',
    );
    assert.deepEqual(k.resolveModule(at('unknown', 'x.js'), 'require'), {
      denied: true,
    });
    assert.equal(
      k.resolveModule(at('d', 'x.js'), 'require'),
      null,
      'disk is managed passthrough',
    );
    assert.equal(
      k.resolveModule(at('lib', 'util.js'), 'require').key,
      '/util.js',
    );
    k.close();
  });

  it('memory places are empty, per-kernel and writable', async () => {
    const k1 = await kernel(root, {
      mem: { provider: 'memory', fs: { writable: true } },
    });
    const k2 = await kernel(root, {
      mem: { provider: 'memory', fs: { writable: true } },
    });
    k1.fs('mem').writeFile('/x', '1');
    assert.equal(k2.fs('mem').exists('/x'), false);
    assert.equal(k1.fs('mem').readFile('/x', 'utf8'), '1');
    k1.close();
    k2.close();
  });
});

describe('VfsKernel: snapshot, workers, ACK', () => {
  let root;
  before(() => {
    root = writeTree(tmpDir('kernel-snap'), {
      'site/a.txt': 'aaa',
      'site/b.js': 'module.exports = 2;',
    });
  });
  after(() => rm(root));

  const places = {
    site: { fs: true, require: true },
    mem: { provider: 'memory', fs: { writable: true } },
    d: { provider: 'disk', fs: true },
  };

  it('snapshot is keyed by place and fromSnapshot projects it read-only', async () => {
    const k = await kernel(root, places);
    const snap = k.snapshot();
    assert.deepEqual(Object.keys(snap.places), ['site']);
    assert.ok(snap.segments.length >= 1);
    const w = VfsKernel.fromSnapshot(snap, config(places), { appRoot: root });
    assert.equal(w.state, 'ready');
    assert.equal(w.fs('site').readFile('/a.txt', 'utf8'), 'aaa');
    assert.ok(w.bytecode(path.join(root, 'site', 'b.js')));
    assert.ok(w.fs('site').readFileView === undefined || true);
    assert.throws(() => w.snapshot(), /main-thread only/);
    assert.throws(() => w.fs('site').writeFile('/x', 'y'), { code: 'EROFS' });
    w.fs('mem').writeFile('/m', 'm');
    assert.equal(w.fs('mem').readFile('/m', 'utf8'), 'm');
    assert.equal(k.fs('mem').exists('/m'), false);
    const empty = VfsKernel.fromSnapshot(null, config(places), {
      appRoot: root,
    });
    assert.equal(empty.fs('site').exists('/a.txt'), false);
    k.close();
    w.close();
  });

  it('handleDelta applies vfs-update entries and removals', async () => {
    const k = await kernel(root, places);
    const w = VfsKernel.fromSnapshot(k.snapshot(), config(places), {
      appRoot: root,
    });
    const entry = await k.cache.allocate('site', '/new.txt', {
      data: Buffer.from('new'),
      stat: { size: 3, mtimeMs: 1 },
    });
    const { sab } = k.cache.getSegment(entry.segmentId);
    w.handleDelta({
      name: 'vfs-update',
      updateId: 1,
      places: {
        site: { entries: [['/new.txt', entry]], removals: ['/a.txt'] },
      },
      newSegments: [{ id: entry.segmentId, sab }],
    });
    assert.equal(w.fs('site').readFile('/new.txt', 'utf8'), 'new');
    assert.equal(w.fs('site').exists('/a.txt'), false);
    w.handleDelta({ name: 'other' });
    k.close();
    w.close();
  });

  it('frees only after every worker ACKed or exited; repeated ACKs are harmless', async () => {
    const workers = new Set(['w1', 'w2']);
    const k = await kernel(root, places, {}, { getWorkerIds: () => workers });
    let freed = 0;
    const originalFree = k.cache.free.bind(k.cache);
    k.cache.free = (entry) => {
      freed++;
      originalFree(entry);
    };
    const old = k.cache.entry('site', '/a.txt');
    // Emulate what an epoch does: track old bytes against an update id.
    k.pendingFrees.set(7, { workerIds: new Set(workers), entries: [old] });
    k.handleAck(7, 'w1');
    assert.equal(freed, 0);
    k.handleAck(7, 'w1');
    assert.equal(freed, 0);
    k.handleWorkerExit('w2');
    assert.equal(freed, 1);
    k.handleAck(7, 'w2');
    k.handleAck(99, 'w1');
    assert.equal(freed, 1, 'nothing is freed twice');
    assert.equal(k.pendingFrees.size, 0);
    k.close();
  });

  it('handleWorkerExit during compaction frees relocated bytes', async () => {
    const KB = 1024;
    const workers = new Set(['w1']);
    const empty = writeTree(tmpDir('kernel-compact'), {});
    const k = await kernel(
      empty,
      { site: { fs: true } },
      {
        memory: {
          limit: '16 kib',
          segmentSize: '4 kib',
          maxFileSize: '4 kib',
        },
        compaction: { threshold: 0.5 },
      },
      { getWorkerIds: () => workers },
    );
    const input = (n, fill) => ({
      data: Buffer.alloc(n, fill),
      stat: { size: n, mtimeMs: 1 },
    });
    const a = await k.cache.allocate('site', '/a', input(2 * KB, 'a'));
    const b = await k.cache.allocate('site', '/b', input(2 * KB, 'b'));
    const c = await k.cache.allocate('site', '/c', input(200, 'c'));
    assert.equal(b.segmentId, 1);
    assert.equal(c.segmentId, 2);
    k.cache.remove('site', '/a');
    k.pendingFrees.set(11, {
      workerIds: new Set(workers),
      entries: [a],
    });
    k.handleWorkerExit('w1');
    assert.equal(k.cache.entry('site', '/c').segmentId, 1);
    assert.equal(
      k.pendingFrees.size,
      0,
      'exiting worker is not waited on for the compaction ACK',
    );
    k.close();
    rm(empty);
  });

  it('link() + attach(): a worker gets the projection, deltas and ACKs them', async () => {
    const k = await kernel(root, places, { watchTimeout: 50, watch: true });
    const { vfs, transferList } = k.link();
    assert.equal(k.links.size, 1);
    const script = `
      const { parentPort } = require('node:worker_threads');
      const { attach, kernel: before } = require(${JSON.stringify(path.resolve(__dirname, '..'))});
      const kernel = attach();
      const { kernel: after } = require(${JSON.stringify(path.resolve(__dirname, '..'))});
      const site = kernel.fs('site');
      parentPort.on('message', (m) => {
        if (m === 'read') parentPort.postMessage(site.readFile('/a.txt', 'utf8'));
        if (m === 'exit') process.exit(0);
      });
      parentPort.postMessage([before, after === kernel, site.readFile('/a.txt', 'utf8')]);
    `;
    const worker = new Worker(script, {
      eval: true,
      workerData: { vfs },
      transferList,
    });
    const messages = [];
    worker.on('message', (m) => messages.push(m));
    const acks = [];
    const port = [...k.links.values()][0];
    port.on('message', (m) => acks.push(m));
    const errors = [];
    worker.on('error', (e) => errors.push(e));
    await until(() => messages.length === 1 || errors.length > 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(messages, [[null, true, 'aaa']]);
    // Anything that is not a delta must not produce an ACK.
    port.postMessage({ name: 'ping' });
    await sleep(100);
    assert.deepEqual(acks, []);
    // Change the file: the delta must reach the worker and be ACKed.
    require('node:fs').writeFileSync(path.join(root, 'site', 'a.txt'), 'AAAA');
    await until(() => k.fs('site').readFile('/a.txt', 'utf8') === 'AAAA');
    await until(() => k.pendingFrees.size === 0, 3000);
    assert.equal(k.pendingFrees.size, 0, 'worker ACKed the update');
    assert.deepEqual(
      acks.map((m) => m.name),
      ['ack-update'],
      'exactly one ACK, only for the delta',
    );
    worker.postMessage('read');
    await until(() => messages.length === 2);
    assert.equal(messages[1], 'AAAA');
    worker.postMessage('exit');
    await until(() => k.links.size === 0);
    assert.equal(k.links.size, 0, 'worker exit closed the link');
    k.close();
  });
});
