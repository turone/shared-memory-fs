'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const moduleHook = require('../lib/adapters/module-hook.js');
const { bytecodeKey } = require('../lib/companion.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// Spy on vm.Script to observe whether V8 accepted our cached data.
const scripts = [];
const RealScript = vm.Script;
const spyScripts = () => {
  vm.Script = class extends RealScript {
    constructor(code, options) {
      super(code, options);
      if (options?.cachedData)
        scripts.push({
          filename: options.filename,
          rejected: this.cachedDataRejected,
        });
    }
  };
};
const unspy = () => {
  vm.Script = RealScript;
};

describe('module-hook: CommonJS', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('modhook'), {
      'lib/a.js':
        "exports.name = 'a'; exports.b = require('./b'); exports.loadedInside = module.loaded; exports.dir = __dirname; exports.file = __filename;",
      'lib/b.js': "exports.name = 'b'; exports.a = require('./a.js');",
      'lib/c.cjs': 'module.exports = "c";',
      'lib/data.json': '{"x": 1}',
      'lib/dir/index.js': 'module.exports = "dir-index";',
      'lib/pkg/package.json': '{"main": "src/entry"}',
      'lib/pkg/src/entry.js': 'module.exports = "pkg-main";',
      'lib/throws.js':
        'globalThis.__vfsThrows = (globalThis.__vfsThrows || 0) + 1; throw new Error("boom");',
      'lib/bare.js': "module.exports = require('node:path').sep;",
      'lib/damaged.js':
        'globalThis.__vfsDamaged = (globalThis.__vfsDamaged || 0) + 1; module.exports = "repaired";',
      'lib/noext': 'module.exports = "noext";',
      'lib/notes.md': '# not a module',
      'disk/d.js': 'module.exports = "disk";',
    });
    k = await kernel(root, {
      lib: { require: true },
      mem: { provider: 'memory', fs: { writable: true }, require: true },
      disk: { provider: 'disk', require: { compile: false } },
    });
    moduleHook.install(k);
    spyScripts();
  });

  after(() => {
    unspy();
    moduleHook.uninstall();
    k.close();
    rm(root);
  });

  it('resolves relative and absolute specifiers, circular deps, module.loaded', () => {
    const a = require(at('lib', 'a'));
    assert.equal(a.name, 'a');
    assert.equal(a.b.name, 'b');
    assert.equal(a.b.a, a, 'circular dependency returns the same module');
    assert.equal(a.loadedInside, false);
    assert.equal(a.dir, at('lib'));
    assert.equal(a.file, at('lib', 'a.js'));
    assert.equal(require.cache[at('lib', 'a.js')].loaded, true);
    assert.equal(require(at('lib', 'a.js')), a, 'cached by filename');
  });

  it('takes the cached-data path for sab modules', () => {
    // V8's per-isolate compilation cache already knows this source (the kernel
    // compiled it here), so acceptance itself is proven in the worker test.
    const used = scripts.filter((s) => s.filename === at('lib', 'a.js'));
    assert.equal(used.length, 1);
    assert.ok(k.bytecode(at('lib', 'a.js')));
  });

  it('LOAD_AS_FILE: exact, .js, .cjs, .json; LOAD_AS_DIRECTORY: package main, index', () => {
    assert.equal(require(at('lib', 'noext')), 'noext');
    assert.equal(require(at('lib', 'c')), 'c');
    assert.deepEqual(require(at('lib', 'data')), { x: 1 });
    assert.equal(require(at('lib', 'dir')), 'dir-index');
    assert.equal(require(at('lib', 'pkg')), 'pkg-main');
    assert.equal(
      k.bytecode(at('lib', 'data.json')),
      null,
      'json has no bytecode',
    );
  });

  it('a throwing module body executes exactly once and propagates', () => {
    assert.ok(
      k.bytecode(at('lib', 'throws.js')),
      'has bytecode, so the cached path is taken',
    );
    assert.throws(() => require(at('lib', 'throws.js')), /boom/);
    assert.equal(globalThis.__vfsThrows, 1);
    assert.throws(() => require(at('lib', 'throws.js')), /boom/);
    assert.equal(
      globalThis.__vfsThrows,
      2,
      'one execution per require, never a re-run fallback',
    );
    delete globalThis.__vfsThrows;
  });

  it('damaged cached data falls back to the normal compiler once', () => {
    const place = k.registry.get('lib');
    const key = bytecodeKey('/damaged.js');
    const good = place.files.get(key);
    place.files.set(key, {
      data: Buffer.from('garbage-not-bytecode'),
      stat: good.stat,
    });
    const before = scripts.length;
    assert.equal(require(at('lib', 'damaged.js')), 'repaired');
    assert.equal(globalThis.__vfsDamaged, 1, 'executed once');
    const attempts = scripts
      .slice(before)
      .filter((s) => s.filename === at('lib', 'damaged.js'));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].rejected, true);
    place.files.set(key, good);
    delete globalThis.__vfsDamaged;
  });

  it('bare and builtin specifiers use the default resolver', () => {
    assert.equal(require(at('lib', 'bare.js')), path.sep);
  });

  it('memory modules load without a disk file; require.cache eviction reloads', () => {
    const mem = k.fs('mem');
    mem.writeFile('/tool.js', 'module.exports = 1;');
    const file = at('mem', 'tool.js');
    assert.equal(require(file), 1);
    assert.equal(require(file), 1);
    mem.writeFile('/tool.js', 'module.exports = 2;');
    assert.equal(
      require(file),
      1,
      'Node module cache still holds the old instance',
    );
    delete require.cache[file];
    assert.equal(require(file), 2);
    const used = scripts.filter((s) => s.filename === file);
    assert.ok(used.length >= 1, 'memory bytecode path taken');
  });

  it('files outside the require ext and disk places are left to Node', () => {
    assert.throws(
      () => require(at('lib', 'notes.md')),
      /Unexpected token|SyntaxError|not a module|Cannot find/,
    );
    assert.equal(require(at('disk', 'd.js')), 'disk');
    assert.equal(
      scripts.filter((s) => s.filename === at('disk', 'd.js')).length,
      0,
    );
  });

  it('uninstall restores Module.prototype._compile and the resolver', () => {
    moduleHook.uninstall();
    assert.throws(() => require(at('mem', 'tool.js') + '.nope'), {
      code: 'MODULE_NOT_FOUND',
    });
    moduleHook.install(k);
  });
});

describe('module-hook: bytecode accepted across isolates', () => {
  it('a worker attached to the snapshot compiles with cached data V8 does not reject', async () => {
    const { Worker } = require('node:worker_threads');
    const { until } = require('./helpers.js');
    const root = writeTree(tmpDir('modhook-worker'), {
      'lib/m.js': 'module.exports = [1, 2, 3].map((x) => x * 2);',
    });
    const k = await kernel(root, { lib: { require: true } });
    const { vfs, transferList } = k.link();
    const script = `
      const vm = require('node:vm');
      const { parentPort } = require('node:worker_threads');
      const seen = [];
      const Real = vm.Script;
      vm.Script = class extends Real {
        constructor(code, options) {
          super(code, options);
          if (options?.cachedData) seen.push(this.cachedDataRejected);
        }
      };
      require(${JSON.stringify(path.resolve(__dirname, '..'))}).attach();
      const result = require(${JSON.stringify(path.join(root, 'lib', 'm.js'))});
      parentPort.postMessage({ result, seen });
    `;
    const worker = new Worker(script, {
      eval: true,
      workerData: { vfs },
      transferList,
    });
    const exited = new Promise((resolve) => worker.on('exit', resolve));
    let message = null;
    const errors = [];
    worker.on('message', (m) => (message = m));
    worker.on('error', (e) => errors.push(e));
    await until(() => message || errors.length);
    assert.deepEqual(errors, []);
    assert.deepEqual(message, { result: [2, 4, 6], seen: [false] });
    await exited;
    k.close();
    rm(root);
  });
});

describe('module-hook: strict', () => {
  it('missing or unpublished modules in indexed mounts are MODULE_NOT_FOUND, never read from disk', async () => {
    const root = writeTree(tmpDir('modhook-strict'), {
      'lib/a.js': 'module.exports = "a";',
    });
    const k = await kernel(root, { lib: { require: true } }, { strict: true });
    moduleHook.install(k);
    // Created after init: on disk, but not published (no watcher).
    fs.writeFileSync(
      path.join(root, 'lib', 'late.js'),
      'module.exports = "late";',
    );
    assert.equal(require(path.join(root, 'lib', 'a.js')), 'a');
    assert.throws(() => require(path.join(root, 'lib', 'late.js')), {
      code: 'MODULE_NOT_FOUND',
    });
    assert.throws(() => require(path.join(root, 'lib', 'nope')), {
      code: 'MODULE_NOT_FOUND',
    });
    assert.throws(() => require(path.join(root, 'stray', 'x.js')), {
      code: 'MODULE_NOT_FOUND',
    });
    moduleHook.uninstall();
    // Without strict the same late file loads from disk through Node.
    const k2 = await kernel(root, { lib: { require: true } });
    moduleHook.install(k2);
    delete require.cache[path.join(root, 'lib', 'late.js')];
    assert.equal(require(path.join(root, 'lib', 'late.js')), 'late');
    moduleHook.uninstall();
    k.close();
    k2.close();
    rm(root);
  });
});

describe('module-hook: ESM', () => {
  let root;
  let k;
  const url = (...p) => pathToFileURL(path.join(root, ...p)).href;

  before(async () => {
    root = writeTree(tmpDir('modhook-esm'), {
      'esm/a.mjs':
        "import { b } from './b.js'; export const a = 'a' + b; export const url = import.meta.url; export { default as data } from './data.json' with { type: 'json' };",
      'esm/b.js': "import { c } from './sub/c.mjs'; export const b = 'b' + c;",
      'esm/sub/c.mjs':
        "export const c = 'c'; globalThis.__vfsEsmRuns = (globalThis.__vfsEsmRuns || 0) + 1;",
      'esm/data.json': '{"ok": true}',
      'esm/bad-attr.mjs':
        "import data from './data.json'; export default data;",
      'esm/weird name #1.mjs': 'export const w = 1;',
      'esm/cjs.cjs': 'module.exports = { fromCjs: true };',
      'esm/uses-cjs.mjs':
        "import cjs from './cjs.cjs'; export const ok = cjs.fromCjs;",
      'disk/d.mjs': 'export const d = 1;',
    });
    k = await kernel(root, {
      esm: { import: { ext: ['js', 'mjs', 'json', 'cjs'] } },
      disk: { provider: 'disk', import: true },
    });
    moduleHook.install(k);
  });

  after(() => {
    moduleHook.uninstall();
    k.close();
    rm(root);
  });

  it('imports a chain of SAB modules with plain file: URLs', async () => {
    const mod = await import(url('esm', 'a.mjs'));
    assert.equal(mod.a, 'abc');
    assert.equal(mod.url, url('esm', 'a.mjs'));
    assert.deepEqual(mod.data, { ok: true });
    assert.equal(globalThis.__vfsEsmRuns, 1);
    await import(url('esm', 'a.mjs'));
    await import(url('esm', 'sub', 'c.mjs'));
    assert.equal(globalThis.__vfsEsmRuns, 1, 'evaluated once per URL');
    delete globalThis.__vfsEsmRuns;
  });

  it('.js in the import domain is ESM; .cjs stays CommonJS', async () => {
    const mod = await import(url('esm', 'uses-cjs.mjs'));
    assert.equal(mod.ok, true);
  });

  it('json needs the import attribute', async () => {
    await assert.rejects(import(url('esm', 'bad-attr.mjs')), {
      code: 'ERR_IMPORT_ATTRIBUTE_MISSING',
    });
  });

  it('special characters in paths round-trip', async () => {
    const mod = await import(url('esm', 'weird name #1.mjs'));
    assert.equal(mod.w, 1);
  });

  it('missing modules and missing extensions are ERR_MODULE_NOT_FOUND', async () => {
    await assert.rejects(import(url('esm', 'nope.mjs')), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await assert.rejects(import(url('esm', 'b')), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
  });

  it('disk places and bare specifiers go through Node', async () => {
    const mod = await import(url('disk', 'd.mjs'));
    assert.equal(mod.d, 1);
    const p = await import('node:path');
    assert.equal(p.sep, path.sep);
  });
});
