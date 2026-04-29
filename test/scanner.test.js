'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scan, getKey } = require('../lib/scanner.js');

const createTmpDir = () => {
  const dir = path.join(os.tmpdir(), `vfs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const rmDir = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
};

describe('scanner', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body{}');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'page.html'), '<p>hi</p>');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'deep', 'nested.js'), '1');
  });

  after(() => rmDir(tmpDir));

  describe('scan()', () => {
    it('returns all files and dirs', async () => {
      const { files, dirs } = await scan(tmpDir);
      assert.ok(files.size >= 5);
      assert.ok(dirs.size >= 3); // root, sub, sub/deep
      assert.ok(dirs.has(tmpDir));
    });

    it('files have stat and path', async () => {
      const { files } = await scan(tmpDir);
      for (const [, file] of files) {
        assert.ok(file.stat);
        assert.ok(file.path);
        assert.ok(typeof file.stat.size === 'number');
      }
    });

    it('keys use forward slashes', async () => {
      const { files } = await scan(tmpDir);
      for (const key of files.keys()) {
        assert.ok(!key.includes('\\'), `key has backslash: ${key}`);
        assert.ok(key.startsWith('/'), `key missing leading /: ${key}`);
      }
    });

    it('includes nested files', async () => {
      const { files } = await scan(tmpDir);
      const keys = [...files.keys()];
      assert.ok(keys.some((k) => k.includes('/sub/page.html')));
      assert.ok(keys.some((k) => k.includes('/sub/deep/nested.js')));
    });
  });

  describe('ext filtering', () => {
    it('filters by extension', async () => {
      const { files } = await scan(tmpDir, { ext: ['html'] });
      for (const key of files.keys()) {
        assert.ok(key.endsWith('.html'), `unexpected: ${key}`);
      }
      assert.ok(files.size >= 2);
    });

    it('supports multiple extensions', async () => {
      const { files } = await scan(tmpDir, { ext: ['html', 'css'] });
      for (const key of files.keys()) {
        assert.ok(
          key.endsWith('.html') || key.endsWith('.css'),
          `unexpected: ${key}`,
        );
      }
    });
  });

  describe('startPath', () => {
    it('scans subdirectory with keys relative to root', async () => {
      const subDir = path.join(tmpDir, 'sub');
      const { files, dirs } = await scan(tmpDir, { startPath: subDir });
      assert.ok(files.size >= 2);
      assert.ok(dirs.has(subDir));
      for (const key of files.keys()) {
        assert.ok(key.startsWith('/sub/'), `key not relative to root: ${key}`);
      }
    });
  });

  describe('getKey()', () => {
    it('produces forward-slash key', () => {
      const base = '/home/user/project';
      const file = '/home/user/project/src/index.js';
      const key = getKey(file, base);
      assert.equal(key, '/src/index.js');
    });

    it('handles Windows-style paths', () => {
      if (process.platform !== 'win32') return;
      const base = 'C:\\Users\\dev\\project';
      const file = 'C:\\Users\\dev\\project\\lib\\cache.js';
      const key = getKey(file, base);
      assert.equal(key, '/lib/cache.js');
    });
  });

  describe('empty directory', () => {
    it('returns empty files map for empty dir', async () => {
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      const { files, dirs } = await scan(emptyDir);
      assert.equal(files.size, 0);
      assert.ok(dirs.has(emptyDir));
    });
  });
});
