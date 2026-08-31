'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VfsConfig } = require('../lib/config.js');

describe('VfsConfig', () => {
  describe('constructor defaults', () => {
    it('creates config with default global values', () => {
      const config = new VfsConfig();
      const g = config.global;
      assert.equal(g.memory.limit, 1024 * 1024 * 1024);
      assert.equal(g.memory.segmentSize, 64 * 1024 * 1024);
      assert.equal(g.memory.maxFileSize, 10_000_000);
      assert.equal(g.compaction.threshold, 0.3);
      assert.equal(g.hooks.fs, true);
      assert.equal(g.hooks.require, true);
      assert.equal(g.hooks.import, true);
      assert.equal(g.watchTimeout, 1000);
    });

    it('returns empty places array when none configured', () => {
      const config = new VfsConfig();
      assert.deepEqual(config.places, []);
      assert.deepEqual(config.allPlaces, []);
    });
  });

  describe('config with places', () => {
    const raw = {
      places: {
        static: {
          domains: ['fs'],
          dir: 'static',
          provider: 'sab',
          ext: ['html', 'css', 'js'],
        },
        api: {
          domains: ['fs', 'require'],
          dir: 'api',
          provider: 'disk',
        },
      },
    };

    it('resolves place configs', () => {
      const config = new VfsConfig(raw);
      assert.equal(config.places.length, 2);
      const s = config.place('static');
      assert.equal(s.name, 'static');
      assert.deepEqual(s.domains, ['fs']);
      assert.equal(s.dir, 'static');
      assert.equal(s.provider, 'sab');
      assert.deepEqual(s.ext, ['html', 'css', 'js']);
    });

    it('returns null for unknown place', () => {
      const config = new VfsConfig(raw);
      assert.equal(config.place('unknown'), null);
    });
  });

  describe('deep freeze', () => {
    it('freezes global config', () => {
      const config = new VfsConfig();
      assert.equal(Object.isFrozen(config.global), true);
      assert.equal(Object.isFrozen(config.global.memory), true);
      assert.equal(Object.isFrozen(config.global.hooks), true);
    });

    it('freezes place configs', () => {
      const config = new VfsConfig({
        places: {
          app: { domains: ['fs'], dir: 'app', provider: 'sab' },
        },
      });
      const p = config.place('app');
      assert.equal(Object.isFrozen(p), true);
    });
  });

  describe('fromArgv', () => {
    it('creates config from argv and app config', () => {
      const appConfig = {
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
          },
        },
      };
      const config = VfsConfig.fromArgv([], appConfig);
      assert.equal(config.places.length, 1);
      assert.equal(Object.isFrozen(config.global), true);
    });

    it('applies CLI overrides to defaults', () => {
      const argv = [
        'node',
        'app.js',
        '--',
        '--vfs.defaults.memory.limit=512mib',
      ];
      const config = VfsConfig.fromArgv(argv, {});
      assert.equal(config.global.memory.limit, 512 * 1024 * 1024);
    });

    it('disables hooks via CLI', () => {
      const argv = ['node', 'app.js', '--', '--vfs.hooks.fs=false'];
      const config = VfsConfig.fromArgv(argv, {});
      assert.equal(config.global.hooks.fs, false);
    });
  });

  describe('defaults override', () => {
    it('merges app defaults with hardcoded defaults', () => {
      const config = new VfsConfig({
        defaults: { memory: { limit: '256 mib' } },
      });
      assert.equal(config.global.memory.limit, 256 * 1024 * 1024);
      assert.equal(config.global.memory.segmentSize, 64 * 1024 * 1024);
    });
  });

  describe('validation', () => {
    it('rejects unknown domain', () => {
      assert.throws(
        () =>
          new VfsConfig({
            places: {
              x: { domains: ['bad'], dir: 'x', provider: 'sab' },
            },
          }),
        /unknown domain/,
      );
    });

    it('rejects unknown provider', () => {
      assert.throws(
        () =>
          new VfsConfig({
            places: {
              x: { domains: ['fs'], dir: 'x', provider: 'bad' },
            },
          }),
        /unknown provider/,
      );
    });

    it('rejects invalid dir', () => {
      assert.throws(
        () =>
          new VfsConfig({
            places: {
              x: { domains: ['fs'], dir: 42, provider: 'sab' },
            },
          }),
        /dir must be a non-empty string/,
      );
    });

    it('rejects overlapping dir matches', () => {
      assert.throws(
        () =>
          new VfsConfig({
            places: {
              a: { domains: ['fs'], dir: 'static', provider: 'sab' },
              b: { domains: ['fs'], dir: 'static', provider: 'sab' },
            },
          }),
        /both match dir/,
      );
    });
  });

  describe('compile', () => {
    it('auto-adds require to domains when compile is true', () => {
      const config = new VfsConfig({
        places: {
          lib: {
            domains: ['fs'],
            dir: 'lib',
            provider: 'sab',
            ext: ['js'],
            compile: true,
          },
        },
      });
      const lib = config.place('lib');
      assert.ok(lib.domains.includes('require'));
    });

    it('does not duplicate require if already present', () => {
      const config = new VfsConfig({
        places: {
          lib: {
            domains: ['fs', 'require'],
            dir: 'lib',
            provider: 'sab',
            ext: ['js'],
            compile: true,
          },
        },
      });
      const lib = config.place('lib');
      const count = lib.domains.filter((d) => d === 'require').length;
      assert.equal(count, 1);
    });

    it('does not add require when compile is false', () => {
      const config = new VfsConfig({
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
          },
        },
      });
      const s = config.place('static');
      assert.equal(s.domains.includes('require'), false);
    });
  });

  describe('compress', () => {
    const makeConfig = (compress, extra = {}) =>
      new VfsConfig({
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
            compress,
            ...extra,
          },
        },
      });

    it('defaults to no codecs, raw retained', () => {
      const s = makeConfig(undefined).place('static');
      assert.deepEqual(s.compress, { codecs: [], ext: null, retainRaw: true });
    });

    it('resolves codecs with explicit options', () => {
      const s = makeConfig({
        encodings: ['br', 'gzip'],
        options: { br: { level: 5 } },
      }).place('static');
      assert.deepEqual(s.compress.codecs, [
        { encoding: 'br', options: { level: 5 } },
        { encoding: 'gzip', options: null },
      ]);
      assert.equal(s.compress.retainRaw, true);
    });

    it('expands the compressible ext alias', () => {
      const s = makeConfig({
        encodings: ['br'],
        ext: 'compressible',
      }).place('static');
      assert.ok(s.compress.ext.includes('html'));
      assert.ok(s.compress.ext.includes('wasm'));
      assert.equal(s.compress.ext.includes('png'), false);
    });

    it('keeps an explicit ext list', () => {
      const s = makeConfig({ encodings: ['br'], ext: ['css'] }).place('static');
      assert.deepEqual(s.compress.ext, ['css']);
    });

    it('reads retainRaw', () => {
      const s = makeConfig({ encodings: ['br'], retainRaw: false }).place(
        'static',
      );
      assert.equal(s.compress.retainRaw, false);
    });

    it('rejects an empty encodings list', () => {
      assert.throws(
        () => makeConfig({ encodings: [] }),
        /compress.encodings must be a non-empty array/,
      );
    });

    it('rejects an unknown encoding', () => {
      assert.throws(
        () => makeConfig({ encodings: ['lzma'] }),
        /unknown encoding "lzma"/,
      );
    });

    it('rejects duplicate encodings', () => {
      assert.throws(
        () => makeConfig({ encodings: ['br', 'br'] }),
        /duplicate encoding "br"/,
      );
    });

    it('rejects options for a codec outside encodings', () => {
      assert.throws(
        () =>
          makeConfig({ encodings: ['br'], options: { gzip: { level: 9 } } }),
        /not listed in compress.encodings/,
      );
    });

    it('rejects an unknown codec option', () => {
      assert.throws(
        () =>
          makeConfig({ encodings: ['br'], options: { br: { quality: 5 } } }),
        /unknown compress option "quality"/,
      );
    });

    it('rejects a level outside the codec range', () => {
      assert.throws(
        () => makeConfig({ encodings: ['br'], options: { br: { level: 12 } } }),
        /level must be an integer in 0\.\.11/,
      );
      assert.throws(
        () =>
          makeConfig({ encodings: ['gzip'], options: { gzip: { level: 10 } } }),
        /level must be an integer in 0\.\.9/,
      );
    });

    it('rejects a bad compress.ext', () => {
      assert.throws(
        () => makeConfig({ encodings: ['br'], ext: 'text' }),
        /compress.ext must be an array or 'compressible'/,
      );
      assert.throws(
        () => makeConfig({ encodings: ['br'], ext: [''] }),
        /compress.ext items must be non-empty strings/,
      );
    });

    it('rejects compression on a non-sab provider', () => {
      assert.throws(
        () =>
          new VfsConfig({
            places: {
              tmp: {
                domains: ['fs'],
                dir: 'tmp',
                provider: 'memory',
                compress: { encodings: ['br'] },
              },
            },
          }),
        /compress requires provider "sab"/,
      );
    });

    it('rejects compile together with retainRaw false', () => {
      assert.throws(
        () =>
          makeConfig(
            { encodings: ['br'], retainRaw: false },
            { compile: true },
          ),
        /compile requires retainRaw/,
      );
    });
  });
});
