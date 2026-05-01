'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');

// Mock node:sea — minimal subset used by VFSKernel.
const mockSea = (assets) => ({
  isSea: () => true,
  getAssetKeys: () => Object.keys(assets),
  getAsset: (key) => {
    if (!(key in assets)) throw new Error(`asset not found: ${key}`);
    return Buffer.from(assets[key]);
  },
});

const APP_ROOT = path.resolve('/tmp/vfs-sea-test');

describe('SEA provider', () => {
  it('loads matching assets into a SAB place under match.dir', async () => {
    const sea = mockSea({
      'public/index.html': '<h1>SEA</h1>',
      'public/style.css': 'body{color:#000}',
      'public/img/logo.svg': '<svg/>',
      'private/secrets.txt': 'nope',
    });
    const config = new VfsConfig({
      defaults: {
        memory: {
          limit: '1 mib',
          segmentSize: '64 kib',
          maxFileSize: '32 kib',
        },
        hooks: { fs: false, require: false, import: false },
      },
      places: {
        public: {
          domains: ['fs'],
          match: { dir: 'public' },
          provider: 'sea',
        },
      },
    });
    const kernel = new VFSKernel(config, {
      appRoot: APP_ROOT,
      seaModule: sea,
      console: { debug() {}, error() {}, log() {}, warn() {} },
    });
    await kernel.initialize();

    const place = kernel.getPlace('public');
    assert.equal(place.files.size, 3);
    assert.equal(place.readFile('/index.html').toString(), '<h1>SEA</h1>');
    assert.equal(place.readFile('/style.css').toString(), 'body{color:#000}');
    assert.equal(place.readFile('/img/logo.svg').toString(), '<svg/>');
    assert.equal(place.exists('/secrets.txt'), false);
    kernel.close();
  });

  it('exposes assets via fs path index', async () => {
    const sea = mockSea({ 'assets/a.txt': 'A' });
    const config = new VfsConfig({
      defaults: {
        memory: {
          limit: '256 kib',
          segmentSize: '64 kib',
          maxFileSize: '8 kib',
        },
        hooks: { fs: false, require: false, import: false },
      },
      places: {
        a: { domains: ['fs'], match: { dir: 'assets' }, provider: 'sea' },
      },
    });
    const kernel = new VFSKernel(config, {
      appRoot: APP_ROOT,
      seaModule: sea,
    });
    await kernel.initialize();

    const abs = path.resolve(APP_ROOT, 'assets', 'a.txt');
    const route = kernel.resolveFsPath(abs);
    assert.ok(route);
    assert.equal(route.place.name, 'a');
    assert.equal(route.fileKey, '/a.txt');
    kernel.close();
  });

  it('snapshot includes SEA assets and worker projects them', async () => {
    const sea = mockSea({
      'pub/x.bin': Buffer.from([1, 2, 3, 4, 5]).toString('binary'),
    });
    // Use Buffer-bytes path to avoid encoding gotchas:
    const seaBin = {
      isSea: () => true,
      getAssetKeys: () => ['pub/x.bin'],
      getAsset: () => Buffer.from([1, 2, 3, 4, 5]),
    };
    const config = new VfsConfig({
      defaults: {
        memory: {
          limit: '256 kib',
          segmentSize: '64 kib',
          maxFileSize: '8 kib',
        },
        hooks: { fs: false, require: false, import: false },
      },
      places: {
        pub: { domains: ['fs'], match: { dir: 'pub' }, provider: 'sea' },
      },
    });
    const main = new VFSKernel(config, {
      appRoot: APP_ROOT,
      seaModule: seaBin,
    });
    await main.initialize();

    const snap = main.snapshot();
    assert.ok(snap.filesystems.pub);

    const worker = VFSKernel.fromSnapshot(snap, config, { appRoot: APP_ROOT });
    const wp = worker.getPlace('pub');
    const data = wp.readFile('/x.bin');
    assert.deepEqual([...data], [1, 2, 3, 4, 5]);

    main.close();
    worker.close();
    void sea;
  });

  it('warns and stays empty when sea module unavailable', async () => {
    const warnings = [];
    const config = new VfsConfig({
      defaults: {
        memory: {
          limit: '256 kib',
          segmentSize: '64 kib',
          maxFileSize: '8 kib',
        },
        hooks: { fs: false, require: false, import: false },
      },
      places: {
        e: { domains: ['fs'], match: { dir: 'e' }, provider: 'sea' },
      },
    });
    const kernel = new VFSKernel(config, {
      appRoot: APP_ROOT,
      // No seaModule injected; outside SEA, node:sea reports isSea() === false
      // and #loadSeaModule returns null.
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await kernel.initialize();

    assert.equal(kernel.getPlace('e').files.size, 0);
    assert.ok(warnings.some((m) => /node:sea unavailable/.test(m)));
    kernel.close();
  });
});
