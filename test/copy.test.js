'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VfsConfig } = require('../lib/config.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const {
  tmpDir,
  writeTree,
  rm,
  kernel,
  worker,
  nextMessage,
} = require('./helpers.js');

// Disk access behind the VFS's back: captured before any patch is installed.
const {
  writeFileSync: writeDisk,
  readFileSync: readDisk,
  existsSync: onDisk,
} = fs;

const { COPYFILE_EXCL, COPYFILE_FICLONE, COPYFILE_FICLONE_FORCE } =
  fs.constants;

// A copy hands the source's raw input to the destination: the raw disk file
// of a disk-origin place — prepared or not — or the canonical bytes of an
// unprepared virtual entry, which are its raw input; never a prepared
// result, never a companion. The destination publishes it through its own
// pipeline: a disk place through its watcher, a virtual place through its
// store, its preparer running once, with no file on disk. A prepared virtual
// entry has no raw input left (ENOTSUP), a hidden source is EACCES, and a
// recursive copy stays out of managed territory (ENOTSUP).

const calls = { upper: 0, wrap: 0 };
const PREPARERS = {
  upper: (raw) => {
    calls.upper++;
    return raw.toString().toUpperCase();
  },
  wrap: (raw) => {
    calls.wrap++;
    return `[${raw.toString()}]`;
  },
  mark: (raw) => `marked:${raw.toString()}`,
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

// Calls `fn(callback)`; resolves with every call the callback received, once
// the event loop has had a chance to deliver a second one.
const callbackCalls = (fn) =>
  new Promise((resolve) => {
    const received = [];
    fn((...args) => {
      received.push(args);
      if (received.length === 1) setImmediate(() => resolve(received));
    });
  });

// A refusal names the operation, its source and its destination.
const refusal = (err, code, syscall, from, to) => {
  assert.equal(err.code, code, err.message ?? String(err));
  assert.equal(err.syscall, syscall);
  assert.equal(err.path, from);
  assert.equal(err.dest, to);
};

// Each form of each copy: resolves 'ok' or the error it failed with.
const COPIES = {
  copyFileSync: (from, to) => fs.copyFileSync(from, to),
  copyFile: (from, to) =>
    new Promise((resolve, reject) => {
      fs.copyFile(from, to, (err) => (err ? reject(err) : resolve()));
    }),
  'promises.copyFile': (from, to) => fs.promises.copyFile(from, to),
  cpSync: (from, to) => fs.cpSync(from, to),
  cp: (from, to) =>
    new Promise((resolve, reject) => {
      fs.cp(from, to, (err) => (err ? reject(err) : resolve()));
    }),
  'promises.cp': (from, to) => fs.promises.cp(from, to),
};

const syscallOf = (form) => (form.includes('copyFile') ? 'copyfile' : 'cp');

describe('single-file copies hand the raw input to the destination', () => {
  let base;
  let root;
  let out;
  let k;
  let n = 0;
  const at = (...p) => path.join(root, ...p);
  const fresh = (name = 'f.txt') => path.join(out, `${++n}-${name}`);
  const external = (content = 'x') => {
    const file = fresh('raw.txt');
    writeDisk(file, content);
    return file;
  };

  // Every form refuses with `code`, names both paths and leaves no file.
  const refusedEverywhere = async (from, to, code) => {
    for (const [form, copy] of Object.entries(COPIES)) {
      const err = await outcome(() => copy(from, to));
      refusal(err, code, syscallOf(form), from, to);
      assert.equal(onDisk(to), false, `${form}: nothing written`);
    }
  };

  before(async () => {
    base = writeTree(tmpDir('vfs-copy'), {
      'app/prep/a.txt': 'hello',
      'app/wd/keep.txt': 'keep',
      'app/ro/keep.txt': 'keep',
      'app/site/index.html': '<h1>index</h1>',
      'app/site/logo.png': 'PNG',
      'app/site/media/clip.mp4': 'MP4',
      'app/closed/index.html': '<h1>',
      'app/closed/logo.png': 'hidden',
      'app/zip/big.txt': 'raw text '.repeat(20),
      'app/stray/s.txt': 'stray',
    });
    root = path.join(base, 'app');
    out = tmpDir('vfs-copy-out');
    const gzip = { encodings: ['gzip'] };
    k = await kernel(
      root,
      {
        prep: { fs: { ext: ['txt'], prepare: 'upper' } },
        wd: { fs: { ext: ['txt'], writable: true, prepare: 'mark' } },
        ro: { fs: { ext: ['txt'] } },
        site: {
          fs: {
            ext: ['html'],
            fallback: 'disk',
            compress: { ...gzip, ext: ['html'] },
          },
        },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        zip: {
          fs: { ext: ['txt'], compress: { ...gzip, retainRaw: false } },
        },
        vs: { origin: 'virtual', fs: { writable: true, compress: gzip } },
        vp: {
          origin: 'virtual',
          fs: { writable: true, ext: ['txt'], prepare: 'wrap', compress: gzip },
        },
        vf: {
          origin: 'virtual',
          fs: { writable: true, ext: ['txt'], prepare: 'boom' },
        },
        vm: {
          provider: 'map',
          origin: 'virtual',
          fs: { writable: true, ext: ['txt'], prepare: 'wrap' },
        },
        vmp: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true, watch: true, watchTimeout: 60000 },
      { preparers: PREPARERS },
    );
    // A cached extension written after the scan: never published.
    writeDisk(at('site', 'late.html'), 'unpublished');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(base);
    rm(out);
  });

  it('A: external → external stays node:fs', async () => {
    for (const [form, copy] of Object.entries(COPIES)) {
      const to = fresh();
      assert.equal(await outcome(() => copy(external('A'), to)), 'ok', form);
      assert.equal(readDisk(to, 'utf8'), 'A');
    }
  });

  it('B: external → a disk-origin place: raw on disk, its watcher prepares it', async () => {
    const to = at('wd', 'b.txt');
    fs.copyFileSync(external('b'), to);
    assert.equal(readDisk(to, 'utf8'), 'b', 'the raw bytes on disk');
    k.watcher.emit('epoch', new Map([[to, 'change']]));
    await k.watchQueue.idle;
    assert.equal(fs.readFileSync(to, 'utf8'), 'marked:b');
  });

  it('C: external → sab + virtual: published through its store, no file on disk', async () => {
    const to = at('vp', 'c.txt');
    const before = calls.wrap;
    await fs.promises.copyFile(external('c'), to);
    assert.equal(k.fs('vp').readFile('/c.txt', 'utf8'), '[c]');
    assert.equal(calls.wrap, before + 1, 'the destination prepares once');
    assert.equal(onDisk(to), false, 'no shadow file');
    // A shared virtual place mutates asynchronously: *Sync forms refuse.
    const sync = await outcome(() => fs.copyFileSync(external(), to));
    refusal(sync, 'ENOTSUP', 'copyfile', sync.path, to);
  });

  it('D: external → map + virtual: published locally, no file on disk', () => {
    const to = at('vm', 'd.txt');
    fs.copyFileSync(external('d'), to);
    assert.equal(k.fs('vm').readFile('/d.txt', 'utf8'), '[d]');
    assert.equal(onDisk(to), false, 'no shadow file');
  });

  it('E: a prepared disk-origin source copies its raw disk file', () => {
    const from = at('prep', 'a.txt');
    assert.equal(fs.readFileSync(from, 'utf8'), 'HELLO', 'canonical');
    const to = fresh();
    fs.copyFileSync(from, to);
    assert.equal(readDisk(to, 'utf8'), 'hello', 'raw');
  });

  it('F: a prepared disk-origin source into a virtual place is prepared once, by the destination', async () => {
    const upper = calls.upper;
    const wrap = calls.wrap;
    await fs.promises.copyFile(at('prep', 'a.txt'), at('vp', 'f.txt'));
    assert.equal(k.fs('vp').readFile('/f.txt', 'utf8'), '[hello]');
    assert.equal(calls.upper, upper, 'the source preparer never runs again');
    assert.equal(calls.wrap, wrap + 1);
  });

  it('G / H: an ordinary virtual source is its own raw input', async () => {
    await k.fs('vs').writeFile('/v.txt', 'virtual');
    k.fs('vmp').writeFile('/m.txt', 'local');
    const outside = fresh();
    fs.copyFileSync(at('vs', 'v.txt'), outside);
    assert.equal(readDisk(outside, 'utf8'), 'virtual');
    fs.copyFileSync(at('vmp', 'm.txt'), fresh());
    await fs.promises.copyFile(at('vs', 'v.txt'), at('vp', 'h.txt'));
    assert.equal(k.fs('vp').readFile('/h.txt', 'utf8'), '[virtual]');
    fs.copyFileSync(at('vmp', 'm.txt'), at('vm', 'h.txt'));
    assert.equal(k.fs('vm').readFile('/h.txt', 'utf8'), '[local]');
  });

  it('I: a prepared virtual source has no raw input left', async () => {
    await k.fs('vp').writeFile('/p.txt', 'p');
    const wrap = calls.wrap;
    await refusedEverywhere(at('vp', 'p.txt'), fresh(), 'ENOTSUP');
    const into = await outcome(() =>
      fs.promises.copyFile(at('vp', 'p.txt'), at('vm', 'p.txt')),
    );
    refusal(into, 'ENOTSUP', 'copyfile', at('vp', 'p.txt'), at('vm', 'p.txt'));
    assert.equal(k.fs('vm').exists('/p.txt'), false, 'nothing published');
    assert.equal(calls.wrap, wrap, 'nothing prepared twice');
  });

  it('J: a hidden source is EACCES before anything is read or written', async () => {
    for (const from of [
      at('site', 'late.html'),
      at('stray', 's.txt'),
      at('closed', 'logo.png'),
    ]) {
      await refusedEverywhere(from, fresh(), 'EACCES');
    }
    const into = await outcome(() =>
      fs.promises.copyFile(at('site', 'late.html'), at('vs', 'late.html')),
    );
    refusal(into, 'EACCES', 'copyfile', at('site', 'late.html'), into.dest);
    assert.equal(k.fs('vs').exists('/late.html'), false);
  });

  it('K: a read-only or refused destination gets nothing', async () => {
    const from = external();
    for (const [to, code] of [
      [at('ro', 'new.txt'), 'EROFS'],
      [at('stray', 'new.txt'), 'EACCES'],
      [root, 'EACCES'],
    ]) {
      for (const [form, copy] of Object.entries(COPIES)) {
        refusal(
          await outcome(() => copy(from, to)),
          code,
          syscallOf(form),
          from,
          to,
        );
      }
    }
    assert.equal(onDisk(at('ro', 'new.txt')), false);
    assert.equal(onDisk(at('stray', 'new.txt')), false);
  });

  it('a failed destination preparation publishes nothing', async () => {
    const to = at('vf', 'x.txt');
    await assert.rejects(fs.promises.copyFile(external(), to), /boom/);
    assert.equal(k.fs('vf').exists('/x.txt'), false);
    assert.equal(onDisk(to), false);
  });

  it("a virtual destination's publication reaches the workers", async () => {
    const w = worker(k);
    try {
      const applied = nextMessage(w.main);
      await fs.promises.copyFile(external('shared'), at('vs', 'w.txt'));
      await applied;
      assert.equal(w.kernel.fs('vs').readFile('/w.txt', 'utf8'), 'shared');
    } finally {
      w.kernel.close();
    }
  });

  it('every form copies through the destination; a callback runs once', async () => {
    for (const [form, copy] of Object.entries(COPIES)) {
      const key = `/${form}.txt`;
      await copy(external(form), at('vmp', key.slice(1)));
      assert.equal(k.fs('vmp').readFile(key, 'utf8'), form);
      await copy(at('vmp', key.slice(1)), fresh());
    }
    const viaCopyFile = await callbackCalls((cb) =>
      fs.copyFile(external(), at('vmp', 'once.txt'), cb),
    );
    assert.equal(viaCopyFile.length, 1);
    assert.equal(viaCopyFile[0][0], null);
    const viaCp = await callbackCalls((cb) =>
      fs.cp(at('vp', 'p.txt'), fresh(), cb),
    );
    assert.equal(viaCp.length, 1);
    assert.equal(viaCp[0][0].code, 'ENOTSUP');
  });

  it('options: EXCL, force and errorOnExist; unsupported ones are refused', async () => {
    const from = external('new');
    const store = at('vmp', 'o.txt');
    const native = fresh();
    for (const to of [store, native]) {
      fs.copyFileSync(at('vs', 'v.txt'), to);
      refusal(
        await outcome(() => fs.copyFileSync(from, to, COPYFILE_EXCL)),
        'EEXIST',
        'copyfile',
        from,
        to,
      );
    }
    // cp: `force` (the default) replaces an existing file whatever the mode,
    // as node:fs does; force: false leaves it alone, errorOnExist reports it.
    for (const to of [store, native]) {
      await fs.promises.cp(from, to, { mode: COPYFILE_EXCL });
      fs.copyFileSync(at('vs', 'v.txt'), to);
    }
    assert.equal(readDisk(native, 'utf8'), 'virtual');
    fs.cpSync(from, store, { force: false });
    fs.cpSync(from, native, { force: false });
    assert.equal(k.fs('vmp').readFile('/o.txt', 'utf8'), 'virtual');
    assert.equal(readDisk(native, 'utf8'), 'virtual');
    const exists = await outcome(() =>
      fs.promises.cp(from, store, { force: false, errorOnExist: true }),
    );
    refusal(exists, 'ERR_FS_CP_EEXIST', 'cp', from, store);
    // A clone that may fall back to a copy is a copy.
    fs.copyFileSync(from, store, COPYFILE_FICLONE);
    assert.equal(k.fs('vmp').readFile('/o.txt', 'utf8'), 'new');
    for (const [run, detail] of [
      [() => fs.copyFileSync(from, store, COPYFILE_FICLONE_FORCE), 'FICLONE'],
      [() => fs.cpSync(from, store, { filter: () => true }), 'filter'],
      [() => fs.cpSync(from, store, { preserveTimestamps: true }), 'preserve'],
    ]) {
      const err = await outcome(run);
      assert.equal(err.code, 'ENOTSUP', detail);
      assert.match(err.message, new RegExp(detail));
    }
  });

  it('compression: a companion is never copied as content', async () => {
    // A disk-origin source: the raw disk file, not its gzip companion.
    assert.ok(k.fs('site').storedEncodings('/index.html').includes('gzip'));
    const html = fresh('i.html');
    fs.copyFileSync(at('site', 'index.html'), html);
    assert.equal(readDisk(html, 'utf8'), '<h1>index</h1>');
    // retainRaw: false keeps only gzip in memory; the raw file is on disk.
    assert.deepEqual(k.fs('zip').storedEncodings('/big.txt'), ['gzip']);
    const big = fresh();
    fs.copyFileSync(at('zip', 'big.txt'), big);
    assert.equal(readDisk(big, 'utf8'), 'raw text '.repeat(20));
    // retainRaw: true on an ordinary virtual entry: its canonical bytes.
    await k.fs('vs').writeFile('/g.txt', 'gzip me');
    assert.ok(k.fs('vs').storedEncodings('/g.txt').includes('gzip'));
    const plain = fresh();
    fs.copyFileSync(at('vs', 'g.txt'), plain);
    assert.equal(readDisk(plain, 'utf8'), 'gzip me');
    // A prepared virtual entry stays without raw input, compressed or not.
    assert.ok(k.fs('vp').storedEncodings('/p.txt').includes('gzip'));
    refusal(
      await outcome(() => fs.copyFileSync(at('vp', 'p.txt'), fresh())),
      'ENOTSUP',
      'copyfile',
      at('vp', 'p.txt'),
      path.join(out, `${n}-f.txt`),
    );
    // A virtual place cannot drop its raw source: there is none on disk.
    assert.throws(
      () =>
        new VfsConfig({
          places: {
            v: {
              origin: 'virtual',
              fs: {
                writable: true,
                compress: { ...{ encodings: ['gzip'] }, retainRaw: false },
              },
            },
          },
        }),
      /retainRaw: false requires origin "disk"/,
    );
  });

  it('a guarded mutation of a virtual place is still refused', () => {
    assert.throws(() => fs.truncateSync(at('vmp', 'o.txt'), 0), {
      code: 'ENOTSUP',
    });
    assert.equal(k.fs('vmp').readFile('/o.txt', 'utf8'), 'new');
  });
});

describe('recursive copies stay out of managed territory', () => {
  let base;
  let root;
  let out;
  let k;
  let n = 0;
  const at = (...p) => path.join(root, ...p);
  const fresh = () => path.join(out, `tree-${++n}`);
  const RECURSIVE = { recursive: true };
  const FORMS = {
    cpSync: (from, to, options) => fs.cpSync(from, to, options),
    cp: (from, to, options) =>
      new Promise((resolve, reject) => {
        fs.cp(from, to, options, (err) => (err ? reject(err) : resolve()));
      }),
    promises: (from, to, options) => fs.promises.cp(from, to, options),
  };

  const refused = async (from, to, code = 'ENOTSUP') => {
    for (const [form, cp] of Object.entries(FORMS)) {
      const err = await outcome(() => cp(from, to, RECURSIVE));
      refusal(err, code, 'cp', from, to);
      assert.equal(onDisk(to), false, `${form}: nothing copied`);
    }
  };

  before(async () => {
    base = writeTree(tmpDir('vfs-tree'), {
      'app/site/index.html': '<h1>',
      'app/site/media/clip.mp4': 'MP4',
      'app/closed/index.html': '<h1>',
      'app/wd/keep.txt': 'keep',
      'src/a.txt': 'a',
      'src/sub/b.txt': 'b',
    });
    root = path.join(base, 'app');
    out = tmpDir('vfs-tree-out');
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html'], fallback: 'disk' } },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        wd: { fs: { ext: ['txt'], writable: true } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
    );
    k.fs('mem').writeFile('/v.txt', 'virtual');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(base);
    rm(out);
  });

  it('a managed source, or a tree that holds places, is refused', async () => {
    for (const from of [
      at('site'),
      at('site', 'media'),
      at('closed'),
      at('mem'),
      root,
      base,
    ]) {
      await refused(from, fresh());
    }
  });

  it('a managed destination is refused; the strict appRoot is denied', async () => {
    const src = path.join(base, 'src');
    await refused(src, at('wd', 'copy'));
    // Existing trees that hold places: nothing is written into them.
    const into = [
      [base, 'ENOTSUP'],
      [root, 'EACCES'],
    ];
    for (const [dest, code] of into) {
      for (const [form, cp] of Object.entries(FORMS)) {
        const err = await outcome(() => cp(src, dest, RECURSIVE));
        refusal(err, code, 'cp', src, dest);
        assert.equal(onDisk(path.join(dest, 'a.txt')), false, form);
      }
    }
  });

  it('unrelated trees stay node:fs', async () => {
    const src = path.join(base, 'src');
    for (const [form, cp] of Object.entries(FORMS)) {
      const to = fresh();
      assert.equal(await outcome(() => cp(src, to, RECURSIVE)), 'ok', form);
      assert.equal(readDisk(path.join(to, 'sub', 'b.txt'), 'utf8'), 'b');
    }
  });
});

describe('hard links stay out of the places', () => {
  let base;
  let root;
  let out;
  let k;
  let n = 0;
  const at = (...p) => path.join(root, ...p);
  const fresh = () => path.join(out, `link-${++n}`);
  const FORMS = {
    linkSync: (from, to) => fs.linkSync(from, to),
    link: (from, to) =>
      new Promise((resolve, reject) => {
        fs.link(from, to, (err) => (err ? reject(err) : resolve()));
      }),
    promises: (from, to) => fs.promises.link(from, to),
  };

  before(async () => {
    base = writeTree(tmpDir('vfs-link'), {
      'app/site/index.html': '<h1>',
      'app/site/logo.png': 'PNG',
      'app/wd/keep.txt': 'keep',
      'src/a.txt': 'a',
    });
    root = path.join(base, 'app');
    out = tmpDir('vfs-link-out');
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html'], fallback: 'disk' } },
        wd: { fs: { ext: ['txt'], writable: true } },
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
    rm(out);
  });

  it('a managed source or destination is ENOTSUP; a hidden source EACCES', async () => {
    const outside = path.join(base, 'src', 'a.txt');
    for (const [from, to, code] of [
      [at('site', 'index.html'), fresh(), 'ENOTSUP'],
      [at('site', 'logo.png'), fresh(), 'ENOTSUP'],
      [outside, at('wd', 'l.txt'), 'ENOTSUP'],
      [at('site', 'late.html'), fresh(), 'EACCES'],
    ]) {
      for (const [form, link] of Object.entries(FORMS)) {
        refusal(await outcome(() => link(from, to)), code, 'link', from, to);
        assert.equal(onDisk(to), false, form);
      }
    }
  });

  it('unrelated files stay node:fs', async () => {
    const outside = path.join(base, 'src', 'a.txt');
    for (const [form, link] of Object.entries(FORMS)) {
      const to = fresh();
      assert.equal(await outcome(() => link(outside, to)), 'ok', form);
      assert.equal(readDisk(to, 'utf8'), 'a');
    }
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
      'site/media/clip.mp4': 'MP4',
      'wd/keep.txt': 'keep',
      'mem/shadow/x.txt': 'on disk under a virtual place',
      'loose/l.txt': 'l',
    });
    out = tmpDir('vfs-copy-loose-out');
    k = await kernel(root, {
      site: { fs: { ext: ['html'] } },
      wd: { fs: { ext: ['txt'], writable: true } },
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

  it('recursive copies of managed territory are refused in this mode too', async () => {
    // A directory the place does not index — raw files of extensions it does
    // not cache, a directory on disk under a virtual place — is still its
    // territory, as a source or as a destination.
    const RECURSIVE = { recursive: true };
    const sources = [
      at('site'),
      at('site', 'media'),
      at('mem'),
      at('mem', 'shadow'),
      root,
    ];
    for (const src of sources) {
      const dest = path.join(out, `x-${path.basename(src)}`);
      const err = await outcome(() => fs.promises.cp(src, dest, RECURSIVE));
      refusal(err, 'ENOTSUP', 'cp', src, dest);
      assert.equal(onDisk(dest), false);
    }
    for (const dest of [at('wd', 'copy'), at('wd')]) {
      const err = await outcome(() =>
        fs.promises.cp(at('loose'), dest, RECURSIVE),
      );
      refusal(err, 'ENOTSUP', 'cp', at('loose'), dest);
      assert.equal(onDisk(path.join(dest, 'l.txt')), false);
    }
  });

  it('files copy their raw input; unmanaged trees stay native', () => {
    const page = path.join(out, 'index.html');
    fs.copyFileSync(at('site', 'index.html'), page);
    assert.equal(readDisk(page, 'utf8'), '<h1>');
    const tree = path.join(out, 'loose');
    fs.cpSync(at('loose'), tree, { recursive: true });
    assert.equal(readDisk(path.join(tree, 'l.txt'), 'utf8'), 'l');
    // Without strict an unpublished file reads from disk: it copies so too.
    const raw = path.join(out, 'late.html');
    fs.cpSync(at('site', 'late.html'), raw);
    assert.equal(readDisk(raw, 'utf8'), 'unpublished');
  });
});
