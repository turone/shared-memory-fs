'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');

const APP_ROOT = path.resolve(os.tmpdir(), 'vfs-strict-test');

const baseConfig = (extra = {}) =>
  new VfsConfig({
    defaults: {
      memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
      hooks: { fs: false, require: false, import: false },
      strict: true,
      ...extra,
    },
    places: {
      mem: { domains: ['fs'], match: { dir: 'mem' }, provider: 'memory' },
    },
  });

describe('strict sandbox mode', () => {
  let kernel;

  beforeEach(async () => {
    kernel = new VFSKernel(baseConfig(), { appRoot: APP_ROOT });
    await kernel.initialize();
    fsPatch.install(kernel);
  });

  afterEach(() => {
    fsPatch.uninstall();
    kernel.close();
  });

  it('isStrictDenied: true for unmatched path under appRoot', () => {
    const p = path.resolve(APP_ROOT, 'forbidden.txt');
    assert.equal(kernel.isStrictDenied(p), true);
  });

  it('isStrictDenied: false for matched mount path', () => {
    const p = path.resolve(APP_ROOT, 'mem', 'a.txt');
    assert.equal(kernel.isStrictDenied(p), false);
  });

  it('isStrictDenied: false for paths outside appRoot', () => {
    const p = path.resolve(APP_ROOT, '..', 'elsewhere', 'x.txt');
    assert.equal(kernel.isStrictDenied(p), false);
  });

  it('isStrictDenied: false when strict is disabled', async () => {
    const k = new VFSKernel(
      new VfsConfig({
        defaults: { hooks: { fs: false, require: false, import: false } },
        places: {
          mem: { domains: ['fs'], match: { dir: 'mem' }, provider: 'memory' },
        },
      }),
      { appRoot: APP_ROOT },
    );
    await k.initialize();
    assert.equal(k.isStrictDenied(path.resolve(APP_ROOT, 'x')), false);
    k.close();
  });

  it('readFileSync throws EACCES for unmatched path under appRoot', () => {
    const p = path.resolve(APP_ROOT, 'forbidden.txt');
    assert.throws(() => fs.readFileSync(p), { code: 'EACCES' });
  });

  it('statSync throws EACCES for unmatched path under appRoot', () => {
    const p = path.resolve(APP_ROOT, 'secret');
    assert.throws(() => fs.statSync(p), { code: 'EACCES' });
  });

  it('existsSync returns false for denied path (no exception)', () => {
    const p = path.resolve(APP_ROOT, 'nope.txt');
    assert.equal(fs.existsSync(p), false);
  });

  it('writeFileSync throws EACCES for unmatched path under appRoot', () => {
    const p = path.resolve(APP_ROOT, 'evil.txt');
    assert.throws(() => fs.writeFileSync(p, 'x'), { code: 'EACCES' });
  });

  it('memory mount writes/reads succeed under strict mode', () => {
    const p = path.resolve(APP_ROOT, 'mem', 'ok.txt');
    fs.writeFileSync(p, 'hello');
    assert.equal(fs.readFileSync(p, 'utf8'), 'hello');
    assert.equal(fs.existsSync(p), true);
  });

  it('async readFile passes EACCES to callback', (t, done) => {
    const p = path.resolve(APP_ROOT, 'forbidden.txt');
    fs.readFile(p, (err) => {
      assert.ok(err);
      assert.equal(err.code, 'EACCES');
      done();
    });
  });

  it('promises.readFile rejects with EACCES', async () => {
    const p = path.resolve(APP_ROOT, 'forbidden.txt');
    await assert.rejects(fs.promises.readFile(p), { code: 'EACCES' });
  });
});
