'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// Disk edits behind the VFS's back: captured before any patch is installed.
const { writeFileSync: writeDisk, unlinkSync: unlinkDisk } = fs;

// glob keeps the node:fs functions it walks with from its first use. Use it
// now, before the patch: its walk stays native and every result reaches the
// patch's filter unfiltered — the case that filter has to hold alone.
fs.globSync('*', { cwd: __dirname });

// opendir lists the same filtered territory as readdir: published entries
// from the VFS, plus the directories and uncached files of an
// `fs.fallback: 'disk'` place from the disk — never an unpublished file of
// a cached extension, a companion or an unmanaged sibling. Outside appRoot
// it stays node:fs.

const drain = async (dir) => {
  const entries = [];
  for await (const entry of dir) entries.push(entry);
  return entries;
};

const drainSync = (dir) => {
  const entries = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      entries.push(entry);
    }
  } finally {
    dir.closeSync();
  }
  return entries;
};

const names = (entries) => entries.map((entry) => entry.name);

// '/'-separated path of each entry relative to `base`.
const within = (base, entries) =>
  entries.map((entry) => {
    const at = path.join(entry.parentPath, entry.name);
    return path.relative(base, at).split(path.sep).join('/');
  });

const slashed = (list) => list.map((p) => String(p).split(path.sep).join('/'));

describe('opendir: the filtered territory of readdir', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  // The site tree as every listing must show it.
  const SITE = [
    'app.js',
    'index.html',
    'logo.png',
    'media',
    'media/clip.mp4',
    'media/deep',
    'media/deep/frame.png',
    'new.png',
    'sub',
    'sub/page.html',
  ];

  before(async () => {
    root = writeTree(tmpDir('vfs-opendir'), {
      'site/index.html': '<h1>',
      'site/app.js': 'js',
      'site/logo.png': 'PNG',
      'site/media/clip.mp4': 'MP4',
      'site/media/deep/frame.png': 'frame',
      'site/sub/page.html': 'page',
      'closed/index.html': '<h1>',
      'closed/logo.png': 'PNG',
      'stray/x.png': 'stray',
      'off/x.html': 'x',
    });
    outside = writeTree(tmpDir('vfs-opendir-out'), {
      'a.txt': 'a',
      'b/c.txt': 'c',
    });
    k = await kernel(
      root,
      {
        site: {
          fs: {
            ext: ['html', 'js'],
            fallback: 'disk',
            compress: { encodings: ['gzip'], ext: ['html'] },
          },
        },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
        off: { enabled: false, fs: true },
      },
      { strict: true },
    );
    // Cached extensions written after the scan: never published.
    writeDisk(at('site', 'late.html'), 'late');
    writeDisk(at('site', 'media', 'raw.html'), 'raw');
    writeDisk(at('site', 'media', 'deep', 'raw.js'), 'raw');
    // Published, then gone from disk: listed from the VFS.
    unlinkDisk(at('site', 'app.js'));
    // Uncached and new on disk: listed from the disk.
    writeDisk(at('site', 'new.png'), 'PNG');
    k.fs('mem').writeFile('/m.txt', 'm');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  });

  it('strict + fallback: disk — the same entries as readdir, nothing else', async () => {
    const listed = fs.readdirSync(at('site'));
    assert.deepEqual(listed, [
      'app.js',
      'index.html',
      'logo.png',
      'media',
      'new.png',
      'sub',
    ]);
    const entries = await drain(await fs.promises.opendir(at('site')));
    assert.deepEqual(names(entries), listed);
    assert.deepEqual(
      entries.filter((entry) => entry.isDirectory()).map((e) => e.name),
      ['media', 'sub'],
    );
    assert.ok(entries.every((entry) => entry.parentPath === at('site')));
    assert.deepEqual(k.fs('site').storedEncodings('/index.html'), [
      'raw',
      'gzip',
    ]);
    assert.ok(names(entries).every((name) => !name.includes('\0')));
  });

  it('a nested disk-only directory keeps the filter at every level', async () => {
    const walk = (dir) => {
      const found = [];
      for (const entry of drainSync(fs.opendirSync(dir))) {
        const child = path.join(entry.parentPath, entry.name);
        found.push(child);
        if (entry.isDirectory()) found.push(...walk(child));
      }
      return found;
    };
    const site = at('site');
    const relative = (list) =>
      list.map((p) => path.relative(site, p).split(path.sep).join('/'));
    assert.deepEqual(relative(walk(site)).sort(), SITE);
    assert.deepEqual(
      within(site, drainSync(fs.opendirSync(site, { recursive: true }))),
      SITE,
    );
    const recursive = await fs.promises.opendir(site, { recursive: true });
    assert.deepEqual(within(site, await drain(recursive)), SITE);
    assert.deepEqual(fs.readdirSync(site, { recursive: true }), SITE);
    assert.deepEqual(names(drainSync(fs.opendirSync(at('site', 'media')))), [
      'clip.mp4',
      'deep',
    ]);
  });

  it('the managed appRoot lists the enabled places only', async () => {
    const entries = await drain(await fs.promises.opendir(root));
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.isDirectory()]),
      [
        ['closed', true],
        ['mem', true],
        ['site', true],
      ],
    );
    const tree = within(
      root,
      drainSync(fs.opendirSync(root, { recursive: true })),
    );
    assert.deepEqual(tree, fs.readdirSync(root, { recursive: true }));
    assert.deepEqual(
      tree.filter((rel) => rel.startsWith('site/')),
      SITE.map((rel) => `site/${rel}`),
    );
    for (const unmanaged of ['stray', 'off']) {
      assert.throws(() => fs.opendirSync(at(unmanaged)), {
        code: 'EACCES',
        syscall: 'opendir',
      });
    }
  });

  it("fallback: 'deny' and virtual places list their projection only", async () => {
    const closed = await drain(await fs.promises.opendir(at('closed')));
    assert.deepEqual(names(closed), ['index.html']);
    assert.deepEqual(names(drainSync(fs.opendirSync(at('mem')))), ['m.txt']);
  });

  it('outside appRoot stays node:fs', async () => {
    const native = fs.opendirSync(outside);
    assert.ok(native instanceof fs.Dir);
    assert.deepEqual(names(drainSync(native)).sort(), ['a.txt', 'b']);
    const viaPromise = await fs.promises.opendir(outside);
    assert.ok(viaPromise instanceof fs.Dir);
    await viaPromise.close();
    const managed = fs.opendirSync(at('site'));
    assert.ok(!(managed instanceof fs.Dir));
    managed.closeSync();
  });

  // One sequence after close(), run on a native handle and a managed one.
  const afterClose = async (dir) => {
    const sync = (fn) => {
      try {
        fn();
        return 'ok';
      } catch (err) {
        return err.code;
      }
    };
    const settled = (promise) =>
      promise.then(
        () => 'ok',
        (err) => err.code,
      );
    return [
      sync(() => dir.closeSync()),
      sync(() => dir.readSync()),
      await settled(dir.read()),
      sync(() => dir.read(() => {})),
      sync(() => dir.closeSync()),
      await settled(dir.close()),
      await new Promise((resolve) => {
        dir.close((err) => resolve(err ? err.code : 'ok'));
      }),
      sync(() => dir[Symbol.dispose]()),
      await settled(dir[Symbol.asyncDispose]()),
    ];
  };

  it('close, read after close and disposal follow node:fs', async () => {
    const native = await afterClose(fs.opendirSync(outside));
    assert.deepEqual(native, [
      'ok',
      'ERR_DIR_CLOSED',
      'ERR_DIR_CLOSED',
      'ERR_DIR_CLOSED',
      'ERR_DIR_CLOSED',
      'ERR_DIR_CLOSED',
      'ERR_DIR_CLOSED',
      'ok',
      'ok',
    ]);
    assert.deepEqual(await afterClose(fs.opendirSync(at('site'))), native);
    // Disposal closes an open handle, once.
    const disposed = fs.opendirSync(at('site'));
    disposed[Symbol.dispose]();
    assert.throws(() => disposed.readSync(), { code: 'ERR_DIR_CLOSED' });
    const asyncDisposed = await fs.promises.opendir(at('site'));
    await asyncDisposed[Symbol.asyncDispose]();
    await asyncDisposed[Symbol.asyncDispose]();
    assert.throws(() => asyncDisposed.readSync(), { code: 'ERR_DIR_CLOSED' });
  });

  it('async iteration closes the handle, also when left early', async () => {
    const dir = await fs.promises.opendir(at('site'));
    assert.deepEqual(names(await drain(dir)), fs.readdirSync(at('site')));
    assert.throws(() => dir.readSync(), { code: 'ERR_DIR_CLOSED' });
    const early = fs.opendirSync(at('site'));
    for await (const entry of early) {
      assert.equal(entry.name, 'app.js');
      break;
    }
    assert.throws(() => early.readSync(), { code: 'ERR_DIR_CLOSED' });
  });

  it('callback, promise and sync forms', async () => {
    const expected = fs.readdirSync(at('site'));
    const viaCallback = await new Promise((resolve, reject) => {
      fs.opendir(at('site'), (err, dir) => {
        if (err) return void reject(err);
        const found = [];
        const next = () => {
          dir.read((readErr, entry) => {
            if (readErr) return void reject(readErr);
            if (entry === null) {
              return void dir.close((closeErr) => {
                if (closeErr) reject(closeErr);
                else resolve(found);
              });
            }
            found.push(entry.name);
            return void next();
          });
        };
        next();
      });
    });
    assert.deepEqual(viaCallback, expected);

    const viaPromise = await fs.promises.opendir(at('site'), {
      bufferSize: 2,
    });
    assert.equal(viaPromise.path, at('site'));
    const found = [];
    for (let e = await viaPromise.read(); e; e = await viaPromise.read()) {
      found.push(e.name);
    }
    await viaPromise.close();
    assert.deepEqual(found, expected);

    assert.deepEqual(names(drainSync(fs.opendirSync(at('site')))), expected);
    const [first] = drainSync(fs.opendirSync(at('site'), 'buffer'));
    assert.deepEqual(first.name, Buffer.from('app.js'));

    // Errors: thrown, rejected or passed to the callback, as node:fs does.
    assert.throws(() => fs.opendirSync(at('stray')), {
      code: 'EACCES',
      syscall: 'opendir',
    });
    await assert.rejects(fs.promises.opendir(at('site', 'late.html')), {
      code: 'EACCES',
    });
    const viaCallbackErr = await new Promise((resolve) => {
      fs.opendir(at('site', 'logo.png'), (err) => resolve(err));
    });
    assert.equal(viaCallbackErr.code, 'ENOTDIR');
    assert.equal(viaCallbackErr.syscall, 'opendir');
    assert.throws(() => fs.opendirSync(at('site', 'index.html')), {
      code: 'ENOTDIR',
    });
    assert.throws(() => fs.opendirSync(at('site', 'nowhere')), {
      code: 'ENOENT',
      syscall: 'opendir',
    });
  });

  // glob walks natively here (see the top of the file): only the patch's
  // filter stands between its results and the listing rules.
  it('strict glob never yields what the listings hide, whatever its cwd', async () => {
    const hidden = ['late.html', 'raw.html', 'raw.js'];
    const shown = (list) => {
      const rels = slashed(list).map((p) =>
        path.isAbsolute(p) ? slashed([path.relative(root, p)])[0] : p,
      );
      assert.ok(rels.includes('site/index.html'), rels.join());
      assert.ok(rels.includes('site/media/deep/frame.png'), rels.join());
      assert.ok(
        rels.every((rel) => !hidden.includes(path.posix.basename(rel))),
        rels.join(),
      );
      return rels;
    };
    const pattern = 'site/**';
    shown(fs.globSync(pattern, { cwd: root }));
    shown(fs.globSync(path.join(root, pattern).replace(/\\/g, '/')));
    shown(
      fs
        .globSync(pattern, { cwd: root, withFileTypes: true })
        .map((entry) => path.join(entry.parentPath, entry.name)),
    );
    shown(
      await new Promise((resolve, reject) => {
        fs.glob(pattern, { cwd: root }, (err, matches) =>
          err ? reject(err) : resolve(matches),
        );
      }),
    );
    const collected = [];
    for await (const match of fs.promises.glob(pattern, { cwd: root })) {
      collected.push(match);
    }
    shown(collected);
    // At appRoot: the enabled places on disk, never an unmanaged sibling.
    assert.deepEqual(fs.globSync('*', { cwd: root }).sort(), [
      'closed',
      'site',
    ]);
    assert.deepEqual(fs.globSync('*', { cwd: pathToFileURL(root) }).sort(), [
      'closed',
      'site',
    ]);
  });
});
