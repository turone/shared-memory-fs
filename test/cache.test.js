'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FilesystemCache } = require('../lib/cache.js');

const KB = 1024;
const make = (options = {}) =>
  new FilesystemCache({
    limit: 16 * KB,
    segmentSize: 4 * KB,
    maxFileSize: 2 * KB,
    ...options,
  });

const buf = (size, fill = 'a') => Buffer.alloc(size, fill);
const input = (size, fill) => ({
  data: buf(size, fill),
  stat: { size, mtimeMs: 1 },
});
const files = (spec) =>
  new Map(Object.entries(spec).map(([k, n]) => [k, input(n)]));

const bytes = (cache, entry) =>
  Buffer.from(
    cache.getSegment(entry.segmentId).sab,
    entry.offset,
    entry.length,
  );

describe('FilesystemCache: load', () => {
  it('packs large files first and keeps the entry map', async () => {
    const cache = make();
    const index = await cache.load(
      'p',
      files({ '/a': 100, '/b': 2000, '/c': 500 }),
    );
    assert.deepEqual([...index.entries.keys()].sort(), ['/a', '/b', '/c']);
    const b = index.entries.get('/b');
    assert.equal(b.kind, 'shared');
    assert.equal(b.offset, 0);
    assert.equal(bytes(cache, b).toString(), 'a'.repeat(2000));
    assert.equal(cache.entry('p', '/a').kind, 'shared');
    assert.equal(cache.entry('p', '/zzz'), null);
  });

  it('turns oversize files into disk entries', async () => {
    const cache = make();
    const file = { path: '/tmp/big', stat: { size: 3 * KB, mtimeMs: 1 } };
    await cache.load('p', new Map([['/big', file]]));
    assert.deepEqual(cache.entry('p', '/big'), {
      kind: 'disk',
      path: '/tmp/big',
      stat: file.stat,
    });
  });

  it('honours per-call maxFileSize', async () => {
    const cache = make();
    await cache.load('p', files({ '/x': 3 * KB }), { maxFileSize: 4 * KB });
    assert.equal(cache.entry('p', '/x').kind, 'shared');
  });

  it('empty files are shared entries without bytes', async () => {
    const cache = make();
    await cache.load('p', files({ '/e': 0 }));
    const e = cache.entry('p', '/e');
    assert.equal(e.kind, 'shared');
    assert.equal(e.length, 0);
    assert.equal(cache.pool.segments.size, 0);
  });

  it('store predicate keeps selected files on disk', async () => {
    const cache = make();
    await cache.load('p', files({ '/a': 10, '/b': 10 }), {
      store: (key) => key !== '/b',
    });
    assert.equal(cache.entry('p', '/a').kind, 'shared');
    assert.equal(cache.entry('p', '/b').kind, 'disk');
  });

  it('uses the injected reader and rolls the extent back when it throws', async () => {
    let calls = 0;
    const reader = async (file, view) => {
      calls++;
      if (file.path === '/bad') throw new Error('changed');
      view.fill(0x42);
    };
    const cache = make({ reader });
    const good = { path: '/good', stat: { size: 100, mtimeMs: 1 } };
    const bad = { path: '/bad', stat: { size: 100, mtimeMs: 1 } };
    const entry = await cache.allocate('p', '/good', good);
    assert.equal(bytes(cache, entry).toString(), 'B'.repeat(100));
    await assert.rejects(cache.allocate('p', '/bad', bad), /changed/);
    assert.equal(calls, 2);
    assert.equal(cache.entry('p', '/bad'), null);
    // The failed extent was released: the next allocation reuses its offset.
    const next = await cache.allocate('p', '/next', good);
    assert.equal(next.offset, 100);
  });

  it('rejects buffers whose length disagrees with stat.size', async () => {
    const cache = make();
    await assert.rejects(
      cache.allocate('p', '/x', { data: buf(10), stat: { size: 11 } }),
      /size mismatch/,
    );
  });

  it('without reader, path inputs fall back to disk entries', async () => {
    const cache = make();
    const entry = await cache.allocate('p', '/x', {
      path: '/tmp/x',
      stat: { size: 5 },
    });
    assert.equal(entry.kind, 'disk');
  });
});

describe('FilesystemCache: allocate / free', () => {
  it('fallback: false returns null instead of a disk entry', async () => {
    const cache = make();
    const entry = await cache.allocate('p', '/big', input(3 * KB), {
      fallback: false,
    });
    assert.equal(entry, null);
    assert.equal(cache.entry('p', '/big'), null);
  });

  it('refuses sizes above one segment even with maxFileSize: Infinity', async () => {
    const cache = make();
    const entry = await cache.allocate('p', '/x', input(5 * KB), {
      fallback: false,
      maxFileSize: Infinity,
    });
    assert.equal(entry, null);
    assert.throws(() => cache.registry.allocate(0), RangeError);
    assert.throws(() => cache.registry.allocate(1.5), RangeError);
  });

  it('respects the pool limit', async () => {
    const cache = make({ limit: 4 * KB });
    await cache.allocate('p', '/a', input(2 * KB));
    await cache.allocate('p', '/b', input(2 * KB));
    const c = await cache.allocate('p', '/c', input(1 * KB));
    assert.equal(c.kind, 'disk');
  });

  it('free() reuses extents best-fit and merges neighbours', async () => {
    const cache = make();
    const a = await cache.allocate('p', '/a', input(500));
    const b = await cache.allocate('p', '/b', input(300));
    const c = await cache.allocate('p', '/c', input(200));
    cache.free(a);
    cache.free(c);
    assert.deepEqual(cache.registry.free.get(1), [
      { offset: 0, length: 500 },
      { offset: 800, length: 200 },
    ]);
    const d = await cache.allocate('p', '/d', input(200));
    assert.equal(d.offset, 800);
    cache.free(b);
    assert.deepEqual(cache.registry.free.get(1), [{ offset: 0, length: 800 }]);
  });

  it('fully freed segments are kept for reuse, never released', async () => {
    const cache = make();
    const a = await cache.allocate('p', '/a', input(100));
    cache.remove('p', '/a');
    cache.free(a);
    assert.ok(cache.pool.emptySegmentIds.has(1));
    assert.equal(cache.pool.segments.size, 1);
    const b = await cache.allocate('p', '/b', input(100));
    assert.equal(b.segmentId, 1);
    assert.equal(cache.pool.segments.size, 1);
  });

  it('remove() returns the entry and free() ignores non-shared ones', async () => {
    const cache = make();
    await cache.allocate('p', '/a', input(10));
    const removed = cache.remove('p', '/a');
    assert.equal(removed.kind, 'shared');
    assert.equal(cache.remove('p', '/a'), null);
    cache.free({ kind: 'disk' });
    cache.free(null);
  });
});

describe('FilesystemCache: compact', () => {
  // seg 1: /a + /b fill it exactly; seg 2: /c alone.
  const fill = async (cache, sizes = [2 * KB, 2 * KB, 200]) => {
    const a = await cache.allocate('p', '/a', input(sizes[0]));
    const b = await cache.allocate('p', '/b', input(sizes[1]));
    const c = await cache.allocate('q', '/c', input(sizes[2], 'c'));
    assert.equal(b.segmentId, 1);
    assert.equal(c.segmentId, 2);
    return { a, b, c };
  };

  it('moves entries of the emptiest segment into others and reports them', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    cache.remove('p', '/a');
    cache.free(a);
    const result = cache.compact(0.5);
    assert.ok(result);
    assert.equal(result.updates.length, 1);
    const [{ name, key, entry }] = result.updates;
    assert.equal(name, 'q');
    assert.equal(key, '/c');
    assert.equal(entry.segmentId, 1);
    assert.equal(entry.offset, 0);
    assert.equal(bytes(cache, entry).toString(), 'c'.repeat(200));
    assert.deepEqual(result.oldEntries, [c]);
    assert.equal(cache.entry('q', '/c'), entry);
    assert.ok(cache.indexes.get('q').segmentIds.has(1));
    assert.ok(!cache.indexes.get('q').segmentIds.has(2));
    assert.equal(result.newSegments[0].id, 1);
  });

  it('threshold 0 disables; nothing to do returns null', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    await fill(cache);
    assert.equal(cache.compact(0), null);
    assert.equal(cache.compact(0.01), null);
  });

  it('rolls back when the move does not fit without growing', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a } = await fill(cache, [1 * KB, 3 * KB, 1536]);
    cache.remove('p', '/a');
    cache.free(a);
    // seg 2 (/c, 37%) is the candidate but 1536 bytes do not fit into the
    // 1 KiB hole of seg 1 and the pool must not grow.
    const before = JSON.stringify([
      [...cache.registry.free],
      [...cache.registry.tail],
    ]);
    assert.equal(cache.compact(0.5), null);
    assert.equal(
      JSON.stringify([[...cache.registry.free], [...cache.registry.tail]]),
      before,
    );
    assert.equal(cache.entry('q', '/c').segmentId, 2);
    assert.equal(cache.registry.closed.size, 0);
  });

  it('the emptied segment stays closed until ACK-pending bytes are freed', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    // /d shares seg 2 with /c, then gets replaced: its bytes wait for an ACK.
    const d = await cache.allocate('q', '/d', input(300, 'd'));
    cache.remove('q', '/d');
    cache.remove('p', '/a');
    cache.free(a);
    const result = cache.compact(0.5);
    assert.equal(result.updates[0].entry.segmentId, 1);
    assert.ok(cache.registry.closed.has(2), 'seg 2 closed, not recycled');
    assert.equal(
      bytes(cache, d).toString(),
      'd'.repeat(300),
      'old bytes intact',
    );
    // New allocations must not land in the closed segment.
    const e = await cache.allocate('p', '/e', input(100));
    assert.notEqual(e.segmentId, 2);
    cache.free(c);
    assert.ok(cache.registry.closed.has(2), 'still holds /d');
    cache.free(d);
    assert.ok(!cache.registry.closed.has(2));
    assert.ok(cache.pool.emptySegmentIds.has(2), 'now reusable');
  });
});

describe('FilesystemCache: snapshot / projection', () => {
  it('snapshot is keyed by place and projects zero-copy views', async () => {
    const cache = make();
    await cache.load('p', files({ '/a': 10 }));
    await cache.load('q', files({ '/b': 0 }));
    const snap = cache.snapshot();
    assert.deepEqual(Object.keys(snap.places), ['p', 'q']);
    assert.equal(snap.segments.length, 1);
    const map = new Map(snap.segments.map((s) => [s.id, s.sab]));
    const files1 = FilesystemCache.project(snap.places.p, map);
    const a = files1.get('/a');
    assert.ok(a.data.buffer instanceof SharedArrayBuffer);
    assert.equal(a.data.toString(), 'a'.repeat(10));
    const b = FilesystemCache.project(snap.places.q, map).get('/b');
    assert.equal(b.data.length, 0);
    const disk = FilesystemCache.projectEntry(
      { kind: 'disk', path: '/x', stat: { size: 1 } },
      map,
    );
    assert.deepEqual(disk, { data: null, stat: { size: 1 }, path: '/x' });
  });

  it('stats() summarises segments', async () => {
    const cache = make();
    await cache.load('p', files({ '/a': 1024 }));
    const s = cache.stats();
    assert.equal(s.segmentCount, 1);
    assert.equal(s.totalUsed, 4 * KB);
    assert.match(s.lines[0], /25\.0%/);
  });
});
