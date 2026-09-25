'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// Disk edits behind the VFS's back: captured before any patch is installed.
const { writeFileSync: writeDisk } = fs;

// Listing names in the requested encoding: every listing (projection, disk
// territory, their merge, the managed appRoot; readdir in each form and
// opendir) sorts and deduplicates the string names, then encodes them —
// 'buffer' gives Buffer names, in the same order as the strings.
//
// Native node:fs (22.22.3 … 26.x) fails `recursive` with `encoding:
// 'buffer'` (ERR_INVALID_ARG_TYPE; the callback form of readdir crashes the
// process). The documented contract has no such exception, and the places
// keep it: a recursive listing gives Buffer names too.

const decoded = (list) =>
  list.map((name) => {
    assert.ok(Buffer.isBuffer(name), `${name} is a Buffer`);
    return name.toString();
  });

const direntsOf = (list) =>
  list.map((entry) => [
    Buffer.isBuffer(entry.name) ? `B:${entry.name}` : entry.name,
    entry.parentPath,
    entry.isFile(),
    entry.isDirectory(),
    entry.isSymbolicLink(),
  ]);

const viaCallback = (p, options) =>
  new Promise((resolve, reject) => {
    fs.readdir(p, options, (err, list) => (err ? reject(err) : resolve(list)));
  });

describe('listing names follow the requested encoding', () => {
  let root;
  let outside;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-encoding'), {
      'site/index.html': '<h1>',
      'site/é.html': 'e',
      'site/logo.png': 'PNG',
      'site/ж.png': 'zh',
      'site/media/звук.mp3': 'mp3',
      'site/sub/page.html': 'page',
      'closed/index.html': '<h1>',
      'closed/ü.png': 'hidden',
      'stray/x.txt': 'stray',
    });
    outside = writeTree(tmpDir('vfs-encoding-out'), { 'é.txt': 'e' });
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html', 'js'], fallback: 'disk' } },
        closed: { fs: { ext: ['html'], fallback: 'deny' } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
    );
    writeDisk(at('site', 'late.html'), 'unpublished');
    k.fs('mem').writeFile('/ö/ü.txt', 'u');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
    rm(outside);
  });

  // Every kind of listing: VFS + disk merge, disk-only nested, projection
  // only, virtual (nested, non-ASCII), the managed appRoot.
  const DIRS = [
    ['site'],
    ['site', 'media'],
    ['site', 'sub'],
    ['closed'],
    ['mem'],
    ['mem', 'ö'],
    [],
  ];

  it('readdirSync: Buffer names in the order of the strings, no duplicates', () => {
    assert.deepEqual(fs.readdirSync(at('site')), [
      'index.html',
      'logo.png',
      'media',
      'sub',
      'é.html',
      'ж.png',
    ]);
    for (const dir of DIRS.map((p) => at(...p))) {
      const strings = fs.readdirSync(dir);
      assert.equal(new Set(strings).size, strings.length, dir);
      assert.deepEqual(decoded(fs.readdirSync(dir, 'buffer')), strings, dir);
      assert.deepEqual(
        decoded(fs.readdirSync(dir, { encoding: 'buffer' })),
        strings,
      );
      assert.deepEqual(fs.readdirSync(dir, { encoding: 'utf8' }), strings);
      const hex = fs.readdirSync(dir, 'hex');
      assert.deepEqual(
        hex,
        strings.map((name) => Buffer.from(name).toString('hex')),
      );
    }
    assert.deepEqual(
      fs.readdirSync(at('site'), 'buffer')[4],
      Buffer.from('é.html'),
    );
  });

  it('withFileTypes: Buffer names, the rest of each Dirent unchanged', () => {
    for (const dir of DIRS.map((p) => at(...p))) {
      const strings = fs.readdirSync(dir, { withFileTypes: true });
      const buffers = fs.readdirSync(dir, {
        withFileTypes: true,
        encoding: 'buffer',
      });
      assert.deepEqual(decoded(buffers.map((entry) => entry.name)), [
        ...strings.map((entry) => entry.name),
      ]);
      assert.deepEqual(
        direntsOf(buffers),
        direntsOf(strings).map(([name, ...rest]) => [`B:${name}`, ...rest]),
      );
      const utf8 = fs.readdirSync(dir, {
        withFileTypes: true,
        encoding: 'utf8',
      });
      assert.ok(utf8.every((entry) => typeof entry.name === 'string'));
    }
  });

  it('callback and promises forms give the same Buffer listings', async () => {
    for (const dir of DIRS.map((p) => at(...p))) {
      const strings = fs.readdirSync(dir);
      const options = { withFileTypes: true, encoding: 'buffer' };
      const sync = direntsOf(fs.readdirSync(dir, options));
      const called = await viaCallback(dir, options);
      assert.deepEqual(decoded(called.map((entry) => entry.name)), strings);
      assert.deepEqual(direntsOf(called), sync);
      const promised = await fs.promises.readdir(dir, options);
      assert.deepEqual(direntsOf(promised), sync);
      assert.deepEqual(decoded(await viaCallback(dir, 'buffer')), strings);
      assert.deepEqual(
        decoded(await fs.promises.readdir(dir, 'buffer')),
        strings,
      );
    }
  });

  it('recursive listings encode every name, parent paths stay strings', async () => {
    const strings = fs.readdirSync(at('site'), { recursive: true });
    assert.deepEqual(strings, [
      'index.html',
      'logo.png',
      'media',
      'media/звук.mp3',
      'sub',
      'sub/page.html',
      'é.html',
      'ж.png',
    ]);
    const options = { recursive: true, encoding: 'buffer' };
    assert.deepEqual(decoded(fs.readdirSync(at('site'), options)), strings);
    assert.deepEqual(decoded(await viaCallback(at('site'), options)), strings);
    const typed = { ...options, withFileTypes: true };
    const entries = await fs.promises.readdir(at('site'), typed);
    assert.deepEqual(
      direntsOf(entries),
      direntsOf(
        fs.readdirSync(at('site'), { recursive: true, withFileTypes: true }),
      ).map(([name, ...rest]) => [`B:${name}`, ...rest]),
    );
    const top = fs.readdirSync(root, { recursive: true, encoding: 'buffer' });
    assert.deepEqual(decoded(top), fs.readdirSync(root, { recursive: true }));
  });

  it('opendir: read() and async iteration give the readdir Dirents', async () => {
    for (const dir of DIRS.map((p) => at(...p))) {
      const expected = direntsOf(
        fs.readdirSync(dir, { withFileTypes: true, encoding: 'buffer' }),
      );
      const handle = await fs.promises.opendir(dir, { encoding: 'buffer' });
      const read = [];
      for (
        let entry = await handle.read();
        entry;
        entry = await handle.read()
      ) {
        read.push(entry);
      }
      await handle.close();
      assert.deepEqual(direntsOf(read), expected);
      const iterated = [];
      for await (const entry of fs.opendirSync(dir, 'buffer')) {
        iterated.push(entry);
      }
      assert.deepEqual(direntsOf(iterated), expected);
      const strings = fs.opendirSync(dir, { encoding: 'utf8' });
      assert.equal(typeof strings.readSync().name, 'string');
      strings.closeSync();
    }
    const nested = fs.opendirSync(at('mem'), {
      recursive: true,
      encoding: 'buffer',
    });
    const names = [];
    for (let entry = nested.readSync(); entry; entry = nested.readSync()) {
      names.push([entry.name.toString(), entry.parentPath]);
    }
    nested.closeSync();
    assert.deepEqual(names, [
      ['ö', at('mem')],
      ['ü.txt', at('mem', 'ö')],
    ]);
  });

  it('the PlaceFs facade takes the same options, an encoding string too', () => {
    const site = k.fs('site');
    const strings = site.readdir('/');
    assert.deepEqual(decoded(site.readdir('/', 'buffer')), strings);
    assert.deepEqual(
      decoded(site.readdir('/', { encoding: 'buffer' })),
      strings,
    );
    assert.deepEqual(site.readdir('/', null), strings);
  });

  it('outside appRoot stays node:fs', () => {
    const [entry] = fs.readdirSync(outside, {
      withFileTypes: true,
      encoding: 'buffer',
    });
    assert.ok(entry instanceof fs.Dirent);
    assert.deepEqual(entry.name, Buffer.from('é.txt'));
  });
});
