'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel, worker } = require('./helpers.js');

// Disk access behind the VFS's back: captured before any patch is installed.
const {
  writeFileSync: writeDisk,
  readFileSync: readDisk,
  existsSync: onDisk,
} = fs;

// A rename routes both of its paths. On disk it moves the raw file — the
// source of truth of a disk-origin place, prepared or not — and the watchers
// republish both ends: the old canonical entry goes, the new key follows the
// policy of its own place and extension. A hidden source stays EACCES: no
// new name makes it readable. In a virtual place a rename moves an ordinary
// entry, whose canonical bytes are its raw input, and refuses a prepared one
// (ENOTSUP); across a virtual boundary it is EXDEV. A directory moves within
// one disk-origin place, never across an indexed place's boundary or as its
// root (ENOTSUP); in a virtual place a subtree of raw sources moves whole,
// any other stays whole (ENOTSUP).

const calls = { upper: 0, wrap: 0, mark: 0 };
const PREPARERS = {
  upper: (raw) => {
    calls.upper++;
    return raw.toString().toUpperCase();
  },
  wrap: (raw) => {
    calls.wrap++;
    return `[${raw.toString()}]`;
  },
  mark: (raw) => {
    calls.mark++;
    return `marked:${raw.toString()}`;
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

// Each form of rename: resolves once done, rejects with its error.
const RENAMES = {
  renameSync: (from, to) => fs.renameSync(from, to),
  rename: (from, to) =>
    new Promise((resolve, reject) => {
      fs.rename(from, to, (err) => (err ? reject(err) : resolve()));
    }),
  'promises.rename': (from, to) => fs.promises.rename(from, to),
};
// A shared virtual place mutates asynchronously: only these forms reach it.
const { renameSync, ...ASYNC } = RENAMES;

// A refusal names the operation, its source and its destination.
const refusal = (err, code, from, to) => {
  assert.equal(err.code, code, err.message ?? String(err));
  assert.equal(err.syscall, 'rename');
  assert.equal(err.path, from);
  assert.equal(err.dest, to);
};

describe('rename routes its source and its destination', () => {
  let base;
  let root;
  let out;
  let k;
  let n = 0;
  const at = (...p) => path.join(root, ...p);
  const fresh = (name = 'f.txt') => path.join(out, `${++n}-${name}`);

  // One watcher epoch, as the directory watcher delivers it.
  const epoch = async (...events) => {
    k.watcher.emit('epoch', new Map(events));
    await k.watchQueue.idle;
  };

  // Every form refuses with `code`, names both paths and moves nothing.
  const refusedEverywhere = async (from, to, code, forms = RENAMES) => {
    for (const [form, rename] of Object.entries(forms)) {
      refusal(await outcome(() => rename(from, to)), code, from, to);
      assert.equal(onDisk(to), false, `${form}: nothing moved`);
    }
  };

  before(async () => {
    base = writeTree(tmpDir('vfs-rename'), {
      'app/wd/a.txt': 'alpha',
      'app/wd/b.txt': 'bravo',
      'app/wd/c.txt': 'charlie',
      'app/wd/d.txt': 'delta',
      'app/wd/e.txt': 'echo',
      'app/wd/pages/p.txt': 'page',
      'app/wd/media/clip.mp4': 'MP4',
      'app/wd2/keep.txt': 'keep',
      'app/ro/r.txt': 'r',
      'app/closed/keep.txt': 'keep',
      'app/closed/raw.png': 'hidden',
      'app/closed/rawdir/x.png': 'hidden',
      'app/files/d/f.txt': 'f',
      'app/nd/d/n.txt': 'n',
      'app/stray/s.txt': 'stray',
      'outside/dir/o.txt': 'o',
    });
    root = path.join(base, 'app');
    out = tmpDir('vfs-rename-out');
    k = await kernel(
      root,
      {
        wd: {
          fs: {
            ext: ['txt', 'html'],
            writable: true,
            fallback: 'disk',
            prepare: { upper: ['txt'], wrap: ['html'] },
          },
        },
        wd2: { fs: { ext: ['txt'], writable: true, prepare: 'mark' } },
        ro: { fs: { ext: ['txt'] } },
        closed: { fs: { ext: ['txt'], writable: true, fallback: 'deny' } },
        vs: {
          origin: 'virtual',
          fs: { writable: true, ext: ['txt', 'js'], prepare: { wrap: ['js'] } },
        },
        vs2: { origin: 'virtual', fs: { writable: true } },
        vm: { provider: 'map', origin: 'virtual', fs: { writable: true } },
        files: { provider: 'disk', fs: { writable: true } },
        nd: { provider: 'node-default', fs: true },
      },
      { strict: true, watch: true, watchTimeout: 60000 },
      { preparers: PREPARERS },
    );
    // A cached extension written after the scan: never published.
    writeDisk(at('wd', 'late.txt'), 'unpublished');
    fsPatch.install(k);
  });

  after(() => {
    fsPatch.uninstall();
    k.close();
    rm(base);
    rm(out);
  });

  it('a hidden source is EACCES: no new name makes it readable', async () => {
    for (const [from, to] of [
      // A cached raw file never published: another extension, or outside.
      [at('wd', 'late.txt'), at('wd', 'late.png')],
      [at('wd', 'late.txt'), fresh('late.txt')],
      // An unmanaged path under strict routing.
      [at('stray', 's.txt'), fresh('s.txt')],
      // A miss of `fs.fallback: 'deny'`.
      [at('closed', 'raw.png'), at('closed', 'raw.txt')],
    ]) {
      await refusedEverywhere(from, to, 'EACCES');
      assert.ok(onDisk(from), 'the source stays');
    }
    assert.throws(() => fs.readFileSync(at('wd', 'late.txt')), {
      code: 'EACCES',
    });
  });

  it('a published disk-origin file moves out of appRoot as its raw source', async () => {
    const from = at('wd', 'a.txt');
    assert.equal(fs.readFileSync(from, 'utf8'), 'ALPHA', 'served prepared');
    const to = fresh('a.txt');
    fs.renameSync(from, to);
    assert.equal(readDisk(to, 'utf8'), 'alpha', 'outside: the raw source');
    assert.equal(onDisk(from), false);
    await epoch([from, 'delete']);
    assert.equal(k.fs('wd').exists('/a.txt'), false, 'the old entry is gone');
  });

  it('an extension change moves the raw file into the policy of its new extension', async () => {
    const { upper, wrap } = calls;
    fs.renameSync(at('wd', 'b.txt'), at('wd', 'b.png'));
    await fs.promises.rename(at('wd', 'c.txt'), at('wd', 'c.html'));
    await epoch(
      [at('wd', 'b.txt'), 'delete'],
      [at('wd', 'b.png'), 'change'],
      [at('wd', 'c.txt'), 'delete'],
      [at('wd', 'c.html'), 'change'],
    );
    // .png is not cached: the disk territory serves the raw file.
    assert.equal(fs.readFileSync(at('wd', 'b.png'), 'utf8'), 'bravo');
    // .html has a preparer of its own: the watcher publishes through it.
    assert.equal(fs.readFileSync(at('wd', 'c.html'), 'utf8'), '[charlie]');
    assert.equal(calls.wrap, wrap + 1, 'the destination prepares once');
    assert.equal(calls.upper, upper, 'the source preparer never runs again');
    for (const key of ['/b.txt', '/c.txt']) {
      assert.equal(k.fs('wd').exists(key), false, `${key}: the old entry`);
    }
  });

  it('a refused destination moves nothing', async () => {
    const from = at('wd', 'd.txt');
    for (const [to, code] of [
      [at('stray', 'd.txt'), 'EACCES'],
      [path.join(root, 'd.txt'), 'EACCES'],
      [at('ro', 'd.txt'), 'EROFS'],
    ]) {
      await refusedEverywhere(from, to, code);
    }
    assert.equal(readDisk(from, 'utf8'), 'delta');
    assert.equal(fs.readFileSync(from, 'utf8'), 'DELTA', 'still published');
    // A read-only place gives nothing up either.
    await refusedEverywhere(at('ro', 'r.txt'), fresh(), 'EROFS');
  });

  it('places on disk share one filesystem; a virtual boundary is EXDEV', async () => {
    const mark = calls.mark;
    fs.renameSync(at('wd', 'e.txt'), at('wd2', 'e.txt'));
    await epoch([at('wd', 'e.txt'), 'delete'], [at('wd2', 'e.txt'), 'change']);
    assert.equal(fs.readFileSync(at('wd2', 'e.txt'), 'utf8'), 'marked:echo');
    assert.equal(calls.mark, mark + 1, "the destination's preparer");
    assert.equal(k.fs('wd').exists('/e.txt'), false);
    // Across a virtual boundary a rename would be a copy and a delete.
    await k.fs('vs').writeFile('/x.txt', 'x');
    for (const [from, to] of [
      [at('vs', 'x.txt'), at('vs2', 'x.txt')],
      [at('vs', 'x.txt'), at('vm', 'x.txt')],
      [at('vs', 'x.txt'), at('wd', 'x.txt')],
      [at('vs', 'x.txt'), fresh()],
      [at('wd', 'd.txt'), at('vs', 'd.txt')],
    ]) {
      await refusedEverywhere(from, to, 'EXDEV', ASYNC);
    }
    assert.equal(fs.readFileSync(at('vs', 'x.txt'), 'utf8'), 'x');
    assert.equal(k.fs('vs2').exists('/x.txt'), false);
    assert.equal(k.fs('vm').exists('/x.txt'), false);
    assert.equal(k.fs('vs').exists('/d.txt'), false);
    assert.equal(readDisk(at('wd', 'd.txt'), 'utf8'), 'delta');
  });

  it('an ordinary virtual entry moves atomically and keeps its mtime', async () => {
    await k.fs('vs').writeFile('/o.txt', 'ordinary');
    const written = fs.statSync(at('vs', 'o.txt'));
    const realNow = Date.now;
    // However late the rename, the entry keeps the time of its write.
    Date.now = () => realNow() + 60_000;
    try {
      await fs.promises.rename(at('vs', 'o.txt'), at('vs', 'sub', 'o2.txt'));
    } finally {
      Date.now = realNow;
    }
    const moved = at('vs', 'sub', 'o2.txt');
    assert.equal(fs.readFileSync(moved, 'utf8'), 'ordinary');
    assert.equal(fs.statSync(moved).mtimeMs, written.mtimeMs);
    assert.equal(k.fs('vs').exists('/o.txt'), false);
    // A local virtual place moves synchronously as well.
    k.fs('vm').writeFile('/m.txt', 'map');
    fs.renameSync(at('vm', 'm.txt'), at('vm', 'n.txt'));
    assert.equal(fs.readFileSync(at('vm', 'n.txt'), 'utf8'), 'map');
    assert.equal(k.fs('vm').exists('/m.txt'), false);
  });

  it('an ordinary virtual entry renamed to a prepared extension is prepared once', async () => {
    await k.fs('vs').writeFile('/r.txt', 'raw');
    const { wrap } = calls;
    await fs.promises.rename(at('vs', 'r.txt'), at('vs', 'r.js'));
    assert.equal(fs.readFileSync(at('vs', 'r.js'), 'utf8'), '[raw]');
    assert.equal(calls.wrap, wrap + 1);
    assert.equal(k.fs('vs').exists('/r.txt'), false);
  });

  it('a prepared virtual entry has no raw input to move', async () => {
    await k.fs('vs').writeFile('/p.js', 'p');
    const { wrap } = calls;
    const from = at('vs', 'p.js');
    for (const to of [at('vs', 'q.js'), at('vs', 'p.txt')]) {
      await refusedEverywhere(from, to, 'ENOTSUP', ASYNC);
    }
    assert.equal(fs.readFileSync(from, 'utf8'), '[p]');
    assert.equal(k.fs('vs').exists('/q.js'), false);
    assert.equal(k.fs('vs').exists('/p.txt'), false);
    assert.equal(calls.wrap, wrap, 'nothing is prepared again');
    // A worker gets the same refusal from the main kernel.
    const w = worker(k);
    try {
      const err = await outcome(() =>
        w.kernel.fs('vs').rename('/p.js', '/q.js'),
      );
      refusal(err, 'ENOTSUP', from, at('vs', 'q.js'));
    } finally {
      w.kernel.close();
    }
  });

  it('a disk directory moves within one disk-origin place, never across one', async () => {
    const unrelated = path.join(base, 'outside', 'dir');
    for (const [from, to] of [
      [at('wd', 'pages'), fresh('pages')],
      [at('wd', 'media'), fresh('media')],
      [at('wd', 'pages'), at('wd2', 'pages')],
      [at('wd'), fresh('wd')],
      [unrelated, at('wd', 'dir')],
    ]) {
      await refusedEverywhere(from, to, 'ENOTSUP');
      assert.ok(onDisk(from), 'the source stays');
    }
    // A directory strict routing hides stays hidden.
    await refusedEverywhere(at('closed', 'rawdir'), fresh('rawdir'), 'EACCES');
    // Within its place, or outside the indexed ones, a directory is node:fs.
    fs.renameSync(at('wd', 'pages'), at('wd', 'docs'));
    assert.equal(readDisk(at('wd', 'docs', 'p.txt'), 'utf8'), 'page');
    fs.renameSync(at('wd', 'docs'), at('wd', 'pages'));
    fs.renameSync(unrelated, `${unrelated}2`);
    fs.renameSync(`${unrelated}2`, unrelated);
    assert.equal(readDisk(path.join(unrelated, 'o.txt'), 'utf8'), 'o');
    for (const name of ['files', 'nd']) {
      const moved = fresh(name);
      fs.renameSync(at(name, 'd'), moved);
      fs.renameSync(moved, at(name, 'd'));
      fs.renameSync(at(name), moved);
      fs.renameSync(moved, at(name));
      assert.ok(onDisk(at(name, 'd')), name);
    }
  });

  it('a raw-only virtual subtree moves; any other subtree stays whole', async () => {
    const vs = k.fs('vs');
    const vm = k.fs('vm');
    for (const [form, rename] of Object.entries(RENAMES)) {
      const places = form === 'renameSync' ? [vm] : [vs, vm];
      for (const place of places) {
        const name = place === vs ? 'vs' : 'vm';
        await place.writeFile(`/${form}/a.txt`, 'a');
        await place.writeFile(`/${form}/sub/b.txt`, 'b');
        await rename(at(name, form), at(name, `${form}-moved`));
        assert.equal(place.readFile(`/${form}-moved/sub/b.txt`, 'utf8'), 'b');
        assert.equal(place.exists(`/${form}`), false, `${name}: ${form}`);
      }
    }
    // One prepared source refuses the whole subtree: nothing moves.
    await vs.writeFile('/mixed/t.txt', 't');
    await vs.writeFile('/mixed/p.js', 'p');
    await refusedEverywhere(
      at('vs', 'mixed'),
      at('vs', 'other'),
      'ENOTSUP',
      ASYNC,
    );
    assert.equal(vs.readFile('/mixed/t.txt', 'utf8'), 't');
    assert.equal(vs.exists('/other'), false);
    // The place's own directory never moves; a virtual boundary is EXDEV.
    await refusedEverywhere(at('vs'), at('vs', 'x'), 'ENOTSUP', ASYNC);
    await refusedEverywhere(at('vm'), fresh('vm'), 'ENOTSUP');
    await vm.writeFile('/cross/c.txt', 'c');
    await refusedEverywhere(
      at('vm', 'cross'),
      at('vs', 'cross'),
      'EXDEV',
      ASYNC,
    );
    assert.equal(vm.readFile('/cross/c.txt', 'utf8'), 'c');
  });

  it('every form renames; a callback runs once', async () => {
    for (const [form, rename] of Object.entries(RENAMES)) {
      // A file from outside enters a place as its raw source.
      const from = fresh();
      writeDisk(from, form);
      const to = at('wd', `${form}.txt`);
      await rename(from, to);
      assert.equal(readDisk(to, 'utf8'), form);
      await epoch([to, 'change']);
      assert.equal(fs.readFileSync(to, 'utf8'), form.toUpperCase());
      k.fs('vm').writeFile(`/${form}.txt`, form);
      await rename(at('vm', `${form}.txt`), at('vm', `${form}-moved.txt`));
      assert.equal(k.fs('vm').readFile(`/${form}-moved.txt`, 'utf8'), form);
    }
    // A shared virtual place cannot be changed synchronously.
    const sync = await outcome(() =>
      renameSync(at('vs', 'x.txt'), at('vs', 'y.txt')),
    );
    refusal(sync, 'ENOTSUP', at('vs', 'x.txt'), at('vs', 'y.txt'));
    const done = await callbackCalls((cb) =>
      fs.rename(at('vs', 'x.txt'), at('vs', 'y.txt'), cb),
    );
    assert.deepEqual(done, [[null]]);
    const refused = await callbackCalls((cb) =>
      fs.rename(at('wd', 'late.txt'), fresh(), cb),
    );
    assert.equal(refused.length, 1);
    assert.equal(refused[0][0].code, 'EACCES');
  });
});
