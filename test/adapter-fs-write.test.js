'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VfsConfig } = require('../lib/config.js');
const { VFSKernel } = require('../lib/kernel.js');
const fsPatch = require('../lib/adapters/fs-patch.js');

const APP_ROOT = path.resolve(os.tmpdir(), `vfs-fswrite-${process.pid}`);

const buildKernel = async () => {
  const config = new VfsConfig({
    defaults: {
      memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
      hooks: { fs: false, require: false, import: false },
    },
    places: {
      mem: { domains: ['fs'], match: { dir: 'mem' }, provider: 'memory' },
      stat: {
        domains: ['fs'],
        match: { dir: 'stat' },
        provider: 'sab',
      },
    },
  });
  const k = new VFSKernel(config, { appRoot: APP_ROOT });
  await k.initialize();
  return k;
};

describe('fs-patch: write paths', () => {
  let kernel;

  before(() => fs.mkdirSync(path.join(APP_ROOT, 'stat'), { recursive: true }));
  after(() => fs.rmSync(APP_ROOT, { recursive: true, force: true }));

  beforeEach(async () => {
    if (kernel) {
      fsPatch.uninstall();
      kernel.close();
    }
    kernel = await buildKernel();
    fsPatch.install(kernel);
  });

  after(() => {
    fsPatch.uninstall();
    if (kernel) kernel.close();
  });

  it('writeFileSync routes string data to memory place', () => {
    const p = path.join(APP_ROOT, 'mem', 'a.txt');
    fs.writeFileSync(p, 'hello');
    const place = kernel.getPlace('mem');
    assert.equal(place.readFile('/a.txt').toString(), 'hello');
  });

  it('writeFileSync routes Buffer data to memory place', () => {
    const p = path.join(APP_ROOT, 'mem', 'b.bin');
    fs.writeFileSync(p, Buffer.from([1, 2, 3]));
    const data = kernel.getPlace('mem').readFile('/b.bin');
    assert.deepEqual(Array.from(data), [1, 2, 3]);
  });

  it('writeFile (callback) routes to memory place', (t, done) => {
    const p = path.join(APP_ROOT, 'mem', 'c.txt');
    fs.writeFile(p, 'async', (err) => {
      assert.equal(err, null);
      assert.equal(
        kernel.getPlace('mem').readFile('/c.txt').toString(),
        'async',
      );
      done();
    });
  });

  it('promises.writeFile routes to memory place', async () => {
    const p = path.join(APP_ROOT, 'mem', 'd.txt');
    await fs.promises.writeFile(p, 'promise');
    assert.equal(
      kernel.getPlace('mem').readFile('/d.txt').toString(),
      'promise',
    );
  });

  it('unlinkSync removes from memory place', () => {
    const p = path.join(APP_ROOT, 'mem', 'e.txt');
    fs.writeFileSync(p, 'x');
    assert.equal(kernel.getPlace('mem').exists('/e.txt'), true);
    fs.unlinkSync(p);
    assert.equal(kernel.getPlace('mem').exists('/e.txt'), false);
  });

  it('unlinkSync throws ENOENT when file absent in memory place', () => {
    const p = path.join(APP_ROOT, 'mem', 'missing.txt');
    assert.throws(() => fs.unlinkSync(p), { code: 'ENOENT' });
  });

  it('unlink (callback) removes from memory place', (t, done) => {
    const p = path.join(APP_ROOT, 'mem', 'f.txt');
    fs.writeFileSync(p, 'x');
    fs.unlink(p, (err) => {
      assert.equal(err, null);
      assert.equal(kernel.getPlace('mem').exists('/f.txt'), false);
      done();
    });
  });

  it('promises.unlink removes from memory place', async () => {
    const p = path.join(APP_ROOT, 'mem', 'g.txt');
    fs.writeFileSync(p, 'x');
    await fs.promises.unlink(p);
    assert.equal(kernel.getPlace('mem').exists('/g.txt'), false);
  });

  it('mkdirSync is a no-op for memory mount paths', () => {
    const p = path.join(APP_ROOT, 'mem', 'subdir');
    // Memory places have flat key namespace — mkdir should not throw and
    // should not create anything on disk.
    fs.mkdirSync(p, { recursive: true });
    assert.equal(fs.existsSync(p), false);
  });

  it('writes to non-memory mount fall through to original fs', () => {
    const p = path.join(APP_ROOT, 'stat', 'real.txt');
    fs.writeFileSync(p, 'on disk');
    // Stat is a sab place (read-only); write must hit the actual disk.
    assert.equal(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), 'on disk');
  });
});

describe('fs-patch: read paths', () => {
  let kernel;

  before(() => {
    fs.mkdirSync(path.join(APP_ROOT, 'stat'), { recursive: true });
    fs.writeFileSync(
      path.join(APP_ROOT, 'stat', 'big.bin'),
      Buffer.alloc(200, 7),
    );
  });

  beforeEach(async () => {
    if (kernel) {
      fsPatch.uninstall();
      kernel.close();
    }
    kernel = await buildKernel();
    fsPatch.install(kernel);
  });

  after(() => {
    fsPatch.uninstall();
    if (kernel) kernel.close();
  });

  it('createReadStream streams SAB-backed file', async () => {
    const p = path.join(APP_ROOT, 'stat', 'big.bin');
    const stream = fs.createReadStream(p);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const got = Buffer.concat(chunks);
    assert.equal(got.length, 200);
    assert.equal(got[0], 7);
    assert.equal(got[199], 7);
  });

  it('createReadStream supports start/end options', async () => {
    const p = path.join(APP_ROOT, 'stat', 'big.bin');
    const stream = fs.createReadStream(p, { start: 10, end: 19 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 10);
  });

  it('createReadStream falls through for non-VFS paths', async () => {
    const real = path.join(os.tmpdir(), `vfs-passthrough-${process.pid}.txt`);
    fs.writeFileSync(real, 'passthrough');
    try {
      const stream = fs.createReadStream(real);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), 'passthrough');
    } finally {
      fs.unlinkSync(real);
    }
  });
});
