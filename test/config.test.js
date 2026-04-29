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
      assert.equal(g.memory.segment, 64 * 1024 * 1024);
      assert.equal(g.memory.maxFileSize, 10_000_000);
      assert.equal(g.gc.enabled, true);
      assert.equal(g.gc.threshold, 0.3);
      assert.equal(g.hooks.fs, true);
      assert.equal(g.hooks.require, true);
      assert.equal(g.hooks.import, true);
      assert.equal(g.hooks.diagnostics, false);
      assert.equal(g.policy.allowWrite, false);
      assert.equal(g.mode, 'overlay');
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
          match: { dir: 'static' },
          provider: 'sab',
          ext: ['html', 'css', 'js'],
        },
        api: {
          domains: ['fs', 'require'],
          match: { dir: 'api' },
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
      assert.deepEqual(s.match, { dir: 'static' });
      assert.equal(s.provider, 'sab');
      assert.deepEqual(s.ext, ['html', 'css', 'js']);
      assert.equal(s.readonly, true);
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
          app: { domains: ['fs'], match: { dir: 'app' }, provider: 'sab' },
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
            match: { dir: 'static' },
            provider: 'sab',
          },
        },
      };
      const config = VfsConfig.fromArgv([], appConfig);
      assert.equal(config.places.length, 1);
      assert.equal(Object.isFrozen(config.global), true);
    });

    it('applies CLI overrides to defaults', () => {
      const argv = ['node', 'app.js', '--', '--vfs.defaults.memory.limit=512mib'];
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
      assert.equal(config.global.memory.segment, 64 * 1024 * 1024);
    });
  });

  describe('validation', () => {
    it('rejects unknown domain', () => {
      assert.throws(() => new VfsConfig({
        places: {
          x: { domains: ['bad'], match: { dir: 'x' }, provider: 'sab' },
        },
      }), /unknown domain/);
    });

    it('rejects unknown provider', () => {
      assert.throws(() => new VfsConfig({
        places: {
          x: { domains: ['fs'], match: { dir: 'x' }, provider: 'bad' },
        },
      }), /unknown provider/);
    });

    it('rejects unknown match type', () => {
      assert.throws(() => new VfsConfig({
        places: {
          x: { domains: ['fs'], match: { bad: 'x' }, provider: 'sab' },
        },
      }), /unknown match type/);
    });

    it('rejects overlapping dir matches', () => {
      assert.throws(() => new VfsConfig({
        places: {
          a: { domains: ['fs'], match: { dir: 'static' }, provider: 'sab' },
          b: { domains: ['fs'], match: { dir: 'static' }, provider: 'sab' },
        },
      }), /both match dir/);
    });

    it('rejects writable place without writeNamespace', () => {
      assert.throws(() => new VfsConfig({
        places: {
          x: {
            domains: ['fs'],
            match: { dir: 'x' },
            provider: 'sab-write',
            readonly: false,
          },
        },
      }), /writeNamespace/);
    });
  });
});
