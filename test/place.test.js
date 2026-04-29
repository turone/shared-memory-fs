'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Place } = require('../lib/place.js');

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
      assert.equal(keys.length, 4);
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
});
