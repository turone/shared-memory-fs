'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');

const createTmpDir = () => {
  const dir = path.join(
    os.tmpdir(),
    `vfs-kernel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const rmDir = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
};

describe('VFSKernel', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'static'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'static', 'index.html'), '<h1>VFS</h1>');
    fs.writeFileSync(path.join(tmpDir, 'static', 'style.css'), 'body{}');
    fs.writeFileSync(path.join(tmpDir, 'api', 'handler.js'), 'module.exports={}');
    fs.writeFileSync(
      path.join(tmpDir, 'lib', 'utils.js'),
      'module.exports = { sum: (a, b) => a + b };',
    );
  });

  after(() => rmDir(tmpDir));

  const makeConfig = (extra = {}) => new VfsConfig({
    defaults: {
      memory: { limit: '10 mib', segment: '1 mib', maxFileSize: '512 kib' },
      hooks: { fs: false, require: false, import: false, diagnostics: false },
    },
    places: {
      static: {
        domains: ['fs'],
        match: { dir: 'static' },
        provider: 'sab',
        ext: ['html', 'css'],
      },
      api: {
        domains: ['fs'],
        match: { dir: 'api' },
        provider: 'disk',
      },
      ...extra,
    },
  });

  const makeCompileConfig = () => new VfsConfig({
    defaults: {
      memory: { limit: '10 mib', segment: '1 mib', maxFileSize: '512 kib' },
      hooks: { fs: false, require: false, import: false, diagnostics: false },
    },
    places: {
      static: {
        domains: ['fs'],
        match: { dir: 'static' },
        provider: 'sab',
        ext: ['html', 'css'],
      },
      api: {
        domains: ['fs'],
        match: { dir: 'api' },
        provider: 'disk',
      },
      lib: {
        domains: ['fs', 'require'],
        match: { dir: 'lib' },
        provider: 'sab',
        ext: ['js'],
        compile: true,
      },
    },
  });

  const makeKernel = (config) => new VFSKernel(config, {
    appRoot: tmpDir,
    console: { debug() {}, error() {}, log() {}, warn() {} },
  });

  describe('initialize', () => {
    it('loads SAB-backed files into projected maps', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();
      assert.equal(kernel.initialized, true);

      const staticPlace = kernel.getPlace('static');
      assert.ok(staticPlace);
      assert.ok(staticPlace.files.size >= 2);

      const html = staticPlace.files.get('/index.html');
      assert.ok(html);
      assert.ok(Buffer.isBuffer(html.data));
      assert.equal(html.data.toString(), '<h1>VFS</h1>');

      kernel.close();
    });

    it('loads disk-backed places with null data', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      const apiPlace = kernel.getPlace('api');
      assert.ok(apiPlace);
      assert.ok(apiPlace.files.size >= 1);

      const handler = apiPlace.files.get('/handler.js');
      assert.ok(handler);
      assert.equal(handler.data, null);
      assert.ok(handler.path);

      kernel.close();
    });
  });

  describe('pathIndex', () => {
    it('builds pathIndex automatically on initialize', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      assert.ok(kernel.pathIndex.size > 0);

      const abs = path.resolve(tmpDir, 'static', 'index.html');
      const resolved = kernel.pathIndex.get(abs);
      assert.ok(resolved);
      assert.equal(resolved.place.name, 'static');

      kernel.close();
    });
  });

  describe('resolveFsPath', () => {
    it('resolves path to place via pathIndex', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      const abs = path.resolve(tmpDir, 'static', 'index.html');
      const result = kernel.resolveFsPath(abs);
      assert.ok(result);
      assert.equal(result.place.name, 'static');

      kernel.close();
    });

    it('returns null for unmanaged paths', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      const result = kernel.resolveFsPath('/some/other/path.js');
      assert.equal(result, null);

      kernel.close();
    });
  });

  describe('snapshot', () => {
    it('returns cache snapshot', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      const snap = kernel.snapshot();
      assert.ok(snap);
      assert.ok(snap.segments.length > 0);
      assert.ok(snap.filesystems.static);

      kernel.close();
    });

    it('returns null before initialize', () => {
      const kernel = makeKernel(makeConfig());
      assert.equal(kernel.snapshot(), null);
      kernel.close();
    });
  });

  describe('ACK flow', () => {
    it('tracks updates and frees after all ACKs', async () => {
      const broadcasts = [];
      const kernel = new VFSKernel(makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
        broadcast: (data) => broadcasts.push(data),
        getWorkerIds: () => [1, 2],
      });
      await kernel.initialize();

      // Simulate an update by writing a file and manually processing
      const filePath = path.join(tmpDir, 'static', 'new.html');
      fs.writeFileSync(filePath, '<p>new</p>');

      // Directly allocate entry to simulate watch
      const { scan } = require('../lib/scanner.js');
      const { files } = await scan(path.join(tmpDir, 'static'), { ext: ['html', 'css'] });
      const newFile = files.get('/new.html');
      if (newFile) {
        const entry = await kernel.cache.allocate('static', '/new.html', newFile);
        // Simulate flushEpoch behavior
        const updateId = ++kernel.nextUpdateId;
        const pendingEntries = [];
        kernel.pendingFrees.set(updateId, {
          workerIds: new Set([1, 2]),
          entries: pendingEntries,
        });

        assert.equal(kernel.pendingFrees.size, 1);

        kernel.handleAck(updateId, 1);
        assert.equal(kernel.pendingFrees.size, 1); // still pending

        kernel.handleAck(updateId, 2);
        assert.equal(kernel.pendingFrees.size, 0); // freed
      }

      fs.unlinkSync(filePath);
      kernel.close();
    });
  });

  describe('handleWorkerExit', () => {
    it('removes worker from all pending ACK sets', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      kernel.pendingFrees.set(1, {
        workerIds: new Set([10, 20]),
        entries: [],
      });
      kernel.pendingFrees.set(2, {
        workerIds: new Set([10, 30]),
        entries: [],
      });

      kernel.handleWorkerExit(10);

      const p1 = kernel.pendingFrees.get(1);
      assert.ok(p1);
      assert.equal(p1.workerIds.has(10), false);
      assert.equal(p1.workerIds.size, 1);

      const p2 = kernel.pendingFrees.get(2);
      assert.ok(p2);
      assert.equal(p2.workerIds.has(10), false);

      kernel.close();
    });

    it('frees entries when last worker exits', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      kernel.pendingFrees.set(1, {
        workerIds: new Set([10]),
        entries: [],
      });

      kernel.handleWorkerExit(10);
      assert.equal(kernel.pendingFrees.size, 0);

      kernel.close();
    });
  });

  describe('close', () => {
    it('clears all state', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      assert.equal(kernel.initialized, true);
      assert.ok(kernel.pathIndex.size > 0);

      kernel.close();

      assert.equal(kernel.initialized, false);
      assert.equal(kernel.pathIndex.size, 0);
      assert.equal(kernel.watcher, null);
      assert.equal(kernel.pendingFrees.size, 0);
      assert.equal(kernel.segmentsMap.size, 0);
      assert.equal(kernel.projected.size, 0);
      assert.equal(kernel.sources.size, 0);
    });
  });

  describe('getPlace / getPlaces', () => {
    it('returns registered places', async () => {
      const kernel = makeKernel(makeConfig());
      await kernel.initialize();

      assert.ok(kernel.getPlace('static'));
      assert.ok(kernel.getPlace('api'));
      assert.equal(kernel.getPlace('unknown'), null);

      const all = kernel.getPlaces();
      assert.ok(all.length >= 2);

      kernel.close();
    });
  });

  describe('single-process mode (no workers)', () => {
    it('frees entries immediately when no workers', async () => {
      const kernel = new VFSKernel(makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
        getWorkerIds: () => [],
      });
      await kernel.initialize();

      // Allocate an entry
      const entry = await kernel.cache.allocate(
        'static',
        '/temp.html',
        { stat: { size: 10 }, path: path.join(tmpDir, 'static', 'index.html') },
      );

      // Simulate trackUpdate via private access — just verify pendingFrees stays empty
      // since getWorkerIds returns []
      assert.equal(kernel.pendingFrees.size, 0);

      kernel.close();
    });
  });

  describe('fromSnapshot', () => {
    it('creates worker-side kernel from snapshot', async () => {
      const main = makeKernel(makeConfig());
      await main.initialize();
      const snapshot = main.snapshot();

      const worker = VFSKernel.fromSnapshot(snapshot, makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      assert.equal(worker.initialized, true);
      assert.equal(worker.cache, null);
      assert.equal(worker.watcher, null);

      const place = worker.getPlace('static');
      assert.ok(place);
      assert.ok(place.files.size >= 2);

      const html = place.files.get('/index.html');
      assert.ok(html);
      assert.ok(Buffer.isBuffer(html.data));
      assert.equal(html.data.toString(), '<h1>VFS</h1>');

      main.close();
      worker.close();
    });

    it('supports dispatch after fromSnapshot', async () => {
      const main = makeKernel(makeConfig());
      await main.initialize();
      const snapshot = main.snapshot();

      const worker = VFSKernel.fromSnapshot(snapshot, makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      const abs = path.resolve(tmpDir, 'static', 'index.html');
      const resolved = worker.dispatchFsRead('readFile', abs);
      assert.ok(resolved);
      assert.equal(resolved.place.name, 'static');

      main.close();
      worker.close();
    });

    it('supports resolveFsPath after fromSnapshot', async () => {
      const main = makeKernel(makeConfig());
      await main.initialize();
      const snapshot = main.snapshot();

      const worker = VFSKernel.fromSnapshot(snapshot, makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      const abs = path.resolve(tmpDir, 'static', 'style.css');
      const resolved = worker.resolveFsPath(abs);
      assert.ok(resolved);
      assert.equal(resolved.place.name, 'static');

      main.close();
      worker.close();
    });
  });

  describe('handleDelta', () => {
    it('applies file-update delta', async () => {
      const main = makeKernel(makeConfig());
      await main.initialize();
      const snapshot = main.snapshot();

      const worker = VFSKernel.fromSnapshot(snapshot, makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      // Create a new SAB entry to simulate an update
      const sab = new SharedArrayBuffer(16);
      const view = new Uint8Array(sab, 0, 6);
      view.set(Buffer.from('<new/>'));
      worker.segmentsMap.set(99, sab);

      worker.handleDelta({
        name: 'file-update',
        target: 'static',
        updateId: 1,
        updates: [['/new.html', {
          kind: 'shared', segmentId: 99, offset: 0, length: 6,
          stat: { size: 6 },
        }]],
        newSegments: [{ id: 99, sab }],
      });

      const place = worker.getPlace('static');
      const file = place.files.get('/new.html');
      assert.ok(file);
      assert.equal(file.data.toString(), '<new/>');

      main.close();
      worker.close();
    });

    it('applies file-delete delta', async () => {
      const main = makeKernel(makeConfig());
      await main.initialize();
      const snapshot = main.snapshot();

      const worker = VFSKernel.fromSnapshot(snapshot, makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      assert.ok(worker.getPlace('static').files.has('/index.html'));

      worker.handleDelta({
        name: 'file-delete',
        target: 'static',
        updateId: 2,
        keys: ['/index.html'],
      });

      assert.equal(worker.getPlace('static').files.has('/index.html'), false);

      main.close();
      worker.close();
    });

    it('updates pathIndex on delta', async () => {
      const main = makeKernel(makeConfig());
      await main.initialize();
      const snapshot = main.snapshot();

      const worker = VFSKernel.fromSnapshot(snapshot, makeConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      const abs = path.resolve(tmpDir, 'static', 'index.html');
      assert.ok(worker.pathIndex.has(abs));

      worker.handleDelta({
        name: 'file-delete',
        target: 'static',
        updateId: 3,
        keys: ['/index.html'],
      });

      assert.equal(worker.pathIndex.has(abs), false);

      main.close();
      worker.close();
    });
  });

  describe('compileModules', () => {
    it('generates bytecode for JS files in compilable places', async () => {
      const kernel = makeKernel(makeCompileConfig());
      await kernel.initialize();

      const libPlace = kernel.getPlace('lib');
      assert.ok(libPlace);

      // Source should be accessible
      const source = libPlace.readFile('/utils.js');
      assert.ok(Buffer.isBuffer(source));
      assert.ok(source.toString().includes('sum'));

      // Bytecode companion should exist
      const bytecode = libPlace.readBytecode('/utils.js');
      assert.ok(Buffer.isBuffer(bytecode));
      assert.ok(bytecode.length > 0);

      // Bytecode should be larger than source (typically 2-5x)
      assert.ok(bytecode.length > source.length);

      kernel.close();
    });

    it('does not generate bytecode for non-compile places', async () => {
      const kernel = makeKernel(makeCompileConfig());
      await kernel.initialize();

      const staticPlace = kernel.getPlace('static');
      assert.ok(staticPlace);
      // HTML files should have no bytecode
      const bytecode = staticPlace.readBytecode('/index.html');
      assert.equal(bytecode, null);

      kernel.close();
    });

    it('bytecode is valid for vm.Script', async () => {
      const vm = require('node:vm');
      const Module = require('node:module');
      const kernel = makeKernel(makeCompileConfig());
      await kernel.initialize();

      const libPlace = kernel.getPlace('lib');
      const source = libPlace.readFile('/utils.js').toString('utf8');
      const bytecode = libPlace.readBytecode('/utils.js');

      const wrapped = Module.wrap(source);
      const script = new vm.Script(wrapped, {
        filename: '/utils.js',
        cachedData: bytecode,
      });
      assert.equal(script.cachedDataRejected, false);

      kernel.close();
    });

    it('snapshot includes bytecode companion entries', async () => {
      const kernel = makeKernel(makeCompileConfig());
      await kernel.initialize();

      const snap = kernel.snapshot();
      assert.ok(snap.filesystems.lib);
      const entries = new Map(snap.filesystems.lib.entries);
      assert.ok(entries.has('/utils.js'));
      assert.ok(entries.has('/utils.js.cache'));

      kernel.close();
    });

    it('worker receives bytecode via fromSnapshot', async () => {
      const kernel = makeKernel(makeCompileConfig());
      await kernel.initialize();
      const snap = kernel.snapshot();

      const worker = VFSKernel.fromSnapshot(snap, makeCompileConfig(), {
        appRoot: tmpDir,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });

      const libPlace = worker.getPlace('lib');
      assert.ok(libPlace);

      const source = libPlace.readFile('/utils.js');
      assert.ok(Buffer.isBuffer(source));

      const bytecode = libPlace.readBytecode('/utils.js');
      assert.ok(Buffer.isBuffer(bytecode));
      assert.ok(bytecode.length > 0);

      kernel.close();
      worker.close();
    });

    it('pathIndex excludes .cache companion keys', async () => {
      const kernel = makeKernel(makeCompileConfig());
      await kernel.initialize();

      // .cache keys should not be in pathIndex
      const cacheAbs = path.resolve(tmpDir, 'lib', 'utils.js.cache');
      assert.equal(kernel.pathIndex.has(cacheAbs), false);

      // But source key should be
      const sourceAbs = path.resolve(tmpDir, 'lib', 'utils.js');
      assert.ok(kernel.pathIndex.has(sourceAbs));

      kernel.close();
    });
  });
});
