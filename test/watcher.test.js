'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bytecodeKey, compressedKey } = require('../lib/companion.js');
const { tmpDir, writeTree, rm, kernel, until, sleep } = require('./helpers.js');

// Watcher tests drive real fs.watch events through the kernel pipeline.

describe('watcher pipeline', () => {
  let root;
  let k;
  let site;
  let msgs;
  const at = (...p) => path.join(root, 'site', ...p);
  const lastUpdate = () => msgs.at(-1);
  const flushed = async (count) => until(() => msgs.length >= count, 4000);

  before(async () => {
    root = writeTree(tmpDir('watch'), {
      'site/a.js': 'module.exports = 1;',
      'site/page.html': '<p>one</p>',
    });
    msgs = [];
    k = await kernel(
      root,
      { site: { fs: { compress: { encodings: ['gzip'] } }, require: true } },
      { watch: true, watchTimeout: 60 },
      { broadcast: (m) => msgs.push(m), getWorkerIds: () => ['w'] },
    );
    site = k.fs('site');
  });

  after(() => {
    k.close();
    rm(root);
  });

  const place = () => k.registry.get('site');

  it('starts because defaults.watch is on', () => {
    assert.ok(k.watcher);
    assert.equal(k.watch(), undefined, 'idempotent');
  });

  it('changed file: new source, bytecode and gzip in one vfs-update; old bytes wait for ACK', async () => {
    const oldEntry = k.cache.entry('site', '/a.js');
    fs.writeFileSync(at('a.js'), 'module.exports = 2; // changed');
    await flushed(1);
    const msg = lastUpdate();
    assert.equal(msg.name, 'vfs-update');
    assert.deepEqual(Object.keys(msg.places), ['site']);
    const keys = msg.places.site.entries.map(([key]) => key).sort();
    assert.deepEqual(
      keys,
      ['/a.js', bytecodeKey('/a.js'), compressedKey('/a.js', 'gzip')].sort(),
    );
    assert.deepEqual(msg.places.site.removals, []);
    assert.ok(msg.newSegments.length >= 1);
    assert.equal(
      site.readFile('/a.js', 'utf8'),
      'module.exports = 2; // changed',
    );
    assert.ok(place().files.has(bytecodeKey('/a.js')));
    assert.deepEqual(site.storedEncodings('/a.js'), ['raw', 'gzip']);
    const pending = k.pendingFrees.get(msg.updateId);
    assert.ok(
      pending && pending.entries.includes(oldEntry),
      'old source tracked until ACK',
    );
    k.handleAck(msg.updateId, 'w');
    assert.equal(k.pendingFrees.size, 0);
  });

  it('new directory subtree: files get bytecode and representations in the same epoch', async () => {
    const n = msgs.length;
    fs.mkdirSync(at('mod', 'deep'), { recursive: true });
    fs.writeFileSync(at('mod', 'deep', 'x.js'), 'module.exports = "x";');
    fs.writeFileSync(at('mod', 'y.html'), '<y/>');
    await until(
      () => site.exists('/mod/deep/x.js') && site.exists('/mod/y.html'),
      4000,
    );
    await sleep(150);
    const updates = msgs.slice(n);
    const entries = updates.flatMap((m) =>
      m.places.site.entries.map(([key]) => key),
    );
    assert.ok(entries.includes(bytecodeKey('/mod/deep/x.js')));
    assert.ok(entries.includes(compressedKey('/mod/y.html', 'gzip')));
    assert.equal(
      new Set(entries).size,
      entries.length,
      'no duplicate publications',
    );
    for (const m of updates) k.handleAck(m.updateId, 'w');
  });

  it('syntax error: source published, stale bytecode removed in the same message', async () => {
    const n = msgs.length;
    fs.writeFileSync(at('a.js'), 'module.exports = (;');
    await until(
      () => site.readFile('/a.js', 'utf8') === 'module.exports = (;',
      4000,
    );
    const msg = msgs[n];
    assert.ok(msg.places.site.entries.some(([key]) => key === '/a.js'));
    assert.ok(msg.places.site.removals.includes(bytecodeKey('/a.js')));
    assert.ok(!place().files.has(bytecodeKey('/a.js')));
    assert.deepEqual(site.storedEncodings('/a.js'), ['raw', 'gzip']);
    for (const m of msgs.slice(n)) k.handleAck(m.updateId, 'w');
  });

  it('deleting a directory removes sources and companions in one message', async () => {
    const n = msgs.length;
    fs.rmSync(at('mod'), { recursive: true });
    await until(() => !site.exists('/mod'), 4000);
    const removals = msgs.slice(n).flatMap((m) => m.places.site.removals);
    assert.ok(removals.includes('/mod/deep/x.js'));
    assert.ok(removals.includes(bytecodeKey('/mod/deep/x.js')));
    assert.ok(removals.includes(compressedKey('/mod/y.html', 'gzip')));
    assert.ok(!place().files.has(bytecodeKey('/mod/deep/x.js')));
    assert.deepEqual(site.readdir('/'), ['a.js', 'page.html']);
    for (const m of msgs.slice(n)) k.handleAck(m.updateId, 'w');
  });

  it('files outside scanExt never enter the pipeline', async () => {
    const root2 = writeTree(tmpDir('watch-ext'), { 'site/a.html': '<a/>' });
    const seen = [];
    const k2 = await kernel(
      root2,
      { site: { fs: { ext: ['html'] } } },
      { watch: true, watchTimeout: 60 },
      { broadcast: (m) => seen.push(m) },
    );
    fs.writeFileSync(path.join(root2, 'site', 'ignored.bin'), 'xx');
    fs.writeFileSync(path.join(root2, 'site', 'b.html'), '<b/>');
    await until(() => k2.fs('site').exists('/b.html'), 4000);
    await sleep(200);
    assert.ok(!k2.fs('site').exists('/ignored.bin'));
    const keys = seen.flatMap((m) => m.places.site.entries.map(([key]) => key));
    assert.deepEqual(keys, ['/b.html']);
    k2.close();
    rm(root2);
  });
});

// Regression: delete and re-create inside one debounce window are two stats
// racing on the threadpool; when the ENOENT one lands last the epoch carries
// 'delete' for a path that exists again. It must not unpublish a live file.
describe('watcher: stale delete event', () => {
  it('re-checks the path before unpublishing', async () => {
    const root = writeTree(tmpDir('watch-stale'), { 'site/a.txt': 'v1' });
    const k = await kernel(
      root,
      { site: { fs: true } },
      { watch: true, watchTimeout: 50 },
    );
    const site = k.fs('site');
    const abs = path.join(root, 'site', 'a.txt');
    k.watcher.emit('epoch', new Map([[abs, 'delete']]));
    await sleep(200);
    assert.equal(site.exists('/a.txt'), true, 'live file survives');
    assert.equal(site.readFile('/a.txt', 'utf8'), 'v1');
    // A delete of a path that is really gone still unpublishes.
    fs.unlinkSync(abs);
    k.watcher.emit('epoch', new Map([[abs, 'delete']]));
    await until(() => !site.exists('/a.txt'), 2000);
    assert.equal(site.exists('/a.txt'), false);
    k.close();
    rm(root);
  });
});

describe('watcher: unstable source', () => {
  it('keeps the previous version, rechecks once, never loops', async () => {
    const root = writeTree(tmpDir('watch-unstable'), { 'site/a.txt': 'v1' });
    const warnings = [];
    const k = await kernel(
      root,
      { site: { fs: true } },
      { watch: true, watchTimeout: 60 },
      {
        console: {
          warn: (m) => warnings.push(m),
          error: () => {},
          log: () => {},
        },
      },
    );
    const site = k.fs('site');
    // Force the stable-read check to fail: every read sees a "changed" file.
    const realOpen = k.cache.reader;
    let attempts = 0;
    k.cache.reader = async () => {
      attempts++;
      throw new Error('source changed during read');
    };
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'v2');
    await until(() => attempts >= 1, 4000);
    await until(() => attempts >= 2, 4000);
    await sleep(400);
    assert.equal(
      attempts,
      2,
      'one event attempt + exactly one deferred recheck',
    );
    assert.equal(site.readFile('/a.txt', 'utf8'), 'v1', 'old version retained');
    assert.ok(warnings.some((w) => /not published/.test(w)));
    k.cache.reader = realOpen;
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'v3');
    await until(() => site.readFile('/a.txt', 'utf8') === 'v3', 4000);
    k.close();
    rm(root);
  });
});

describe('readInto: stable source reads', () => {
  const { readInto } = require('../lib/kernel.js');

  it('reads exactly stat.size bytes and refuses drift', async () => {
    const root = writeTree(tmpDir('readinto'), { 'a.txt': 'hello' });
    const file = path.join(root, 'a.txt');
    const { size, mtimeMs } = fs.statSync(file);
    const view = new Uint8Array(size);
    await readInto({ path: file, stat: { size, mtimeMs } }, view);
    assert.equal(Buffer.from(view).toString(), 'hello');
    await assert.rejects(
      readInto({ path: file, stat: { size: 99, mtimeMs } }, new Uint8Array(99)),
      /source changed/,
    );
    await assert.rejects(
      readInto(
        { path: file, stat: { size, mtimeMs: 1 } },
        new Uint8Array(size),
      ),
      /source changed/,
    );
    await assert.rejects(
      readInto(
        { path: path.join(root, 'nope'), stat: { size, mtimeMs } },
        view,
      ),
      { code: 'ENOENT' },
    );
    rm(root);
  });
});
