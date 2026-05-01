'use strict';

const {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach,
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');

// import-hook.mjs uses module.register API and is normally activated
// through `node --import shared-memory-fs/register`. For unit tests we
// import its exported `resolve`/`load` functions directly and drive them
// with synthetic context/next, validating routing logic in isolation.

const APP_ROOT = path.resolve(os.tmpdir(), `vfs-import-${process.pid}`);
const ESM_DIR = path.join(APP_ROOT, 'esm');
const VFS_SYMBOL = Symbol.for('shared-memory-fs');

const setup = () => {
  fs.mkdirSync(ESM_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ESM_DIR, 'mod.mjs'),
    `export const value = 'hello-from-vfs';\n`,
  );
  fs.writeFileSync(path.join(ESM_DIR, 'data.json'), `{"v":1}\n`);
};
const cleanup = () => fs.rmSync(APP_ROOT, { recursive: true, force: true });

const buildKernel = async () => {
  const config = new VfsConfig({
    defaults: {
      memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
      hooks: { fs: false, require: false, import: false },
    },
    places: {
      esm: {
        domains: ['fs', 'import'],
        match: { dir: 'esm' },
        provider: 'sab',
      },
    },
  });
  const k = new VFSKernel(config, { appRoot: APP_ROOT });
  await k.initialize();
  return k;
};

describe('import-hook', () => {
  let kernel;
  let hook;

  before(async () => {
    setup();
    hook = await import('../lib/adapters/import-hook.mjs');
  });
  after(cleanup);

  beforeEach(async () => {
    kernel = await buildKernel();
    process[VFS_SYMBOL] = kernel;
    hook.initialize();
  });

  afterEach(() => {
    delete process[VFS_SYMBOL];
    if (kernel) kernel.close();
  });

  it('resolve: maps relative ESM specifier to vfs: URL', async () => {
    const parentAbs = path.join(ESM_DIR, 'entry.mjs');
    const parentURL = 'file://' + parentAbs.replace(/\\/g, '/');
    const result = await hook.resolve('./mod.mjs', { parentURL }, () =>
      assert.fail('next should not be called'),
    );
    assert.equal(result.shortCircuit, true);
    assert.equal(result.format, 'module');
    assert.ok(result.url.startsWith('vfs:'));
    assert.ok(result.url.includes('mod.mjs'));
  });

  it('resolve: maps .json specifier with json format', async () => {
    const parentURL =
      'file://' + path.join(ESM_DIR, 'entry.mjs').replace(/\\/g, '/');
    const result = await hook.resolve('./data.json', { parentURL }, () =>
      assert.fail('next should not be called'),
    );
    assert.equal(result.format, 'json');
  });

  it('resolve: passes through non-VFS specifiers', async () => {
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
      return { shortCircuit: true, url: 'node:fs', format: 'builtin' };
    };
    await hook.resolve('node:fs', { parentURL: undefined }, next);
    assert.equal(nextCalled, true);
  });

  it('resolve: passes through vfs: URLs (already resolved)', async () => {
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    await hook.resolve('vfs:/some/path', {}, next);
    assert.equal(nextCalled, true);
  });

  it('load: returns source from SAB cache for vfs: URL', async () => {
    const url = 'vfs:' + path.join(ESM_DIR, 'mod.mjs');
    const result = await hook.load(url, { format: 'module' }, () =>
      assert.fail('next should not be called'),
    );
    assert.equal(result.shortCircuit, true);
    assert.equal(result.format, 'module');
    assert.match(result.source, /hello-from-vfs/);
  });

  it('load: passes through non-vfs URLs', async () => {
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
      return {};
    };
    await hook.load('file:///etc/hostname', {}, next);
    assert.equal(nextCalled, true);
  });

  it('load: passes through vfs: URL when path is not in cache', async () => {
    const url = 'vfs:' + path.join(ESM_DIR, 'missing.mjs');
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
      return {};
    };
    await hook.load(url, {}, next);
    assert.equal(nextCalled, true);
  });

  it('resolve: noop when kernel global is not set', async () => {
    delete process[VFS_SYMBOL];
    hook.initialize();
    let nextArgs = null;
    const next = (s, c) => {
      nextArgs = [s, c];
      return {};
    };
    await hook.resolve('./anything', { parentURL: 'file:///x' }, next);
    assert.deepEqual(nextArgs[0], './anything');
  });
});
