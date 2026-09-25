'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, worker } = require('./helpers.js');

// A write into a store honors its flag as node:fs does: 'w…' replaces the
// file, 'a…' appends to it, 'x' only creates it — checked when the write
// runs, so it never replaces a file written meanwhile. A flag the store
// cannot honor is refused, never ignored.

const PLACES = {
  v: { origin: 'virtual', fs: { writable: true } },
  m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
};

const outcome = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err;
  }
};

// Runs `fn` over a fresh kernel, the fs patch installed.
const withPlaces = async (fn) => {
  const base = writeTree(tmpDir('vfs-flags'), { 'outside/o.txt': 'o' });
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const k = await kernel(root, PLACES);
  fsPatch.install(k);
  try {
    await fn(k, {
      at: (...p) => path.join(root, ...p),
      outside: path.join(base, 'outside', 'o.txt'),
    });
  } finally {
    fsPatch.uninstall();
    k.close();
    rm(base);
  }
};

const refused = (err, code, syscall, where) => {
  assert.equal(err.code, code, err.message ?? String(err));
  assert.equal(err.syscall, syscall);
  assert.equal(err.path, where);
};

describe('write flags', () => {
  it('replace, append, create only; the rest is refused, in every thread', async () => {
    await withPlaces(async (k, { at }) => {
      const w = worker(k);
      try {
        for (const [label, name, place] of [
          ['map', 'm', k.fs('m')],
          ['sab', 'v', k.fs('v')],
          ['worker', 'v', w.kernel.fs('v')],
        ]) {
          const key = (file) => `/${label}/${file}`;
          const read = (file) => k.fs(name).readFile(key(file), 'utf8');
          await place.writeFile(key('f.txt'), 'one');
          await place.writeFile(key('f.txt'), 'two', { flag: 'a' });
          assert.equal(read('f.txt'), 'onetwo', label);
          await place.appendFile(key('f.txt'), '!', { flag: 'w' });
          assert.equal(read('f.txt'), '!', label);
          await place.writeFile(key('new.txt'), 'n', { flag: 'wx' });
          await place.appendFile(key('ax.txt'), 'a', { flag: 'ax' });
          assert.equal(read('new.txt'), 'n', label);
          assert.equal(read('ax.txt'), 'a', label);
          await place.writeFile(key('d/in.txt'), 'in');
          for (const [file, flag, code] of [
            ['f.txt', 'wx', 'EEXIST'],
            ['ax.txt', 'xa', 'EEXIST'],
            ['d', 'wx', 'EEXIST'],
            ['f.txt', 'r+', 'ENOTSUP'],
            ['f.txt', fs.constants.O_WRONLY, 'ENOTSUP'],
          ]) {
            const err = await outcome(() =>
              place.writeFile(key(file), 'x', { flag }),
            );
            refused(err, code, 'open', at(name, key(file)));
          }
          assert.equal(read('f.txt'), '!', `${label}: nothing replaced`);
        }
      } finally {
        w.kernel.close();
      }
    });
  });

  it('through node:fs, the flag reaches the store', async () => {
    await withPlaces(async (k, { at }) => {
      const file = at('m', 'f.txt');
      fs.writeFileSync(file, 'one');
      fs.writeFileSync(file, 'two', { flag: 'a' });
      assert.equal(fs.readFileSync(file, 'utf8'), 'onetwo');
      assert.throws(() => fs.writeFileSync(file, 'x', { flag: 'wx' }), {
        code: 'EEXIST',
        syscall: 'open',
        path: file,
      });
      await fs.promises.writeFile(at('v', 'f.txt'), 'one');
      await fs.promises.appendFile(at('v', 'f.txt'), 'two', 'utf8');
      await assert.rejects(
        fs.promises.writeFile(at('v', 'f.txt'), 'x', { flag: 'wx' }),
        { code: 'EEXIST' },
      );
      assert.equal(k.fs('v').readFile('/f.txt', 'utf8'), 'onetwo');
    });
  });

  it('v: exclusive when it runs, never against a file written meanwhile', async () => {
    await withPlaces(async (k, { at, outside }) => {
      const v = k.fs('v');
      const w = worker(k);
      try {
        for (const place of [v, w.kernel.fs('v')]) {
          const results = await Promise.allSettled([
            place.writeFile('/r.txt', 'first'),
            place.writeFile('/r.txt', 'second', { flag: 'wx' }),
          ]);
          assert.deepEqual(
            results.map((r) => r.reason?.code ?? r.status),
            ['fulfilled', 'EEXIST'],
          );
          assert.equal(v.readFile('/r.txt', 'utf8'), 'first');
          await place.unlink('/r.txt');
        }
      } finally {
        w.kernel.close();
      }
      // COPYFILE_EXCL is the same exclusive write.
      const to = at('v', 'c.txt');
      const [written, copied] = await Promise.allSettled([
        v.writeFile('/c.txt', 'first'),
        fs.promises.copyFile(outside, to, fs.constants.COPYFILE_EXCL),
      ]);
      assert.equal(written.status, 'fulfilled');
      assert.equal(copied.reason.code, 'EEXIST');
      assert.equal(copied.reason.syscall, 'copyfile');
      assert.equal(copied.reason.dest, to);
      assert.equal(v.readFile('/c.txt', 'utf8'), 'first');
      // cp with force: false skips a file written meanwhile, and keeps it.
      const [first, skipped] = await Promise.allSettled([
        v.writeFile('/s.txt', 'first'),
        fs.promises.cp(outside, at('v', 's.txt'), { force: false }),
      ]);
      assert.equal(first.status, 'fulfilled');
      assert.equal(skipped.status, 'fulfilled');
      assert.equal(v.readFile('/s.txt', 'utf8'), 'first');
      assert.equal(k.mutations.size, 0, 'no lock left');
    });
  });
});
