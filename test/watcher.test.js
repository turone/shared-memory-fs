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

  it('an unstable file does not block the rest of the epoch', async () => {
    const root = writeTree(tmpDir('watch-partial'), {
      'site/a.txt': 'a1',
      'site/b.txt': 'b1',
    });
    const k = await kernel(
      root,
      { site: { fs: true } },
      { watch: true, watchTimeout: 60 },
    );
    const site = k.fs('site');
    const realOpen = k.cache.reader;
    k.cache.reader = async (file, view) => {
      if (
        file.path.endsWith(`${path.sep}a.txt`) ||
        file.path.endsWith('/a.txt')
      ) {
        throw new Error('source changed during read');
      }
      return realOpen(file, view);
    };
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'a2');
    fs.writeFileSync(path.join(root, 'site', 'b.txt'), 'b2');
    await until(() => site.readFile('/b.txt', 'utf8') === 'b2', 4000);
    assert.equal(
      site.readFile('/a.txt', 'utf8'),
      'a1',
      'failed source retained',
    );
    assert.equal(
      site.readFile('/b.txt', 'utf8'),
      'b2',
      'stable sibling published',
    );
    k.close();
    rm(root);
  });
});

describe('watcher: linux edge events', () => {
  it('staged writes, rename, delete+recreate, and close drop handles', async () => {
    const root = writeTree(tmpDir('watch-edges'), {
      'site/a.js': 'module.exports = 1;',
      'site/page.html': '<p>one</p>',
    });
    const k = await kernel(
      root,
      { site: { fs: true, require: true } },
      { watch: true, watchTimeout: 60 },
    );
    const site = k.fs('site');
    const at = (...p) => path.join(root, 'site', ...p);

    const fd = fs.openSync(at('page.html'), 'w');
    fs.writeSync(fd, '<p>');
    fs.writeSync(fd, 'two');
    fs.writeSync(fd, '</p>');
    fs.closeSync(fd);
    await until(
      () => site.readFile('/page.html', 'utf8') === '<p>two</p>',
      4000,
    );

    fs.renameSync(at('a.js'), at('z.js'));
    await until(() => site.exists('/z.js') && !site.exists('/a.js'), 4000);
    assert.equal(site.readFile('/z.js', 'utf8'), 'module.exports = 1;');

    fs.unlinkSync(at('page.html'));
    fs.writeFileSync(at('page.html'), '<p>new</p>');
    await until(
      () => site.readFile('/page.html', 'utf8') === '<p>new</p>',
      4000,
    );

    const handles = k.watcher.watchers.size;
    assert.ok(handles >= 1);
    k.close();
    assert.equal(k.watcher, null);
    rm(root);
  });
});

// Regression (nodejs/node#63638): libuv's recursive fs.watch on Windows aborts
// the process when the watched path carries an 8.3 alias segment, so the
// watcher hands fs.watch the long form. It must expand aliases at any depth,
// and it must never invent a path it did not resolve -- the earlier heuristic
// rewrote the alias to os.homedir() and so pointed at a different profile.
describe('DirWatcher: 8.3 alias roots', () => {
  const os = require('node:os');
  const { execFileSync, spawnSync } = require('node:child_process');
  const { watchPath } = require('../lib/watcher.js');
  const win = process.platform === 'win32';

  // The 8.3 alias of `dir`, or null when the volume has 8.3 names disabled.
  // The `dir` header is localized, the short-name column is not.
  const aliasOf = (dir) => {
    const parent = path.dirname(dir);
    const name = path.basename(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = execFileSync('cmd', ['/c', 'dir', '/x', '/a:d', parent], {
      encoding: 'utf8',
    });
    const re = new RegExp(`\\s(\\S*~\\d\\S*)\\s+${name}\\s*$`, 'm');
    const found = out.match(re);
    return found ? path.join(parent, found[1]) : null;
  };

  it('passes ordinary paths through unchanged', () => {
    // GHA Windows TEMP is C:\Users\RUNNER~1\... — that is an alias root,
    // not an ordinary path. Probe a long-name directory that has no ~N.
    const ordinary = win
      ? path.join(path.parse(os.homedir()).root, 'Users', 'Public', 'vfs-plain')
      : path.join(os.tmpdir(), 'vfs-plain');
    assert.equal(watchPath(ordinary), path.resolve(ordinary));
    assert.equal(
      watchPath(path.join(ordinary, 'sub', '..')),
      path.resolve(ordinary),
    );
  });

  it('never guesses: an alias it cannot resolve is left alone', (t) => {
    if (!win) {
      t.skip('windows only');
      return;
    }
    // The shape the old heuristic remapped onto os.homedir(): a profile
    // directory that is not ours. Watching it would be the wrong tree.
    // UNC and other drives take the same route -- the OS resolves them or
    // the path is returned untouched; nothing is ever rewritten by pattern.
    const foreign = path.join(path.dirname(os.homedir()), 'OTHERU~1', 'data');
    assert.equal(watchPath(foreign), foreign);
  });

  it('expands an alias mid-path onto the same directory', (t) => {
    if (!win) {
      t.skip('windows only');
      return;
    }
    const root = writeTree(tmpDir('watch-alias'), { 'site/a.txt': 'a' });
    const alias = aliasOf(root);
    if (!alias) {
      rm(root);
      t.skip('8.3 names disabled on this volume');
      return;
    }
    // C:\...\WATCH-~1\site -- the alias is a parent, as with RUNNER~1 on CI.
    const viaAlias = watchPath(path.join(alias, 'site'));
    assert.ok(!/~\d/.test(viaAlias), `still short: ${viaAlias}`);
    assert.equal(viaAlias, watchPath(path.join(root, 'site')));
    rm(root);
  });

  it('watches through an alias root without aborting', (t) => {
    if (!win) {
      t.skip('windows only');
      return;
    }
    const root = writeTree(tmpDir('watch-abort'), { 'site/deep/a.txt': 'a' });
    const alias = aliasOf(root);
    if (!alias) {
      rm(root);
      t.skip('8.3 names disabled on this volume');
      return;
    }
    // The abort would take the test reporter with it, so the watch runs in a
    // child process and its exit code is the assertion.
    const module = JSON.stringify(require.resolve('../lib/watcher.js'));
    const child = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { DirWatcher } = require(${module});
      const [alias, root] = process.argv.slice(1);
      const watcher = new DirWatcher({ timeout: 30 });
      watcher.on('error', () => {});
      watcher.on('epoch', () => {});
      watcher.watch(alias);
      setTimeout(() => {
        fs.writeFileSync(path.join(root, 'site', 'deep', 'b.txt'), 'b');
        setTimeout(() => watcher.close(), 600);
      }, 200);
    `;
    const res = spawnSync(process.execPath, ['-e', child, alias, root], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `libuv abort: ${res.stderr}`);
    rm(root);
  });
});

describe('DirWatcher.close', () => {
  it('drops watchers, the debounce timer and the queued epoch', async () => {
    const { DirWatcher } = require('../lib/watcher.js');
    const root = writeTree(tmpDir('watch-close'), { 'a.txt': 'a' });
    const watcher = new DirWatcher({ timeout: 5000 });
    watcher.watch(root);
    assert.equal(watcher.watchers.size, 1);
    fs.writeFileSync(path.join(root, 'b.txt'), 'b');
    await until(() => watcher.queue.size >= 1 || watcher.timer, 2000);
    watcher.close();
    assert.equal(watcher.watchers.size, 0);
    assert.equal(watcher.timer, null);
    assert.equal(watcher.queue.size, 0);
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
