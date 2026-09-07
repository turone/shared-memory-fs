'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VfsConfig } = require('../lib/config.js');

const make = (places, defaults) => new VfsConfig({ defaults, places });
const fails = (raw, re) => assert.throws(() => new VfsConfig(raw), re);

describe('VfsConfig: globals', () => {
  it('applies defaults', () => {
    const { global } = new VfsConfig();
    assert.equal(global.memory.limit, 1024 ** 3);
    assert.equal(global.memory.segmentSize, 64 * 1024 ** 2);
    assert.equal(global.compaction.threshold, 0.3);
    assert.deepEqual(global.hooks, { fs: true, module: true });
    assert.equal(global.watch, false);
    assert.equal(global.strict, false);
  });

  it('parses sizes as strings or numbers', () => {
    const { global } = make(
      {},
      { memory: { limit: 4096, segmentSize: '1 kib', maxFileSize: 512 } },
    );
    assert.equal(global.memory.limit, 4096);
    assert.equal(global.memory.segmentSize, 1024);
  });

  it('rejects invalid numbers', () => {
    fails({ defaults: { memory: { limit: 0 } } }, /limit/);
    fails({ defaults: { memory: { limit: -1 } } }, /limit/);
    fails({ defaults: { memory: { segmentSize: 1.5 } } }, /segmentSize/);
    fails({ defaults: { memory: { maxFileSize: NaN } } }, /maxFileSize/);
    fails({ defaults: { memory: { maxFileSize: Infinity } } }, /maxFileSize/);
    fails({ defaults: { compaction: { threshold: 2 } } }, /threshold/);
    fails({ defaults: { compaction: { threshold: '0.3' } } }, /threshold/);
    fails({ defaults: { watchTimeout: -5 } }, /watchTimeout/);
    fails({ defaults: { watchTimeout: 1.5 } }, /watchTimeout/);
  });

  it('requires real booleans', () => {
    fails({ defaults: { strict: 'false' } }, /strict must be a boolean/);
    fails({ defaults: { hooks: { fs: 'true' } } }, /hooks\.fs/);
    fails({ defaults: { watch: 1 } }, /watch must be a boolean/);
  });

  it('enforces limit >= segmentSize >= maxFileSize', () => {
    fails(
      { defaults: { memory: { limit: '1 kib', segmentSize: '2 kib' } } },
      /limit/,
    );
    fails(
      { defaults: { memory: { maxFileSize: '2 mib', segmentSize: '1 mib' } } },
      /maxFileSize/,
    );
  });

  it('rejects unknown keys everywhere', () => {
    fails({ mode: 'x' }, /unknown option "mode"/);
    fails({ defaults: { gc: {} } }, /unknown option "gc"/);
    fails(
      { places: { a: { fs: true, domains: ['fs'] } } },
      /unknown option "domains"/,
    );
    fails({ places: { a: { fs: true, dir: 'x' } } }, /unknown option "dir"/);
    fails(
      { places: { a: { fs: { ext: ['js'], writable: true, other: 1 } } } },
      /unknown option "other"/,
    );
  });
});

describe('VfsConfig: place names', () => {
  it('accepts ASCII names with . _ - and keeps case', () => {
    const c = make({ 'My.Place_1-x': { fs: true } });
    assert.equal(c.places[0].name, 'My.Place_1-x');
  });

  it('rejects invalid names', () => {
    for (const name of [
      '',
      '.',
      '..',
      'a/b',
      'a\\b',
      '-a',
      '.hidden',
      'a.',
      'a\u0000',
      'a b',
      'кир',
    ]) {
      fails({ places: { [name]: { fs: true } } }, /invalid place name/);
    }
  });

  it('rejects Windows reserved names case-insensitively', () => {
    for (const name of ['con', 'CON', 'Nul', 'com1', 'LPT9', 'aux.txt']) {
      fails({ places: { [name]: { fs: true } } }, /reserved/);
    }
  });

  it('rejects names that collide when lowercased', () => {
    fails(
      { places: { Static: { fs: true }, static: { fs: true } } },
      /differ only in case/,
    );
  });
});

describe('VfsConfig: domains', () => {
  it('fs: true enables defaults', () => {
    const [p] = make({ a: { fs: true } }).places;
    assert.deepEqual(p.fs, {
      ext: null,
      writable: false,
      zeroCopy: false,
      compress: null,
    });
    assert.equal(p.require, null);
    assert.equal(p.import, null);
    assert.equal(p.scanExt, null);
  });

  it('require: true means compile with default ext', () => {
    const [p] = make({ a: { require: true } }).places;
    assert.deepEqual(p.require, { ext: ['js', 'cjs', 'json'], compile: true });
    assert.deepEqual(p.scanExt, ['js', 'cjs', 'json']);
  });

  it('import: true uses default ext', () => {
    const [p] = make({ a: { import: true } }).places;
    assert.deepEqual(p.import, { ext: ['js', 'mjs', 'json'] });
  });

  it('domain ext replaces defaults and is normalized', () => {
    const [p] = make({
      a: { require: { ext: ['JS', 'js', 'Cjs'], compile: false } },
    }).places;
    assert.deepEqual(p.require, { ext: ['js', 'cjs'], compile: false });
  });

  it('scanExt is the ordered union fs → require → import', () => {
    const [p] = make({
      a: { fs: { ext: ['html', 'css', 'js'] }, require: true, import: true },
    }).places;
    assert.deepEqual(p.scanExt, ['html', 'css', 'js', 'cjs', 'json', 'mjs']);
  });

  it('fs without ext makes scanExt null even with other domains', () => {
    const [p] = make({ a: { fs: true, require: true } }).places;
    assert.equal(p.scanExt, null);
  });

  it('false / absent disables; other types are rejected', () => {
    const [p] = make({ a: { fs: true, require: false } }).places;
    assert.equal(p.require, null);
    fails({ places: { a: { fs: 'yes' } } }, /must be true, false or an object/);
    fails(
      { places: { a: { fs: { ext: 'js' } } } },
      /ext must be a non-empty array/,
    );
    fails({ places: { a: { fs: { ext: ['.js'] } } } }, /without dots/);
  });

  it('requires at least one domain', () => {
    fails({ places: { a: { provider: 'sab' } } }, /at least one domain/);
  });
});

describe('VfsConfig: providers', () => {
  it('defaults to sab and validates provider names', () => {
    assert.equal(make({ a: { fs: true } }).places[0].provider, 'sab');
    fails(
      { places: { a: { provider: 'redis', fs: true } } },
      /unknown provider/,
    );
  });

  it('sea is read-only', () => {
    fails(
      { places: { a: { provider: 'sea', fs: { writable: true } } } },
      /read-only/,
    );
    make({ a: { provider: 'sea', fs: true, require: true } });
  });

  it('disk and node-default cannot compile', () => {
    fails(
      { places: { a: { provider: 'disk', require: true } } },
      /compile: false/,
    );
    fails(
      { places: { a: { provider: 'node-default', require: true } } },
      /compile: false/,
    );
    const [p] = make({
      a: { provider: 'disk', require: { compile: false } },
    }).places;
    assert.equal(p.require.compile, false);
  });

  it('zeroCopy and compress need in-memory providers', () => {
    fails(
      { places: { a: { provider: 'disk', fs: { zeroCopy: true } } } },
      /zeroCopy/,
    );
    fails(
      {
        places: {
          a: { provider: 'memory', fs: { compress: { encodings: ['gzip'] } } },
        },
      },
      /compress/,
    );
    fails(
      { places: { a: { provider: 'node-default', fs: { writable: true } } } },
      /not applicable/,
    );
    make({ a: { provider: 'memory', fs: { zeroCopy: true, writable: true } } });
  });

  it('caps place maxFileSize by segmentSize for shared providers', () => {
    fails(
      {
        defaults: { memory: { segmentSize: '1 mib' } },
        places: { a: { fs: true, maxFileSize: '2 mib' } },
      },
      /maxFileSize/,
    );
  });

  // Only sab and sea store files in the SAB pool, so a cap anywhere else
  // would be silently ignored at runtime.
  it('rejects maxFileSize on providers that never use it', () => {
    for (const provider of ['memory', 'disk', 'node-default']) {
      fails(
        { places: { a: { provider, fs: true, maxFileSize: '1 kib' } } },
        /maxFileSize applies to providers/,
      );
    }
    make({ a: { provider: 'sea', fs: true, maxFileSize: '1 kib' } });
  });
});

describe('VfsConfig: compress', () => {
  const c = (compress) =>
    make({ a: { fs: { compress } } }).places[0].fs.compress;

  it('resolves codecs in order with native defaults', () => {
    const r = c({ encodings: ['br', 'gzip'] });
    assert.deepEqual(r.codecs, [
      { encoding: 'br', options: null },
      { encoding: 'gzip', options: null },
    ]);
    assert.equal(r.ext, null);
    assert.equal(r.retainRaw, true);
  });

  it('validates levels per codec', () => {
    assert.deepEqual(
      c({ encodings: ['br'], options: { br: { level: 5 } } }).codecs[0].options,
      { level: 5 },
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: {
                encodings: ['gzip'],
                options: { gzip: { level: 10 } },
              },
            },
          },
        },
      },
      /0\.\.9/,
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: {
                encodings: ['zstd'],
                options: { zstd: { level: 0 } },
              },
            },
          },
        },
      },
      /1\.\.22/,
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: { encodings: ['br'], options: { br: { level: 12 } } },
            },
          },
        },
      },
      /0\.\.11/,
    );
    fails(
      {
        places: {
          a: {
            fs: {
              compress: { encodings: ['br'], options: { br: { quality: 5 } } },
            },
          },
        },
      },
      /unknown option/,
    );
  });

  it('rejects duplicates, unknown and unselected encodings', () => {
    fails(
      { places: { a: { fs: { compress: { encodings: ['gzip', 'gzip'] } } } } },
      /duplicate/,
    );
    fails(
      { places: { a: { fs: { compress: { encodings: ['lz4'] } } } } },
      /unknown encoding/,
    );
    fails(
      {
        places: {
          a: { fs: { compress: { encodings: ['gzip'], options: { br: {} } } } },
        },
      },
      /not in encodings/,
    );
    fails(
      { places: { a: { fs: { compress: { encodings: [] } } } } },
      /non-empty/,
    );
  });

  it('expands ext: compressible', () => {
    const r = c({ encodings: ['gzip'], ext: 'compressible' });
    assert.ok(
      r.ext.includes('html') &&
        r.ext.includes('wasm') &&
        !r.ext.includes('png'),
    );
  });

  it('retainRaw: false needs sab and no compile', () => {
    fails(
      {
        places: {
          a: {
            provider: 'sea',
            fs: { compress: { encodings: ['gzip'], retainRaw: false } },
          },
        },
      },
      /retainRaw/,
    );
    fails(
      {
        places: {
          a: {
            fs: { compress: { encodings: ['gzip'], retainRaw: false } },
            require: true,
          },
        },
      },
      /retainRaw/,
    );
    make({
      a: {
        fs: { compress: { encodings: ['gzip'], retainRaw: false } },
        require: { compile: false },
      },
    });
  });
});

describe('VfsConfig: immutability', () => {
  it('is deeply frozen and does not mutate input', () => {
    const input = {
      defaults: { strict: true },
      places: { a: { fs: { ext: ['js'] } } },
    };
    const copy = structuredClone(input);
    const c = new VfsConfig(input);
    assert.deepEqual(input, copy);
    assert.ok(Object.isFrozen(c.global.memory));
    assert.ok(Object.isFrozen(c.places[0].fs.ext));
    assert.ok(Object.isFrozen(c.raw.places.a));
    assert.throws(() => c.places[0].fs.ext.push('x'));
  });

  it('exposes raw for workers and place()/allPlaces()', () => {
    const c = make({ a: { fs: true }, b: { fs: true, enabled: false } });
    assert.deepEqual(c.raw.places.a, { fs: true });
    assert.equal(c.places.length, 1);
    assert.equal(c.allPlaces.length, 2);
    assert.equal(c.place('b').enabled, false);
    assert.equal(c.place('zzz'), null);
  });
});

describe('VfsConfig.fromArgv', () => {
  const app = {
    places: {
      a: { fs: true },
      b: { fs: true },
      c: { fs: true, maxFileSize: '1 kib' },
    },
  };
  const argv = (...args) => ['node', 'app.js', '--', ...args];

  it('overrides defaults with typed values', () => {
    const c = VfsConfig.fromArgv(
      argv(
        '--vfs.defaults.memory.limit=2mib',
        '--vfs.defaults.memory.segmentSize=1mib',
        '--vfs.defaults.memory.maxFileSize=100kib',
        '--vfs.defaults.strict=true',
        '--vfs.defaults.watchTimeout=50',
      ),
      app,
    );
    assert.equal(c.global.memory.limit, 2 * 1024 ** 2);
    assert.equal(c.global.strict, true);
    assert.equal(c.global.watchTimeout, 50);
  });

  it('overrides place options and toggles places', () => {
    const c = VfsConfig.fromArgv(
      argv('--vfs.places.c.maxFileSize=2kib', '--vfs.enable=a,c'),
      app,
    );
    assert.equal(c.place('c').maxFileSize, 2048);
    assert.deepEqual(
      c.places.map((p) => p.name),
      ['a', 'c'],
    );
    const d = VfsConfig.fromArgv(argv('--vfs.disable=b'), app);
    assert.deepEqual(
      d.places.map((p) => p.name),
      ['a', 'c'],
    );
  });

  it('ignores args before -- and --vfs.config, rejects unknown/unsafe keys', () => {
    const c = VfsConfig.fromArgv(
      ['node', '--vfs.defaults.strict=true', 'x', '--', '--vfs.config=./c.js'],
      app,
    );
    assert.equal(c.global.strict, false);
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.strict=true'), app),
      /unknown CLI key/,
    );
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.defaults.__proto__.x=1'), app),
      /unsafe/,
    );
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.enable=nope'), app),
      /unknown place/,
    );
    assert.equal(Object.prototype.x, undefined);
  });

  it('enable selects places; disable subtracts from the current set', () => {
    const onlyA = VfsConfig.fromArgv(argv('--vfs.enable=a'), app);
    assert.deepEqual(
      onlyA.places.map((p) => p.name),
      ['a'],
    );
    const dropped = VfsConfig.fromArgv(
      argv('--vfs.enable=a,b', '--vfs.disable=a'),
      app,
    );
    assert.deepEqual(
      dropped.places.map((p) => p.name),
      ['b'],
    );
    assert.throws(
      () => VfsConfig.fromArgv(argv('--vfs.disable=nope'), app),
      /unknown place/,
    );
  });
});
