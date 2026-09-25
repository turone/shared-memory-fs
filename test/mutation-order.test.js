'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { tmpDir, rm, kernel, until } = require('./helpers.js');

// Per-key mutation ordering on sab+virtual places: every scenario is a
// deterministic assertion, not a printed log.

const settle = (p) =>
  p.then(
    () => ({ ok: true }),
    (e) => ({ ok: false, code: e.code }),
  );

describe('mutation ordering: same key', () => {
  it('two writes: publication and settlement follow arrival order', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    const seen = [];
    const w1 = v.writeFile('/a.txt', 'one').then(() => seen.push('A'));
    const w2 = v.writeFile('/a.txt', 'two').then(() => seen.push('B'));
    await Promise.all([w1, w2]);
    assert.deepEqual(seen, ['A', 'B']);
    assert.equal(v.readFile('/a.txt', 'utf8'), 'two');
    k.close();
    rm(root);
  });

  it('a slow publication of A holds the key: a ready B never overtakes it', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    const gateA = Promise.withResolvers();
    const original = k.publishVirtual.bind(k);
    let first = true;
    // Deterministically slow down only the *first* commit reaching the
    // allocator (A's), without touching the synchronous preparer contract:
    // the mutation queue itself must be what keeps B from overtaking it.
    k.publishVirtual = async (place, key, raw) => {
      if (first) {
        first = false;
        await gateA.promise;
      }
      return original(place, key, raw);
    };
    const order = [];
    const a = v.writeFile('/g.txt', 'A').then(() => order.push('A'));
    const b = v.writeFile('/g.txt', 'B').then(() => order.push('B'));
    // Give B every chance to race ahead before releasing A.
    await new Promise((r) => setImmediate(r));
    assert.equal(order.length, 0, 'neither has published yet');
    gateA.resolve();
    await Promise.all([a, b]);
    assert.deepEqual(order, ['A', 'B']);
    assert.equal(v.readFile('/g.txt', 'utf8'), 'B');
    k.close();
    rm(root);
  });

  it('write then unlink: entry is gone', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    const [w, u] = await Promise.all([
      settle(v.writeFile('/b.txt', 'x')),
      settle(v.unlink('/b.txt')),
    ]);
    assert.equal(w.ok, true);
    assert.equal(u.ok, true);
    assert.equal(v.exists('/b.txt'), false);
    k.close();
    rm(root);
  });

  it('unlink(ENOENT) then write: entry exists with the new content', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    const [u, w] = await Promise.all([
      settle(v.unlink('/c.txt')),
      settle(v.writeFile('/c.txt', 'c')),
    ]);
    assert.equal(u.ok, false);
    assert.equal(u.code, 'ENOENT');
    assert.equal(w.ok, true);
    assert.equal(v.readFile('/c.txt', 'utf8'), 'c');
    k.close();
    rm(root);
  });

  it('a failed mutation does not block a following write of the same key', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    const [failed, wrote] = await Promise.all([
      settle(v.rename('/gone.txt', '/nope.txt')),
      settle(v.writeFile('/gone.txt', 'after failure')),
    ]);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'ENOENT');
    assert.equal(wrote.ok, true);
    assert.equal(v.readFile('/gone.txt', 'utf8'), 'after failure');
    assert.equal(k.mutations.size, 0);
    k.close();
    rm(root);
  });

  it('two workers writing the same key: order = arrival at main, one update each', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const first = k.nextUpdateId;
    const WORKER = `
      const { parentPort } = require('node:worker_threads');
      const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
      const kernel = attach();
      parentPort.on('message', async (msg) => {
        try {
          await kernel.fs('v').writeFile(msg.key, msg.data);
          parentPort.postMessage({ ok: true });
        } catch (err) {
          parentPort.postMessage({ ok: false, code: err.code });
        }
      });
      parentPort.postMessage('ready');
    `;
    const spawn = () => {
      const { vfs, transferList } = k.link();
      return new Worker(WORKER, {
        eval: true,
        workerData: { vfs },
        transferList,
      });
    };
    const ready = (w) =>
      new Promise((resolve, reject) => {
        w.once('message', resolve);
        w.once('error', reject);
      });
    const ask = (w, msg) =>
      new Promise((resolve, reject) => {
        w.once('message', resolve);
        w.once('error', reject);
        w.postMessage(msg);
      });
    const w1 = spawn();
    const w2 = spawn();
    await Promise.all([ready(w1), ready(w2)]);
    const [r1, r2] = await Promise.all([
      ask(w1, { key: '/shared.txt', data: 'from-1' }),
      ask(w2, { key: '/shared.txt', data: 'from-2' }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const v = k.fs('v');
    assert.ok(['from-1', 'from-2'].includes(v.readFile('/shared.txt', 'utf8')));
    assert.equal(
      k.nextUpdateId - first,
      2,
      'no coalescing: one update per accepted mutation',
    );
    await w1.terminate();
    await w2.terminate();
    k.close();
    rm(root);
  });
});

describe('mutation ordering: independent keys', () => {
  it('a slow key does not block a fast, unrelated key', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    const gateSlow = Promise.withResolvers();
    const original = k.publishVirtual.bind(k);
    let first = true;
    // Gate only the first publication reaching the allocator (slow.txt's,
    // issued first below), the same way as the same-key test above: the
    // queue itself, not a timer, must be what lets /fast.txt through.
    k.publishVirtual = async (place, key, raw) => {
      if (first) {
        first = false;
        await gateSlow.promise;
      }
      return original(place, key, raw);
    };
    const order = [];
    const slow = v
      .writeFile('/slow.txt', 'x'.repeat(64 * 1024))
      .then(() => order.push('slow'));
    const fast = v.writeFile('/fast.txt', 'y').then(() => order.push('fast'));

    // Prove /fast.txt is fully published and its Promise settled while
    // /slow.txt is still gated — not just that both eventually finish.
    await fast;
    assert.deepEqual(
      order,
      ['fast'],
      "fast published before slow's gate opened",
    );
    assert.equal(v.readFile('/fast.txt', 'utf8'), 'y');
    assert.equal(v.exists('/slow.txt'), false, 'slow is still unpublished');

    gateSlow.resolve();
    await slow;
    assert.deepEqual(order, ['fast', 'slow']);
    assert.equal(v.readFile('/slow.txt', 'utf8').length, 64 * 1024);
    k.close();
    rm(root);
  });
});

describe('mutation ordering: rename and rm coordination', () => {
  // `require: { compile: true }` gives every source a bytecode companion,
  // so these tests can also prove no orphan companion survives.
  const compiled = {
    v: {
      origin: 'virtual',
      fs: { writable: true },
      require: { compile: true },
    },
  };
  const requireCompanion = (key) => `${key}\0require:bytecode`;

  it('rename(src→dst) racing write(dst): deterministic result, no orphan companion', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, compiled);
    const v = k.fs('v');
    await v.writeFile('/r1.js', 'src');
    // `v.rename(...)` registers the queue locks for both keys synchronously,
    // before the `v.writeFile(...)` argument next to it is even evaluated —
    // so the write is deterministically queued behind the whole rename.
    const [renamed, wrote] = await Promise.all([
      settle(v.rename('/r1.js', '/r2.js')),
      settle(v.writeFile('/r2.js', 'dst')),
    ]);
    assert.equal(renamed.ok, true);
    assert.equal(wrote.ok, true);
    assert.equal(
      v.readFile('/r2.js', 'utf8'),
      'dst',
      'write always follows the rename it raced',
    );
    assert.equal(v.exists('/r1.js'), false);
    assert.equal(
      k.registry.get('v').files.has(requireCompanion('/r1.js')),
      false,
      'no orphan companion of the renamed-away source',
    );
    assert.notEqual(
      k.registry.get('v').bytecode('/r2.js', 'require'),
      null,
      'destination has its own companion',
    );
    assert.equal(k.mutations.size, 0);
    k.close();
    rm(root);
  });

  it('two concurrent renames a→b and b→a: deterministic swap, no deadlock', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, compiled);
    const v = k.fs('v');
    await v.writeFile('/a.js', 'A');
    await v.writeFile('/b.js', 'B');
    // `rename('/a.js','/b.js')` locks both keys before `rename('/b.js','/a.js')`
    // is even evaluated, so it always runs first: /b.js is overwritten with
    // 'A', then the queued b→a moves that same content back onto /a.js.
    const [first, second] = await Promise.all([
      settle(v.rename('/a.js', '/b.js')),
      settle(v.rename('/b.js', '/a.js')),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(v.exists('/a.js'), true);
    assert.equal(v.readFile('/a.js', 'utf8'), 'A');
    assert.equal(v.exists('/b.js'), false);
    const place = k.registry.get('v');
    assert.equal(
      place.files.has(requireCompanion('/b.js')),
      false,
      'no orphan companion left on /b.js',
    );
    assert.notEqual(place.bytecode('/a.js', 'require'), null);
    assert.equal(k.mutations.size, 0);
    k.close();
    rm(root);
  });

  it('recursive rm(dir) racing write(dir/child.js): deterministic result, no orphan, no resurrection', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, compiled);
    const v = k.fs('v');
    await v.writeFile('/d/one.js', '1');
    // `rm(null, ...)` takes the exclusive place barrier synchronously before
    // `writeFile('/d/two.js', ...)` is evaluated, so the write is
    // deterministically queued behind the whole recursive removal.
    const [removed, wrote] = await Promise.all([
      settle(v.rm('/d', { recursive: true })),
      settle(v.writeFile('/d/two.js', '2')),
    ]);
    assert.equal(removed.ok, true);
    assert.equal(wrote.ok, true);
    assert.deepEqual(
      v.readdir('/d'),
      ['two.js'],
      'the write always follows the rm it raced',
    );
    const place = k.registry.get('v');
    assert.equal(place.files.has('/d/one.js'), false);
    assert.equal(
      place.files.has(requireCompanion('/d/one.js')),
      false,
      'no orphan companion of the removed file',
    );
    assert.notEqual(place.bytecode('/d/two.js', 'require'), null);
    assert.equal(k.mutations.size, 0);
    k.close();
    rm(root);
  });

  it('an independent write outside the removed subtree is never lost', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    await v.writeFile('/d/one.txt', '1');
    await Promise.all([
      settle(v.rm('/d', { recursive: true })),
      settle(v.writeFile('/other/file.js', 'kept')),
    ]);
    assert.equal(v.readFile('/other/file.js', 'utf8'), 'kept');
    k.close();
    rm(root);
  });
});

describe('mutation lifecycle and cleanup', () => {
  it('kernel close rejects a still-queued mutation and frees the lock', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const v = k.fs('v');
    let error = null;
    const pending = v.writeFile('/late.txt', 'late').catch((err) => {
      error = err;
    });
    k.close();
    await pending;
    assert.notEqual(error, null, 'the queued write settles by rejecting');
    assert.match(error.message, /requires a ready kernel/);
    assert.equal(k.mutations.size, 0, 'no lock record survives close()');
    assert.equal(k.links.size, 0);
    assert.equal(k.acks.size, 0);
    assert.equal(k.retired.size, 0);
    rm(root);
  });

  // Regression: the link port is unref'd, so a worker with nothing else to
  // do used to exit before its own write settled.
  it('a pending worker mutation keeps the worker alive until it settles', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const WORKER = `
      const { parentPort } = require('node:worker_threads');
      const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
      attach()
        .fs('v')
        .writeFile('/alive.txt', 'x')
        .then(() => parentPort.postMessage('settled'));
    `;
    const { vfs, transferList } = k.link();
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { vfs },
      transferList,
    });
    const messages = [];
    worker.on('message', (m) => messages.push(m));
    await new Promise((resolve, reject) => {
      worker.once('exit', resolve);
      worker.once('error', reject);
    });
    assert.deepEqual(messages, ['settled'], 'settled before the worker exited');
    assert.equal(k.fs('v').readFile('/alive.txt', 'utf8'), 'x');
    k.close();
    rm(root);
  });

  it('worker exit with a pending request leaves no dangling state on main', async () => {
    const root = tmpDir('vfs-order');
    const k = await kernel(root, {
      v: { origin: 'virtual', fs: { writable: true } },
    });
    const WORKER = `
      const { parentPort } = require('node:worker_threads');
      const { attach } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
      const kernel = attach();
      parentPort.on('message', () => {
        // Fire the mutation and exit immediately, before any response.
        kernel.fs('v').writeFile('/from-worker.txt', 'x').catch(() => {});
        process.exit(0);
      });
      parentPort.postMessage('ready');
    `;
    const { vfs, transferList } = k.link();
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { vfs },
      transferList,
    });
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    worker.postMessage('go');
    await new Promise((resolve) => worker.once('exit', resolve));
    // Give the closed port's 'close' handler a turn to run handleWorkerExit,
    // and the request itself a turn to finish publishing on main.
    await until(() => k.links.size === 0 && k.mutations.size === 0, 2000);
    // The request's Promise settled (main actually published it) rather than
    // being left to hang forever once the worker that awaited it is gone.
    assert.equal(k.fs('v').exists('/from-worker.txt'), true);
    assert.equal(k.mutations.size, 0, 'no pending-request lock record left');
    assert.equal(k.links.size, 0, "the exited worker's link is gone");
    assert.equal(k.acks.size, 0, 'no ACK bookkeeping left for it');
    assert.equal(k.retired.size, 0, 'nothing retired waits for it');
    assert.equal(k.rechecks.size, 0, 'no leaked recheck timer (active handle)');
    k.close();
    rm(root);
  });
});
