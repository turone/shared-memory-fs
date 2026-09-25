'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VfsConfig } = require('../lib/config.js');
const { VfsStats } = require('../lib/stats.js');
const fsPatch = require('../lib/adapters/fs-patch.js');
const moduleHook = require('../lib/adapters/module-hook.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// Disk edits behind the VFS's back: captured before any patch is installed.
const { writeFileSync: writeDisk } = fs;

// Strict appRoot as a managed root, and `fs.fallback` — what a disk-origin
// place does with a path it does not serve: 'deny' (published canonical
// entries only) or 'disk' (the files its cache filters do not select are
// served from disk, inside that place only).

const resolved = (places, defaults) =>
  new VfsConfig({ places, defaults }).places.map((p) => p.fs?.fallback);

describe('fs.fallback: config', () => {
  it('is normalized explicitly for disk-origin places, null elsewhere', () => {
    const places = {
      sab: { fs: { ext: ['html'] } },
      map: { provider: 'map', fs: { ext: ['html'] } },
      virtual: { origin: 'virtual', fs: { writable: true } },
      sea: { provider: 'sea', fs: true },
      disk: { provider: 'disk', fs: true },
      nd: { provider: 'node-default', fs: true },
    };
    assert.deepEqual(resolved(places), [
      'disk',
      'disk',
      null,
      null,
      null,
      null,
    ]);
    assert.deepEqual(resolved(places, { strict: true }), [
      'deny',
      'deny',
      null,
      null,
      null,
      null,
    ]);
    assert.deepEqual(
      resolved(
        { a: { fs: { ext: ['html'], fallback: 'disk' } } },
        {
          strict: true,
        },
      ),
      ['disk'],
    );
    assert.deepEqual(
      resolved({ a: { fs: { ext: ['html'], fallback: 'deny' } } }),
      ['deny'],
    );
    const cli = VfsConfig.fromArgv(
      ['node', 'app', '--', '--vfs.defaults.strict=true'],
      { places: { a: { fs: { ext: ['html'] } } } },
    );
    assert.equal(cli.place('a').fs.fallback, 'deny', 'follows the CLI mode');
  });

  it('rejects values and places it cannot apply to', () => {
    const fails = (places, re) =>
      assert.throws(() => new VfsConfig({ places }), re);
    fails(
      { a: { fs: { ext: ['html'], fallback: 'yes' } } },
      /places\.a\.fs\.fallback must be "disk" or "deny", got "yes"/,
    );
    fails(
      { a: { origin: 'virtual', fs: { writable: true, fallback: 'deny' } } },
      /fs\.fallback applies to disk-origin places .* provider "sab", origin "virtual"/,
    );
    fails(
      { a: { provider: 'sea', fs: { fallback: 'deny' } } },
      /provider "sea" has no directory/,
    );
    fails(
      { a: { provider: 'disk', fs: { fallback: 'disk' } } },
      /provider "disk" has no directory/,
    );
    fails(
      { a: { provider: 'node-default', fs: { fallback: 'disk' } } },
      /not applicable to provider "node-default"/,
    );
    fails(
      { a: { fs: { fallback: 'disk' } } },
      /"disk" needs a finite ext list/,
    );
  });

  it('retainRaw: false needs a disk origin', () => {
    assert.throws(
      () =>
        new VfsConfig({
          places: {
            v: {
              origin: 'virtual',
              fs: {
                writable: true,
                compress: { encodings: ['gzip'], retainRaw: false },
              },
            },
          },
        }),
      /places\.v\.fs\.compress\.retainRaw: false requires origin "disk" — provider "sab", origin "virtual"/,
    );
  });
});

describe('strict: appRoot is a managed root', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-root'), {
      'pub/index.html': '<h1>',
      'pub/sub/a.html': 'a',
      'lib/util.js': 'exports.x = 1;',
      'stray/secret.txt': 'secret',
      'root-level.txt': 'root',
      'off/x.html': 'x',
    });
    k = await kernel(
      root,
      {
        pub: { fs: { ext: ['html'] } },
        lib: { require: true },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
        off: { enabled: false, fs: true },
      },
      { strict: true },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('lists the enabled places and nothing else', () => {
    assert.deepEqual(fs.readdirSync(root), ['lib', 'mem', 'pub']);
    assert.deepEqual(
      fs.readdirSync(root, { withFileTypes: true }).map((d) => {
        return [d.name, d.isDirectory(), d.parentPath];
      }),
      [
        ['lib', true, root],
        ['mem', true, root],
        ['pub', true, root],
      ],
    );
    assert.ok(Buffer.isBuffer(fs.readdirSync(root, 'buffer')[0]));
    const dir = fs.opendirSync(root);
    const names = [];
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      names.push(entry.name);
    }
    dir.closeSync();
    assert.deepEqual(names, ['lib', 'mem', 'pub']);
  });

  it('a recursive listing descends through each place own routing', async () => {
    k.fs('mem').writeFile('/m.txt', 'm');
    assert.deepEqual(fs.readdirSync(root, { recursive: true }), [
      'lib',
      'mem',
      'mem/m.txt',
      'pub',
      'pub/index.html',
      'pub/sub',
      'pub/sub/a.html',
    ]);
    assert.deepEqual(await fs.promises.readdir(root), ['lib', 'mem', 'pub']);
  });

  it('stats as a directory without asking the disk', () => {
    const stat = fs.statSync(root);
    assert.ok(stat instanceof VfsStats);
    assert.ok(stat.isDirectory());
    assert.ok(fs.lstatSync(root).isDirectory());
    assert.equal(fs.existsSync(root), true);
    assert.equal(fs.realpathSync(root), path.resolve(root));
    fs.accessSync(root, fs.constants.R_OK);
    assert.throws(() => fs.accessSync(root, fs.constants.W_OK), {
      code: 'EACCES',
    });
  });

  it('refuses whatever would reach the native root', () => {
    assert.throws(() => fs.watch(root, () => {}), { code: 'ENOTSUP' });
    assert.throws(() => fs.readFileSync(root), { code: 'EISDIR' });
    assert.throws(() => fs.rmdirSync(root), { code: 'EACCES' });
    assert.throws(() => fs.writeFileSync(root, 'x'), { code: 'EACCES' });
    assert.throws(() => fs.mkdirSync(root, { recursive: true }), {
      code: 'EACCES',
    });
  });

  it('unmanaged and disabled entries stay EACCES; outside is native', () => {
    assert.throws(() => fs.readFileSync(at('root-level.txt')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readdirSync(at('stray')), { code: 'EACCES' });
    assert.throws(() => fs.readFileSync(at('off', 'x.html')), {
      code: 'EACCES',
    });
    assert.ok(fs.readdirSync(path.dirname(root)).length > 0);
  });

  it('a non-strict appRoot stays native', async () => {
    const plain = await kernel(root, { pub: { fs: { ext: ['html'] } } });
    fsPatch.uninstall();
    fsPatch.install(plain);
    try {
      assert.ok(fs.readdirSync(root).includes('stray'));
      assert.ok(!(fs.statSync(root) instanceof VfsStats));
    } finally {
      fsPatch.uninstall();
      fsPatch.install(k);
      plain.close();
    }
  });
});

describe("fs.fallback: 'disk' — a partial disk cache", () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-fallback'), {
      'site/index.html': '<h1>cached</h1>',
      'site/app.js': 'cached js',
      'site/logo.png': 'PNG',
      'site/media/clip.mp4': 'MP4',
      'site/sub/page.html': 'page',
      'site/sub/pic.png': 'pic',
      'sib/x.png': 'sibling',
      'stray/x.png': 'stray',
      'lib/m.js': 'module.exports = "m";',
      'lib/data.json': '{"a":1}',
      'up/a.txt': 'a1',
    });
    k = await kernel(
      root,
      {
        site: { fs: { ext: ['html', 'js'], fallback: 'disk' } },
        sib: { fs: { ext: ['html'] } },
        lib: {
          fs: { ext: ['js'], fallback: 'disk' },
          require: { ext: ['js'], compile: false },
        },
        up: { fs: { ext: ['txt'], writable: true, fallback: 'disk' } },
      },
      { strict: true, watch: true, watchTimeout: 60000 },
    );
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('serves cached extensions from the VFS and the rest from disk', () => {
    // The disk copy of a cached file changes; the VFS keeps its version.
    writeDisk(at('site', 'index.html'), '<h1>changed on disk</h1>');
    assert.equal(
      fs.readFileSync(at('site', 'index.html'), 'utf8'),
      '<h1>cached</h1>',
    );
    assert.equal(fs.readFileSync(at('site', 'logo.png'), 'utf8'), 'PNG');
    assert.equal(
      fs.readFileSync(at('site', 'media', 'clip.mp4'), 'utf8'),
      'MP4',
    );
    assert.equal(k.cache.entry('site', '/logo.png'), null, 'never cached');
  });

  it('merges cached and disk entries in listings, without duplicates', () => {
    assert.deepEqual(fs.readdirSync(at('site')), [
      'app.js',
      'index.html',
      'logo.png',
      'media',
      'sub',
    ]);
    assert.deepEqual(fs.readdirSync(at('site', 'sub')), [
      'page.html',
      'pic.png',
    ]);
    assert.deepEqual(fs.readdirSync(at('site'), { recursive: true }), [
      'app.js',
      'index.html',
      'logo.png',
      'media',
      'media/clip.mp4',
      'sub',
      'sub/page.html',
      'sub/pic.png',
    ]);
  });

  it('cached extensions stay VFS-only, even when present on disk', () => {
    writeDisk(at('site', 'late.html'), 'late');
    assert.throws(() => fs.readFileSync(at('site', 'late.html')), {
      code: 'EACCES',
    });
    assert.ok(!fs.readdirSync(at('site')).includes('late.html'));
  });

  // A directory only on disk has no published entries to merge with: its
  // listing still comes from the place, never from a native readdir.
  it('a disk-only directory lists no raw file of a cached extension', async () => {
    writeDisk(at('site', 'media', 'raw.html'), 'raw');
    assert.deepEqual(fs.readdirSync(at('site', 'media')), ['clip.mp4']);
    assert.deepEqual(await fs.promises.readdir(at('site', 'media')), [
      'clip.mp4',
    ]);
    assert.deepEqual(
      fs
        .readdirSync(at('site', 'media'), { withFileTypes: true })
        .map((d) => [d.name, d.isFile()]),
      [['clip.mp4', true]],
    );
    assert.deepEqual(k.fs('site').readdir('/media'), ['clip.mp4']);
    assert.throws(() => fs.readFileSync(at('site', 'media', 'raw.html')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readdirSync(at('site', 'logo.png')), {
      code: 'ENOTDIR',
    });
    assert.throws(() => fs.readdirSync(at('site', 'nowhere')), {
      code: 'ENOENT',
    });
  });

  it('never extends past the place', () => {
    assert.throws(() => fs.readFileSync(at('sib', 'x.png')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readFileSync(at('stray', 'x.png')), {
      code: 'EACCES',
    });
    const site = k.fs('site');
    assert.equal(site.readFile('/../stray/x.png'), null);
    assert.equal(site.exists('/../stray'), false);
  });

  it('the PlaceFs facade serves the same disk territory', () => {
    const site = k.fs('site');
    assert.equal(site.readFile('/logo.png', 'utf8'), 'PNG');
    assert.equal(site.stat('/logo.png').size, 3);
    assert.ok(site.exists('/media') && site.stat('/media').isDirectory());
    assert.deepEqual(site.readdir('/media'), ['clip.mp4']);
    assert.equal(site.readFile('/late.html'), null, 'cached territory');
    assert.deepEqual(site.storedEncodings('/logo.png'), [], 'not in memory');
  });

  it('writable stays an independent policy', () => {
    assert.throws(() => fs.writeFileSync(at('site', 'new.png'), 'x'), {
      code: 'EROFS',
    });
    fs.writeFileSync(at('up', 'new.png'), 'PNG');
    assert.equal(fs.readFileSync(at('up', 'new.png'), 'utf8'), 'PNG');
  });

  it('disk writes: cached extensions republish, the rest never enter SAB', async () => {
    fs.writeFileSync(at('up', 'a.txt'), 'a2');
    fs.writeFileSync(at('up', 'b.png'), 'PNG');
    k.watcher.emit(
      'epoch',
      new Map([
        [at('up', 'a.txt'), 'change'],
        [at('up', 'b.png'), 'change'],
      ]),
    );
    await k.watchQueue.idle;
    assert.equal(fs.readFileSync(at('up', 'a.txt'), 'utf8'), 'a2');
    assert.equal(k.cache.entry('up', '/b.png'), null);
    assert.equal(fs.readFileSync(at('up', 'b.png'), 'utf8'), 'PNG');
  });

  it('module hooks get no fallback', () => {
    moduleHook.install(k);
    try {
      assert.equal(fs.readFileSync(at('lib', 'data.json'), 'utf8'), '{"a":1}');
      assert.equal(require(at('lib', 'm.js')), 'm');
      assert.throws(() => require(at('lib', 'data.json')), {
        code: 'MODULE_NOT_FOUND',
      });
    } finally {
      moduleHook.uninstall();
    }
  });
});

describe("fs.fallback: 'disk' — the non-strict default", () => {
  it('reads stay permissive; listings still come from the place', async () => {
    const root = writeTree(tmpDir('vfs-loose'), {
      'site/index.html': '<h1>',
      'site/media/clip.mp4': 'MP4',
    });
    const k = await kernel(root, { site: { fs: { ext: ['html'] } } });
    fsPatch.install(k);
    try {
      const at = (...p) => path.join(root, 'site', ...p);
      assert.equal(k.registry.get('site').config.fs.fallback, 'disk');
      writeDisk(at('media', 'raw.html'), 'raw');
      assert.equal(fs.readFileSync(at('media', 'raw.html'), 'utf8'), 'raw');
      assert.deepEqual(fs.readdirSync(at('media')), ['clip.mp4']);
      assert.deepEqual(fs.readdirSync(at(), { recursive: true }), [
        'index.html',
        'media',
        'media/clip.mp4',
      ]);
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(root);
    }
  });
});

describe("fs.fallback: 'deny' — published canonical entries only", () => {
  it('closes a place even without strict', async () => {
    const root = writeTree(tmpDir('vfs-deny'), {
      'closed/index.html': '<h1>',
      'closed/logo.png': 'PNG',
    });
    const k = await kernel(root, {
      closed: { fs: { ext: ['html'], fallback: 'deny' } },
    });
    fsPatch.install(k);
    try {
      const at = (...p) => path.join(root, 'closed', ...p);
      assert.equal(fs.readFileSync(at('index.html'), 'utf8'), '<h1>');
      assert.throws(() => fs.readFileSync(at('logo.png')), { code: 'EACCES' });
      assert.throws(() => fs.readFileSync(at('missing.html')), {
        code: 'EACCES',
      });
      assert.deepEqual(fs.readdirSync(path.join(root, 'closed')), [
        'index.html',
      ]);
      assert.equal(k.fs('closed').readFile('/logo.png'), null);
    } finally {
      fsPatch.uninstall();
      k.close();
      rm(root);
    }
  });
});
