'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { compressedKey } = require('../lib/companion.js');
const { tmpDir, writeTree, rm, kernel, drain, until } = require('./helpers.js');

describe('compression: representations in SAB', () => {
  let root;
  let k;
  let site;
  const text = 'hello hello hello hello hello hello hello hello';

  before(async () => {
    root = writeTree(tmpDir('compress'), {
      'site/index.html': text,
      'site/app.js': text,
      'site/logo.png': 'PNG'.repeat(20),
      'site/empty.css': '',
    });
    k = await kernel(root, {
      site: {
        fs: {
          zeroCopy: true,
          compress: {
            encodings: ['gzip', 'br'],
            options: { br: { level: 4 } },
            ext: 'compressible',
          },
        },
      },
    });
    site = k.fs('site');
  });

  after(() => {
    k.close();
    rm(root);
  });

  it('builds every configured encoding for compressible files only', () => {
    assert.deepEqual(site.storedEncodings('/index.html'), [
      'raw',
      'gzip',
      'br',
    ]);
    assert.deepEqual(site.storedEncodings('/app.js'), ['raw', 'gzip', 'br']);
    assert.deepEqual(site.storedEncodings('/logo.png'), ['raw']);
    assert.deepEqual(site.storedEncodings('/empty.css'), ['raw', 'gzip', 'br']);
    assert.deepEqual(site.storedEncodings('/nope'), []);
  });

  it('compressed bytes decode to the source; stat carries both sizes', () => {
    const gz = site.readFileCompressed('/index.html', 'gzip');
    assert.equal(zlib.gunzipSync(gz).toString(), text);
    assert.ok(!(gz.buffer instanceof SharedArrayBuffer), 'owned copy');
    const view = site.readFileCompressedView('/index.html', 'br');
    assert.ok(view.buffer instanceof SharedArrayBuffer);
    assert.equal(zlib.brotliDecompressSync(view).toString(), text);
    const st = site.statCompressed('/index.html', 'gzip');
    assert.equal(st.size, gz.length);
    assert.equal(st.sourceSize, text.length);
    assert.equal(st.encoding, 'gzip');
    assert.equal(typeof st.mtimeMs, 'number');
    assert.equal(site.readFileCompressed('/logo.png', 'gzip'), null);
    assert.equal(site.statCompressed('/nope', 'gzip'), null);
  });

  it('rejects encodings that are not configured', () => {
    assert.throws(() => site.readFileCompressed('/index.html', 'zstd'), {
      code: 'ENOTSUP',
    });
    assert.throws(
      () =>
        site.storedEncodings.call(site, '/index.html') &&
        site.statCompressed('/index.html', 'deflate'),
      {
        code: 'ENOTSUP',
      },
    );
  });

  it('streams compressed bytes with ranges', async () => {
    const gz = site.readFileCompressed('/index.html', 'gzip');
    const all = await drain(
      site.createReadStreamCompressed('/index.html', 'gzip'),
    );
    assert.deepEqual(all, gz);
    const part = await drain(
      site.createReadStreamCompressed('/index.html', 'gzip', {
        start: 2,
        end: 5,
      }),
    );
    assert.deepEqual(part, gz.subarray(2, 6));
    assert.equal(site.createReadStreamCompressed('/nope', 'gzip'), null);
  });

  it('companions never leak into listings, exists or the patched fs', () => {
    assert.deepEqual(site.readdir('/'), [
      'app.js',
      'empty.css',
      'index.html',
      'logo.png',
    ]);
    assert.equal(site.exists(compressedKey('/index.html', 'gzip')), false);
    assert.equal(site.readFile(compressedKey('/index.html', 'gzip')), null);
    assert.equal(
      k.routeRead(path.join(root, 'site', compressedKey('index.html', 'gzip')))
        .kind,
      'passthrough',
    );
  });

  it('snapshot carries representations to workers', () => {
    const { VfsKernel } = require('../lib/kernel.js');
    const w = VfsKernel.fromSnapshot(k.snapshot(), k.config, { appRoot: root });
    const ws = w.fs('site');
    assert.deepEqual(ws.storedEncodings('/index.html'), ['raw', 'gzip', 'br']);
    assert.equal(
      zlib.gunzipSync(ws.readFileCompressed('/index.html', 'gzip')).toString(),
      text,
    );
    w.close();
  });
});

describe('compression: retainRaw: false', () => {
  it('keeps only representations in SAB; the source stays on disk', async () => {
    const root = writeTree(tmpDir('compress-raw'), {
      'site/index.html': '<h1>'.repeat(50),
      'site/logo.png': 'PNG',
    });
    const k = await kernel(root, {
      site: {
        fs: {
          compress: { encodings: ['gzip'], ext: ['html'], retainRaw: false },
        },
      },
    });
    const site = k.fs('site');
    assert.deepEqual(site.storedEncodings('/index.html'), ['gzip']);
    assert.deepEqual(site.storedEncodings('/logo.png'), ['raw']);
    assert.equal(
      site.readFile('/index.html', 'utf8'),
      '<h1>'.repeat(50),
      'read from disk',
    );
    assert.equal(site.stat('/index.html').size, 200);
    assert.equal(k.cache.entry('site', '/index.html').kind, 'disk');
    assert.equal(
      k.routeRead(path.join(root, 'site', 'index.html')).kind,
      'passthrough',
    );
    k.close();
    rm(root);
  });
});

describe('compression: failures are per representation', () => {
  it('a representation that does not fit one segment is skipped, others survive', async () => {
    const root = writeTree(tmpDir('compress-fit'), {
      // Random bytes do not compress: gzip output exceeds the 4 KiB segment.
      'site/noise.txt': require('node:crypto').randomBytes(4090),
    });
    const warnings = [];
    const k = await kernel(
      root,
      { site: { fs: { compress: { encodings: ['gzip'] } } } },
      {
        memory: { limit: '64 kib', segmentSize: '4 kib', maxFileSize: '4 kib' },
      },
      { console: { warn: (m) => warnings.push(m), error() {}, log() {} } },
    );
    const site = k.fs('site');
    assert.deepEqual(site.storedEncodings('/noise.txt'), ['raw']);
    assert.ok(
      warnings.some((w) => /skipped gzip/.test(w) && /segment/.test(w)),
    );
    k.close();
    rm(root);
  });

  it('hot reload replaces representations; a shrunk source keeps only fresh ones', async () => {
    const root = writeTree(tmpDir('compress-watch'), {
      'site/a.txt': 'aaaa'.repeat(10),
    });
    const msgs = [];
    const k = await kernel(
      root,
      { site: { fs: { compress: { encodings: ['gzip'] } } } },
      { watch: true, watchTimeout: 60 },
      { broadcast: (m) => msgs.push(m) },
    );
    const site = k.fs('site');
    const before = site.readFileCompressed('/a.txt', 'gzip');
    fs.writeFileSync(path.join(root, 'site', 'a.txt'), 'bbbb'.repeat(20));
    await until(
      () => site.readFile('/a.txt', 'utf8') === 'bbbb'.repeat(20),
      4000,
    );
    const after = site.readFileCompressed('/a.txt', 'gzip');
    assert.notDeepEqual(after, before);
    assert.equal(zlib.gunzipSync(after).toString(), 'bbbb'.repeat(20));
    const keys = msgs.at(-1).places.site.entries.map(([key]) => key);
    assert.ok(
      keys.includes('/a.txt') && keys.includes(compressedKey('/a.txt', 'gzip')),
    );
    k.close();
    rm(root);
  });
});
