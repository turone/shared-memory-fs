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
const Module = require('node:module');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const requireHook = require('../lib/adapters/require-hook.js');

const APP_ROOT = path.resolve(os.tmpdir(), `vfs-require-${process.pid}`);
const CODE_DIR = path.join(APP_ROOT, 'code');

const setup = () => {
  fs.mkdirSync(CODE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CODE_DIR, 'main.js'),
    `'use strict'; const sub = require('./sub'); module.exports = { v: sub.v + 1 };`,
  );
  fs.writeFileSync(
    path.join(CODE_DIR, 'sub.js'),
    `'use strict'; module.exports = { v: 41 };`,
  );
};

const cleanup = () => fs.rmSync(APP_ROOT, { recursive: true, force: true });

const buildKernel = async (extra = {}) => {
  const config = new VfsConfig({
    defaults: {
      memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
      hooks: { fs: false, require: false, import: false },
    },
    places: {
      code: {
        domains: ['fs', 'require'],
        match: { dir: 'code' },
        provider: 'sab',
        ...extra,
      },
      mem: {
        domains: ['fs', 'require'],
        match: { dir: 'mem' },
        provider: 'memory',
      },
    },
  });
  const k = new VFSKernel(config, { appRoot: APP_ROOT });
  await k.initialize();
  return k;
};

const clearRequireCache = (dir) => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir)) delete require.cache[key];
  }
};

describe('require-hook', () => {
  let kernel;

  before(setup);
  after(cleanup);

  beforeEach(async () => {
    kernel = await buildKernel();
    fsPatch.install(kernel);
    requireHook.install(kernel);
  });

  afterEach(() => {
    requireHook.uninstall();
    fsPatch.uninstall();
    clearRequireCache(APP_ROOT);
    if (kernel) kernel.close();
  });

  it('require resolves SAB-backed module by absolute path', () => {
    const mod = require(path.join(CODE_DIR, 'main.js'));
    assert.equal(mod.v, 42);
  });

  it('relative require between SAB modules works', () => {
    // main.js requires './sub' — the patched _resolveFilename must route
    // it via VFS so sub.js is loaded from the same place.
    const mod = require(path.join(CODE_DIR, 'main.js'));
    assert.equal(mod.v, 42);
    // sub.js is now in Node's require cache too.
    const subPath = path.join(CODE_DIR, 'sub.js');
    assert.ok(require.cache[subPath], 'sub.js should be in require cache');
  });

  it('require uses Node module cache on second call', () => {
    const mod1 = require(path.join(CODE_DIR, 'main.js'));
    const mod2 = require(path.join(CODE_DIR, 'main.js'));
    assert.equal(mod1, mod2);
  });

  it('require of memory-backed module after writeFile', () => {
    const place = kernel.getPlace('mem');
    place.writeFile(
      '/dyn.js',
      Buffer.from(`'use strict'; module.exports = { hello: 'world' };`),
    );
    const mod = require(path.join(APP_ROOT, 'mem', 'dyn.js'));
    assert.equal(mod.hello, 'world');
  });

  it('non-VFS require falls through to Node resolver', () => {
    // Built-ins and node_modules must keep working unchanged.
    const realFs = require('node:fs');
    assert.equal(typeof realFs.readFileSync, 'function');
    const assertMod = require('node:assert');
    assert.equal(typeof assertMod.equal, 'function');
  });
});

describe('require-hook: bytecode (compile: true)', () => {
  let kernel;

  before(setup);
  after(cleanup);

  beforeEach(async () => {
    kernel = await buildKernel({ compile: true });
    fsPatch.install(kernel);
    requireHook.install(kernel);
  });

  afterEach(() => {
    requireHook.uninstall();
    fsPatch.uninstall();
    clearRequireCache(APP_ROOT);
    if (kernel) kernel.close();
  });

  it('bytecode companion entry exists for compiled JS', () => {
    const place = kernel.getPlace('code');
    const cached = place.getCachedData('/main.js');
    assert.ok(Buffer.isBuffer(cached), 'expected bytecode buffer');
    assert.ok(cached.length > 0);
  });

  it('require still works when bytecode path is taken', () => {
    const mod = require(path.join(CODE_DIR, 'main.js'));
    assert.equal(mod.v, 42);
  });
});

describe('require-hook: install/uninstall idempotence', () => {
  it('double install does not double-wrap', async () => {
    const kernel = await buildKernel();
    const before = Module._resolveFilename;
    requireHook.install(kernel);
    const afterFirst = Module._resolveFilename;
    requireHook.install(kernel);
    const afterSecond = Module._resolveFilename;
    assert.notEqual(before, afterFirst);
    assert.equal(afterFirst, afterSecond);
    requireHook.uninstall();
    assert.equal(Module._resolveFilename, before);
    kernel.close();
  });
});
