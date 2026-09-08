'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan, keyOf } = require('../lib/scanner.js');
const { tmpDir, writeTree, rm } = require('./helpers.js');

describe('scanner', () => {
  let root;
  let canSymlink = true;

  before(() => {
    root = writeTree(tmpDir('scan'), {
      'a.html': 'A',
      'sub/b.JS': 'B',
      'sub/deep/c.txt': 'C',
      noext: 'N',
    });
    try {
      fs.symlinkSync(
        path.join(root, 'a.html'),
        path.join(root, 'link.html'),
        'file',
      );
      fs.symlinkSync(
        path.join(root, 'sub'),
        path.join(root, 'linkdir'),
        'junction',
      );
    } catch {
      canSymlink = false;
    }
  });

  after(() => rm(root));

  it('keys are /-separated, relative, with leading slash', async () => {
    const files = await scan(root);
    const keys = [...files.keys()].sort();
    assert.deepEqual(
      keys.filter((k) => !k.startsWith('/link')),
      ['/a.html', '/noext', '/sub/b.JS', '/sub/deep/c.txt'],
    );
    const b = files.get('/sub/b.JS');
    assert.equal(b.path, path.join(root, 'sub', 'b.JS'));
    assert.deepEqual(Object.keys(b.stat).sort(), ['mtimeMs', 'size']);
    assert.equal(b.stat.size, 1);
    assert.equal(keyOf(path.join(root, 'x', 'y.z'), root), '/x/y.z');
  });

  it('filters by ext (case-insensitive, no dots)', async () => {
    const files = await scan(root, { ext: ['js'] });
    assert.deepEqual([...files.keys()], ['/sub/b.JS']);
  });

  it('startPath scans a subtree with keys relative to root', async () => {
    const files = await scan(root, {
      startPath: path.join(root, 'sub', 'deep'),
    });
    assert.deepEqual([...files.keys()], ['/sub/deep/c.txt']);
  });

  it('missing directory yields an empty map', async () => {
    const files = await scan(path.join(root, 'nope'));
    assert.equal(files.size, 0);
  });

  it('never traverses directory links; file links only with followSymlinks', async (t) => {
    if (!canSymlink) {
      t.skip('symlinks unavailable');
      return;
    }
    const strict = await scan(root);
    assert.ok(!strict.has('/link.html'));
    assert.ok(![...strict.keys()].some((k) => k.startsWith('/linkdir')));
    const loose = await scan(root, { followSymlinks: true });
    assert.ok(loose.has('/link.html'));
    assert.ok(![...loose.keys()].some((k) => k.startsWith('/linkdir')));
  });
});
