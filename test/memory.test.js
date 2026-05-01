'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');

const APP_ROOT = path.resolve('/tmp/vfs-mem-test');

const makeKernel = (extraPlace = {}) => {
  const config = new VfsConfig({
    defaults: {
      memory: { limit: '1 mib', segmentSize: '256 kib', maxFileSize: '64 kib' },
      hooks: { fs: false, require: false, import: false },
    },
    places: {
      tmp: {
        domains: ['fs'],
        match: { dir: 'tmp' },
        provider: 'memory',
        ...extraPlace,
      },
    },
  });
  return new VFSKernel(config, {
    appRoot: APP_ROOT,
    console: { debug() {}, error() {}, log() {}, warn() {} },
  });
};

describe('Memory provider', () => {
  describe('basic write/read/delete', () => {
    it('starts empty', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      assert.equal(place.files.size, 0);
      assert.equal(place.exists('/x.txt'), false);
      kernel.close();
    });

    it('writes and reads back', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/hello.txt', Buffer.from('hello world'));
      const data = place.readFile('/hello.txt');
      assert.ok(Buffer.isBuffer(data));
      assert.equal(data.toString(), 'hello world');
      const stat = place.stat('/hello.txt');
      assert.equal(stat.size, 11);
      assert.ok(typeof stat.mtimeMs === 'number');
      kernel.close();
    });

    it('owns the buffer (caller mutation does not affect cache)', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      const src = Buffer.from('abc');
      place.writeFile('/a', src);
      src[0] = 0x7a; // 'z'
      assert.equal(place.readFile('/a').toString(), 'abc');
      kernel.close();
    });

    it('deletes', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/x', Buffer.from('1'));
      assert.equal(place.exists('/x'), true);
      place.unlink('/x');
      assert.equal(place.exists('/x'), false);
      kernel.close();
    });

    it('overwrites in place', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/k', Buffer.from('one'));
      place.writeFile('/k', Buffer.from('two-longer'));
      assert.equal(place.readFile('/k').toString(), 'two-longer');
      assert.equal(place.stat('/k').size, 10);
      kernel.close();
    });
  });

  describe('read-only places reject writes', () => {
    it('throws on writeFile to sab place', () => {
      const config = new VfsConfig({
        places: {
          static: {
            domains: ['fs'],
            match: { dir: 'static' },
            provider: 'sab',
          },
        },
      });
      const kernel = new VFSKernel(config, { appRoot: APP_ROOT });
      // Build a Place via registry without initialize (we just want the API check)
      const { Place } = require('../lib/place.js');
      const place = new Place('static', config.place('static'));
      assert.throws(() => place.writeFile('/x', Buffer.from('y')), /read-only/);
      assert.throws(() => place.unlink('/x'), /read-only/);
      kernel.close();
    });
  });

  describe('pathIndex tracks memory writes', () => {
    it('routes fs reads after write', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/file.txt', Buffer.from('data'));
      const abs = path.resolve(APP_ROOT, 'tmp', 'file.txt');
      const resolved = kernel.resolveFsPath(abs);
      assert.ok(resolved);
      assert.equal(resolved.place.name, 'tmp');
      assert.equal(resolved.fileKey, '/file.txt');
      kernel.close();
    });

    it('removes from pathIndex on unlink', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/g.txt', Buffer.from('g'));
      const abs = path.resolve(APP_ROOT, 'tmp', 'g.txt');
      assert.ok(kernel.resolveFsPath(abs));
      place.unlink('/g.txt');
      assert.equal(kernel.resolveFsPath(abs), null);
      kernel.close();
    });
  });

  describe('routeWrite', () => {
    it('returns route for memory mount', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      const abs = path.resolve(APP_ROOT, 'tmp', 'sub', 'a.txt');
      const route = kernel.routeWrite(abs);
      assert.ok(route);
      assert.equal(route.place.name, 'tmp');
      assert.equal(route.fileKey, '/sub/a.txt');
      kernel.close();
    });

    it('returns null for paths outside any mount', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      assert.equal(kernel.routeWrite('/etc/hostname'), null);
      kernel.close();
    });

    it('returns null for non-memory mounts', async () => {
      const config = new VfsConfig({
        defaults: { memory: { limit: '1 mib', segmentSize: '64 kib' } },
        places: {
          ro: { domains: ['fs'], match: { dir: 'ro' }, provider: 'sab' },
        },
      });
      const kernel = new VFSKernel(config, { appRoot: APP_ROOT });
      // sab init would scan disk; skip initialize and test routeWrite directly
      // by registering manually.
      const { Place } = require('../lib/place.js');
      const place = new Place('ro', config.place('ro'));
      kernel.registry.register(place);
      const abs = path.resolve(APP_ROOT, 'ro', 'x');
      assert.equal(kernel.routeWrite(abs), null);
    });
  });

  describe('compile auto-bytecode', () => {
    it('generates .cache companion on JS write', async () => {
      const kernel = makeKernel({ domains: ['fs', 'require'], compile: true });
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/m.js', Buffer.from('module.exports = 42;'));
      const bc = place.getCachedData('/m.js');
      assert.ok(Buffer.isBuffer(bc));
      assert.ok(bc.length > 0);
      kernel.close();
    });

    it('bytecode is accepted by vm.Script', async () => {
      const kernel = makeKernel({ domains: ['fs', 'require'], compile: true });
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      const src = 'module.exports = (a, b) => a + b;';
      place.writeFile('/sum.js', Buffer.from(src));
      const bc = place.getCachedData('/sum.js');
      const wrapped = Module.wrap(src);
      const script = new vm.Script(wrapped, {
        filename: '/sum.js',
        cachedData: bc,
      });
      assert.equal(script.cachedDataRejected, false);
      kernel.close();
    });

    it('removes .cache on unlink', async () => {
      const kernel = makeKernel({ domains: ['fs', 'require'], compile: true });
      await kernel.initialize();
      const place = kernel.getPlace('tmp');
      place.writeFile('/x.js', Buffer.from('module.exports = 1;'));
      assert.ok(place.getCachedData('/x.js'));
      place.unlink('/x.js');
      assert.equal(place.getCachedData('/x.js'), null);
      assert.equal(place.exists('/x.js.cache'), false);
      kernel.close();
    });
  });

  describe('isolation across kernels (per-thread semantics)', () => {
    it('snapshot does not include memory entries', async () => {
      const kernel = makeKernel();
      await kernel.initialize();
      kernel.getPlace('tmp').writeFile('/secret.txt', Buffer.from('s'));
      const snap = kernel.snapshot();
      assert.equal(snap.filesystems.tmp, undefined);
      kernel.close();
    });

    it('fromSnapshot creates empty memory place per worker', async () => {
      const main = makeKernel();
      await main.initialize();
      main.getPlace('tmp').writeFile('/main-only.txt', Buffer.from('M'));
      const snap = main.snapshot();

      const config = new VfsConfig({
        defaults: { memory: { limit: '1 mib', segmentSize: '64 kib' } },
        places: {
          tmp: { domains: ['fs'], match: { dir: 'tmp' }, provider: 'memory' },
        },
      });
      const worker = VFSKernel.fromSnapshot(snap, config, {
        appRoot: APP_ROOT,
        console: { debug() {}, error() {}, log() {}, warn() {} },
      });
      const wp = worker.getPlace('tmp');
      assert.ok(wp);
      assert.equal(wp.files.size, 0);
      // Worker can write its own data independently
      wp.writeFile('/worker-only.txt', Buffer.from('W'));
      assert.equal(wp.readFile('/worker-only.txt').toString(), 'W');
      assert.equal(wp.exists('/main-only.txt'), false);
      assert.equal(main.getPlace('tmp').exists('/worker-only.txt'), false);

      main.close();
      worker.close();
    });
  });
});
