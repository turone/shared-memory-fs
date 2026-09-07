'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { VfsStats, VfsBigIntStats, VfsDirent } = require('../lib/stats.js');
const { fsError } = require('../lib/errors.js');
const { PlaceFs } = require('../lib/place-fs.js');
const { tmpDir, writeTree, rm, kernel, drain } = require('./helpers.js');

describe('VfsStats / VfsDirent / fsError', () => {
  it('file stats expose size, times and type predicates', () => {
    const s = new VfsStats(10, 1700000000123.5);
    assert.equal(s.size, 10);
    assert.equal(s.mtimeMs, 1700000000123.5);
    assert.ok(s.mtime instanceof Date);
    assert.equal(s.ctime, s.mtime);
    assert.ok(
      s.isFile() && !s.isDirectory() && !s.isSymbolicLink() && !s.isFIFO(),
    );
    assert.equal(s.mode & 0o170000, 0o100000);
  });

  it('directory stats and bigint variant', () => {
    const d = new VfsStats(0, 0, true);
    assert.ok(d.isDirectory() && !d.isFile());
    const b = new VfsBigIntStats(7, 1500.9, false);
    assert.equal(b.size, 7n);
    assert.equal(b.mtimeMs, 1500n);
    assert.equal(b.mtimeNs, 1500000000n);
    assert.ok(b.isFile());
  });

  it('dirents', () => {
    const d = new VfsDirent('x.js', '/root', false);
    assert.equal(d.name, 'x.js');
    assert.equal(d.parentPath, '/root');
    assert.ok(d.isFile() && !d.isDirectory() && !d.isSymbolicLink());
  });

  it('fsError mirrors node:fs error shape', () => {
    const err = fsError('ENOENT', 'open', '/x/y');
    assert.equal(err.code, 'ENOENT');
    assert.equal(err.syscall, 'open');
    assert.equal(err.path, '/x/y');
    assert.ok(err.errno < 0);
    assert.equal(err.message, "ENOENT: no such file or directory, open '/x/y'");
    assert.equal(
      fsError('EROFS', 'unlink').message,
      'EROFS: read-only file system, unlink',
    );
    assert.match(
      fsError('ENOTSUP', 'read', undefined, 'why').message,
      /\(why\), read$/,
    );
  });
});

describe('PlaceFs: reads', () => {
  let root;
  let k;
  let pub;

  before(async () => {
    root = writeTree(tmpDir('placefs'), {
      'pub/index.html': '<h1>hi</h1>',
      'pub/app.js': 'x'.repeat(200),
      'pub/img/logo.svg': '<svg/>',
      'pub/img/deep/x.css': 'a{}',
      'pub/skip.bin': '\x00\x01',
      'pub/empty.txt': '',
    });
    k = await kernel(root, {
      pub: { fs: { ext: ['html', 'js', 'svg', 'css', 'txt'], zeroCopy: true } },
      plain: { fs: true },
    });
    pub = k.fs('pub');
  });

  after(() => {
    k.close();
    rm(root);
  });

  it('is a PlaceFs with identity getters', () => {
    assert.ok(pub instanceof PlaceFs);
    assert.equal(pub.name, 'pub');
    assert.equal(pub.root, path.join(root, 'pub'));
    assert.equal(pub.provider, 'sab');
    assert.equal(pub.writable, false);
    assert.equal(pub.zeroCopy, true);
    assert.equal(
      pub.pathOf('/img/logo.svg'),
      path.join(root, 'pub', 'img', 'logo.svg'),
    );
    assert.equal(pub.pathOf('/'), path.join(root, 'pub'));
    assert.equal(k.fs('pub'), pub);
  });

  it('readFile returns owned copies; keys with or without leading slash', () => {
    const a = pub.readFile('/index.html');
    const b = pub.readFile('index.html');
    assert.equal(a.toString(), '<h1>hi</h1>');
    assert.ok(!(a.buffer instanceof SharedArrayBuffer));
    assert.notEqual(a, b);
    a[0] = 0x58;
    assert.equal(pub.readFile('/index.html', 'utf8'), '<h1>hi</h1>');
    assert.equal(
      pub.readFile('/index.html', { encoding: 'utf8' }),
      '<h1>hi</h1>',
    );
    assert.equal(pub.readFile('/nope'), null);
    assert.equal(pub.readFile('/skip.bin'), null, 'outside fs.ext');
    assert.equal(pub.readFile('/empty.txt').length, 0);
  });

  it('readFile honours AbortSignal', () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    assert.throws(
      () => pub.readFile('/index.html', { signal: ac.signal }),
      /stop/,
    );
  });

  it('readFileView is a borrowed SAB view when zeroCopy is on, ENOTSUP otherwise', () => {
    const v = pub.readFileView('/index.html');
    assert.ok(v.buffer instanceof SharedArrayBuffer);
    assert.equal(pub.readFileView('/nope'), null);
    const plain = k.fs('plain');
    assert.throws(() => plain.readFileView('/x'), { code: 'ENOTSUP' });
  });

  it('exists / stat for files and implicit directories', () => {
    assert.ok(pub.exists('/index.html') && pub.exists('index.html'));
    assert.ok(
      pub.exists('/img') &&
        pub.exists('/img/deep') &&
        pub.exists('/') &&
        pub.exists(''),
    );
    assert.ok(!pub.exists('/nope') && !pub.exists('/skip.bin'));
    const s = pub.stat('/app.js');
    assert.ok(s instanceof VfsStats);
    assert.equal(s.size, 200);
    assert.ok(s.isFile());
    assert.ok(pub.stat('/img').isDirectory());
    assert.ok(pub.stat('/').isDirectory());
    assert.equal(pub.stat('/nope'), null);
    assert.equal(pub.stat('/app.js', { bigint: true }).size, 200n);
    assert.notEqual(pub.stat('/app.js'), pub.stat('/app.js'), 'never cached');
  });

  it('readdir: direct children, recursive, withFileTypes, errors', () => {
    assert.deepEqual(pub.readdir('/'), [
      'app.js',
      'empty.txt',
      'img',
      'index.html',
    ]);
    assert.deepEqual(pub.readdir(''), pub.readdir('/'));
    assert.deepEqual(pub.readdir('/img'), ['deep', 'logo.svg']);
    assert.deepEqual(pub.readdir('img/'), ['deep', 'logo.svg']);
    assert.deepEqual(pub.readdir('/', { recursive: true }), [
      'app.js',
      'empty.txt',
      'img',
      'img/deep',
      'img/deep/x.css',
      'img/logo.svg',
      'index.html',
    ]);
    const dirents = pub.readdir('/img', { withFileTypes: true });
    assert.deepEqual(
      dirents.map((d) => [d.name, d.isDirectory(), d.parentPath]),
      [
        ['deep', true, path.join(root, 'pub', 'img')],
        ['logo.svg', false, path.join(root, 'pub', 'img')],
      ],
    );
    const deep = pub
      .readdir('/', { recursive: true, withFileTypes: true })
      .find((d) => d.name === 'x.css');
    assert.equal(deep.parentPath, path.join(root, 'pub', 'img', 'deep'));
    assert.ok(Buffer.isBuffer(pub.readdir('/', { encoding: 'buffer' })[0]));
    assert.throws(() => pub.readdir('/nope'), {
      code: 'ENOENT',
      syscall: 'scandir',
    });
    assert.throws(() => pub.readdir('/app.js'), { code: 'ENOTDIR' });
  });

  it('createReadStream: ranges, chunking, zero-copy chunks', async () => {
    const all = await drain(pub.createReadStream('/app.js'));
    assert.equal(all.length, 200);
    const part = await drain(
      pub.createReadStream('/app.js', { start: 10, end: 19 }),
    );
    assert.equal(part.length, 10);
    const tail = await drain(pub.createReadStream('/app.js', { start: 190 }));
    assert.equal(tail.length, 10);
    const chunks = [];
    for await (const c of pub.createReadStream('/app.js', {
      highWaterMark: 64,
    }))
      chunks.push(c);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [64, 64, 64, 8],
    );
    assert.ok(chunks[0].buffer instanceof SharedArrayBuffer, 'zeroCopy chunk');
    const text = await drain(
      pub
        .createReadStream('/index.html', { encoding: 'utf8' })
        .map((s) => Buffer.from(s)),
    );
    assert.equal(text.toString(), '<h1>hi</h1>');
    assert.equal((await drain(pub.createReadStream('/empty.txt'))).length, 0);
    assert.equal(pub.createReadStream('/nope'), null);
  });

  it('createReadStream: strict range validation', () => {
    const bad = [
      { start: -1 },
      { start: 1.5 },
      { start: NaN },
      { end: Infinity },
      { start: 10, end: 5 },
      { start: 200 },
      { end: 200 },
      { start: 0, end: 200 },
    ];
    const open = (options) => () => pub.createReadStream('/app.js', options);
    for (const options of bad) {
      assert.throws(open(options), RangeError, JSON.stringify(options));
    }
    assert.throws(
      () => pub.createReadStream('/empty.txt', { start: 0 }),
      RangeError,
    );
  });

  it('createReadStream: copies when zeroCopy is off and supports AbortSignal', async () => {
    writeTree(root, { 'plain/p.txt': 'plain' });
    const k2 = await kernel(root, { plain: { fs: true } });
    const chunks = [];
    for await (const c of k2.fs('plain').createReadStream('/p.txt'))
      chunks.push(c);
    assert.ok(!(chunks[0].buffer instanceof SharedArrayBuffer));
    const ac = new AbortController();
    const stream = k2
      .fs('plain')
      .createReadStream('/p.txt', { signal: ac.signal });
    ac.abort();
    await assert.rejects(drain(stream), { name: 'AbortError' });
    k2.close();
  });

  it('mutations fail with EROFS on read-only places', () => {
    assert.throws(() => pub.writeFile('/x', 'y'), { code: 'EROFS' });
    assert.throws(() => pub.unlink('/index.html'), { code: 'EROFS' });
    assert.throws(() => pub.rm('/img', { recursive: true }), { code: 'EROFS' });
    assert.throws(() => pub.mkdir('/d'), { code: 'EROFS' });
    assert.throws(() => pub.rename('/a', '/b'), { code: 'EROFS' });
    assert.ok(pub.exists('/index.html'));
  });
});

describe('PlaceFs: memory mutations', () => {
  let root;
  let k;
  let mem;

  before(async () => {
    root = tmpDir('placefs-mem');
    k = await kernel(root, {
      mem: { provider: 'memory', fs: { writable: true }, require: true },
    });
    mem = k.fs('mem');
  });

  after(() => {
    k.close();
    rm(root);
  });

  it('writeFile canonicalizes keys and rebuilds bytecode', () => {
    mem.writeFile('a.js', 'module.exports = 1;');
    assert.ok(mem.exists('/a.js'));
    assert.deepEqual(mem.readdir('/'), ['a.js']);
    assert.equal(mem.readFile('/a.js', 'utf8'), 'module.exports = 1;');
    assert.ok(k.bytecode(path.join(root, 'mem', 'a.js')));
    mem.writeFile('/a.js', 'module.exports = 2;');
    assert.equal(mem.readFile('a.js', 'utf8'), 'module.exports = 2;');
    mem.writeFile('/broken.js', 'module.exports = (;');
    assert.ok(
      mem.exists('/broken.js'),
      'syntax-invalid source is still published',
    );
    assert.equal(k.bytecode(path.join(root, 'mem', 'broken.js')), null);
    mem.writeFile('/note.txt', 'text', 'utf8');
    assert.equal(k.bytecode(path.join(root, 'mem', 'note.txt')), null);
  });

  it('rejects invalid keys', () => {
    const write = (key) => () => mem.writeFile(key, 'x');
    for (const key of ['', '/', 'a\u0000b', '../x', '/a/../b', 'a\\b', 42]) {
      assert.throws(write(key), TypeError, String(key));
    }
  });

  it('appendFile creates or extends', () => {
    mem.appendFile('/log.txt', 'a');
    mem.appendFile('/log.txt', Buffer.from('b'));
    assert.equal(mem.readFile('/log.txt', 'utf8'), 'ab');
    assert.equal(mem.stat('/log.txt').size, 2);
  });

  it('mkdir is a no-op; directories are implicit', () => {
    mem.mkdir('/dir');
    assert.ok(!mem.exists('/dir'));
    mem.writeFile('/dir/sub/f.txt', 'f');
    assert.ok(mem.stat('/dir').isDirectory());
    assert.deepEqual(mem.readdir('/dir'), ['sub']);
  });

  it('unlink removes source and companions', () => {
    mem.writeFile('/u.js', 'module.exports = 3;');
    assert.ok(k.bytecode(path.join(root, 'mem', 'u.js')));
    mem.unlink('/u.js');
    assert.ok(!mem.exists('/u.js'));
    assert.equal(k.bytecode(path.join(root, 'mem', 'u.js')), null);
    assert.throws(() => mem.unlink('/u.js'), { code: 'ENOENT' });
  });

  it('rm: file, recursive tree, force, non-empty', () => {
    mem.writeFile('/t/a.txt', 'a');
    mem.writeFile('/t/b/c.txt', 'c');
    assert.throws(() => mem.rm('/t'), { code: 'ENOTEMPTY' });
    assert.throws(() => mem.rm('/nope'), { code: 'ENOENT' });
    mem.rm('/nope', { force: true });
    mem.rm('/t/a.txt');
    assert.ok(!mem.exists('/t/a.txt'));
    mem.rm('/t', { recursive: true });
    assert.ok(!mem.exists('/t') && !mem.exists('/t/b/c.txt'));
  });

  it('rename moves source and companions inside the place', () => {
    mem.writeFile('/r1.js', 'module.exports = 4;');
    mem.rename('/r1.js', '/moved/r2.js');
    assert.ok(!mem.exists('/r1.js'));
    assert.equal(mem.readFile('/moved/r2.js', 'utf8'), 'module.exports = 4;');
    assert.equal(k.bytecode(path.join(root, 'mem', 'r1.js')), null);
    assert.ok(k.bytecode(path.join(root, 'mem', 'moved', 'r2.js')));
    assert.throws(() => mem.rename('/nope', '/x'), { code: 'ENOENT' });
  });

  it('readFileView on memory returns the internal buffer only with zeroCopy', async () => {
    assert.throws(() => mem.readFileView('/log.txt'), { code: 'ENOTSUP' });
    const k2 = await kernel(root, {
      mem: { provider: 'memory', fs: { writable: true, zeroCopy: true } },
    });
    const m2 = k2.fs('mem');
    m2.writeFile('/v.txt', 'view');
    const view = m2.readFileView('/v.txt');
    view[0] = 0x56;
    assert.equal(m2.readFile('/v.txt', 'utf8'), 'View');
    k2.close();
  });
});

describe('PlaceFs: writable sab place writes to disk', () => {
  it('writes through node:fs and reads back after the watcher epoch', async () => {
    const root = writeTree(tmpDir('placefs-sab-w'), { 'data/a.txt': 'a' });
    const k = await kernel(
      root,
      { data: { fs: { writable: true } } },
      { watchTimeout: 50 },
    );
    const data = k.fs('data');
    assert.equal(data.writable, true);
    assert.ok(k.watcher, 'writable sab place starts the watcher');
    data.writeFile('/b.txt', 'b');
    assert.equal(
      fs.readFileSync(path.join(root, 'data', 'b.txt'), 'utf8'),
      'b',
    );
    data.appendFile('/b.txt', 'b');
    data.mkdir('/d');
    assert.ok(fs.statSync(path.join(root, 'data', 'd')).isDirectory());
    data.rename('/b.txt', '/d/c.txt');
    data.unlink('/a.txt');
    data.rm('/d', { recursive: true });
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
    k.close();
    rm(root);
  });
});
