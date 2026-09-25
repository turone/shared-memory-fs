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
  readFileSync: readDisk,
  existsSync: onDisk,
} = fs;

// cp, copyFile and link work on the raw disk file: from a source the places
// serve they would copy (or link) raw disk bytes in place of the published,
// prepared or virtual content, and a recursive copy would walk past the
// filtered listings. Such copies are recognized but unsupported (ENOTSUP)
// and never start; a copy the places do not serve stays node:fs.

const upper = (raw) => raw.toString().toUpperCase();

// Each form of cp: resolves 'ok' or the error it failed with.
const FORMS = {
  sync: (src, dest, options) => {
    fs.cpSync(src, dest, options);
  },
  callback: (src, dest, options) =>
    new Promise((resolve, reject) => {
      fs.cp(src, dest, options, (err) => (err ? reject(err) : resolve()));
    }),
  promises: (src, dest, options) => fs.promises.cp(src, dest, options),
};

const outcome = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err;
  }
};

describe('copies under strict routing', () => {
  let base;
  let root;
  let out;
  let k;
  let n = 0;
  const at = (...p) => path.join(root, ...p);
  const fresh = () => path.join(out, `copy-${++n}`);

  // Every form refuses with ENOTSUP and leaves nothing behind.
  const refused = async (src, options) => {
    for (const [form, cp] of Object.entries(FORMS)) {
      const dest = fresh();
      const err = await outcome(() => cp(src, dest, options));
      assert.equal(err.code, 'ENOTSUP', `${form}: ${err.message ?? err}`);
      assert.equal(err.syscall, 'cp');
      assert.equal(err.path, src);
      assert.equal(err.dest, dest);
      assert.equal(onDisk(dest), false, `${form}: nothing copied`);
    }
  };

  before(async () => {
    base = writeTree(tmpDir('vfs-copy'), {
      'app/site/index.html': '<h1>',
      'app/site/logo.png': 'PNG',
      'app/site/media/clip.mp4': 'MP4',
      'app/closed/index.html': '<h1>',
      'app/closed/logo.png': 'hidden',
      'app/prep/a.txt': 'hello',
      'app/wr/w.txt': 'w',
      'app/stray/s.txt': 'stray',
      'src/a.txt': 'a',
      'src/sub/b.txt': 'b',
    });
    root = path.join(base, 'app');
    out = tmpDir('vfs-copy-out');
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html'], fallback: 'disk' } },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        prep: { fs: { ext: ['txt'], prepare: 'upper' } },
        wr: { fs: { ext: ['txt'], writable: true } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
      { preparers: { upper } },
    );
    // Cached extensions written after the scan: never published.
    writeDisk(at('site', 'late.html'), 'unpublished');
    writeDisk(at('site', 'media', 'raw.html'), 'unpublished');
    k.fs('mem').writeFile('/v.txt', 'virtual');
    k.fs('mem').writeFile('/d/w.txt', 'virtual');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(base);
    rm(out);
  });

  it("fallback: 'deny' — a recursive copy never reaches the hidden files", async () => {
    assert.throws(() => fs.readFileSync(at('closed', 'logo.png')), {
      code: 'EACCES',
    });
    await refused(at('closed'), { recursive: true });
  });

  it("fallback: 'disk' — a recursive copy never walks past the listing", async () => {
    assert.throws(() => fs.readFileSync(at('site', 'late.html')), {
      code: 'EACCES',
    });
    await refused(at('site'), { recursive: true });
    // A directory only on disk, and a single disk-territory file.
    await refused(at('site', 'media'), { recursive: true });
    await refused(at('site', 'logo.png'), { recursive: true });
  });

  it('a prepared file never copies its raw source', async () => {
    const file = at('prep', 'a.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'HELLO');
    assert.equal(readDisk(file, 'utf8'), 'hello', 'the raw source on disk');
    await refused(file);
    await refused(file, { recursive: true });
    await refused(at('prep'), { recursive: true });
    const dest = fresh();
    assert.throws(() => fs.copyFileSync(file, dest), {
      code: 'ENOTSUP',
      syscall: 'copyfile',
    });
    await assert.rejects(fs.promises.copyFile(file, dest), {
      code: 'ENOTSUP',
    });
    const viaCallback = await new Promise((resolve) => {
      fs.copyFile(file, dest, (err) => resolve(err));
    });
    assert.equal(viaCallback.code, 'ENOTSUP');
    assert.equal(onDisk(dest), false);
  });

  it('a hard link never gives a served entry a raw second name', async () => {
    const file = at('prep', 'a.txt');
    const dest = fresh();
    assert.throws(
      () => fs.linkSync(file, dest),
      (err) => {
        assert.equal(err.code, 'ENOTSUP');
        assert.equal(err.syscall, 'link');
        assert.equal(err.path, file);
        assert.equal(err.dest, dest);
        return true;
      },
    );
    await assert.rejects(fs.promises.link(file, dest), { code: 'ENOTSUP' });
    const viaCallback = await new Promise((resolve) => {
      fs.link(file, dest, (err) => resolve(err));
    });
    assert.equal(viaCallback.code, 'ENOTSUP');
    assert.equal(onDisk(dest), false);
    // A disk-territory file links natively: its disk bytes are its content.
    const linked = fresh();
    fs.linkSync(at('site', 'logo.png'), linked);
    assert.equal(readDisk(linked, 'utf8'), 'PNG');
  });

  it('virtual entries: no partial, disk-only copy', async () => {
    await refused(at('mem'), { recursive: true });
    await refused(at('mem', 'd'), { recursive: true });
    await refused(at('mem', 'v.txt'));
    assert.throws(() => fs.copyFileSync(at('mem', 'v.txt'), fresh()), {
      code: 'ENOTSUP',
    });
  });

  it('the managed appRoot and every tree that holds it are refused', async () => {
    await refused(root, { recursive: true });
    await refused(root);
    // A directory above appRoot is outside it, but a walk from there
    // copies the places as raw disk trees.
    await refused(base, { recursive: true });
    assert.equal(
      (await outcome(() => fs.promises.cp(base, fresh()))).code,
      'ERR_FS_EISDIR',
      'without recursive, node:fs refuses a directory itself',
    );
  });

  it('a managed source is refused whatever the destination', async () => {
    const inside = at('wr', 'copy');
    const err = await outcome(() =>
      fs.promises.cp(at('site'), inside, { recursive: true }),
    );
    assert.equal(err.code, 'ENOTSUP');
    assert.equal(err.dest, inside);
    assert.equal(onDisk(inside), false);
  });

  it('the error names the operation, the source and the destination', () => {
    const dest = path.join(out, 'named');
    assert.throws(
      () => fs.cpSync(at('site'), dest, { recursive: true }),
      (err) => {
        assert.equal(err.code, 'ENOTSUP');
        assert.equal(err.syscall, 'cp');
        assert.equal(err.path, at('site'));
        assert.equal(err.dest, dest);
        assert.equal(
          err.message,
          `ENOTSUP: operation not supported (managed source), cp '${at('site')}' -> '${dest}'`,
        );
        return true;
      },
    );
  });

  it('disk-territory files copy natively; denied sources stay EACCES', async () => {
    for (const [form, cp] of Object.entries(FORMS)) {
      const dest = fresh();
      assert.equal(await outcome(() => cp(at('site', 'logo.png'), dest)), 'ok');
      assert.equal(readDisk(dest, 'utf8'), 'PNG', form);
    }
    const copied = fresh();
    fs.copyFileSync(at('site', 'logo.png'), copied);
    assert.equal(readDisk(copied, 'utf8'), 'PNG');
    for (const denied of [at('site', 'late.html'), at('stray')]) {
      const err = await outcome(() =>
        fs.promises.cp(denied, fresh(), { recursive: true }),
      );
      assert.equal(err.code, 'EACCES');
    }
    assert.throws(() => fs.copyFileSync(at('closed', 'logo.png'), fresh()), {
      code: 'EACCES',
    });
  });

  it('sources outside appRoot stay node:fs', async () => {
    const src = path.join(base, 'src');
    for (const [form, cp] of Object.entries(FORMS)) {
      const dest = fresh();
      const copied = await outcome(() => cp(src, dest, { recursive: true }));
      assert.equal(copied, 'ok', form);
      assert.equal(readDisk(path.join(dest, 'sub', 'b.txt'), 'utf8'), 'b');
    }
    const file = fresh();
    fs.copyFileSync(path.join(src, 'a.txt'), file);
    assert.equal(readDisk(file, 'utf8'), 'a');
  });

  it('a guarded write into a virtual place is refused, not left on disk', async () => {
    const source = path.join(base, 'src', 'a.txt');
    for (const target of [at('mem', 'x.txt'), at('mem', 'd', 'y.txt')]) {
      assert.throws(() => fs.copyFileSync(source, target), {
        code: 'ENOTSUP',
      });
      assert.equal(
        (await outcome(() => fs.promises.cp(source, target))).code,
        'ENOTSUP',
      );
      assert.equal(onDisk(target), false);
      assert.equal(k.fs('mem').exists(target.slice(at('mem').length)), false);
    }
    assert.throws(() => fs.truncateSync(at('mem', 'v.txt'), 0), {
      code: 'ENOTSUP',
    });
    assert.equal(k.fs('mem').readFile('/v.txt', 'utf8'), 'virtual');
    // Writable disk-origin places keep native copies in.
    fs.copyFileSync(source, at('wr', 'in.txt'));
    assert.equal(readDisk(at('wr', 'in.txt'), 'utf8'), 'a');
  });
});

describe('copies without strict routing', () => {
  let root;
  let out;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-copy-loose'), {
      'site/index.html': '<h1>',
      'site/logo.png': 'PNG',
      'loose/l.txt': 'l',
    });
    out = tmpDir('vfs-copy-loose-out');
    k = await kernel(root, {
      site: { fs: { ext: ['html'] } },
      mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    });
    writeDisk(at('site', 'late.html'), 'unpublished');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(out);
  });

  it('managed sources are refused in the permissive mode too', async () => {
    for (const [src, options] of [
      [at('site'), { recursive: true }],
      [at('mem'), { recursive: true }],
      [root, { recursive: true }],
      [at('site', 'index.html'), {}],
    ]) {
      const dest = path.join(out, `x-${path.basename(src)}`);
      const err = await outcome(() => fs.promises.cp(src, dest, options));
      assert.equal(err.code, 'ENOTSUP', src);
      assert.equal(onDisk(dest), false);
    }
  });

  it('unmanaged trees and permissive disk reads copy natively', async () => {
    const tree = path.join(out, 'loose');
    fs.cpSync(at('loose'), tree, { recursive: true });
    assert.equal(readDisk(path.join(tree, 'l.txt'), 'utf8'), 'l');
    // Without strict, an unpublished file reads from disk, so it copies
    // from disk as well.
    const raw = path.join(out, 'late.html');
    fs.cpSync(at('site', 'late.html'), raw);
    assert.equal(readDisk(raw, 'utf8'), 'unpublished');
  });
});
