'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');

const APP_ROOT = path.resolve(os.tmpdir(), `vfs-extwhitelist-${process.pid}`);

const setup = () => {
  const dir = path.join(APP_ROOT, 'static');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1/>');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# md');
  fs.writeFileSync(path.join(dir, 'backup.bak'), 'x');
  fs.writeFileSync(path.join(dir, 'data.tmp'), 'x');
};

const cleanup = () => fs.rmSync(APP_ROOT, { recursive: true, force: true });

const baseConfig = (extOnExtra) =>
  new VfsConfig({
    defaults: { hooks: { fs: false, require: false, import: false } },
    places: {
      static: {
        domains: ['fs'],
        match: { dir: 'static' },
        provider: 'sab',
        ext: ['html', 'css'],
        extOnExtra,
      },
    },
  });

describe('ext whitelist diagnostics', () => {
  before(setup);
  after(cleanup);

  it('silent (default): no warning, files filtered out', async () => {
    const warnings = [];
    const k = new VFSKernel(baseConfig('silent'), {
      appRoot: APP_ROOT,
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await k.initialize();
    assert.equal(warnings.length, 0);
    const place = k.getPlace('static');
    assert.equal(place.files.has('/index.html'), true);
    assert.equal(place.files.has('/notes.md'), false);
    k.close();
  });

  it('warn: emits one aggregated message', async () => {
    const warnings = [];
    const k = new VFSKernel(baseConfig('warn'), {
      appRoot: APP_ROOT,
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await k.initialize();
    assert.equal(warnings.length, 1);
    const msg = warnings[0];
    assert.match(msg, /3 file\(s\) outside ext whitelist/);
    assert.match(msg, /md \(1\)/);
    assert.match(msg, /bak \(1\)/);
    assert.match(msg, /tmp \(1\)/);
    assert.match(msg, /whitelist: html, css/);
    k.close();
  });

  it('error: throws on initialize', async () => {
    const k = new VFSKernel(baseConfig('error'), {
      appRoot: APP_ROOT,
      console: { debug() {}, error() {}, log() {}, warn() {} },
    });
    await assert.rejects(() => k.initialize(), /outside ext whitelist/);
    k.close();
  });

  it('config rejects unknown extOnExtra', () => {
    assert.throws(
      () =>
        new VfsConfig({
          places: {
            x: {
              domains: ['fs'],
              match: { dir: 'x' },
              ext: ['js'],
              extOnExtra: 'shout',
            },
          },
        }),
      /unknown extOnExtra/,
    );
  });
});

const memoryConfig = (extOnExtra) =>
  new VfsConfig({
    defaults: { hooks: { fs: false, require: false, import: false } },
    places: {
      mem: {
        domains: ['fs'],
        match: { dir: 'mem' },
        provider: 'memory',
        ext: ['js'],
        extOnExtra,
      },
    },
  });

describe('ext whitelist: memory writes', () => {
  it('silent: write of disallowed ext succeeds', async () => {
    const warnings = [];
    const k = new VFSKernel(memoryConfig('silent'), {
      appRoot: APP_ROOT,
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await k.initialize();
    k.getPlace('mem').writeFile('/x.bak', Buffer.from('x'));
    assert.equal(warnings.length, 0);
    assert.equal(k.getPlace('mem').exists('/x.bak'), true);
    k.close();
  });

  it('warn: write of disallowed ext warns but succeeds', async () => {
    const warnings = [];
    const k = new VFSKernel(memoryConfig('warn'), {
      appRoot: APP_ROOT,
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await k.initialize();
    k.getPlace('mem').writeFile('/x.bak', Buffer.from('x'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /writeFile\("\/x\.bak"\) outside ext whitelist/);
    assert.equal(k.getPlace('mem').exists('/x.bak'), true);
    k.close();
  });

  it('error: write of disallowed ext throws', async () => {
    const k = new VFSKernel(memoryConfig('error'), {
      appRoot: APP_ROOT,
      console: { debug() {}, error() {}, log() {}, warn() {} },
    });
    await k.initialize();
    assert.throws(
      () => k.getPlace('mem').writeFile('/x.bak', Buffer.from('x')),
      /outside ext whitelist/,
    );
    assert.equal(k.getPlace('mem').exists('/x.bak'), false);
    k.close();
  });

  it('allowed ext always writes regardless of policy', async () => {
    const k = new VFSKernel(memoryConfig('error'), {
      appRoot: APP_ROOT,
      console: { debug() {}, error() {}, log() {}, warn() {} },
    });
    await k.initialize();
    k.getPlace('mem').writeFile('/ok.js', Buffer.from('1'));
    assert.equal(k.getPlace('mem').exists('/ok.js'), true);
    k.close();
  });
});

describe('ext whitelist: SEA loader', () => {
  const seaMod = (assets) => ({
    isSea: () => true,
    getAssetKeys: () => Object.keys(assets),
    getAsset: (k) => Buffer.from(assets[k]),
  });

  const seaConfig = (extOnExtra) =>
    new VfsConfig({
      defaults: { hooks: { fs: false, require: false, import: false } },
      places: {
        bundle: {
          domains: ['fs'],
          match: { dir: 'pub' },
          provider: 'sea',
          ext: ['html'],
          extOnExtra,
        },
      },
    });

  const assets = {
    'pub/index.html': '<h1/>',
    'pub/app.js': 'x',
    'pub/style.css': 'y',
  };

  it('silent: drops disallowed assets', async () => {
    const warnings = [];
    const k = new VFSKernel(seaConfig('silent'), {
      appRoot: APP_ROOT,
      seaModule: seaMod(assets),
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await k.initialize();
    const place = k.getPlace('bundle');
    assert.equal(place.files.size, 1);
    assert.equal(place.exists('/index.html'), true);
    assert.equal(warnings.length, 0);
    k.close();
  });

  it('warn: drops disallowed and warns', async () => {
    const warnings = [];
    const k = new VFSKernel(seaConfig('warn'), {
      appRoot: APP_ROOT,
      seaModule: seaMod(assets),
      console: {
        debug() {},
        error() {},
        log() {},
        warn: (m) => warnings.push(m),
      },
    });
    await k.initialize();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 file\(s\) outside ext whitelist/);
    assert.match(warnings[0], /js \(1\)/);
    assert.match(warnings[0], /css \(1\)/);
    k.close();
  });

  it('error: throws during initialize', async () => {
    const k = new VFSKernel(seaConfig('error'), {
      appRoot: APP_ROOT,
      seaModule: seaMod(assets),
      console: { debug() {}, error() {}, log() {}, warn() {} },
    });
    await assert.rejects(() => k.initialize(), /outside ext whitelist/);
    k.close();
  });
});
