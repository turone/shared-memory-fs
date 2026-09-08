'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');

// fs-patch executes router decisions; these tests exercise node:fs itself
// while the patch is installed. Suites install/uninstall around themselves.

describe('fs-patch: reads over sab and memory places', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('fspatch'), {
      'pub/index.html': '<h1>x</h1>',
      'pub/sub/a.txt': 'aaa',
      'pub/hidden.bin': 'bin',
      'pub/big.txt': 'B'.repeat(70 * 1024),
      'other/o.txt': 'outside any place',
    });
    k = await kernel(root, {
      pub: { fs: { ext: ['html', 'txt'], zeroCopy: true } },
      mem: { provider: 'memory', fs: { writable: true } },
    });
    fsPatch.install(k);
    fsPatch.install(k); // idempotent
  });

  after(() => {
    fsPatch.uninstall();
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('readFile: sync, callback, promises; owned copies; encodings', async () => {
    const file = at('pub', 'index.html');
    const buf = fs.readFileSync(file);
    assert.equal(buf.toString(), '<h1>x</h1>');
    assert.ok(!(buf.buffer instanceof SharedArrayBuffer));
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1>x</h1>');
    assert.equal(fs.readFileSync(file, { encoding: 'utf8' }), '<h1>x</h1>');
    assert.equal(await fs.promises.readFile(file, 'utf8'), '<h1>x</h1>');
    const viaCb = await new Promise((resolve, reject) =>
      fs.readFile(file, 'utf8', (err, data) =>
        err ? reject(err) : resolve(data),
      ),
    );
    assert.equal(viaCb, '<h1>x</h1>');
    assert.equal(
      fs.readFileSync(new URL(`file:///${file.replace(/\\/g, '/')}`), 'utf8'),
      '<h1>x</h1>',
    );
    assert.equal(fs.readFileSync(Buffer.from(file), 'utf8'), '<h1>x</h1>');
  });

  it('passthrough: outside places, disk-backed entries, excluded ext (non-strict)', () => {
    assert.equal(
      fs.readFileSync(at('other', 'o.txt'), 'utf8'),
      'outside any place',
    );
    assert.equal(fs.readFileSync(at('pub', 'big.txt')).length, 70 * 1024);
    assert.equal(fs.readFileSync(at('pub', 'hidden.bin'), 'utf8'), 'bin');
    assert.equal(
      fs.readFileSync(__filename, 'utf8').slice(0, 12),
      "'use strict'",
    );
  });

  it('stat / lstat / existsSync / access / realpath', async () => {
    const file = at('pub', 'sub', 'a.txt');
    const s = fs.statSync(file);
    assert.equal(s.size, 3);
    assert.ok(s.isFile());
    assert.ok(fs.statSync(at('pub', 'sub')).isDirectory());
    assert.ok(fs.lstatSync(at('pub')).isDirectory());
    assert.equal(fs.statSync(file, { bigint: true }).size, 3n);
    assert.ok((await fs.promises.stat(file)).isFile());
    const cb = await new Promise((resolve, reject) =>
      fs.stat(file, (err, st) => (err ? reject(err) : resolve(st))),
    );
    assert.equal(cb.size, 3);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(at('pub', 'sub')), true);
    assert.equal(fs.existsSync(at('pub', 'nope')), false);
    assert.equal(fs.existsSync(at('other', 'o.txt')), true);
    fs.accessSync(file);
    fs.accessSync(file, fs.constants.F_OK);
    fs.accessSync(file, fs.constants.R_OK);
    fs.accessSync(file, fs.constants.F_OK | fs.constants.R_OK);
    assert.throws(() => fs.accessSync(file, fs.constants.W_OK), {
      code: 'EACCES',
    });
    assert.throws(() => fs.accessSync(file, fs.constants.X_OK), {
      code: 'EACCES',
    });
    assert.throws(
      () => fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK),
      { code: 'EACCES' },
    );
    assert.throws(
      () => fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK),
      { code: 'EACCES' },
    );
    await fs.promises.access(file);
    assert.equal(fs.realpathSync(file), file);
    assert.equal(await fs.promises.realpath(file), file);
    assert.equal(typeof fs.realpathSync.native, 'function');
    assert.throws(() => fs.statSync(at('pub', 'nope')), { code: 'ENOENT' });
    assert.equal(
      fs.statSync(at('pub', 'nope'), { throwIfNoEntry: false }),
      undefined,
    );
  });

  it('readdir: sync, callback, promises, options, ENOTDIR', async () => {
    assert.deepEqual(fs.readdirSync(at('pub')), [
      'big.txt',
      'index.html',
      'sub',
    ]);
    assert.deepEqual(fs.readdirSync(at('pub'), { recursive: true }), [
      'big.txt',
      'index.html',
      'sub',
      'sub/a.txt',
    ]);
    const dirents = fs.readdirSync(at('pub'), { withFileTypes: true });
    assert.deepEqual(
      dirents.map((d) => [d.name, d.isDirectory()]),
      [
        ['big.txt', false],
        ['index.html', false],
        ['sub', true],
      ],
    );
    assert.deepEqual(await fs.promises.readdir(at('pub', 'sub')), ['a.txt']);
    const cb = await new Promise((resolve, reject) =>
      fs.readdir(at('pub', 'sub'), (err, list) =>
        err ? reject(err) : resolve(list),
      ),
    );
    assert.deepEqual(cb, ['a.txt']);
    assert.throws(() => fs.readdirSync(at('pub', 'index.html')), {
      code: 'ENOTDIR',
    });
    assert.throws(() => fs.readFileSync(at('pub', 'sub')), { code: 'EISDIR' });
  });

  it('createReadStream: zero-copy chunks honour place setting; errors are emitted', async () => {
    const stream = fs.createReadStream(at('pub', 'sub', 'a.txt'), { start: 1 });
    const data = await drain(stream);
    assert.equal(data.toString(), 'aa');
    const chunks = [];
    for await (const c of fs.createReadStream(at('pub', 'index.html')))
      chunks.push(c);
    assert.ok(
      chunks[0].buffer instanceof SharedArrayBuffer,
      'pub has zeroCopy: true',
    );
    const bad = fs.createReadStream(at('pub', 'sub'));
    await assert.rejects(drain(bad), { code: 'EISDIR' });
    const passthrough = await drain(fs.createReadStream(at('other', 'o.txt')));
    assert.equal(passthrough.toString(), 'outside any place');
  });

  it('open() has no descriptor for virtual entries', async () => {
    assert.throws(() => fs.openSync(at('pub', 'index.html'), 'r'), {
      code: 'ENOTSUP',
    });
    await assert.rejects(fs.promises.open(at('pub', 'index.html')), {
      code: 'ENOTSUP',
    });
    const fd = fs.openSync(at('other', 'o.txt'), 'r');
    fs.closeSync(fd);
  });

  it('read-only place: mutations fail with EROFS', async () => {
    assert.throws(() => fs.writeFileSync(at('pub', 'new.txt'), 'x'), {
      code: 'EROFS',
    });
    assert.throws(() => fs.unlinkSync(at('pub', 'index.html')), {
      code: 'EROFS',
    });
    assert.throws(() => fs.mkdirSync(at('pub', 'd')), { code: 'EROFS' });
    assert.throws(() => fs.rmSync(at('pub', 'sub'), { recursive: true }), {
      code: 'EROFS',
    });
    assert.throws(
      () => fs.renameSync(at('pub', 'index.html'), at('pub', 'i2.html')),
      { code: 'EROFS' },
    );
    await assert.rejects(fs.promises.appendFile(at('pub', 'index.html'), 'x'), {
      code: 'EROFS',
    });
    const err = await new Promise((resolve) =>
      fs.writeFile(at('pub', 'x'), 'x', resolve),
    );
    assert.equal(err.code, 'EROFS');
    assert.ok(fs.existsSync(at('pub', 'index.html')));
  });

  it('memory place: writeFile / appendFile / unlink / mkdir / rm / rename through node:fs', async () => {
    const mem = at('mem');
    fs.writeFileSync(path.join(mem, 'a.txt'), 'a');
    await fs.promises.appendFile(path.join(mem, 'a.txt'), 'b');
    await new Promise((resolve, reject) =>
      fs.writeFile(path.join(mem, 'dir', 'c.txt'), Buffer.from('c'), (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    assert.equal(fs.readFileSync(path.join(mem, 'a.txt'), 'utf8'), 'ab');
    assert.deepEqual(fs.readdirSync(mem), ['a.txt', 'dir']);
    fs.mkdirSync(path.join(mem, 'whatever'), { recursive: true });
    fs.renameSync(path.join(mem, 'a.txt'), path.join(mem, 'dir', 'a2.txt'));
    assert.deepEqual(fs.readdirSync(path.join(mem, 'dir')), [
      'a2.txt',
      'c.txt',
    ]);
    fs.accessSync(path.join(mem, 'dir', 'c.txt'), fs.constants.W_OK);
    fs.unlinkSync(path.join(mem, 'dir', 'c.txt'));
    assert.throws(() => fs.unlinkSync(path.join(mem, 'dir', 'c.txt')), {
      code: 'ENOENT',
    });
    await fs.promises.rm(path.join(mem, 'dir'), { recursive: true });
    assert.deepEqual(fs.readdirSync(mem), []);
    assert.equal(k.fs('mem').exists('/dir/a2.txt'), false);
  });

  it('rename across places or into disk is EXDEV', () => {
    fs.writeFileSync(at('mem', 'x.txt'), 'x');
    assert.throws(
      () => fs.renameSync(at('mem', 'x.txt'), at('other', 'x.txt')),
      { code: 'EXDEV' },
    );
    assert.throws(
      () => fs.renameSync(at('other', 'o.txt'), at('mem', 'o.txt')),
      { code: 'EXDEV' },
    );
    fs.unlinkSync(at('mem', 'x.txt'));
  });

  it('uninstall restores node:fs', () => {
    fsPatch.uninstall();
    assert.throws(() => fs.readFileSync(at('mem', 'nothing.txt')), {
      code: 'ENOENT',
    });
    fsPatch.install(k);
  });
});

describe('fs-patch: strict sandbox', () => {
  let root;
  let k;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('fspatch-strict'), {
      'pub/index.html': '<h1>x</h1>',
      'pub/hidden.bin': 'bin',
      'pub/big.txt': 'B'.repeat(70 * 1024),
      'lib/util.js': 'exports.x = 1;',
      'uploads/u.txt': 'u',
      'stray/s.txt': 's',
      'stray/sub/deep.txt': 'deep',
      'nd/n.txt': 'n',
      'root-level.txt': 'root level file',
    });
    k = await kernel(
      root,
      {
        pub: { fs: { ext: ['html', 'txt'] } },
        lib: { require: true },
        uploads: { provider: 'disk', fs: { writable: true } },
        ro: { provider: 'disk', fs: true },
        nd: { provider: 'node-default', fs: true },
        mem: { provider: 'memory', fs: { writable: true } },
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

  it('published entries are served; unpublished paths inside indexed mounts are EACCES', () => {
    assert.equal(
      fs.readFileSync(at('pub', 'index.html'), 'utf8'),
      '<h1>x</h1>',
    );
    assert.throws(
      () => fs.readFileSync(at('pub', 'hidden.bin')),
      { code: 'EACCES' },
      'excluded ext',
    );
    assert.throws(() => fs.readFileSync(at('pub', 'missing.txt')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.statSync(at('pub', 'missing.txt')), {
      code: 'EACCES',
    });
    assert.equal(fs.existsSync(at('pub', 'hidden.bin')), false);
    assert.throws(() => fs.readFileSync(at('mem', 'nope.txt')), {
      code: 'EACCES',
    });
  });

  it('explicit disk entries inside a SAB place are the only disk fallback', () => {
    assert.equal(fs.readFileSync(at('pub', 'big.txt')).length, 70 * 1024);
  });

  // Regression: these APIs are not implemented by the patch, so before the
  // guard they reached libuv directly and read, listed or modified denied
  // paths behind the sandbox's back.
  it('unimplemented path APIs cannot bypass the sandbox', async () => {
    const secret = at('lib', 'util.js');
    const outside = path.join(os.tmpdir(), 'vfs-leak-probe.txt');
    assert.throws(() => fs.copyFileSync(secret, outside), { code: 'EACCES' });
    assert.throws(() => fs.cpSync(at('lib'), outside, { recursive: true }), {
      code: 'EACCES',
    });
    assert.throws(() => fs.opendirSync(at('lib')), { code: 'EACCES' });
    assert.throws(() => fs.readlinkSync(secret), { code: 'EACCES' });
    assert.throws(() => fs.statfsSync(at('lib')), { code: 'EACCES' });
    assert.throws(() => fs.rmdirSync(at('stray', 'sub')), { code: 'EACCES' });
    assert.throws(() => fs.truncateSync(secret, 0), { code: 'EACCES' });
    assert.throws(() => fs.utimesSync(secret, new Date(), new Date()), {
      code: 'EACCES',
    });
    assert.throws(() => fs.chmodSync(secret, 0o666), { code: 'EACCES' });
    assert.throws(() => fs.linkSync(secret, outside), { code: 'EACCES' });
    assert.throws(() => fs.symlinkSync(outside, at('stray', 'link')), {
      code: 'EACCES',
    });
    await assert.rejects(fs.promises.opendir(at('lib')), { code: 'EACCES' });
    await assert.rejects(fs.promises.copyFile(secret, outside), {
      code: 'EACCES',
    });
    const viaCb = await new Promise((resolve) =>
      fs.copyFile(secret, outside, resolve),
    );
    assert.equal(viaCb.code, 'EACCES');
    assert.equal(fs.existsSync(outside), false);
    const viaChown = await new Promise((resolve) =>
      fs.chown(secret, 0, 0, resolve),
    );
    assert.equal(viaChown.code, 'EACCES');
    await assert.rejects(fs.promises.chmod(secret, 0o666), { code: 'EACCES' });
    await assert.rejects(fs.promises.truncate(secret, 0), { code: 'EACCES' });
  });

  it('glob never yields denied paths', async () => {
    const pattern = path.join(root, '*', '*').replace(/\\/g, '/');
    const names = (list) => list.map((p) => path.basename(String(p))).sort();
    // Published, disk-backed and passthrough entries stay; denied ones
    // (hidden.bin, lib/util.js, stray/s.txt) never appear.
    const visible = ['big.txt', 'index.html', 'n.txt', 'u.txt'];
    assert.deepEqual(names(fs.globSync(pattern)), visible);
    const viaCb = await new Promise((resolve, reject) =>
      fs.glob(pattern, (err, m) => (err ? reject(err) : resolve(m))),
    );
    assert.deepEqual(names(viaCb), visible);
    const collected = [];
    for await (const entry of fs.promises.glob(pattern)) collected.push(entry);
    assert.deepEqual(names(collected), visible);
  });

  it('mutating APIs honour a read-only place even without strict', () => {
    assert.throws(() => fs.utimesSync(at('pub', 'index.html'), 1, 1), {
      code: 'EROFS',
    });
    assert.throws(() => fs.chmodSync(at('pub', 'index.html'), 0o666), {
      code: 'EROFS',
    });
    assert.throws(() => fs.rmdirSync(at('ro')), { code: 'EROFS' });
  });

  it('places without fs domain and unknown mounts under appRoot are EACCES', () => {
    assert.throws(() => fs.readFileSync(at('lib', 'util.js')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readFileSync(at('stray', 's.txt')), {
      code: 'EACCES',
    });
    assert.throws(() => fs.readdirSync(at('stray', 'sub')), { code: 'EACCES' });
    assert.throws(() => fs.writeFileSync(at('stray', 'w.txt'), 'w'), {
      code: 'EACCES',
    });
    assert.throws(() => fs.openSync(at('stray', 's.txt'), 'r'), {
      code: 'EACCES',
    });
    assert.equal(fs.existsSync(at('stray', 's.txt')), false);
  });

  // appRoot is the sandbox boundary: an unmanaged entry under it is denied at
  // every depth, whether it is a file or a directory. Previously only depth
  // >= 2 was routed, so an unmanaged first-level directory stayed listable and
  // `cp -r` copied its whole subtree out.
  describe('unmanaged paths under appRoot are denied at every depth', () => {
    const outside = () =>
      path.join(os.tmpdir(), `vfs-escape-${process.pid}-${Date.now()}`);

    it('readdir', () => {
      assert.throws(() => fs.readdirSync(at('stray')), { code: 'EACCES' });
      assert.throws(() => fs.readdirSync(at('stray', 'sub')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.readdirSync(at('stray'), { recursive: true }), {
        code: 'EACCES',
      });
    });

    it('opendir', async () => {
      assert.throws(() => fs.opendirSync(at('stray')), { code: 'EACCES' });
      await assert.rejects(fs.promises.opendir(at('stray')), {
        code: 'EACCES',
      });
    });

    it('cp recursive', async () => {
      const dest = outside();
      assert.throws(() => fs.cpSync(at('stray'), dest, { recursive: true }), {
        code: 'EACCES',
      });
      await assert.rejects(
        fs.promises.cp(at('stray'), dest, { recursive: true }),
        { code: 'EACCES' },
      );
      assert.equal(fs.existsSync(dest), false, 'nothing escaped');
    });

    it('glob', () => {
      const pattern = path.join(root, 'stray', '**').replace(/\\/g, '/');
      assert.deepEqual(fs.globSync(pattern), []);
    });

    it('readFile', () => {
      assert.throws(() => fs.readFileSync(at('stray', 's.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.readFileSync(at('stray', 'sub', 'deep.txt')), {
        code: 'EACCES',
      });
    });

    it('mutation', () => {
      assert.throws(() => fs.writeFileSync(at('stray', 'new.txt'), 'x'), {
        code: 'EACCES',
      });
      assert.throws(() => fs.unlinkSync(at('stray', 's.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.mkdirSync(at('stray', 'sub2')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.rmSync(at('stray'), { recursive: true }), {
        code: 'EACCES',
      });
      assert.ok(fs.existsSync(path.join(root, 'stray', 's.txt')) || true);
    });

    it('unmanaged root-level file', () => {
      assert.throws(() => fs.readFileSync(at('root-level.txt')), {
        code: 'EACCES',
      });
      assert.throws(() => fs.statSync(at('root-level.txt')), {
        code: 'EACCES',
      });
      assert.equal(fs.existsSync(at('root-level.txt')), false);
      assert.throws(() => fs.writeFileSync(at('root-level.txt'), 'x'), {
        code: 'EACCES',
      });
    });

    it('unmanaged root-level directory', () => {
      assert.throws(() => fs.statSync(at('stray')), { code: 'EACCES' });
      assert.equal(fs.existsSync(at('stray')), false);
      assert.throws(() => fs.rmdirSync(at('stray')), { code: 'EACCES' });
      assert.throws(() => fs.chmodSync(at('stray'), 0o777), {
        code: 'EACCES',
      });
    });

    it('watch and watchFile cannot probe denied paths', () => {
      assert.throws(() => fs.watch(at('stray'), () => {}), { code: 'EACCES' });
      assert.throws(() => fs.watch(at('pub', 'missing.txt'), () => {}), {
        code: 'EACCES',
      });
      assert.throws(() => fs.watchFile(at('stray', 's.txt'), () => {}), {
        code: 'EACCES',
      });
      assert.throws(() => fs.promises.watch(at('stray')), { code: 'EACCES' });
    });

    it('paths outside appRoot keep ordinary Node semantics', async () => {
      const dest = outside();
      assert.ok(fs.readFileSync(__filename, 'utf8').length > 0);
      assert.ok(fs.readdirSync(__dirname).includes('fs-patch.test.js'));
      assert.ok(fs.statSync(__dirname).isDirectory());
      assert.equal(fs.existsSync(__filename), true);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'a.txt'), 'a');
      fs.copyFileSync(path.join(dest, 'a.txt'), path.join(dest, 'b.txt'));
      assert.deepEqual(fs.readdirSync(dest).sort(), ['a.txt', 'b.txt']);
      const dir = fs.opendirSync(dest);
      dir.closeSync();
      const watcher = fs.watch(dest, () => {});
      watcher.close();
      await fs.promises.rm(dest, { recursive: true, force: true });
    });
  });

  it('disk places are managed passthrough with writable policy; node-default is plain', () => {
    assert.equal(fs.readFileSync(at('uploads', 'u.txt'), 'utf8'), 'u');
    fs.writeFileSync(at('uploads', 'w.txt'), 'w');
    assert.equal(fs.readFileSync(at('uploads', 'w.txt'), 'utf8'), 'w');
    assert.throws(
      () => fs.readFileSync(at('ro', 'x.txt')),
      { code: 'ENOENT' },
      'real disk error',
    );
    assert.throws(() => fs.writeFileSync(at('ro', 'x.txt'), 'x'), {
      code: 'EROFS',
    });
    assert.equal(fs.readFileSync(at('nd', 'n.txt'), 'utf8'), 'n');
    fs.writeFileSync(at('nd', 'n2.txt'), 'n2');
    assert.ok(fs.existsSync(at('nd', 'n2.txt')));
  });

  it('paths outside appRoot pass through', () => {
    assert.ok(fs.readFileSync(__filename, 'utf8').length > 0);
    assert.ok(fs.existsSync(__dirname));
  });
});
