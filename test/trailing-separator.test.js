'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, worker } = require('./helpers.js');

// A path that ends in a separator names a directory, as on POSIX — on every
// platform for what the VFS serves or stores. A file named so is ENOTDIR, a
// file write to it EISDIR, and a refusal changes nothing.

const PLACES = {
  pub: { fs: true },
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

// Runs `fn` over a fresh kernel, the fs patch installed. `big.txt` is over
// the test maxFileSize, so pub serves it from disk.
const withPlaces = async (fn) => {
  const base = writeTree(tmpDir('vfs-trailing'), {
    'app/pub/a.txt': 'a',
    'app/pub/big.txt': 'B'.repeat(70 * 1024),
    'app/pub/dir/b.txt': 'b',
    'outside/o.txt': 'o',
  });
  const root = path.join(base, 'app');
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

// A refusal: the code, the syscall and the paths it names.
const refused = (err, code, syscall, where, dest) => {
  assert.equal(err.code, code, err.message ?? String(err));
  assert.equal(err.syscall, syscall);
  assert.equal(err.path, where);
  assert.equal(err.dest, dest);
};

// Every key a place projects, companions included.
const keysOf = (k, name) => [...k.registry.get(name).files.keys()].sort();

// What a read stream ends with: its error, or 'ok' once read to the end.
const streamOutcome = (filePath) =>
  new Promise((resolve) => {
    const stream = fs.createReadStream(filePath);
    stream
      .on('error', resolve)
      .on('end', () => resolve('ok'))
      .resume();
  });

// The mutations of one place through node:fs, keys joined to its path.
const syncFs = (to) => ({
  writeFile: (key, data) => fs.writeFileSync(to(key), data),
  appendFile: (key, data) => fs.appendFileSync(to(key), data),
  unlink: (key) => fs.unlinkSync(to(key)),
  rm: (key, options) => fs.rmSync(to(key), options),
  rename: (from, target) => fs.renameSync(to(from), to(target)),
  mkdir: (key, options) => fs.mkdirSync(to(key), options),
});

const promisesFs = (to) => ({
  writeFile: (key, data) => fs.promises.writeFile(to(key), data),
  appendFile: (key, data) => fs.promises.appendFile(to(key), data),
  unlink: (key) => fs.promises.unlink(to(key)),
  rm: (key, options) => fs.promises.rm(to(key), options),
  rename: (from, target) => fs.promises.rename(to(from), to(target)),
  mkdir: (key, options) => fs.promises.mkdir(to(key), options),
});

describe('a trailing separator names a directory', () => {
  it('a served file named so is ENOTDIR, a directory is one', async () => {
    await withPlaces(async (k, { at, outside }) => {
      await k.fs('v').writeFile('/v.txt', 'v');
      k.fs('m').writeFile('/m.txt', 'm');
      const separators = process.platform === 'win32' ? ['/', '\\'] : ['/'];
      for (const file of [
        at('pub', 'a.txt'),
        at('pub', 'big.txt'),
        at('v', 'v.txt'),
        at('m', 'm.txt'),
      ]) {
        assert.ok(fs.statSync(file).isFile(), file);
        for (const sep of separators) {
          const named = file + sep;
          for (const [syscall, run] of [
            ['open', () => fs.readFileSync(named)],
            ['open', () => fs.promises.readFile(named)],
            ['stat', () => fs.statSync(named)],
            ['lstat', () => fs.promises.lstat(named)],
            ['access', () => fs.accessSync(named)],
            ['scandir', () => fs.readdirSync(named)],
          ]) {
            refused(await outcome(run), 'ENOTDIR', syscall, named, undefined);
          }
          const stream = await streamOutcome(named);
          refused(stream, 'ENOTDIR', 'open', named, undefined);
          assert.equal(fs.existsSync(named), false, named);
          const copy = await outcome(() =>
            fs.promises.copyFile(named, outside),
          );
          refused(copy, 'ENOTDIR', 'copyfile', named, outside);
        }
      }
      assert.equal(fs.readFileSync(outside, 'utf8'), 'o', 'nothing copied');
      for (const dir of [at('pub', 'dir'), at('pub'), at('v'), at('m')]) {
        assert.ok(fs.statSync(dir + '/').isDirectory(), dir);
      }
      assert.deepEqual(fs.readdirSync(at('pub', 'dir') + '/'), ['b.txt']);
    });
  });

  it('mutations answer as POSIX does, in every thread', async () => {
    await withPlaces(async (k, { at, outside }) => {
      const w = worker(k);
      try {
        for (const [label, name, place] of [
          ['map', 'm', syncFs((key) => at('m', key))],
          ['sab', 'v', promisesFs((key) => at('v', key))],
          ['worker', 'v', w.kernel.fs('v')],
        ]) {
          const dir = `/${label}`;
          const abs = (key) => at(name, key);
          await place.writeFile(`${dir}/f.txt`, 'f');
          await place.writeFile(`${dir}/d/a.txt`, 'a');
          const keys = keysOf(k, name);
          const f = `${dir}/f.txt`;
          const d = `${dir}/d`;
          const n = `${dir}/n.txt`;
          for (const [run, code, syscall, from, to] of [
            [() => place.writeFile(`${f}/`, 'x'), 'EISDIR', 'open', f],
            [() => place.writeFile(`${n}/`, 'x'), 'EISDIR', 'open', n],
            [() => place.writeFile(`${d}/`, 'x'), 'EISDIR', 'open', d],
            [() => place.appendFile(`${f}/`, 'x'), 'EISDIR', 'open', f],
            [() => place.unlink(`${f}/`), 'ENOTDIR', 'unlink', f],
            [() => place.unlink(`${d}/`), 'EISDIR', 'unlink', d],
            [() => place.unlink(`${n}/`), 'ENOENT', 'unlink', n],
            [() => place.rm(`${f}/`, {}), 'ENOTDIR', 'rm', f],
            [() => place.rm(`${f}/`, { recursive: true }), 'ENOTDIR', 'rm', f],
            [() => place.rm(`${n}/`, {}), 'ENOENT', 'rm', n],
            [() => place.rename(`${f}/`, n), 'ENOTDIR', 'rename', f, n],
            [() => place.rename(f, `${n}/`), 'ENOTDIR', 'rename', f, n],
            [() => place.rename(f, `${d}/`), 'ENOTDIR', 'rename', f, d],
            [() => place.mkdir(`${f}/`), 'EEXIST', 'mkdir', f],
          ]) {
            const err = await outcome(run);
            const dest = to && abs(to);
            refused(err, code, syscall, abs(from), dest);
          }
          assert.deepEqual(keysOf(k, name), keys, `${label}: nothing changed`);
          // `force` ignores ENOTDIR as it does ENOENT: the file stays.
          await place.rm(`${f}/`, { force: true });
          await place.rm(`${f}/`, { recursive: true, force: true });
          assert.deepEqual(keysOf(k, name), keys, `${label}: file kept`);
          // A directory named so is the directory.
          await place.rename(`${d}/`, `${dir}/e/`);
          assert.equal(k.fs(name).readFile(`${dir}/e/a.txt`, 'utf8'), 'a');
          await place.rm(`${dir}/e/`, { recursive: true });
          assert.equal(k.fs(name).exists(`${dir}/e`), false, label);
          assert.equal(k.fs(name).readFile(f, 'utf8'), 'f', label);
        }
        // The destination of a copy: the copy's error, nothing written.
        const used = k.cache.stats().totalUsed;
        for (const [name, syscall, copy] of [
          ['m', 'copyfile', (to) => fs.copyFileSync(outside, to)],
          ['v', 'copyfile', (to) => fs.promises.copyFile(outside, to)],
          ['m', 'cp', (to) => fs.cpSync(outside, to)],
          ['v', 'cp', (to) => fs.promises.cp(outside, to)],
        ]) {
          const to = at(name, 'copy.txt') + path.sep;
          refused(
            await outcome(() => copy(to)),
            'EISDIR',
            syscall,
            outside,
            to,
          );
          assert.equal(k.fs(name).exists('/copy.txt'), false, name);
        }
        assert.equal(k.cache.stats().totalUsed, used, 'nothing allocated');
      } finally {
        w.kernel.close();
      }
    });
  });

  it('v: checked when the mutation runs, never against a file meanwhile', async () => {
    await withPlaces(async (k) => {
      const w = worker(k);
      try {
        for (const place of [k.fs('v'), w.kernel.fs('v')]) {
          const results = await Promise.allSettled([
            place.writeFile('/x', 'x'),
            place.unlink('/x/'),
            place.rm('/x/', { recursive: true }),
            place.rename('/x/', '/y'),
            place.rename('/x', '/y/'),
          ]);
          assert.deepEqual(
            results.map((r) => r.reason?.code ?? r.status),
            ['fulfilled', 'ENOTDIR', 'ENOTDIR', 'ENOTDIR', 'ENOTDIR'],
          );
          assert.equal(k.fs('v').readFile('/x', 'utf8'), 'x');
          assert.equal(k.fs('v').exists('/y'), false);
          await place.unlink('/x');
        }
        // Tasks run after the calls that queue them: the file /x is gone
        // and a directory took its name by the time the rename runs, which
        // moves that directory.
        const v = k.fs('v');
        await v.writeFile('/x', 'x');
        await v.writeFile('/dir/a', 'a');
        const moves = await Promise.allSettled([
          v.unlink('/x'),
          v.rename('/dir', '/x'),
          v.rename('/x/', '/y'),
        ]);
        assert.deepEqual(
          moves.map((r) => r.reason?.code ?? r.status),
          ['fulfilled', 'fulfilled', 'fulfilled'],
        );
        assert.equal(v.readFile('/y/a', 'utf8'), 'a');
        assert.equal(k.mutations.size, 0, 'no lock left');
      } finally {
        w.kernel.close();
      }
    });
  });
});
