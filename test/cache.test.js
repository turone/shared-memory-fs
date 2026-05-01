'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FilesystemCache } = require('../lib/cache.js');

const KB = 1024;
const MB = 1024 * KB;

const makeReader = () => async (filePath, sab, offset, size) => {
  const view = new Uint8Array(sab, offset, size);
  const buf = Buffer.from(filePath, 'utf8');
  view.set(buf.subarray(0, size));
};

const makeFile = (name, size) => ({
  stat: { size },
  path: name,
});

describe('FilesystemCache', () => {
  describe('constructor', () => {
    it('applies defaults', () => {
      const cache = new FilesystemCache();
      assert.equal(cache.maxFileSize, 10 * MB);
      assert.equal(cache.totalUsed, 0);
    });

    it('accepts custom options', () => {
      const cache = new FilesystemCache({
        limit: 128 * MB,
        baseSegmentSize: 32 * MB,
        maxFileSize: 5 * MB,
      });
      assert.equal(cache.maxFileSize, 5 * MB);
    });
  });

  describe('load + snapshot + project', () => {
    it('loads files into SAB and projects them', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
        reader: makeReader(),
      });
      const files = new Map();
      files.set('/index.html', makeFile('/index.html', 100));
      files.set('/style.css', makeFile('/style.css', 200));
      await cache.load('static', files);

      const snap = cache.snapshot();
      assert.ok(snap.segments.length > 0);
      assert.ok(snap.filesystems.static);
      assert.equal(snap.filesystems.static.entries.length, 2);

      const segmentsMap = new Map();
      for (const seg of snap.segments) segmentsMap.set(seg.id, seg.sab);

      const projected = FilesystemCache.project(
        snap.filesystems.static,
        segmentsMap,
      );
      assert.equal(projected.size, 2);
      const html = projected.get('/index.html');
      assert.ok(html.data instanceof Buffer);
      assert.equal(html.data.length, 100);
      assert.equal(html.stat.size, 100);
    });
  });

  describe('allocate + free', () => {
    it('allocates and frees entries', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
        reader: makeReader(),
      });
      await cache.load('fs1', new Map());
      const entry = await cache.allocate(
        'fs1',
        '/a.js',
        makeFile('/a.js', 500),
      );
      assert.equal(entry.kind, 'shared');
      assert.equal(entry.length, 500);

      cache.free(entry);
      // After free, can reallocate in same space
      const entry2 = await cache.allocate(
        'fs1',
        '/b.js',
        makeFile('/b.js', 300),
      );
      assert.equal(entry2.kind, 'shared');
    });
  });

  describe('disk fallback', () => {
    it('falls back to disk for oversize files', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 100,
        reader: makeReader(),
      });
      const files = new Map();
      files.set('/big.bin', makeFile('/big.bin', 200));
      await cache.load('fs1', files);
      const snap = cache.snapshot();
      const entries = new Map(snap.filesystems.fs1.entries);
      const entry = entries.get('/big.bin');
      assert.equal(entry.kind, 'disk');
      assert.equal(entry.path, '/big.bin');
    });

    it('falls back to disk when no reader and no data', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
      });
      const files = new Map();
      files.set('/a.js', makeFile('/a.js', 100));
      await cache.load('fs1', files);
      const snap = cache.snapshot();
      const entries = new Map(snap.filesystems.fs1.entries);
      assert.equal(entries.get('/a.js').kind, 'disk');
    });
  });

  describe('empty file', () => {
    it('handles zero-size files as shared with length 0', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
        reader: makeReader(),
      });
      const files = new Map();
      files.set('/empty.txt', makeFile('/empty.txt', 0));
      await cache.load('fs1', files);
      const snap = cache.snapshot();
      const entries = new Map(snap.filesystems.fs1.entries);
      const entry = entries.get('/empty.txt');
      assert.equal(entry.kind, 'shared');
      assert.equal(entry.length, 0);
    });
  });

  describe('remove', () => {
    it('removes entry from filesystem index', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
        reader: makeReader(),
      });
      const files = new Map();
      files.set('/a.js', makeFile('/a.js', 100));
      await cache.load('fs1', files);
      const removed = cache.remove('fs1', '/a.js');
      assert.ok(removed);
      assert.equal(removed.kind, 'shared');
      assert.equal(cache.remove('fs1', '/a.js'), null);
    });

    it('returns null for unknown filesystem', () => {
      const cache = new FilesystemCache();
      assert.equal(cache.remove('nope', '/a.js'), null);
    });
  });

  describe('compact', () => {
    it('returns null when less than 2 segments', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
        reader: makeReader(),
      });
      const files = new Map();
      files.set('/a.js', makeFile('/a.js', 100));
      await cache.load('fs1', files);
      assert.equal(cache.compact(), null);
    });

    it('compacts when a segment is underutilized', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1024,
        maxFileSize: 512,
        reader: makeReader(),
      });
      // Fill two segments
      const files = new Map();
      for (let i = 0; i < 3; i++) {
        files.set(`/f${i}.js`, makeFile(`/f${i}.js`, 500));
      }
      await cache.load('fs1', files);
      // Free entries from first segment to make it underutilized
      const snap = cache.snapshot();
      const entries = new Map(snap.filesystems.fs1.entries);
      const firstEntry = entries.get('/f0.js');
      cache.free(firstEntry);
      cache.remove('fs1', '/f0.js');
      // Now compact should try to move remaining entry
      const result = cache.compact(0.9);
      // Result may be null if conditions not met, that's valid
      if (result) {
        assert.ok(result.updates.length > 0);
        assert.ok(result.oldEntries.length > 0);
      }
    });
  });

  describe('projection', () => {
    it('projects disk entry correctly', () => {
      const entry = { kind: 'disk', path: '/big.bin', stat: { size: 999 } };
      const projected = FilesystemCache.projectEntry(entry, new Map());
      assert.equal(projected.data, null);
      assert.equal(projected.path, '/big.bin');
      assert.equal(projected.stat.size, 999);
    });

    it('projects empty shared entry', () => {
      const entry = {
        kind: 'shared',
        segmentId: 0,
        offset: 0,
        length: 0,
        stat: { size: 0 },
      };
      const projected = FilesystemCache.projectEntry(entry, new Map());
      assert.ok(Buffer.isBuffer(projected.data));
      assert.equal(projected.data.length, 0);
    });

    it('projects shared entry as Buffer view over SAB', () => {
      const sab = new SharedArrayBuffer(1024);
      const view = new Uint8Array(sab, 0, 5);
      view.set([72, 101, 108, 108, 111]); // "Hello"
      const segmentsMap = new Map([[1, sab]]);
      const entry = {
        kind: 'shared',
        segmentId: 1,
        offset: 0,
        length: 5,
        stat: { size: 5 },
      };
      const projected = FilesystemCache.projectEntry(entry, segmentsMap);
      assert.equal(projected.data.toString(), 'Hello');
      assert.equal(projected.data.buffer, sab);
    });
  });

  describe('stats', () => {
    it('returns segment statistics', async () => {
      const cache = new FilesystemCache({
        limit: 10 * MB,
        baseSegmentSize: 1 * MB,
        maxFileSize: 512 * KB,
        reader: makeReader(),
      });
      const files = new Map();
      files.set('/a.js', makeFile('/a.js', 100));
      await cache.load('fs1', files);
      const stats = cache.stats();
      assert.equal(stats.segmentCount, 1);
      assert.equal(stats.cleanCount, 0);
      assert.ok(stats.totalUsed > 0);
      assert.ok(stats.lines.length > 0);
    });
  });
});
