'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Place } = require('../lib/place.js');

const collect = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

describe('Place', () => {
  const makePlace = () => {
    const config = { name: 'static', match: { dir: 'static' } };
    const place = new Place('static', config);
    const sab = new SharedArrayBuffer(1024);
    const view = new Uint8Array(sab, 0, 5);
    view.set([72, 101, 108, 108, 111]); // "Hello"
    place.files = new Map([
      ['/index.html', { data: Buffer.from(sab, 0, 5), stat: { size: 5 } }],
      ['/style.css', { data: Buffer.from(sab, 5, 3), stat: { size: 3 } }],
      ['/big.bin', { data: null, stat: { size: 99999 }, path: '/tmp/big.bin' }],
      ['/sub/page.html', { data: Buffer.alloc(0), stat: { size: 0 } }],
      ['/handler.js', { data: Buffer.from(sab, 10, 4), stat: { size: 4 } }],
      ['/handler.js.cache', { data: Buffer.from(sab, 14, 3), stat: { size: 3 } }],
    ]);
    return place;
  };

  describe('readFile', () => {
    it('returns Buffer for SAB entry', () => {
      const place = makePlace();
      const data = place.readFile('/index.html');
      assert.ok(Buffer.isBuffer(data));
      assert.equal(data.toString(), 'Hello');
    });

    it('returns null for disk entry', () => {
      const place = makePlace();
      assert.equal(place.readFile('/big.bin'), null);
    });

    it('returns null for unknown key', () => {
      const place = makePlace();
      assert.equal(place.readFile('/nope'), null);
    });
  });

  describe('readBytecode', () => {
    it('returns bytecode from companion .cache entry', () => {
      const place = makePlace();
      const bc = place.readBytecode('/handler.js');
      assert.ok(Buffer.isBuffer(bc));
      assert.equal(bc.length, 3);
    });

    it('returns null when no .cache companion exists', () => {
      const place = makePlace();
      assert.equal(place.readBytecode('/index.html'), null);
    });

    it('returns null for unknown key', () => {
      const place = makePlace();
      assert.equal(place.readBytecode('/nope.js'), null);
    });
  });

  describe('stat', () => {
    it('returns stat object', () => {
      const place = makePlace();
      const s = place.stat('/index.html');
      assert.equal(s.size, 5);
    });

    it('returns null for unknown key', () => {
      const place = makePlace();
      assert.equal(place.stat('/nope'), null);
    });
  });

  describe('exists', () => {
    it('returns true for existing key', () => {
      const place = makePlace();
      assert.equal(place.exists('/index.html'), true);
    });

    it('returns false for unknown key', () => {
      const place = makePlace();
      assert.equal(place.exists('/nope'), false);
    });
  });

  describe('filePath', () => {
    it('returns path for disk entry', () => {
      const place = makePlace();
      assert.equal(place.filePath('/big.bin'), '/tmp/big.bin');
    });

    it('returns null for SAB entry without path', () => {
      const place = makePlace();
      assert.equal(place.filePath('/index.html'), null);
    });

    it('returns null for unknown key', () => {
      const place = makePlace();
      assert.equal(place.filePath('/nope'), null);
    });
  });

  describe('list', () => {
    it('lists all keys with default prefix', () => {
      const place = makePlace();
      const keys = place.list('/');
      assert.equal(keys.length, 6);
    });

    it('filters by prefix', () => {
      const place = makePlace();
      const keys = place.list('/sub');
      assert.deepEqual(keys, ['/sub/page.html']);
    });

    it('returns empty array for non-matching prefix', () => {
      const place = makePlace();
      const keys = place.list('/nope');
      assert.deepEqual(keys, []);
    });
  });

  describe('createReadStream', () => {
    it('streams SAB data in chunks', async () => {
      const place = makePlace();
      const stream = place.createReadStream('/index.html');
      assert.ok(stream);
      const data = await collect(stream);
      assert.equal(data.toString(), 'Hello');
    });

    it('returns null for disk entry', () => {
      const place = makePlace();
      assert.equal(place.createReadStream('/big.bin'), null);
    });

    it('returns null for unknown key', () => {
      const place = makePlace();
      assert.equal(place.createReadStream('/nope'), null);
    });

    it('supports start/end range', async () => {
      const place = makePlace();
      const stream = place.createReadStream('/index.html', { start: 1, end: 3 });
      const data = await collect(stream);
      assert.equal(data.toString(), 'ell');
    });

    it('streams empty for out-of-range start', async () => {
      const place = makePlace();
      const stream = place.createReadStream('/index.html', { start: 100 });
      const data = await collect(stream);
      assert.equal(data.length, 0);
    });

    it('streams large buffer in multiple chunks', async () => {
      const config = { name: 'big', match: { dir: 'big' } };
      const place = new Place('big', config);
      const size = 200000; // > 64KB * 3
      const sab = new SharedArrayBuffer(size);
      const view = new Uint8Array(sab);
      for (let i = 0; i < size; i++) view[i] = i & 0xff;
      place.files = new Map([
        ['/data.bin', { data: Buffer.from(sab, 0, size), stat: { size } }],
      ]);
      const chunks = [];
      const stream = place.createReadStream('/data.bin');
      stream.on('data', (chunk) => chunks.push(chunk));
      const result = await collect(
        place.createReadStream('/data.bin'),
      );
      assert.equal(result.length, size);
      assert.equal(result[0], 0);
      assert.equal(result[size - 1], (size - 1) & 0xff);
    });

    it('streams zero-length file', async () => {
      const place = makePlace();
      const stream = place.createReadStream('/sub/page.html');
      const data = await collect(stream);
      assert.equal(data.length, 0);
    });
  });
});
