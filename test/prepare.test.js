'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { bytecodeKey, compressedKey } = require('../lib/companion.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  config,
  quiet,
  drain,
  tap,
  worker,
  nextMessage,
} = require('./helpers.js');

// `prepare` is declared by one domain (fs, require, import) and prepares the
// file itself: one preparer per extension in a place, run once per
// publication attempt, one canonical content shared by every domain.

const places = (spec) => new VfsConfig({ places: spec }).places;
const placeOf = (spec) => places({ p: spec })[0];
const rejects = (spec, re) =>
  assert.throws(() => new VfsConfig({ places: { p: spec } }), re);

describe('prepare config: forms', () => {
  it('short forms cover the finite ext of their own domain', () => {
    assert.deepEqual(
      placeOf({ fs: { ext: ['js', 'cjs'], prepare: 'api' } }).prepare,
      {
        js: 'api',
        cjs: 'api',
      },
    );
    assert.deepEqual(
      placeOf({ require: { ext: ['js'], prepare: 'mod' } }).prepare,
      { js: 'mod' },
    );
    assert.deepEqual(
      placeOf({ import: { ext: ['mjs'], prepare: 'esm' } }).prepare,
      { mjs: 'esm' },
    );
    assert.deepEqual(
      placeOf({ require: { prepare: 'mod' } }).prepare,
      { js: 'mod', cjs: 'mod', json: 'mod' },
      'the effective (default) ext of the domain',
    );
  });

  it('object form routes several preparers, one of them to several ext', () => {
    const p = placeOf({
      fs: {
        ext: ['js', 'cjs', 'css', 'html', 'svg'],
        prepare: {
          api: ['js', 'cjs'],
          styles: ['css'],
          markup: ['html', 'SVG'],
        },
      },
    });
    assert.deepEqual(p.prepare, {
      js: 'api',
      cjs: 'api',
      css: 'styles',
      html: 'markup',
      svg: 'markup',
    });
  });

  it('an unrestricted fs takes the object form only', () => {
    rejects({ fs: { prepare: 'content' } }, /needs a finite ext list/);
    // `null` is not a way to say "every file": leave `ext` out.
    rejects(
      { fs: { ext: null, prepare: 'content' } },
      /fs\.ext must be a non-empty array of extensions/,
    );
    const p = placeOf({ fs: { prepare: { code: ['js'], styles: ['css'] } } });
    assert.deepEqual(p.prepare, { js: 'code', css: 'styles' });
    assert.equal(p.fs.ext, null, 'still every file');
    assert.equal(p.scanExt, null);
  });

  it('fs.script.ext is not the scope of a short fs.prepare', () => {
    rejects(
      { fs: { prepare: 'api', script: { ext: ['js'] } } },
      /fs\.prepare: "api" needs a finite ext list/,
    );
    const p = placeOf({
      fs: { ext: ['css'], prepare: 'styles', script: { ext: ['js'] } },
    });
    assert.deepEqual(p.prepare, { css: 'styles' }, 'js is not covered');
    assert.deepEqual(p.fs.ext, ['css', 'js']);
  });

  it('prepare neither adds nor removes extensions', () => {
    const p = placeOf({
      fs: { ext: ['js', 'css'], prepare: { api: ['js'] } },
      require: { ext: ['js'] },
    });
    assert.deepEqual(p.fs.ext, ['js', 'css']);
    assert.deepEqual(p.require.ext, ['js']);
    assert.deepEqual(p.scanExt, ['js', 'css']);
    assert.equal(p.fs.prepare, undefined, 'the index lives on the place');
  });

  it('a domain without prepare shares the file prepared by another', () => {
    const p = placeOf({
      fs: { ext: ['js', 'json'] },
      require: { ext: ['js'], prepare: 'module', compile: true },
    });
    assert.deepEqual(p.prepare, { js: 'module' });
  });

  it('resolved config is frozen and cloneable', () => {
    const [p] = places({
      p: { fs: { ext: ['js'], prepare: 'api', script: { compile: true } } },
    });
    assert.ok(Object.isFrozen(p.prepare));
    assert.throws(() => {
      p.prepare.css = 'x';
    });
    assert.deepEqual(structuredClone(p).prepare, { js: 'api' });
  });
});

describe('prepare config: errors', () => {
  it('an object-form extension must be in a finite domain ext', () => {
    rejects(
      { fs: { ext: ['js'], prepare: { styles: ['css'] } } },
      /fs\.prepare\.styles: extension "css" is not in the domain ext/,
    );
    rejects(
      { require: { ext: ['js'], prepare: { m: ['cjs'] } } },
      /require\.prepare\.m: extension "cjs"/,
    );
  });

  it('names and values are validated', () => {
    rejects({ fs: { ext: ['js'], prepare: '1bad' } }, /invalid preparer name/);
    rejects({ fs: { ext: ['js'], prepare: { 'a b': ['js'] } } }, /invalid/);
    rejects({ fs: { ext: ['js'], prepare: () => {} } }, /got a function/);
    rejects({ fs: { ext: ['js'], prepare: null } }, /preparer name or/);
    rejects({ fs: { ext: ['js'], prepare: {} } }, /preparer name or/);
    rejects({ fs: { ext: ['js'], prepare: { a: [] } } }, /non-empty array/);
    rejects({ fs: { ext: ['js'], prepare: { a: 'js' } } }, /non-empty array/);
    rejects({ fs: { ext: ['js'], prepare: { a: ['.js'] } } }, /without dots/);
  });

  it('an extension appears once in a domain', () => {
    rejects(
      { fs: { ext: ['js'], prepare: { a: ['js', 'JS'] } } },
      /fs\.prepare\.a: extension "js" is listed twice/,
    );
    rejects(
      { fs: { ext: ['js'], prepare: { a: ['js'], b: ['js'] } } },
      /fs\.prepare: extension "js" is assigned to both "a" and "b"/,
    );
  });

  it('an extension has one declaration in the whole place', () => {
    rejects(
      {
        fs: { ext: ['js'], prepare: 'code' },
        require: { ext: ['js'], prepare: 'code' },
      },
      new RegExp(
        'places\\.p: extension "js" has multiple preparer declarations: ' +
          'fs\\.prepare → "code", require\\.prepare → "code"',
      ),
    );
    rejects(
      {
        fs: { ext: ['js'], prepare: 'api' },
        require: { ext: ['js'], prepare: 'module' },
      },
      /fs\.prepare → "api", require\.prepare → "module"/,
    );
    rejects(
      {
        fs: { ext: ['js'], prepare: 'a' },
        require: { ext: ['js'], prepare: 'b' },
        import: { ext: ['js'], prepare: 'c' },
      },
      /fs\.prepare → "a", require\.prepare → "b", import\.prepare → "c"/,
    );
  });

  it('the old fs.script.prepare is gone', () => {
    rejects(
      { fs: { script: { prepare: 'wrap' } } },
      /fs\.script: unknown option "prepare"/,
    );
  });

  it('prepare needs an indexed provider and in-memory sources', () => {
    rejects(
      { provider: 'disk', fs: { ext: ['js'], prepare: 'x' } },
      /prepare requires provider sab, map or sea/,
    );
    rejects(
      {
        fs: {
          ext: ['js'],
          prepare: 'x',
          compress: { encodings: ['gzip'], retainRaw: false },
        },
        require: { compile: false },
      },
      /retainRaw: false is incompatible with prepare/,
    );
  });

  it('every preparer an enabled place names must be registered', async () => {
    const root = tmpDir('vfs-prep');
    const cfg = config({
      a: { fs: { ext: ['js'], prepare: 'missing' } },
      off: { enabled: false, fs: { ext: ['js'], prepare: 'nope' } },
    });
    const k = new VfsKernel(cfg, { appRoot: root, console: quiet });
    await assert.rejects(
      k.initialize(),
      /places\.a: preparer "missing" is not registered/,
    );
    assert.equal(k.state, 'closed');
    assert.throws(
      () => new VfsKernel(cfg, { preparers: { x: 'not a function' } }),
      /preparers\.x is not a function/,
    );
    // A disabled place names a preparer nobody registered: it is not needed.
    const ok = new VfsKernel(
      config({
        a: { fs: { ext: ['js'], prepare: 'id' } },
        off: { enabled: false, fs: { ext: ['js'], prepare: 'nope' } },
      }),
      { appRoot: root, console: quiet, preparers: { id: (raw) => raw } },
    );
    await ok.initialize();
    assert.equal(ok.state, 'ready');
    ok.close();
    rm(root);
  });
});

// --- Pipeline ---

const RAW = 'module.exports = "RAW";';
const PREPARED = 'module.exports = "PREPARED";';
const code = (raw) => raw.toString().replace('RAW', 'PREPARED');

// Calls of a preparer, by key.
const counted = (fn) => {
  const calls = [];
  const wrapped = (raw, file) => {
    calls.push(file.key);
    return fn(raw, file);
  };
  return { fn: wrapped, calls };
};

// A disk-origin kernel whose epochs are emitted by hand and awaited: a long
// debounce keeps real fs.watch events out.
const disk = async (files, spec, preparers, options = {}) => {
  const root = writeTree(tmpDir('vfs-prep'), files);
  const k = await kernel(
    root,
    spec,
    { watch: true, watchTimeout: 60000 },
    { preparers, ...options },
  );
  const at = (...p) => path.join(root, ...p);
  const epoch = async (events) => {
    k.watcher.emit('epoch', new Map(events));
    await k.watchQueue.idle;
  };
  const done = () => {
    k.close();
    rm(root);
  };
  return { root, k, at, epoch, done };
};

describe('prepare pipeline: every way content arrives', () => {
  it('initial scan, watcher update, new file, new directory', async () => {
    const prep = counted(code);
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW, 'app/n.txt': 'plain' },
      { app: { fs: { ext: ['js', 'txt'], prepare: { code: ['js'] } } } },
      { code: prep.fn },
    );
    const app = k.fs('app');
    assert.equal(app.readFile('/a.js', 'utf8'), PREPARED);
    assert.equal(app.readFile('/n.txt', 'utf8'), 'plain', 'no preparer');
    assert.equal(fs.readFileSync(at('app', 'a.js'), 'utf8'), RAW, 'disk raw');
    fs.writeFileSync(at('app', 'a.js'), RAW + ' // v2');
    await epoch([[at('app', 'a.js'), 'change']]);
    assert.equal(app.readFile('/a.js', 'utf8'), PREPARED + ' // v2');
    fs.writeFileSync(at('app', 'b.js'), RAW);
    await epoch([[at('app', 'b.js'), 'change']]);
    assert.equal(app.readFile('/b.js', 'utf8'), PREPARED);
    fs.mkdirSync(at('app', 'd', 'e'), { recursive: true });
    fs.writeFileSync(at('app', 'd', 'e', 'c.js'), RAW);
    await epoch([[at('app', 'd'), 'scan']]);
    assert.equal(app.readFile('/d/e/c.js', 'utf8'), PREPARED);
    assert.deepEqual(prep.calls, ['/a.js', '/a.js', '/b.js', '/d/e/c.js']);
    done();
  });

  it('sab + virtual: main thread and worker mutations', async () => {
    const root = tmpDir('vfs-prep');
    const prep = counted(code);
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'code' },
        },
      },
      {},
      { preparers: { code: prep.fn } },
    );
    await k.fs('v').writeFile('/a.js', RAW);
    assert.equal(k.fs('v').readFile('/a.js', 'utf8'), PREPARED);
    // The worker never prepares a shared place: the main kernel does, and
    // the update reaches the worker before the mutation's response.
    const w = worker(k);
    await w.kernel.fs('v').writeFile('/b.js', RAW);
    assert.equal(k.fs('v').readFile('/b.js', 'utf8'), PREPARED);
    assert.equal(w.kernel.fs('v').readFile('/b.js', 'utf8'), PREPARED);
    assert.deepEqual(prep.calls, ['/a.js', '/b.js']);
    w.kernel.close();
    k.close();
    rm(root);
  });

  it('map + disk: init and watcher; map + virtual: local writes', async () => {
    const { k, at, epoch, done } = await disk(
      { 'm/a.js': RAW },
      {
        m: { provider: 'map', fs: { ext: ['js'], prepare: 'code' } },
        mv: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'code' },
        },
      },
      { code },
    );
    assert.equal(k.fs('m').readFile('/a.js', 'utf8'), PREPARED);
    fs.writeFileSync(at('m', 'a.js'), RAW + ' // v2');
    await epoch([[at('m', 'a.js'), 'change']]);
    assert.equal(k.fs('m').readFile('/a.js', 'utf8'), PREPARED + ' // v2');
    k.fs('mv').writeFile('/x.js', RAW);
    assert.equal(k.fs('mv').readFile('/x.js', 'utf8'), PREPARED);
    done();
  });

  it('SEA assets are prepared once at init', async () => {
    const root = tmpDir('vfs-prep');
    const asset = Buffer.from(RAW);
    const seaModule = {
      isSea: () => true,
      getAssetKeys: () => ['pub/a.js'],
      getAsset: () =>
        asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.length),
    };
    const k = new VfsKernel(
      config({
        pub: { provider: 'sea', fs: { ext: ['js'], prepare: 'code' } },
      }),
      { appRoot: root, console: quiet, seaModule, preparers: { code } },
    );
    await k.initialize();
    assert.equal(k.fs('pub').readFile('/a.js', 'utf8'), PREPARED);
    k.close();
    rm(root);
  });

  it('worker map + virtual prepares with attach({ preparers }) only', async () => {
    const root = tmpDir('vfs-prep');
    const spec = {
      m: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true, ext: ['js', 'txt'], prepare: { code: ['js'] } },
      },
    };
    const k = await kernel(root, spec, {}, { preparers: { code } });
    const given = worker(k, { preparers: { code } });
    given.kernel.fs('m').writeFile('/a.js', RAW);
    assert.equal(given.kernel.fs('m').readFile('/a.js', 'utf8'), PREPARED);
    const bare = worker(k);
    bare.kernel.fs('m').writeFile('/n.txt', 'plain');
    assert.throws(() => bare.kernel.fs('m').writeFile('/a.js', RAW), {
      code: 'ENOTSUP',
      message: /preparer "code" is not registered in this thread/,
    });
    assert.equal(bare.kernel.fs('m').exists('/a.js'), false);
    given.kernel.close();
    bare.kernel.close();
    k.close();
    rm(root);
  });
});

describe('prepare pipeline: every consumer sees the canonical content', () => {
  const files = {
    'app/a.js': RAW,
    'app/s.css': 'a{}',
    'esm/m.mjs': 'export default "RAW";',
  };
  const spec = {
    app: {
      fs: {
        ext: ['js', 'css'],
        zeroCopy: true,
        prepare: { code: ['js'], styles: ['css'] },
        script: { ext: ['js'], compile: true },
        compress: { encodings: ['gzip'] },
      },
      require: { ext: ['js'], compile: true },
    },
    esm: { import: { ext: ['mjs'], prepare: 'code' } },
  };
  const scriptOptions = { filename: 'prepared.js', lineOffset: 0 };
  const preparers = {
    code: (raw, file) => ({
      source: code(raw),
      scriptOptions,
      meta: { key: file.key, nested: { ext: file.ext } },
    }),
    styles: (raw) => '/*p*/' + raw,
  };

  it('reads, views, streams, compression and PlaceFs.script()', async () => {
    const { k, done } = await disk(files, spec, preparers);
    const app = k.fs('app');
    assert.equal(app.readFile('/a.js', 'utf8'), PREPARED);
    assert.equal(app.readFile('/s.css', 'utf8'), '/*p*/a{}');
    const lease = app.readFileView('/a.js');
    assert.equal(lease.view.toString(), PREPARED);
    lease.release();
    const stream = app.createReadStream('/a.js');
    assert.equal((await drain(stream)).toString(), PREPARED);
    stream.release();
    const zlib = require('node:zlib');
    const gz = app.readFileCompressed('/a.js', 'gzip');
    assert.equal(zlib.gunzipSync(gz).toString(), PREPARED);
    const bundle = app.script('/a.js');
    assert.equal(bundle.source, PREPARED);
    assert.ok(Buffer.isBuffer(bundle.cachedData));
    assert.deepEqual(bundle.scriptOptions, scriptOptions);
    assert.deepEqual(bundle.meta, { key: '/a.js', nested: { ext: 'js' } });
    assert.ok(Object.isFrozen(bundle.meta.nested), 'meta is deep-frozen');
    assert.equal(app.meta('/a.js'), bundle.meta);
    assert.equal(app.script('/s.css'), null, 'not a script source');
    assert.deepEqual(app.readdir('/'), ['a.js', 's.css'], 'no companions');
    done();
  });

  it('patched node:fs, require and import', async () => {
    const { k, at, done } = await disk(files, spec, preparers);
    fsPatch.install(k);
    moduleHook.install(k);
    try {
      assert.equal(fs.readFileSync(at('app', 'a.js'), 'utf8'), PREPARED);
      assert.equal(require(at('app', 'a.js')), 'PREPARED');
      assert.ok(k.bytecode(at('app', 'a.js')), 'require.compile companion');
      const mod = await import(pathToFileURL(at('esm', 'm.mjs')).href);
      assert.equal(mod.default, 'PREPARED');
    } finally {
      moduleHook.uninstall();
      fsPatch.uninstall();
      done();
    }
  });

  it('require.compile cached data matches the prepared source (worker)', async () => {
    const { k, at, done } = await disk(files, spec, preparers);
    const { vfs, transferList } = k.link();
    const index = JSON.stringify(path.resolve(__dirname, '../index.js'));
    const thread = new Worker(
      `
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
      require(${index}).attach();
      const value = require(${JSON.stringify(at('app', 'a.js'))});
      parentPort.postMessage({ value, seen });
      `,
      { eval: true, workerData: { vfs }, transferList },
    );
    const [message] = await once(thread, 'message');
    assert.deepEqual(message, { value: 'PREPARED', seen: [false] });
    await thread.terminate();
    done();
  });

  it('runs once per publication, never on read, for every domain', async () => {
    const prep = counted(code);
    const { k, at, done } = await disk(
      { 'all/a.js': RAW },
      {
        all: {
          fs: { ext: ['js'], prepare: 'code', script: { compile: true } },
          require: { ext: ['js'], compile: true },
          import: { ext: ['js'] },
        },
      },
      { code: prep.fn },
    );
    assert.deepEqual(prep.calls, ['/a.js']);
    const all = k.fs('all');
    all.readFile('/a.js');
    all.script('/a.js');
    k.resolveModule(at('all', 'a.js'), 'require');
    k.resolveModule(at('all', 'a.js'), 'import');
    assert.deepEqual(prep.calls, ['/a.js'], 'reads never prepare');
    const place = k.registry.get('all');
    assert.ok(place.bytecode('/a.js', 'script'));
    assert.ok(place.bytecode('/a.js', 'require'));
    done();
  });

  it('a preparer declared in require prepares fs reads and fs.script', async () => {
    const { k, done } = await disk(
      { 'lib/a.js': RAW },
      {
        lib: {
          fs: { ext: ['js', 'json'], script: { ext: ['js'] } },
          require: { ext: ['js'], prepare: 'code', compile: true },
        },
      },
      {
        code: (raw) => ({
          source: code(raw),
          scriptOptions: { lineOffset: 1 },
        }),
      },
    );
    const lib = k.fs('lib');
    assert.equal(lib.readFile('/a.js', 'utf8'), PREPARED);
    const bundle = lib.script('/a.js');
    assert.equal(bundle.source, PREPARED);
    assert.deepEqual(bundle.scriptOptions, { lineOffset: 1 });
    assert.ok(bundle.cachedData);
    done();
  });

  it('an unrestricted fs prepares only the listed extensions', async () => {
    const { k, done } = await disk(
      { 'u/a.js': RAW, 'u/b.txt': 'RAW' },
      { u: { fs: { prepare: { code: ['js'] } } } },
      { code },
    );
    assert.equal(k.fs('u').readFile('/a.js', 'utf8'), PREPARED);
    assert.equal(k.fs('u').readFile('/b.txt', 'utf8'), 'RAW');
    done();
  });
});

describe('prepare pipeline: the preparer contract', () => {
  const virtual = async (fn, extra = {}) => {
    const root = tmpDir('vfs-prep');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js', 'txt'], prepare: { p: ['js'] } },
          ...extra,
        },
      },
      {},
      { preparers: { p: (...args) => fn(...args) } },
    );
    const done = () => {
      k.close();
      rm(root);
    };
    return { k, v: k.fs('v'), done };
  };

  it('passes the raw Buffer and a frozen file description', async () => {
    const seen = [];
    const { k, v, done } = await virtual((raw, file) => {
      seen.push({ raw, file });
      return null;
    });
    const before = Date.now();
    await v.writeFile('/d/a.js', 'raw bytes');
    const [{ raw, file }] = seen;
    assert.ok(Buffer.isBuffer(raw));
    assert.equal(raw.toString(), 'raw bytes');
    assert.ok(Object.isFrozen(file) && Object.isFrozen(file.stat));
    assert.equal(file.place, 'v');
    assert.equal(file.key, '/d/a.js');
    assert.equal(file.path, path.join(k.appRoot, 'v', 'd', 'a.js'));
    assert.equal(file.ext, 'js');
    assert.equal(file.stat.size, 9);
    assert.ok(file.stat.mtimeMs >= before);
    assert.equal(v.readFile('/d/a.js', 'utf8'), 'raw bytes', 'null → raw');
    done();
  });

  it('accepts strings, Buffers and Uint8Arrays, empty ones too, and copies bytes', async () => {
    let result = null;
    const { v, done } = await virtual(() => result);
    result = 'text';
    await v.writeFile('/a.js', 'x');
    assert.equal(v.readFile('/a.js', 'utf8'), 'text');
    const reused = Buffer.from('buffer');
    result = reused;
    await v.writeFile('/a.js', 'x');
    reused.write('BUFFER');
    assert.equal(v.readFile('/a.js', 'utf8'), 'buffer', 'published a copy');
    result = { source: new Uint8Array([0x75, 0x38]) };
    await v.writeFile('/a.js', 'x');
    assert.equal(v.readFile('/a.js', 'utf8'), 'u8');
    result = '';
    await v.writeFile('/a.js', 'x');
    assert.equal(v.readFile('/a.js').length, 0);
    result = { source: Buffer.alloc(0) };
    await v.writeFile('/a.js', 'x');
    assert.equal(v.stat('/a.js').size, 0);
    done();
  });

  it('rejects async preparers and malformed results, keeping the old version', async () => {
    let result = 'good';
    const { k, v, done } = await virtual(() => result);
    await v.writeFile('/a.js', 'x');
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const bad = [
      [Promise.reject(new Error('async')), /must be synchronous/],
      [{ then() {} }, /must be synchronous/],
      [42, /result must be a string, a Uint8Array or \{ source \}/],
      [{ source: 42 }, /source must be a string or Uint8Array/],
      [{}, /source must be a string or Uint8Array/],
      [{ source: 'x', meta: 'm' }, /meta must be an object/],
      [{ source: 'x', scriptOptions: { cachedData: 1 } }, /reserved/],
    ];
    for (const [value, re] of bad) {
      result = value;
      await assert.rejects(v.writeFile('/a.js', 'x'), re);
      assert.equal(v.readFile('/a.js', 'utf8'), 'good');
    }
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
    assert.equal(k.retired.size, 0);
    done();
  });

  it('a throwing preparer keeps the previous version and its companions', async () => {
    let fail = false;
    const { k, v, done } = await virtual(
      (raw) => {
        if (fail) throw new Error('bad input');
        return raw.toString();
      },
      { require: { ext: ['js'], compile: true } },
    );
    await v.writeFile('/a.js', 'module.exports = 1;');
    const place = k.registry.get('v');
    const bytecode = place.bytecode('/a.js');
    fail = true;
    await assert.rejects(v.writeFile('/a.js', 'module.exports = 2;'), /bad/);
    assert.equal(v.readFile('/a.js', 'utf8'), 'module.exports = 1;');
    assert.equal(place.bytecode('/a.js'), bytecode);
    done();
  });

  it('a watcher-side failure keeps the previous version', async () => {
    const warnings = [];
    let fail = false;
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW },
      {
        app: {
          fs: { ext: ['js'], prepare: 'code', script: { compile: true } },
        },
      },
      {
        code: (raw) => (fail ? '(((' : code(raw)),
      },
      { console: { ...quiet, warn: (m) => warnings.push(m) } },
    );
    fail = true;
    fs.writeFileSync(at('app', 'a.js'), RAW + ' // v2');
    await epoch([[at('app', 'a.js'), 'change']]);
    assert.equal(k.fs('app').readFile('/a.js', 'utf8'), PREPARED);
    assert.equal(k.fs('app').script('/a.js').source, PREPARED);
    assert.ok(
      warnings.some((w) => /not published — fs\.script\.compile/.test(w)),
    );
    done();
  });

  it('prepare and scriptOptions never turn fs.script on', async () => {
    const root = tmpDir('vfs-prep-noscript');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js'], prepare: 'wrap' },
        },
      },
      {},
      {
        preparers: {
          wrap: (raw, file) => ({
            source: `(${raw.toString().trim()})`,
            scriptOptions: { filename: file.path },
          }),
        },
      },
    );
    try {
      const v = k.fs('v');
      await v.writeFile('/a.js', 'x => x');
      assert.equal(v.readFile('/a.js', 'utf8'), '(x => x)');
      assert.ok(!k.cache.entry('v', bytecodeKey('/a.js', 'script')));
      assert.throws(() => v.script('/a.js'), { code: 'ENOTSUP' });
    } finally {
      k.close();
      rm(root);
    }
  });
});

describe('prepare pipeline: publication', () => {
  it('source and companions travel in one update; raw bytes never stay', async () => {
    const { k, at, epoch, done } = await disk(
      { 'app/a.js': RAW },
      {
        app: {
          fs: {
            ext: ['js'],
            prepare: 'code',
            script: { compile: true },
            compress: { encodings: ['gzip'] },
          },
          require: { ext: ['js'], compile: true },
        },
      },
      { code },
    );
    // The pool holds exactly the published entries: no raw copy anywhere.
    const pooled = () => {
      let published = 0;
      for (const entry of k.cache.index('app').entries.values()) {
        published += entry.length;
      }
      let used = 0;
      for (const id of k.cache.pool.segments.keys()) {
        used += k.cache.registry.used(id);
      }
      return [used, published];
    };
    const [used, published] = pooled();
    assert.equal(used, published);
    const t = tap(k);
    const acked = nextMessage(k.links.get(t.id));
    fs.writeFileSync(at('app', 'a.js'), RAW + ' // v2');
    await epoch([[at('app', 'a.js'), 'change']]);
    await acked;
    const [msg] = t.updates();
    assert.deepEqual(
      msg.places.app.entries.map(([key]) => key).sort(),
      [
        '/a.js',
        bytecodeKey('/a.js', 'require'),
        bytecodeKey('/a.js', 'script'),
        compressedKey('/a.js', 'gzip'),
      ].sort(),
    );
    assert.equal(k.retired.size, 0, 'the old version went with the ACK');
    const [usedAfter, publishedAfter] = pooled();
    assert.equal(usedAfter, publishedAfter);
    done();
  });

  it('appendFile and moves of prepared keys are refused; others re-prepare', async () => {
    const root = tmpDir('vfs-prep');
    const k = await kernel(
      root,
      {
        v: {
          origin: 'virtual',
          fs: { writable: true, ext: ['js', 'txt'], prepare: { code: ['js'] } },
        },
        m: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, ext: ['js', 'txt'], prepare: { code: ['js'] } },
        },
      },
      {},
      { preparers: { code } },
    );
    for (const name of ['v', 'm']) {
      const place = k.fs(name);
      await place.writeFile('/a.js', RAW);
      await assert.rejects(async () => place.appendFile('/a.js', 'x'), {
        code: 'ENOTSUP',
      });
      await assert.rejects(async () => place.rename('/a.js', '/a.txt'), {
        code: 'ENOTSUP',
      });
      await assert.rejects(async () => place.rename('/a.js', '/b.js'), {
        code: 'ENOTSUP',
      });
      assert.equal(place.readFile('/a.js', 'utf8'), PREPARED, name);
      await place.writeFile('/r.txt', RAW);
      await place.rename('/r.txt', '/r.js');
      assert.equal(place.readFile('/r.js', 'utf8'), PREPARED, 'new ext rules');
      assert.equal(place.exists('/r.txt'), false);
      await place.writeFile('/t.txt', 'plain');
      await place.appendFile('/t.txt', '+');
      assert.equal(place.readFile('/t.txt', 'utf8'), 'plain+');
    }
    k.close();
    rm(root);
  });
});
