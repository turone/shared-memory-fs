'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, worker } = require('./helpers.js');

// A virtual place keeps the hierarchy a filesystem has: a path is a file or
// a directory, never both. A key under a file is ENOTDIR, a file where a
// directory is EISDIR — for writes, appends, copies, file renames and
// subtree moves alike, checked by one helper before anything is published.
// A key whose publication has begun counts already, so two mutations
// running together cannot create /f and /f/x both as files.

const PLACES = {
  v: {
    origin: 'virtual',
    fs: { writable: true, prepare: { boom: ['bad'] } },
  },
  m: { provider: 'map', origin: 'virtual', fs: { writable: true } },
};
const PREPARERS = {
  boom: () => {
    throw new Error('boom');
  },
};

const outcome = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err;
  }
};

// Settles once the microtasks queued so far — lock releases included — ran.
const drained = () => new Promise(setImmediate);

// Runs `fn` over a fresh kernel with both places, the fs patch installed.
const withPlaces = async (fn) => {
  const base = writeTree(tmpDir('vfs-hierarchy'), { 'outside/o.txt': 'o' });
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const k = await kernel(root, PLACES, {}, { preparers: PREPARERS });
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

// A refusal: the code, the syscall and the paths it names.
const refused = (err, code, syscall, where, dest) => {
  assert.equal(err.code, code, err.message ?? String(err));
  assert.equal(err.syscall, syscall);
  assert.equal(err.path, where);
  assert.equal(err.dest, dest);
};

// Every key a place projects, companions included.
const keysOf = (k, name) => [...k.registry.get(name).files.keys()].sort();

describe('virtual hierarchy', () => {
  for (const name of ['m', 'v']) {
    it(`${name}: no key under a file, no file on a directory`, async () => {
      await withPlaces(async (k, { at }) => {
        const place = k.fs(name);
        await place.writeFile('/f.txt', 'f');
        await place.writeFile('/dir/a.txt', 'a');
        const keys = keysOf(k, name);
        const used = k.cache.stats().totalUsed;
        for (const [run, code, key] of [
          [() => place.writeFile('/f.txt/x', 'x'), 'ENOTDIR', '/f.txt/x'],
          [() => place.writeFile('/f.txt/y/z', 'z'), 'ENOTDIR', '/f.txt/y/z'],
          [() => place.appendFile('/f.txt/x', 'x'), 'ENOTDIR', '/f.txt/x'],
          [() => place.writeFile('/dir', 'x'), 'EISDIR', '/dir'],
          [() => place.appendFile('/dir', 'x'), 'EISDIR', '/dir'],
        ]) {
          refused(await outcome(run), code, 'open', at(name, key), undefined);
        }
        assert.deepEqual(keysOf(k, name), keys, 'nothing published');
        assert.equal(k.cache.stats().totalUsed, used, 'nothing allocated');
        // A directory takes new files; a file is still rewritten in place.
        await place.writeFile('/dir/b.txt', 'b');
        await place.writeFile('/f.txt', 'g');
        assert.equal(place.readFile('/dir/b.txt', 'utf8'), 'b');
        assert.equal(place.readFile('/f.txt', 'utf8'), 'g');
      });
    });

    it(`${name}: a rename never puts a key under a file or a file on a directory`, async () => {
      await withPlaces(async (k, { at }) => {
        const place = k.fs(name);
        await place.writeFile('/f.txt', 'f');
        await place.writeFile('/a.txt', 'a');
        await place.writeFile('/old/b.txt', 'b');
        await place.writeFile('/old/sub/c.txt', 'c');
        await place.writeFile('/dir/d.txt', 'd');
        const keys = keysOf(k, name);
        for (const [from, to, code] of [
          ['/a.txt', '/f.txt/x', 'ENOTDIR'],
          ['/a.txt', '/a.txt/x', 'ENOTDIR'],
          ['/a.txt', '/dir', 'EISDIR'],
          ['/old', '/f.txt/new', 'ENOTDIR'],
          ['/old', '/f.txt/deep/new', 'ENOTDIR'],
        ]) {
          const err = await outcome(() => place.rename(from, to));
          refused(err, code, 'rename', at(name, from), at(name, to));
        }
        assert.deepEqual(keysOf(k, name), keys, 'source and destination kept');
        assert.equal(place.readFile('/old/sub/c.txt', 'utf8'), 'c');
      });
    });
  }

  it('v: a worker write under a file is refused by the main kernel', async () => {
    await withPlaces(async (k, { at }) => {
      await k.fs('v').writeFile('/f.txt', 'f');
      const w = worker(k);
      try {
        const err = await outcome(() =>
          w.kernel.fs('v').writeFile('/f.txt/x', 'x'),
        );
        refused(err, 'ENOTDIR', 'open', at('v', 'f.txt', 'x'), undefined);
        assert.equal(k.fs('v').exists('/f.txt/x'), false);
      } finally {
        w.kernel.close();
      }
    });
  });

  it('a copy under a file fails as the copy, the destination unchanged', async () => {
    await withPlaces(async (k, { at, outside }) => {
      await k.fs('v').writeFile('/f.txt', 'f');
      k.fs('m').writeFile('/f.txt', 'f');
      const copies = [
        ['m', 'copyfile', (to) => fs.copyFileSync(outside, to)],
        ['v', 'copyfile', (to) => fs.promises.copyFile(outside, to)],
        ['m', 'cp', (to) => fs.cpSync(outside, to)],
        ['v', 'cp', (to) => fs.promises.cp(outside, to)],
      ];
      for (const [name, syscall, copy] of copies) {
        const to = at(name, 'f.txt', 'x');
        refused(await outcome(() => copy(to)), 'ENOTDIR', syscall, outside, to);
        assert.equal(k.fs(name).readFile('/f.txt', 'utf8'), 'f', name);
        assert.equal(k.fs(name).exists('/f.txt/x'), false, name);
      }
    });
  });

  it('v: mutations running together cannot create a file and a key under it', async () => {
    await withPlaces(async (k) => {
      const v = k.fs('v');
      for (const [first, second] of [
        ['/f', '/f/x'],
        ['/g/x', '/g'],
      ]) {
        const results = await Promise.allSettled([
          v.writeFile(first, 'first'),
          v.writeFile(second, 'second'),
        ]);
        assert.equal(results[0].status, 'fulfilled', first);
        assert.equal(results[1].status, 'rejected', second);
        const code = second.length > first.length ? 'ENOTDIR' : 'EISDIR';
        assert.equal(results[1].reason.code, code);
        assert.equal(v.exists(second), second.length < first.length);
      }
      // A rename into a key while a file takes its parent's name.
      await v.writeFile('/a.txt', 'a');
      const [written, moved] = await Promise.allSettled([
        v.writeFile('/h', 'file'),
        v.rename('/a.txt', '/h/a.txt'),
      ]);
      assert.equal(written.status, 'fulfilled');
      assert.equal(moved.reason.code, 'ENOTDIR');
      assert.equal(v.readFile('/a.txt', 'utf8'), 'a', 'the source stays');
      assert.equal(v.stat('/h').isFile(), true);
    });
  });

  it('mkdir creates no entry; the place root answers at once', async () => {
    await withPlaces(async (k, { at }) => {
      for (const name of ['m', 'v']) {
        fs.mkdirSync(at(name), { recursive: true });
        assert.throws(() => fs.mkdirSync(at(name)), {
          code: 'EEXIST',
          syscall: 'mkdir',
          path: at(name),
        });
        await fs.promises.mkdir(at(name, 'd', 'e'), { recursive: true });
        assert.equal(k.fs(name).exists('/d'), false, `${name}: no entry`);
      }
      fs.mkdirSync(at('m', 'd', 'e'), { recursive: true });
      // A shared virtual place publishes through the main kernel.
      assert.throws(() => fs.mkdirSync(at('v', 'd'), { recursive: true }), {
        code: 'ENOTSUP',
        syscall: 'mkdir',
      });
      // A directory exists while a file is under it.
      await k.fs('v').writeFile('/d/e/f.txt', 'f');
      assert.ok(fs.statSync(at('v', 'd', 'e')).isDirectory());
    });
  });

  it('mkdir and unlink answer as a filesystem does, in every thread', async () => {
    await withPlaces(async (k, { at }) => {
      const w = worker(k);
      try {
        for (const [label, name, place] of [
          ['map', 'm', k.fs('m')],
          ['sab', 'v', k.fs('v')],
          ['worker', 'v', w.kernel.fs('v')],
        ]) {
          const dir = `/${label}`;
          await place.writeFile(`${dir}/f.txt`, 'f');
          await place.writeFile(`${dir}/d/a.txt`, 'a');
          const keys = keysOf(k, name);
          for (const [key, options, code] of [
            [`${dir}/f.txt/x`, {}, 'ENOTDIR'],
            [`${dir}/f.txt/x/y`, { recursive: true }, 'ENOTDIR'],
            [`${dir}/f.txt`, {}, 'EEXIST'],
            [`${dir}/f.txt`, { recursive: true }, 'EEXIST'],
            [`${dir}/d`, {}, 'EEXIST'],
          ]) {
            const err = await outcome(() => place.mkdir(key, options));
            refused(err, code, 'mkdir', at(name, key), undefined);
          }
          // A directory that exists, or none yet: mkdir creates no entry.
          await place.mkdir(`${dir}/d`, { recursive: true });
          await place.mkdir(`${dir}/new/deep`);
          assert.equal(place.exists(`${dir}/new`), false, label);
          const err = await outcome(() => place.unlink(`${dir}/d`));
          refused(err, 'EISDIR', 'unlink', at(name, `${dir}/d`), undefined);
          assert.deepEqual(keysOf(k, name), keys, `${label}: nothing changed`);
        }
        // A file on its way already refuses a directory under it.
        const v = k.fs('v');
        const [written, made] = await Promise.allSettled([
          v.writeFile('/c', 'c'),
          v.mkdir('/c/x'),
        ]);
        assert.equal(written.status, 'fulfilled');
        assert.equal(made.reason.code, 'ENOTDIR');
      } finally {
        w.kernel.close();
      }
    });
  });

  it('v: refusals leak no allocation, lock, barrier or pending key', async () => {
    await withPlaces(async (k) => {
      const v = k.fs('v');
      await v.writeFile('/f.txt', 'f');
      await v.writeFile('/tree/t.txt', 't');
      const used = k.cache.stats().totalUsed;
      const refusals = await Promise.allSettled([
        v.writeFile('/f.txt/x', 'x'),
        v.rename('/tree', '/f.txt/tree'),
        v.writeFile('/tree', 'x'),
      ]);
      assert.deepEqual(
        refusals.map((r) => r.reason?.code),
        ['ENOTDIR', 'ENOTDIR', 'EISDIR'],
      );
      await drained();
      assert.equal(k.mutations.size, 0, 'no lock left');
      assert.equal(k.cache.stats().totalUsed, used, 'nothing allocated');
      // A publication that fails releases its key: nothing blocks it after.
      await assert.rejects(v.writeFile('/p.bad', 'x'), /boom/);
      await v.writeFile('/p.bad/child.txt', 'c');
      // The barrier is free: a subtree operation runs.
      await v.rename('/tree', '/moved');
      await v.rm('/moved', { recursive: true });
      assert.equal(v.exists('/moved'), false);
    });
  });
});
