'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VfsKernel } = require('../lib/kernel.js');
const { tmpDir, rm, config, quiet } = require('./helpers.js');

// SEA places load node:sea assets named `<place>/<key>` into SAB. Tests
// inject a compatible module instead of building a real executable.

const seaModule = (assets) => ({
  isSea: () => true,
  getAssetKeys: () => Object.keys(assets),
  getAsset: (key) => {
    const buf = Buffer.from(assets[key]);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
});

describe('SEA provider', () => {
  const assets = {
    'bundle/index.html': '<h1>sea</h1>',
    'bundle/app.js': 'module.exports = "sea-js";',
    'bundle/sub/style.css': 'a{}',
    'bundle/skip.bin': 'zz',
    'other/x.txt': 'not ours',
  };

  it('loads matching assets into SAB and serves them like a sab place', async () => {
    const root = tmpDir('sea');
    const k = new VfsKernel(
      config({
        bundle: {
          provider: 'sea',
          fs: { ext: ['html', 'css', 'js'], zeroCopy: true },
          require: true,
        },
      }),
      { appRoot: root, console: quiet, seaModule: seaModule(assets) },
    );
    await k.initialize();
    const bundle = k.fs('bundle');
    assert.deepEqual(bundle.readdir('/', { recursive: true }), [
      'app.js',
      'index.html',
      'sub',
      'sub/style.css',
    ]);
    assert.equal(bundle.readFile('/index.html', 'utf8'), '<h1>sea</h1>');
    assert.ok(
      bundle.readFileView('/index.html').buffer instanceof SharedArrayBuffer,
    );
    assert.ok(
      k.bytecode(path.join(root, 'bundle', 'app.js')),
      'bytecode compiled for sea sources',
    );
    assert.equal(
      k.resolveModule(path.join(root, 'bundle', 'app.js'), 'require').key,
      '/app.js',
    );
    assert.throws(() => bundle.writeFile('/x', 'y'), { code: 'EROFS' });
    const snap = k.snapshot();
    assert.ok(snap.places.bundle.entries.length >= 3);
    const w = VfsKernel.fromSnapshot(snap, k.config, { appRoot: root });
    assert.equal(w.fs('bundle').readFile('/sub/style.css', 'utf8'), 'a{}');
    assert.equal(k.watcher, null, 'nothing to watch');
    k.close();
    w.close();
    rm(root);
  });

  it('is empty when node:sea is unavailable', async () => {
    const root = tmpDir('sea-none');
    const warnings = [];
    const k = new VfsKernel(config({ bundle: { provider: 'sea', fs: true } }), {
      appRoot: root,
      console: { ...quiet, warn: (m) => warnings.push(m) },
      seaModule: null,
    });
    await k.initialize();
    assert.deepEqual(k.fs('bundle').readdir('/'), []);
    assert.ok(warnings.some((w) => /node:sea unavailable/.test(w)));
    k.close();
    rm(root);
  });
});
