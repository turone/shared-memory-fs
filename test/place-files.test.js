'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlaceFiles, dirOf } = require('../lib/place.js');

// The directory index of a place projection must say exactly what a scan
// of its keys says, whatever sequence of sets and deletes built it.

const SEP = '\u0000';

// Deterministic pseudo-random numbers (a linear congruential generator).
const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// What a scan of `files` says about directory `dir`.
const scan = (files, dir) => {
  const prefix = dir + '/';
  const below = new Map();
  for (const key of files.keys()) {
    if (key.includes(SEP) || !key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = prefix + parts.slice(0, i).join('/');
      // A key that is also a directory prefix of another key is both.
      if (i < parts.length) below.set(`${path}/`, true);
      else below.set(path, false);
    }
  }
  return below;
};

const indexed = (files, dir) => {
  const below = new Map();
  for (const [key, isDirectory] of files.below(dir)) {
    below.set(isDirectory ? `${key}/` : key, isDirectory);
  }
  return below;
};

const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));

describe('PlaceFiles: the directory index of a projection', () => {
  it('matches a scan after any sequence of sets and deletes', () => {
    const next = random(42);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const names = ['a', 'b', 'c.txt', 'd.js'];
    const keyOf = () => {
      const depth = 1 + Math.floor(next() * 4);
      return '/' + Array.from({ length: depth }, () => pick(names)).join('/');
    };
    const files = new PlaceFiles();
    const dirs = ['', '/a', '/b', '/a/a', '/a/b', '/b/a', '/a/a/a', '/c.txt'];
    for (let step = 0; step < 3000; step++) {
      const key = keyOf();
      const roll = next();
      if (roll < 0.45) files.set(key, { step });
      else if (roll < 0.55) files.set(`${key}${SEP}fs:gzip`, { step });
      else if (roll < 0.95) files.delete(key);
      else if (roll < 0.96) files.clear();
      else files.set(key, { again: step }); // an update of a key it holds
      for (const dir of dirs) {
        const expected = scan(files, dir);
        assert.deepEqual(sorted(indexed(files, dir)), sorted(expected), dir);
        assert.equal(files.hasDirectory(dir), expected.size > 0, dir);
      }
    }
  });

  it('children lists what a directory holds directly', () => {
    const files = new PlaceFiles();
    for (const key of ['/a/x.txt', '/a/b/y.txt', '/a/b/z.txt', '/c.txt']) {
      files.set(key, {});
    }
    files.set(`/a/x.txt${SEP}fs:gzip`, {});
    assert.deepEqual(
      [...files.children('/a')],
      [
        ['/a/x.txt', false],
        ['/a/b', true],
      ],
    );
    assert.deepEqual(
      [...files.children('')],
      [
        ['/a', true],
        ['/c.txt', false],
      ],
    );
    files.delete('/a/b/y.txt');
    files.delete('/a/b/z.txt');
    assert.equal(files.hasDirectory('/a/b'), false, 'an emptied directory');
    assert.deepEqual([...files.children('/a')], [['/a/x.txt', false]]);
    files.delete('/a/x.txt');
    files.delete('/c.txt');
    assert.equal(files.hasDirectory(''), false);
    assert.equal(files.size, 1, 'only the companion is left');
  });

  it('directory keys have one form', () => {
    for (const [key, dir] of [
      ['', ''],
      ['/', ''],
      ['//', ''],
      ['a', '/a'],
      ['a/', '/a'],
      ['/a/b/', '/a/b'],
      ['/a/b', '/a/b'],
    ]) {
      assert.equal(dirOf(key), dir, JSON.stringify(key));
    }
  });
});
