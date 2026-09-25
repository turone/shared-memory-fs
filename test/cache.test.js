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

const bytes = (cache, entry) =>
  Buffer.from(
    cache.getSegment(entry.segmentId).sab,
    entry.offset,
    entry.length,
  );

// allocate + put: the two steps of a publication.
const publish = async (cache, name, key, file, options) => {
  const entry = await cache.allocate(file, options);
  if (entry) cache.put(name, key, entry);
  return entry;
};

describe('FilesystemCache: allocate', () => {
  it('places bytes without publishing them', async () => {
    const cache = make();
    const entry = await cache.allocate(input(100));
    assert.equal(entry.kind, 'shared');
    assert.equal(bytes(cache, entry).toString(), 'a'.repeat(100));
    assert.equal(cache.entry('p', '/a'), null, 'not in the index yet');
    assert.deepEqual(cache.snapshot().places, {});
    assert.equal(cache.put('p', '/a', entry), null);
    assert.equal(cache.entry('p', '/a'), entry);
  });

  it('turns oversize files into disk entries', async () => {
    const cache = make();
    const file = { path: '/tmp/big', stat: { size: 3 * KB, mtimeMs: 1 } };
    assert.deepEqual(await cache.allocate(file), {
      kind: 'disk',
      path: '/tmp/big',
      stat: file.stat,
    });
  });

  it('honours per-call maxFileSize', async () => {
    const cache = make();
    const entry = await cache.allocate(input(3 * KB), { maxFileSize: 4 * KB });
    assert.equal(entry.kind, 'shared');
  });

  it('empty files are shared entries without bytes', async () => {
    const cache = make();
    const e = await cache.allocate(input(0));
    assert.equal(e.kind, 'shared');
    assert.equal(e.length, 0);
    assert.equal(cache.pool.segments.size, 0);
  });

  it('onDisk keeps a file on disk', async () => {
    const cache = make();
    const b = await cache.allocate(
      { ...input(10), path: '/tmp/b' },
      { onDisk: true },
    );
    assert.equal(b.kind, 'disk');
    assert.equal(b.path, '/tmp/b');
    assert.equal(cache.pool.segments.size, 0);
  });

  it('fallback: false yields null instead of a disk entry', async () => {
    const cache = make();
    assert.equal(
      await cache.allocate(input(3 * KB), { fallback: false }),
      null,
    );
    assert.equal(
      await cache.allocate(input(10), { fallback: false, onDisk: true }),
      null,
    );
    const meta = Object.freeze({ kind: 'custom' });
    const m = await cache.allocate({ ...input(5), meta }, { fallback: false });
    assert.equal(m.meta, meta, 'extras travel with the entry');
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
    const entry = await cache.allocate(good);
    assert.equal(bytes(cache, entry).toString(), 'B'.repeat(100));
    await assert.rejects(cache.allocate(bad), /changed/);
    assert.equal(calls, 2);
    // The failed extent was released: the next allocation reuses its offset.
    const next = await cache.allocate(good);
    assert.equal(next.offset, 100);
  });

  it('rejects buffers whose length disagrees with stat.size', async () => {
    const cache = make();
    await assert.rejects(
      cache.allocate({ data: buf(10), stat: { size: 11 } }),
      /size mismatch/,
    );
  });

  it('without reader, path inputs fall back to disk entries', async () => {
    const cache = make();
    const entry = await cache.allocate({ path: '/tmp/x', stat: { size: 5 } });
    assert.equal(entry.kind, 'disk');
  });

  it('refuses sizes above one segment even with maxFileSize: Infinity', async () => {
    const cache = make();
    const entry = await cache.allocate(input(5 * KB), {
      fallback: false,
      maxFileSize: Infinity,
    });
    assert.equal(entry, null);
    assert.throws(() => cache.registry.allocate(0), RangeError);
    assert.throws(() => cache.registry.allocate(1.5), RangeError);
  });

  it('respects the pool limit', async () => {
    const cache = make({ limit: 4 * KB });
    await cache.allocate(input(2 * KB));
    await cache.allocate(input(2 * KB));
    const c = await cache.allocate(input(1 * KB));
    assert.equal(c.kind, 'disk');
  });
});

describe('FilesystemCache: put / remove / free', () => {
  it('put and remove return the entry they replace', async () => {
    const cache = make();
    const a = await publish(cache, 'p', '/a', input(10));
    const b = await cache.allocate(input(20));
    assert.equal(cache.put('p', '/a', b), a);
    assert.equal(cache.remove('p', '/a'), b);
    assert.equal(cache.remove('p', '/a'), null);
    assert.equal(cache.remove('nope', '/a'), null);
    cache.free({ kind: 'disk' });
    cache.free(null);
  });

  it('free() reuses extents best-fit and merges neighbours', async () => {
    const cache = make();
    const a = await cache.allocate(input(500));
    const b = await cache.allocate(input(300));
    const c = await cache.allocate(input(200));
    cache.free(a);
    cache.free(c);
    assert.deepEqual(cache.registry.free.get(1), [
      { offset: 0, length: 500 },
      { offset: 800, length: 200 },
    ]);
    const d = await cache.allocate(input(200));
    assert.equal(d.offset, 800);
    cache.free(b);
    assert.deepEqual(cache.registry.free.get(1), [{ offset: 0, length: 800 }]);
  });

  it('fully freed segments are kept for reuse, never released', async () => {
    const cache = make();
    const a = await cache.allocate(input(100));
    cache.free(a);
    assert.ok(cache.pool.emptySegmentIds.has(1));
    assert.equal(cache.pool.segments.size, 1);
    const b = await cache.allocate(input(100));
    assert.equal(b.segmentId, 1);
    assert.equal(cache.pool.segments.size, 1);
  });
});

describe('FilesystemCache: compact', () => {
  // seg 1: /a + /b fill it exactly; seg 2: /c alone.
  const fill = async (cache, sizes = [2 * KB, 2 * KB, 200]) => {
    const a = await publish(cache, 'p', '/a', input(sizes[0]));
    const b = await publish(cache, 'p', '/b', input(sizes[1]));
    const c = await publish(cache, 'q', '/c', input(sizes[2], 'c'));
    assert.equal(b.segmentId, 1);
    assert.equal(c.segmentId, 2);
    return { a, b, c };
  };

  it('plans the move of the emptiest segment without touching the index', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    cache.remove('p', '/a');
    cache.free(a);
    const moves = cache.compact(0.5);
    assert.equal(moves.length, 1);
    const [{ name, key, entry }] = moves;
    assert.equal(name, 'q');
    assert.equal(key, '/c');
    assert.equal(entry.segmentId, 1);
    assert.equal(entry.offset, 0);
    assert.equal(bytes(cache, entry).toString(), 'c'.repeat(200));
    assert.equal(cache.entry('q', '/c'), c, 'the caller publishes the move');
    assert.ok(cache.registry.closed.has(2));
    assert.equal(cache.put('q', '/c', entry), c);
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

  it('the emptied segment stays closed until retired bytes are freed', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a, c } = await fill(cache);
    // /d shares seg 2 with /c, then gets replaced: its bytes wait for an ACK.
    const d = await publish(cache, 'q', '/d', input(300, 'd'));
    cache.remove('q', '/d');
    cache.remove('p', '/a');
    cache.free(a);
    const moves = cache.compact(0.5);
    assert.equal(moves.length, 1, 'only published entries move');
    assert.equal(moves[0].entry.segmentId, 1);
    cache.put('q', '/c', moves[0].entry);
    assert.ok(cache.registry.closed.has(2), 'seg 2 closed, not recycled');
    assert.equal(
      bytes(cache, d).toString(),
      'd'.repeat(300),
      'old bytes intact',
    );
    // New allocations must not land in the closed segment.
    const e = await cache.allocate(input(100));
    assert.notEqual(e.segmentId, 2);
    cache.free(c);
    assert.ok(cache.registry.closed.has(2), 'still holds /d');
    cache.free(d);
    assert.ok(!cache.registry.closed.has(2));
    assert.ok(cache.pool.emptySegmentIds.has(2), 'now reusable');
  });

  it('publishing into a closed segment reopens it', async () => {
    const cache = make({ maxFileSize: 4 * KB });
    const { a } = await fill(cache);
    // A publication in progress holds an extent in seg 2.
    const pending = await cache.allocate(input(100, 'p'));
    assert.equal(pending.segmentId, 2);
    cache.remove('p', '/a');
    cache.free(a);
    const moves = cache.compact(0.5);
    for (const move of moves) cache.put(move.name, move.key, move.entry);
    assert.ok(cache.registry.closed.has(2));
    cache.put('p', '/pending', pending);
    assert.ok(!cache.registry.closed.has(2), 'a live entry keeps it open');
  });
});

describe('FilesystemCache: snapshot / projection', () => {
  it('snapshot is keyed by place and projects zero-copy views', async () => {
    const cache = make();
    await publish(cache, 'p', '/a', input(10));
    await publish(cache, 'q', '/b', input(0));
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
    assert.deepEqual(disk, {
      data: null,
      stat: { size: 1 },
      meta: undefined,
      scriptOptions: undefined,
      path: '/x',
    });
  });

  it('stats() summarises segments', async () => {
    const cache = make();
    await cache.allocate(input(1024));
    const s = cache.stats();
    assert.equal(s.segmentCount, 1);
    assert.equal(s.totalUsed, 4 * KB);
    assert.match(s.lines[0], /25\.0%/);
  });
});
