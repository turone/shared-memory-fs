'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { VfsConfig, VFSKernel } = require('../index.js');

const SOURCE = 'body { color: red; }\n'.repeat(40);
const PAGE = '<html><body>hello</body></html>\n'.repeat(20);
const BINARY = Buffer.from(
  Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256),
);

const silentConsole = { debug() {}, error() {}, log() {}, warn() {} };

const waitFor = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
};

let tmpDir;

const makeKernel = (compress, extra = {}) => {
  const config = new VfsConfig({
    places: {
      static: {
        domains: ['fs'],
        dir: 'static',
        provider: 'sab',
        compress,
        ...extra,
      },
    },
  });
  return new VFSKernel(config, { appRoot: tmpDir, console: silentConsole });
};

describe('compression', () => {
  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vfs-compress-'));
    const dir = path.join(tmpDir, 'static');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'style.css'), SOURCE);
    await fsp.writeFile(path.join(dir, 'index.html'), PAGE);
    await fsp.writeFile(path.join(dir, 'movie.mp4'), BINARY);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('representations', () => {
    it('round-trips every codec', async () => {
      const kernel = makeKernel({
        encodings: ['br', 'gzip', 'deflate', 'zstd'],
      });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      const decode = {
        br: zlib.brotliDecompressSync,
        gzip: zlib.gunzipSync,
        deflate: zlib.inflateSync,
        zstd: zlib.zstdDecompressSync,
      };
      for (const [encoding, fn] of Object.entries(decode)) {
        const data = place.readFileCompressed('/style.css', encoding);
        assert.ok(Buffer.isBuffer(data), `${encoding} missing`);
        assert.equal(fn(data).toString(), SOURCE);
      }
      kernel.close();
    });

    it('keeps compressed bytes in SAB', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      const data = place.readFileCompressed('/style.css', 'br');
      assert.ok(data.buffer instanceof SharedArrayBuffer);
      kernel.close();
    });

    it('returns null for an encoding that is not stored', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.equal(place.readFileCompressed('/style.css', 'gzip'), null);
      assert.equal(place.statCompressed('/style.css', 'gzip'), null);
      kernel.close();
    });

    it('exposes compressed stat with source metadata', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      const stat = place.statCompressed('/style.css', 'br');
      const raw = place.stat('/style.css');
      assert.equal(stat.encoding, 'br');
      assert.equal(stat.sourceSize, raw.size);
      assert.equal(stat.mtimeMs, raw.mtimeMs);
      assert.ok(stat.size > 0);
      assert.ok(stat.size < stat.sourceSize);
      kernel.close();
    });

    it('lists stored encodings, raw first', async () => {
      const kernel = makeKernel({ encodings: ['br', 'gzip'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.deepEqual(place.storedEncodings('/style.css'), [
        'raw',
        'br',
        'gzip',
      ]);
      assert.deepEqual(place.storedEncodings('/nope.css'), []);
      kernel.close();
    });
  });

  describe('options', () => {
    it('honours an explicit level', async () => {
      const fast = makeKernel({
        encodings: ['br'],
        options: { br: { level: 0 } },
      });
      const best = makeKernel({
        encodings: ['br'],
        options: { br: { level: 11 } },
      });
      await fast.initialize();
      await best.initialize();
      const fastSize = fast
        .getPlace('static')
        .statCompressed('/style.css', 'br').size;
      const bestSize = best
        .getPlace('static')
        .statCompressed('/style.css', 'br').size;
      assert.ok(bestSize < fastSize, `${bestSize} !< ${fastSize}`);
      fast.close();
      best.close();
    });
  });

  describe('file selection', () => {
    it('compresses only the configured extensions', async () => {
      const kernel = makeKernel({ encodings: ['br'], ext: ['css'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.ok(place.readFileCompressed('/style.css', 'br'));
      assert.equal(place.readFileCompressed('/index.html', 'br'), null);
      assert.equal(place.readFileCompressed('/movie.mp4', 'br'), null);
      kernel.close();
    });

    it('compresses every file when ext is omitted', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.ok(place.readFileCompressed('/index.html', 'br'));
      assert.ok(place.readFileCompressed('/movie.mp4', 'br'));
      kernel.close();
    });

    it('expands the compressible alias', async () => {
      const kernel = makeKernel({ encodings: ['br'], ext: 'compressible' });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.ok(place.readFileCompressed('/style.css', 'br'));
      assert.ok(place.readFileCompressed('/index.html', 'br'));
      assert.equal(place.readFileCompressed('/movie.mp4', 'br'), null);
      kernel.close();
    });
  });

  describe('retainRaw: false', () => {
    const config = () => ({
      encodings: ['br'],
      ext: ['css'],
      retainRaw: false,
    });

    it('keeps the source on disk and the representation in SAB', async () => {
      const kernel = makeKernel(config());
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.equal(place.readFile('/style.css'), null);
      assert.equal(place.createReadStream('/style.css'), null);
      assert.equal(
        place.filePath('/style.css'),
        path.join(tmpDir, 'static', 'style.css'),
      );
      assert.equal(place.stat('/style.css').size, SOURCE.length);
      assert.ok(place.readFileCompressed('/style.css', 'br'));
      assert.deepEqual(place.storedEncodings('/style.css'), ['br']);
      kernel.close();
    });

    it('leaves files outside compress.ext raw in SAB', async () => {
      const kernel = makeKernel(config());
      await kernel.initialize();
      const place = kernel.getPlace('static');
      const data = place.readFile('/movie.mp4');
      assert.ok(Buffer.isBuffer(data));
      assert.ok(data.buffer instanceof SharedArrayBuffer);
      assert.deepEqual(place.storedEncodings('/movie.mp4'), ['raw']);
      kernel.close();
    });
  });

  describe('streaming', () => {
    it('streams a byte range of the chosen representation', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      const full = place.readFileCompressed('/style.css', 'br');
      const stream = place.createReadStreamCompressed('/style.css', 'br', {
        start: 2,
        end: 9,
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), full.subarray(2, 10));
      kernel.close();
    });

    it('returns null for an encoding that is not stored', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.equal(
        place.createReadStreamCompressed('/style.css', 'gzip'),
        null,
      );
      kernel.close();
    });
  });

  describe('companions stay internal', () => {
    it('are hidden from list, exists and pathIndex', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      const keys = place.list('/');
      assert.ok(keys.every((k) => !k.includes('\u0000')));
      assert.equal(place.exists('/style.css\u0000br'), false);
      const abs = path.join(tmpDir, 'static', 'style.css\u0000br');
      assert.equal(kernel.pathIndex.has(abs), false);
      kernel.close();
    });
  });

  describe('worker projection', () => {
    it('propagates representations through the snapshot', async () => {
      const raw = {
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
            compress: { encodings: ['br'] },
          },
        },
      };
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const worker = VFSKernel.fromSnapshot(
        kernel.snapshot(),
        new VfsConfig(raw),
        { appRoot: tmpDir, console: silentConsole },
      );
      const place = worker.getPlace('static');
      const data = place.readFileCompressed('/style.css', 'br');
      assert.ok(data.buffer instanceof SharedArrayBuffer);
      assert.equal(zlib.brotliDecompressSync(data).toString(), SOURCE);
      kernel.close();
      worker.close();
    });
  });

  describe('allocation failure', () => {
    it('warns and skips the representation that does not fit', async () => {
      const warnings = [];
      const config = new VfsConfig({
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
            maxFileSize: 200,
            compress: { encodings: ['br'], ext: ['mp4'] },
          },
        },
      });
      const kernel = new VFSKernel(config, {
        appRoot: tmpDir,
        console: { ...silentConsole, warn: (m) => warnings.push(m) },
      });
      await kernel.initialize();
      const place = kernel.getPlace('static');
      assert.equal(place.readFileCompressed('/movie.mp4', 'br'), null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /static/);
      assert.match(warnings[0], /movie\.mp4/);
      assert.match(warnings[0], /br/);
      assert.match(warnings[0], /does not fit/);
      kernel.close();
    });
  });

  describe('worker delta', () => {
    const workerConfig = () =>
      new VfsConfig({
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
            compress: { encodings: ['br'] },
          },
        },
      });

    it('drops a stale representation named in removals', async () => {
      const kernel = makeKernel({ encodings: ['br'] });
      await kernel.initialize();
      const worker = VFSKernel.fromSnapshot(kernel.snapshot(), workerConfig(), {
        appRoot: tmpDir,
        console: silentConsole,
      });
      const place = worker.getPlace('static');
      assert.ok(place.readFileCompressed('/style.css', 'br'));

      const entry = kernel.cache.filesystems.static.entries.get('/style.css');
      worker.handleDelta({
        name: 'file-update',
        target: 'static',
        updateId: 1,
        updates: [['/style.css', entry]],
        removals: ['/style.css\u0000br'],
        newSegments: [],
      });

      assert.equal(place.readFileCompressed('/style.css', 'br'), null);
      assert.deepEqual(place.storedEncodings('/style.css'), ['raw']);
      kernel.close();
      worker.close();
    });
  });

  describe('watcher', () => {
    let watchDir;

    before(async () => {
      watchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vfs-watch-'));
      await fsp.mkdir(path.join(watchDir, 'static'), { recursive: true });
      await fsp.writeFile(path.join(watchDir, 'static', 'style.css'), SOURCE);
    });

    after(() => {
      fs.rmSync(watchDir, { recursive: true, force: true });
    });

    it('republishes source and representations in one message', async () => {
      const messages = [];
      const config = new VfsConfig({
        defaults: { watchTimeout: 30 },
        places: {
          static: {
            domains: ['fs'],
            dir: 'static',
            provider: 'sab',
            compress: { encodings: ['br'] },
          },
        },
      });
      const kernel = new VFSKernel(config, {
        appRoot: watchDir,
        console: silentConsole,
        broadcast: (msg) => messages.push(msg),
      });
      await kernel.initialize();
      kernel.watch();

      const updated = SOURCE + 'p { margin: 0; }\n';
      await fsp.writeFile(path.join(watchDir, 'static', 'style.css'), updated);
      await waitFor(() => messages.some((m) => m.name === 'file-update'));

      const msg = messages.find((m) => m.name === 'file-update');
      assert.ok(msg, 'no file-update broadcast');
      const keys = msg.updates.map(([key]) => key);
      assert.ok(keys.includes('/style.css'));
      assert.ok(keys.includes('/style.css\u0000br'));

      const place = kernel.getPlace('static');
      assert.equal(place.readFile('/style.css').toString(), updated);
      const br = place.readFileCompressed('/style.css', 'br');
      assert.equal(zlib.brotliDecompressSync(br).toString(), updated);
      assert.equal(
        place.statCompressed('/style.css', 'br').sourceSize,
        updated.length,
      );
      kernel.close();
    });
  });
});
