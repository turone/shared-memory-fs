'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// Disk access behind the VFS's back: captured before any patch is installed.
const {
  writeFileSync: writeDisk,
  existsSync: onDisk,
  readFileSync: readDisk,
} = fs;

// A native operation that walks a tree, or acts on every entry under a
// path, checks only that path. Where the walk would reach what the places
// serve — a managed directory, appRoot, or a directory above it — it is
// recognized but unsupported (ENOTSUP) and nothing is read or changed.
// Unrelated paths outside appRoot keep node:fs.

const outcome = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err;
  }
};

const viaCallback = (fn) =>
  new Promise((resolve, reject) => {
    fn((err, value) => (err ? reject(err) : resolve(value)));
  });

// ENOTSUP with the operation and its paths.
const notSupported = (err, syscall, source, dest) => {
  assert.equal(err.code, 'ENOTSUP', err.message ?? String(err));
  assert.equal(err.syscall, syscall);
  assert.equal(err.path, source);
  if (dest !== undefined) assert.equal(err.dest, dest);
};

// fs.watch: 'ok' (the watcher is closed at once) or the error it threw.
const watchOutcome = (dir, options) => {
  try {
    fs.watch(dir, options, () => {}).close();
    return 'ok';
  } catch (err) {
    return err;
  }
};

// The first step of fs.promises.watch: the error it fails with, or 'ok'
// when it is still waiting for a change after a moment.
const promisedWatch = async (dir, options) => {
  const signal = AbortSignal.timeout(500);
  try {
    await fs.promises.watch(dir, { ...options, signal }).next();
    return 'ok';
  } catch (err) {
    return err.name === 'AbortError' ? 'ok' : err;
  }
};

describe('native walks under strict routing', () => {
  let base;
  let root;
  let other;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    base = writeTree(tmpDir('vfs-walks'), {
      'app/site/index.html': '<h1>',
      'app/site/logo.png': 'PNG',
      'app/site/media/clip.mp4': 'MP4',
      'app/ro/keep.txt': 'keep',
      'app/stray/secret.txt': 'secret',
      'other/o.txt': 'o',
      'other/sub/p.txt': 'p',
    });
    root = path.join(base, 'app');
    other = path.join(base, 'other');
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html'], fallback: 'disk' } },
        ro: { fs: { ext: ['txt'] } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
    );
    writeDisk(at('site', 'late.html'), 'unpublished');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(base);
  });

  it('recursive readdir of a directory above appRoot', async () => {
    const options = { recursive: true };
    assert.throws(
      () => fs.readdirSync(base, options),
      (err) => notSupported(err, 'scandir', base) ?? true,
    );
    notSupported(
      await outcome(() => viaCallback((cb) => fs.readdir(base, options, cb))),
      'scandir',
      base,
    );
    notSupported(
      await outcome(() => fs.promises.readdir(base, options)),
      'scandir',
      base,
    );
    // One level does not walk into appRoot; unrelated trees stay native.
    assert.deepEqual(fs.readdirSync(base).sort(), ['app', 'other']);
    assert.deepEqual(
      fs
        .readdirSync(other, options)
        .map((n) => n.split(path.sep).join('/'))
        .sort(),
      ['o.txt', 'sub', 'sub/p.txt'],
    );
    // The managed appRoot keeps its own recursive listing.
    assert.ok(fs.readdirSync(root, options).includes('site/index.html'));
  });

  it('recursive opendir of a directory above appRoot', async () => {
    const options = { recursive: true };
    assert.throws(
      () => fs.opendirSync(base, options),
      (err) => notSupported(err, 'opendir', base) ?? true,
    );
    notSupported(
      await outcome(() => viaCallback((cb) => fs.opendir(base, options, cb))),
      'opendir',
      base,
    );
    notSupported(
      await outcome(() => fs.promises.opendir(base, options)),
      'opendir',
      base,
    );
    const dir = fs.opendirSync(base);
    assert.ok(dir instanceof fs.Dir, 'one level stays native');
    dir.closeSync();
    const walk = fs.opendirSync(other, options);
    assert.ok(walk instanceof fs.Dir);
    walk.closeSync();
  });

  it('watch: managed territory, recursive or not, and appRoot', () => {
    for (const dir of [at('site'), at('site', 'media'), at('mem'), root]) {
      for (const options of [{}, { recursive: true }]) {
        notSupported(watchOutcome(dir, options), 'watch', dir);
      }
    }
    // A published file: its raw events are not its publications.
    const published = at('site', 'index.html');
    notSupported(watchOutcome(published, {}), 'watch', published);
    // A file of the disk territory is its own content and keeps a native
    // watcher; a denied path stays EACCES.
    assert.equal(watchOutcome(at('site', 'logo.png'), {}), 'ok');
    assert.equal(watchOutcome(at('stray'), {}).code, 'EACCES');
    assert.equal(watchOutcome(at('site', 'late.html'), {}).code, 'EACCES');
  });

  it('watch: recursive above appRoot; unrelated trees stay native', () => {
    notSupported(watchOutcome(base, { recursive: true }), 'watch', base);
    assert.equal(watchOutcome(base, {}), 'ok', 'one level stays native');
    assert.equal(watchOutcome(other, { recursive: true }), 'ok');
  });

  it('fs.promises.watch refuses when iterated, as node:fs reports errors', async () => {
    notSupported(await promisedWatch(at('site'), {}), 'watch', at('site'));
    notSupported(await promisedWatch(base, { recursive: true }), 'watch', base);
    assert.equal(await promisedWatch(other, { recursive: true }), 'ok');
  });

  it('recursive rm / rmdir of a tree that holds places', async () => {
    const options = { recursive: true, force: true };
    assert.throws(
      () => fs.rmSync(base, options),
      (err) => notSupported(err, 'rm', base) ?? true,
    );
    notSupported(
      await outcome(() => viaCallback((cb) => fs.rm(base, options, cb))),
      'rm',
      base,
    );
    notSupported(
      await outcome(() => fs.promises.rm(base, options)),
      'rm',
      base,
    );
    assert.throws(
      () => fs.rmdirSync(base, { recursive: true }),
      (err) => notSupported(err, 'rmdir', base) ?? true,
    );
    notSupported(
      await outcome(() =>
        viaCallback((cb) => fs.rmdir(base, { recursive: true }, cb)),
      ),
      'rmdir',
      base,
    );
    notSupported(
      await outcome(() => fs.promises.rmdir(base, { recursive: true })),
      'rmdir',
      base,
    );
    assert.equal(readDisk(at('ro', 'keep.txt'), 'utf8'), 'keep');
    // A read-only place stays read-only; unrelated trees are removed.
    assert.throws(() => fs.rmSync(at('ro'), options), { code: 'EROFS' });
    const scratch = writeTree(path.join(base, 'scratch'), { 'x/y.txt': 'y' });
    await fs.promises.rm(scratch, options);
    assert.equal(onDisk(scratch), false);
  });

  it('rename of a tree that holds places', async () => {
    const moved = path.join(path.dirname(base), `${path.basename(base)}-moved`);
    assert.throws(
      () => fs.renameSync(base, moved),
      (err) => notSupported(err, 'rename', base, moved) ?? true,
    );
    notSupported(
      await outcome(() => viaCallback((cb) => fs.rename(base, moved, cb))),
      'rename',
      base,
      moved,
    );
    notSupported(
      await outcome(() => fs.promises.rename(base, moved)),
      'rename',
      base,
      moved,
    );
    assert.equal(onDisk(moved), false);
    assert.equal(fs.readFileSync(at('site', 'index.html'), 'utf8'), '<h1>');
    assert.throws(() => fs.readFileSync(at('site', 'late.html')), {
      code: 'EACCES',
    });
    const renamed = path.join(base, 'other-renamed');
    fs.renameSync(other, renamed);
    fs.renameSync(renamed, other);
    assert.equal(readDisk(path.join(other, 'o.txt'), 'utf8'), 'o');
  });

  it('a recursive copy into a tree that holds places', async () => {
    const options = { recursive: true, force: true };
    const source = other;
    const into = (dest) => outcome(() => fs.promises.cp(source, dest, options));
    notSupported(await into(base), 'cp', source, base);
    assert.throws(
      () => fs.cpSync(source, base, options),
      (err) => notSupported(err, 'cp', source, base) ?? true,
    );
    notSupported(
      await outcome(() =>
        viaCallback((cb) => fs.cp(source, base, options, cb)),
      ),
      'cp',
      source,
      base,
    );
    assert.equal((await into(root)).code, 'EACCES', 'the strict appRoot');
    assert.equal(onDisk(path.join(base, 'o.txt')), false, 'nothing written');
  });
});

describe('native walks without strict routing', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-walks-loose'), {
      'site/index.html': '<h1>',
      'loose/l.txt': 'l',
    });
    k = await kernel(root, { site: { fs: { ext: ['html'] } } });
    writeDisk(at('site', 'late.html'), 'unpublished');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('appRoot passes through, but never walks into the places', async () => {
    const options = { recursive: true };
    assert.throws(() => fs.readdirSync(root, options), { code: 'ENOTSUP' });
    await assert.rejects(fs.promises.opendir(root, options), {
      code: 'ENOTSUP',
    });
    assert.equal(watchOutcome(root, options).code, 'ENOTSUP');
    assert.throws(() => fs.rmSync(root, { recursive: true }), {
      code: 'ENOTSUP',
    });
    assert.throws(() => fs.renameSync(root, `${root}-moved`), {
      code: 'ENOTSUP',
    });
    assert.equal(watchOutcome(at('site'), {}).code, 'ENOTSUP');
    // One level of appRoot, and unmanaged trees, stay native.
    assert.deepEqual(fs.readdirSync(root).sort(), ['loose', 'site']);
    assert.equal(watchOutcome(root, {}), 'ok');
    assert.deepEqual(fs.readdirSync(at('loose'), options), ['l.txt']);
    assert.equal(watchOutcome(at('loose'), options), 'ok');
  });
});
