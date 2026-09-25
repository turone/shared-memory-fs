'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('./helpers.js');

// A reference to a node:fs function taken while the patch is installed —
// `const { readFile } = require('node:fs')` in a module loaded then, or the
// functions glob keeps from its first use — outlives uninstall(). Once no
// kernel is installed it must be node:fs again: native results, native
// errors, one callback, and never a call into a kernel that is gone.
//
// glob captures the node:fs functions it walks with when it is loaded, and a
// `node --test` child loads it before any test runs. So the case where glob
// kept the patched ones runs in a plain node process: fixtures/glob-kept.cjs.

const NATIVE = {
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  opendirSync: fs.opendirSync,
  promisesReadFile: fs.promises.readFile,
  globSync: fs.globSync,
};

const { writeFileSync: writeDisk } = fs;

// Calls `fn(callback)`; resolves with every call the callback received,
// once the event loop has had a chance to deliver a second one.
const callbackCalls = (fn) =>
  new Promise((resolve) => {
    const calls = [];
    fn((...args) => {
      calls.push(args);
      if (calls.length === 1) setImmediate(() => resolve(calls));
    });
  });

const slashed = (list) => list.map((p) => String(p).split(path.sep).join('/'));

describe('fs-patch: references taken while installed outlive uninstall()', () => {
  let root;
  let k;
  let captured;
  const at = (...p) => path.join(root, ...p);

  before(async () => {
    root = writeTree(tmpDir('vfs-uninstall'), {
      'pub/index.html': '<h1>vfs</h1>',
      'stray/x.txt': 'stray',
    });
    k = await kernel(
      root,
      {
        pub: { fs: { ext: ['html'] } },
        mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
      },
      { strict: true },
    );
    k.fs('mem').writeFile('/m.txt', 'm');
    // The disk copy changes behind the VFS: routed reads keep the VFS one.
    writeDisk(at('pub', 'index.html'), '<h1>disk</h1>');
    fsPatch.install(k);
    captured = {
      readFile: fs.readFile,
      readFileSync: fs.readFileSync,
      promisesReadFile: fs.promises.readFile,
      readdirSync: fs.readdirSync,
      existsSync: fs.existsSync,
      createReadStream: fs.createReadStream,
      opendir: fs.opendir,
      opendirSync: fs.opendirSync,
      promisesOpendir: fs.promises.opendir,
      watch: fs.watch,
      globSync: fs.globSync,
      glob: fs.glob,
      promisesGlob: fs.promises.glob,
    };
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(root);
  });

  it('while installed, the references route through the kernel', async () => {
    const page = at('pub', 'index.html');
    assert.equal(captured.readFileSync(page, 'utf8'), '<h1>vfs</h1>');
    assert.throws(() => captured.readFileSync(at('stray', 'x.txt')), {
      code: 'EACCES',
    });
    assert.equal(captured.existsSync(at('mem', 'm.txt')), true);
    const dir = captured.opendirSync(at('mem'));
    assert.ok(!(dir instanceof fs.Dir));
    assert.equal(dir.readSync().name, 'm.txt');
    dir.closeSync();
    assert.deepEqual(slashed(captured.globSync('*', { cwd: root })), ['pub']);
  });

  it('after uninstall(), every reference is node:fs again', async () => {
    fsPatch.uninstall();
    // The live functions are the native ones: no wrapper is left behind.
    assert.equal(fs.readFileSync, NATIVE.readFileSync);
    assert.equal(fs.globSync, NATIVE.globSync);

    const page = at('pub', 'index.html');
    // Sync.
    assert.equal(captured.readFileSync(page, 'utf8'), '<h1>disk</h1>');
    assert.equal(captured.readFileSync(at('stray', 'x.txt'), 'utf8'), 'stray');
    assert.deepEqual(captured.readdirSync(root).sort(), ['pub', 'stray']);
    assert.equal(captured.existsSync(at('mem', 'm.txt')), false);
    // Callback: native result, delivered once.
    const read = await callbackCalls((cb) =>
      captured.readFile(page, 'utf8', cb),
    );
    assert.deepEqual(read, [[null, '<h1>disk</h1>']]);
    // Promises.
    assert.equal(
      await captured.promisesReadFile(page, 'utf8'),
      '<h1>disk</h1>',
    );
    // Streams and watchers are native objects again.
    const stream = captured.createReadStream(page);
    assert.ok(stream instanceof fs.ReadStream);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), '<h1>disk</h1>');
    const watcher = captured.watch(root, () => {});
    watcher.close();
  });

  it('native errors stay native: never swallowed, never a TypeError', async () => {
    const virtual = at('mem', 'm.txt');
    assert.throws(() => captured.readFileSync(virtual), {
      code: 'ENOENT',
      syscall: 'open',
    });
    const read = await callbackCalls((cb) => captured.readFile(virtual, cb));
    assert.equal(read.length, 1, 'one callback');
    assert.equal(read[0][0].code, 'ENOENT');
    await assert.rejects(captured.promisesReadFile(virtual), {
      code: 'ENOENT',
    });
    await assert.rejects(NATIVE.promisesReadFile(virtual), { code: 'ENOENT' });
    assert.throws(() => captured.opendirSync(at('mem')), { code: 'ENOENT' });
  });

  it('opendir: managed while installed, native after — captured or not', async () => {
    const native = captured.opendirSync(root);
    assert.ok(native instanceof fs.Dir);
    const names = [];
    for await (const entry of native) names.push(entry.name);
    assert.deepEqual(names.sort(), ['pub', 'stray']);
    const viaCallback = await callbackCalls((cb) =>
      captured.opendir(at('pub'), cb),
    );
    assert.equal(viaCallback.length, 1);
    assert.ok(viaCallback[0][1] instanceof fs.Dir);
    viaCallback[0][1].closeSync();
    const viaPromise = await captured.promisesOpendir(at('pub'));
    assert.ok(viaPromise instanceof fs.Dir);
    await viaPromise.close();
    assert.ok(NATIVE.opendirSync(root) instanceof fs.Dir);
  });

  it('glob: native again, including the functions it kept from the patch', async () => {
    const expected = ['pub', 'stray'];
    assert.deepEqual(slashed(fs.globSync('*', { cwd: root })).sort(), expected);
    assert.deepEqual(
      slashed(captured.globSync('*', { cwd: root })).sort(),
      expected,
    );
    const viaCallback = await callbackCalls((cb) =>
      captured.glob('*', { cwd: root }, cb),
    );
    assert.equal(viaCallback.length, 1);
    assert.deepEqual(slashed(viaCallback[0][1]).sort(), expected);
    const collected = [];
    for await (const entry of captured.promisesGlob('*', { cwd: root })) {
      collected.push(entry);
    }
    assert.deepEqual(slashed(collected).sort(), expected);
    assert.deepEqual(slashed(fs.globSync('stray/*', { cwd: root })), [
      'stray/x.txt',
    ]);
    // glob first used while installed walks with the patched functions:
    // routed then (a virtual entry shows, an unmanaged one does not), node:fs
    // after uninstall — not an empty result from a swallowed TypeError.
    const script = path.join(__dirname, 'fixtures', 'glob-kept.cjs');
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), {
      loadedBefore: false,
      installed: { virtual: ['mem/m.txt'], top: ['mem', 'pub'] },
      uninstalled: ['pub', 'stray'],
    });
  });

  it('never reaches a kernel that is gone', () => {
    const closed = [];
    for (const name of ['routeRead', 'routeMutation', 'fs', 'rootEntries']) {
      k[name] = () => closed.push(name);
    }
    assert.equal(
      captured.readFileSync(at('pub', 'index.html'), 'utf8'),
      '<h1>disk</h1>',
    );
    assert.equal(captured.existsSync(at('pub')), true);
    captured.opendirSync(root).closeSync();
    captured.globSync('**', { cwd: root });
    assert.deepEqual(closed, []);
  });

  it('install → uninstall → install → uninstall leaves no chain', async () => {
    const first = captured.readFileSync;
    const k2 = await kernel(root, { pub: { fs: { ext: ['html'] } } });
    try {
      fsPatch.install(k2);
      const second = fs.readFileSync;
      assert.notEqual(second, first);
      assert.notEqual(second, NATIVE.readFileSync);
      fsPatch.install(k2); // already installed: no second layer
      assert.equal(fs.readFileSync, second);
      // An older reference follows the kernel installed now.
      const page = at('pub', 'index.html');
      assert.equal(first(page, 'utf8'), '<h1>disk</h1>');
      assert.equal(second(page, 'utf8'), '<h1>disk</h1>');
      writeDisk(page, '<h1>disk 2</h1>');
      assert.equal(first(page, 'utf8'), '<h1>disk</h1>', 'k2 keeps its VFS');
      fsPatch.uninstall();
      assert.equal(fs.readFileSync, NATIVE.readFileSync);
      assert.equal(first(page, 'utf8'), '<h1>disk 2</h1>');
      assert.equal(second(page, 'utf8'), '<h1>disk 2</h1>');
      fsPatch.uninstall(); // twice: nothing left to undo
      assert.equal(fs.readFileSync, NATIVE.readFileSync);
    } finally {
      fsPatch.uninstall();
      k2.close();
    }
  });
});
