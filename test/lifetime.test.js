'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { Writable, pipeline } = require('node:stream');
const { Worker } = require('node:worker_threads');
const {
  tmpDir,
  rm,
  kernel,
  drain,
  tap,
  worker,
  nextEvent,
  nextMessage,
} = require('./helpers.js');

// Lifetime of shared allocations: a direct consumer (stream, view lease)
// pins the version it started with; an update publishes the new version
// for new readers, retires the old one, and its bytes are freed only after
// every worker ACKed and no consumer holds it. Deterministic: consumers are
// driven by hand, workers are in-thread links unless stated otherwise.

const NOOP = () => {};

// A sab + virtual place: writes are awaited publications, and with no
// linked worker a retired version is freed as soon as nothing holds it.
const virtual = async (fs = {}) => {
  const root = tmpDir('vfs-life');
  const k = await kernel(root, {
    v: { origin: 'virtual', fs: { writable: true, ...fs } },
  });
  const done = () => {
    k.close();
    rm(root);
  };
  return { k, v: k.fs('v'), done };
};

const readAll = async (iterator, first) => {
  const chunks = [first];
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

// Calls of k.handleRelease — every release that reached the main kernel.
const spyReleases = (k) => {
  const calls = [];
  const handleRelease = k.handleRelease.bind(k);
  k.handleRelease = (holder, ids) => {
    calls.push([holder, ids]);
    return handleRelease(holder, ids);
  };
  return calls;
};

const spyFrees = (k) => {
  const freed = [];
  const free = k.cache.free.bind(k.cache);
  k.cache.free = (entry) => {
    freed.push(entry);
    free(entry);
  };
  return freed;
};

describe('lifetime: a stream keeps reading its version', () => {
  for (const zeroCopy of [false, true]) {
    it(`never reads bytes of another file (zeroCopy: ${zeroCopy})`, async () => {
      const { k, v, done } = await virtual({ zeroCopy });
      await v.writeFile('/a.txt', 'A'.repeat(64));
      const stream = v.createReadStream('/a.txt', { highWaterMark: 16 });
      const iterator = stream[Symbol.asyncIterator]();
      const { value: first } = await iterator.next();
      // Retires the old extent, then offers the allocator the same size.
      await v.writeFile('/a.txt', 'C'.repeat(32));
      await v.writeFile('/b.txt', 'B'.repeat(64));
      const all = await readAll(iterator, first);
      assert.equal(all.toString(), 'A'.repeat(64));
      assert.equal(v.readFile('/b.txt', 'utf8'), 'B'.repeat(64));
      if (zeroCopy) {
        assert.equal(k.retired.size, 1, 'borrowed chunks hold it');
        stream.release();
      }
      assert.equal(k.retired.size, 0, 'freed once the consumer is done');
      done();
    });
  }

  it('a compressed stream never reads bytes of another file', async () => {
    const { k, v, done } = await virtual({
      compress: { encodings: ['gzip'] },
    });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const gz = v.readFileCompressed('/a.txt', 'gzip');
    const stream = v.createReadStreamCompressed('/a.txt', 'gzip', {
      highWaterMark: 4,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const { value: first } = await iterator.next();
    await v.writeFile('/a.txt', 'C'.repeat(32));
    // Unpinned, the freed source and gzip extents would merge and this exact
    // fit would reuse both; the stream's pin keeps the gzip bytes in place.
    await v.writeFile('/b.txt', 'B'.repeat(64 + gz.length));
    assert.deepEqual(await readAll(iterator, first), gz);
    assert.equal(k.retired.size, 0);
    done();
  });

  it('finishes the old version while a new stream reads the new one', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(48));
    const old = v.createReadStream('/a.txt', { highWaterMark: 16 });
    const iterator = old[Symbol.asyncIterator]();
    const { value: first } = await iterator.next();
    await v.writeFile('/a.txt', 'B'.repeat(48));
    const fresh = await drain(v.createReadStream('/a.txt'));
    assert.equal(fresh.toString(), 'B'.repeat(48));
    assert.equal((await readAll(iterator, first)).toString(), 'A'.repeat(48));
    assert.equal(k.retired.size, 0);
    done();
  });
});

describe('lifetime: one record per version', () => {
  it('several consumers share one record and one release', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(48));
    const releases = spyReleases(k);
    const borrowed = v.createReadStream('/a.txt');
    const owned = v.createReadStream('/a.txt', { zeroCopy: false });
    const lease = v.readFileView('/a.txt');
    assert.equal(k.pins.size, 1, 'one local record for the version');
    await v.writeFile('/a.txt', 'B'.repeat(48));
    const [record] = k.retirements();
    assert.equal(k.retired.size, 1);
    assert.deepEqual(record.holders, ['main']);
    assert.equal(record.representation, 'source');
    assert.equal(record.bytes, 48);
    assert.equal(record.waiting, 'release');
    assert.match(record.label, /^v:\/a\.txt#\d+$/);
    assert.equal((await drain(owned)).toString(), 'A'.repeat(48));
    borrowed.release();
    assert.equal(releases.length, 0, 'the lease still reads it');
    lease.release();
    assert.deepEqual(releases, [['main', [record.id]]]);
    assert.equal(k.retired.size, 0);
    done();
  });

  it('a worker reports a retired version once and releases it once', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(48));
    const w = worker(k);
    const inbox = [];
    w.main.on('message', (m) => inbox.push(m));
    const wv = w.kernel.fs('v');
    const s1 = wv.createReadStream('/a.txt');
    const s2 = wv.createReadStream('/a.txt');
    const acked = nextMessage(w.main);
    await v.writeFile('/a.txt', 'B'.repeat(48));
    await acked;
    const [ack] = inbox;
    assert.equal(ack.name, 'vfs-ack');
    assert.equal(ack.retained.length, 1);
    const [record] = k.retirements();
    assert.deepEqual(record.holders, [w.id]);
    assert.equal(record.id, ack.retained[0]);
    s1.release();
    const released = nextMessage(w.main);
    s2.release();
    await released;
    const releases = inbox.filter((m) => m.name === 'vfs-release');
    assert.equal(releases.length, 1, 'nothing was sent for the first stream');
    assert.deepEqual(releases[0].retireIds, ack.retained);
    assert.equal(k.retired.size, 0, 'freed after the ACK and the release');
    w.kernel.close();
    done();
  });
});

describe('lifetime: view leases', () => {
  it('a lease keeps its bytes until release, then the extent is reused', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(32));
    const { segmentId, offset } = k.cache.entry('v', '/a.txt');
    const lease = v.readFileView('/a.txt');
    await v.writeFile('/a.txt', 'B'.repeat(32));
    await v.writeFile('/c.txt', 'C'.repeat(32));
    assert.equal(lease.view.toString(), 'A'.repeat(32));
    assert.equal(v.readFile('/a.txt', 'utf8'), 'B'.repeat(32), 'new readers');
    lease.release();
    lease.release();
    lease[Symbol.dispose]();
    assert.equal(k.retired.size, 0);
    await v.writeFile('/d.txt', 'D'.repeat(32));
    const d = k.cache.entry('v', '/d.txt');
    assert.deepEqual([d.segmentId, d.offset], [segmentId, offset]);
    done();
  });

  it('withFileView holds the lease for the callback, sync or async', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(16));
    let calls = 0;
    const missing = await v.withFileView('/nope', () => calls++);
    assert.equal(missing, null);
    assert.equal(calls, 0);
    assert.equal(await v.withFileView('/a.txt', (view) => view.length), 16);
    const result = await v.withFileView('/a.txt', async (view) => {
      assert.equal(k.pins.size, 1);
      await v.writeFile('/a.txt', 'B'.repeat(16));
      await v.writeFile('/b.txt', 'X'.repeat(16));
      return view.toString();
    });
    assert.equal(result, 'A'.repeat(16));
    assert.equal(k.pins.size, 0);
    assert.equal(k.retired.size, 0);
    await assert.rejects(
      v.withFileView('/a.txt', () => {
        throw new Error('inside');
      }),
      /inside/,
    );
    assert.equal(k.pins.size, 0, 'released on error too');
    done();
  });

  it('a compressed lease pins only its own representation', async () => {
    const { k, v, done } = await virtual({
      zeroCopy: true,
      compress: { encodings: ['gzip', 'br'] },
    });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const lease = v.readFileCompressedView('/a.txt', 'gzip');
    const stream = v.createReadStreamCompressed('/a.txt', 'br', {
      zeroCopy: false,
      highWaterMark: 4,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const { value: first } = await iterator.next();
    await v.writeFile('/a.txt', 'C'.repeat(64));
    const held = k.retirements().map((r) => r.representation);
    assert.deepEqual(held.sort(), ['fs:br', 'fs:gzip'], 'the source is free');
    assert.match(
      k.retirements().find((r) => r.representation === 'fs:gzip').label,
      /^v:\/a\.txt \[fs:gzip\]#\d+$/,
    );
    await readAll(iterator, first);
    lease.release();
    assert.equal(k.retired.size, 0);
    done();
  });

  it('a representation nobody reads is not held', async () => {
    const { k, v, done } = await virtual({
      zeroCopy: true,
      compress: { encodings: ['gzip', 'br'] },
    });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const lease = v.readFileCompressedView('/a.txt', 'gzip');
    await v.writeFile('/a.txt', 'C'.repeat(64));
    assert.deepEqual(
      k.retirements().map((r) => r.representation),
      ['fs:gzip'],
      'the source and br are free at once',
    );
    lease.release();
    assert.equal(k.retired.size, 0);
    done();
  });

  it('zero-copy chunks need fs.zeroCopy on the place', async () => {
    const { v, done } = await virtual({ compress: { encodings: ['gzip'] } });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    assert.throws(() => v.createReadStream('/a.txt', { zeroCopy: true }), {
      code: 'ENOTSUP',
    });
    assert.throws(
      () => v.createReadStreamCompressed('/a.txt', 'gzip', { zeroCopy: true }),
      { code: 'ENOTSUP' },
    );
    const owned = v.createReadStream('/a.txt', { zeroCopy: false });
    assert.equal(Buffer.concat(await owned.toArray()).length, 64);
    done();
  });
});

describe('lifetime: ACK ordering', () => {
  for (const order of ['release before the last ACK', 'the last ACK first']) {
    it(`retain in the ACK, then ${order}: one safe free`, async () => {
      const { k, v, done } = await virtual();
      await v.writeFile('/a.txt', 'A'.repeat(16));
      const w1 = tap(k, { ack: false });
      const w2 = tap(k, { ack: false });
      const freed = spyFrees(k);
      await v.writeFile('/a.txt', 'B'.repeat(16));
      const updateId = k.nextUpdateId;
      const [{ id }] = k.retirements();
      k.handleAck(updateId, w1.id, [id]);
      assert.equal(freed.length, 0, 'nothing is freed before every ACK');
      if (order === 'the last ACK first') {
        k.handleAck(updateId, w2.id);
        assert.equal(freed.length, 0, 'w1 still reads it');
        assert.equal(k.retirements()[0].waiting, 'release');
        k.handleRelease(w1.id, [id]);
      } else {
        k.handleRelease(w1.id, [id]);
        assert.equal(freed.length, 0, 'w2 has not ACKed');
        assert.equal(k.retirements()[0].waiting, 'ack');
        k.handleAck(updateId, w2.id);
      }
      assert.equal(freed.length, 1);
      k.handleRelease(w1.id, [id]);
      k.handleAck(updateId, w2.id);
      assert.equal(freed.length, 1, 'never twice');
      assert.equal(k.acks.size, 0);
      done();
    });
  }
});

describe('lifetime: worker exit', () => {
  it('a closed link drops its ACKs and holds', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const w = worker(k);
    const reading = w.kernel.fs('v').createReadStream('/a.txt');
    const acked = nextMessage(w.main);
    await v.writeFile('/a.txt', 'B'.repeat(64));
    await acked;
    assert.deepEqual(k.retirements()[0].holders, [w.id]);
    const closed = nextEvent(w.main, 'close');
    w.port.close();
    await closed;
    assert.equal(k.retired.size, 0, 'no leak');
    assert.equal(k.links.size, 0);
    reading.destroy();
    w.kernel.close();
    done();
  });

  it('a worker thread that exits mid-stream releases what it held', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(64 * 1024));
    const { vfs, transferList } = k.link();
    const id = [...k.links.keys()].at(-1);
    const port = k.links.get(id);
    const index = JSON.stringify(path.resolve(__dirname, '../index.js'));
    const thread = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      const { attach } = require(${index});
      const stream = attach().fs('v').createReadStream('/a.txt', {
        highWaterMark: 1024,
      });
      stream.once('readable', () => {
        stream.read(1024);
        parentPort.postMessage('reading');
      });
      parentPort.on('message', () => {});
      `,
      { eval: true, workerData: { vfs }, transferList },
    );
    await once(thread, 'message');
    const acked = nextMessage(port);
    await v.writeFile('/a.txt', 'B'.repeat(64 * 1024));
    await acked;
    const [record] = k.retirements();
    assert.deepEqual(record.holders, [id]);
    assert.equal(record.waiting, 'release');
    const closed = nextEvent(port, 'close');
    await thread.terminate();
    await closed;
    assert.equal(k.retired.size, 0);
    done();
  });
});

describe('lifetime: stream cleanup', () => {
  it('destroy, error and AbortSignal release owned-chunk streams once', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const releases = spyReleases(k);
    const destroyed = v.createReadStream('/a.txt');
    const failed = v.createReadStream('/a.txt');
    failed.on('error', NOOP);
    const ac = new AbortController();
    const aborted = v.createReadStream('/a.txt', { signal: ac.signal });
    aborted.on('error', NOOP);
    await v.writeFile('/a.txt', 'B'.repeat(64));
    destroyed.destroy();
    failed.destroy(new Error('boom'));
    assert.equal(releases.length, 0, 'the aborted stream still reads it');
    ac.abort();
    assert.equal(releases.length, 1);
    destroyed.destroy();
    destroyed.release();
    failed.release();
    aborted[Symbol.dispose]();
    assert.equal(releases.length, 1, 'repeated cleanup releases nothing');
    assert.equal(k.retired.size, 0);
    assert.equal(k.pins.size, 0);
    done();
  });

  it('borrowed chunks outlive the end of the stream until release()', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const stream = v.createReadStream('/a.txt', { highWaterMark: 16 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(chunks[0].buffer instanceof SharedArrayBuffer);
    await v.writeFile('/a.txt', 'B'.repeat(64));
    await v.writeFile('/b.txt', 'X'.repeat(64));
    assert.equal(Buffer.concat(chunks).toString(), 'A'.repeat(64));
    assert.equal(k.retired.size, 1, 'a downstream socket may still hold them');
    stream.release();
    stream.release();
    assert.equal(k.retired.size, 0);
    done();
  });

  it('release() stops an active stream first', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const stream = v.createReadStream('/a.txt', { highWaterMark: 16 });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    stream.release();
    assert.ok(stream.destroyed);
    assert.equal(k.pins.size, 0);
    done();
  });

  it('pipeline() destroys the source when the destination fails', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(256));
    const source = v.createReadStream('/a.txt', { highWaterMark: 16 });
    const sink = new Writable({
      write(chunk, encoding, callback) {
        callback(new Error('client gone'));
      },
    });
    await assert.rejects(
      new Promise((resolve, reject) =>
        pipeline(source, sink, (err) => (err ? reject(err) : resolve())),
      ),
      /client gone/,
    );
    assert.ok(source.destroyed);
    assert.equal(k.pins.size, 0);
    done();
  });

  it('manual pipe(): a destroyed destination leaves the source to the caller', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(256));
    const source = v.createReadStream('/a.txt', { highWaterMark: 16 });
    // Never acknowledges a write: the source pauses on backpressure.
    const sink = new Writable({ highWaterMark: 1, write() {} });
    source.pipe(sink);
    await once(source, 'pause');
    const closed = once(sink, 'close');
    sink.destroy();
    await closed;
    assert.equal(source.destroyed, false, 'pipe() does not destroy it');
    assert.equal(k.pins.size, 1);
    source.destroy();
    assert.equal(k.pins.size, 0);
    done();
  });

  it('close() stops active streams', async () => {
    const { k, v, done } = await virtual();
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const stream = v.createReadStream('/a.txt', { highWaterMark: 16 });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    k.close();
    await assert.rejects(iterator.next(), { code: 'ERR_VFS_CLOSED' });
    assert.equal(k.pins.size, 0);
    done();
  });
});

describe('lifetime: compaction', () => {
  it('never moves or reuses a pinned retired extent', async () => {
    const KB = 1024;
    const root = tmpDir('vfs-life');
    const k = await kernel(
      root,
      { v: { origin: 'virtual', fs: { writable: true } } },
      {
        memory: { limit: '16 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
        compaction: { threshold: 0.5 },
      },
    );
    const v = k.fs('v');
    await v.writeFile('/a', Buffer.alloc(2 * KB, 'a'));
    await v.writeFile('/b', Buffer.alloc(2 * KB, 'b'));
    await v.writeFile('/c', Buffer.alloc(200, 'c'));
    await v.writeFile('/d', Buffer.alloc(100, 'd'));
    assert.equal(k.cache.entry('v', '/d').segmentId, 2);
    const stream = v.createReadStream('/d', { highWaterMark: 10 });
    const iterator = stream[Symbol.asyncIterator]();
    const { value: first } = await iterator.next();
    await v.unlink('/d');
    assert.equal(k.retired.size, 1, '/d is pinned');
    // Freeing /a makes segment 2 the compaction target: /c moves out, the
    // retired /d stays where it is and the segment stays closed.
    await v.unlink('/a');
    assert.equal(k.cache.entry('v', '/c').segmentId, 1, '/c relocated');
    assert.equal(v.readFile('/c', 'utf8'), 'c'.repeat(200));
    assert.ok(k.cache.registry.closed.has(2), 'closed, not reused');
    await v.writeFile('/e', Buffer.alloc(100, 'e'));
    assert.notEqual(k.cache.entry('v', '/e').segmentId, 2);
    assert.equal((await readAll(iterator, first)).toString(), 'd'.repeat(100));
    assert.equal(k.retired.size, 0);
    assert.ok(k.cache.pool.emptySegmentIds.has(2), 'reclaimable after release');
    k.close();
    rm(root);
  });
});

describe('lifetime: fast path', () => {
  it('no update, no IPC: pins of current versions stay local', async () => {
    const { k, v, done } = await virtual({ zeroCopy: true });
    await v.writeFile('/a.txt', 'A'.repeat(64));
    const releases = spyReleases(k);
    const w = worker(k);
    const inbox = [];
    w.main.on('message', (m) => inbox.push(m));
    const wv = w.kernel.fs('v');
    await drain(wv.createReadStream('/a.txt', { zeroCopy: false }));
    const stream = wv.createReadStream('/a.txt');
    await drain(stream);
    stream.release();
    wv.readFileView('/a.txt').release();
    assert.equal(await wv.withFileView('/a.txt', (view) => view.length), 64);
    await drain(v.createReadStream('/a.txt', { zeroCopy: false }));
    v.readFileView('/a.txt').release();
    assert.equal(w.kernel.pins.size, 0);
    // FIFO port: a marker sent now arrives after anything sent before it.
    const marker = nextMessage(w.main);
    w.port.postMessage({ name: 'marker' });
    await marker;
    assert.deepEqual(
      inbox.map((m) => m.name),
      ['marker'],
    );
    assert.deepEqual(releases, []);
    assert.equal(k.retired.size, 0);
    assert.equal(k.nextRetireId, 0, 'no retirement record was needed');
    w.kernel.close();
    done();
  });

  it('map places need no pins: an owned Buffer outlives any update', async () => {
    const root = tmpDir('vfs-life');
    const k = await kernel(root, {
      m: {
        provider: 'map',
        origin: 'virtual',
        fs: { writable: true, zeroCopy: true },
      },
    });
    const m = k.fs('m');
    m.writeFile('/a.txt', 'A'.repeat(32));
    const lease = m.readFileView('/a.txt');
    const stream = m.createReadStream('/a.txt', { highWaterMark: 8 });
    const iterator = stream[Symbol.asyncIterator]();
    const { value: first } = await iterator.next();
    assert.equal(k.pins.size, 0);
    m.writeFile('/a.txt', 'B'.repeat(32));
    assert.equal(lease.view.toString(), 'A'.repeat(32));
    assert.equal((await readAll(iterator, first)).toString(), 'A'.repeat(32));
    lease.release();
    stream.release();
    assert.equal(k.nextRetireId, 0, 'no retirement protocol for Map entries');
    k.close();
    rm(root);
  });
});
