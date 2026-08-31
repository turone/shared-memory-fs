'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const Module = require('node:module');
const { ModuleCache, cacheKeyOf } = require('../lib/module-cache.js');

// Minimal in-memory stub compatible with the injected cache contract.
const makeStubCache = () => {
  const filesystems = {};
  return {
    filesystems,
    allocated: [],
    async allocate(mount, key, file) {
      const index =
        filesystems[mount] ||
        (filesystems[mount] = { entries: new Map(), segmentIds: new Set() });
      const entry = { kind: 'shared', segmentId: 0, data: file.data };
      index.entries.set(key, entry);
      this.allocated.push([mount, key]);
      return entry;
    },
    getSegment() {
      throw new Error('not used in stub');
    },
  };
};

const makeModuleCache = (cache) => {
  const projected = [];
  const mc = new ModuleCache({
    cache,
    projectInto: (mount, key, entry, files) => {
      projected.push([mount, key]);
      if (files) files.set(key, { data: entry.data, stat: {} });
    },
  });
  return { mc, projected };
};

describe('cacheKeyOf', () => {
  it('builds a NUL-separated companion key', () => {
    assert.equal(cacheKeyOf('/a.js'), '/a.js\u0000cache');
  });
});

describe('createBytecode', () => {
  const { mc } = makeModuleCache(makeStubCache());

  it('produces V8 cached data accepted by vm.Script', () => {
    const source = 'module.exports = { answer: 42 };';
    const bytecode = mc.createBytecode(source, '/x.js');
    assert.ok(Buffer.isBuffer(bytecode));
    assert.ok(bytecode.length > 0);
    const script = new vm.Script(Module.wrap(source), {
      filename: '/x.js',
      cachedData: bytecode,
    });
    assert.equal(script.cachedDataRejected, false);
  });

  it('returns null for unparsable source', () => {
    assert.equal(mc.createBytecode('const = broken(', '/bad.js'), null);
  });
});

describe('isCompilable', () => {
  const { mc } = makeModuleCache(makeStubCache());
  const compiling = { config: { compile: true } };
  const plain = { config: {} };

  it('requires compile flag and .js extension', () => {
    assert.equal(mc.isCompilable(compiling, '/a.js'), true);
    assert.equal(mc.isCompilable(compiling, '/a.json'), false);
    assert.equal(mc.isCompilable(plain, '/a.js'), false);
    assert.equal(mc.isCompilable(null, '/a.js'), false);
  });
});

describe('compilePlace', () => {
  it('compiles JS sources and projects bytecode companions', async () => {
    const cache = makeStubCache();
    const { mc, projected } = makeModuleCache(cache);
    const files = new Map([
      ['/a.js', { data: Buffer.from('module.exports = 1;'), stat: {} }],
      ['/b.html', { data: Buffer.from('<html>'), stat: {} }],
      ['/c.js\u0000cache', { data: Buffer.alloc(4), stat: {} }],
    ]);
    const place = { files, config: { compile: true } };
    await mc.compilePlace('lib', place);
    assert.deepEqual(cache.allocated, [['lib', '/a.js\u0000cache']]);
    assert.deepEqual(projected, [['lib', '/a.js\u0000cache']]);
    assert.ok(files.has('/a.js\u0000cache'));
    assert.equal(files.has('/b.html\u0000cache'), false);
  });

  it('skips entries without data and broken sources', async () => {
    const cache = makeStubCache();
    const { mc } = makeModuleCache(cache);
    const files = new Map([
      ['/disk.js', { data: null, stat: {} }],
      ['/bad.js', { data: Buffer.from('const = ('), stat: {} }],
    ]);
    await mc.compilePlace('lib', { files, config: { compile: true } });
    assert.equal(cache.allocated.length, 0);
  });
});

describe('compileFromEntry', () => {
  it('recompiles from a shared source entry', async () => {
    const cache = makeStubCache();
    const source = Buffer.from('module.exports = 2;');
    const sab = new SharedArrayBuffer(source.length);
    new Uint8Array(sab).set(source);
    cache.getSegment = () => ({ sab });
    const { mc } = makeModuleCache(cache);
    const oldCache = { kind: 'shared' };
    cache.filesystems.lib = {
      entries: new Map([['/m.js\u0000cache', oldCache]]),
      segmentIds: new Set(),
    };
    const entry = { kind: 'shared', segmentId: 1, offset: 0, length: 19 };
    const r = await mc.compileFromEntry('lib', '/m.js', entry);
    assert.ok(r);
    assert.equal(r.cacheKey, '/m.js\u0000cache');
    assert.equal(r.oldCache, oldCache);
    assert.ok(Buffer.isBuffer(r.cacheEntry.data));
  });

  it('returns null when source does not compile', async () => {
    const cache = makeStubCache();
    const source = Buffer.from('const = (');
    const sab = new SharedArrayBuffer(source.length);
    new Uint8Array(sab).set(source);
    cache.getSegment = () => ({ sab });
    const { mc } = makeModuleCache(cache);
    const entry = { kind: 'shared', segmentId: 1, offset: 0, length: 9 };
    const r = await mc.compileFromEntry('lib', '/bad.js', entry);
    assert.equal(r, null);
  });
});
