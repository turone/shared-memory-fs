'use strict';

// Run by test/uninstall.test.js in a plain node process. Unlike a
// `node --test` child, nothing has loaded glob yet, so it is loaded while
// the patch is installed and walks with the patched functions from then on
// — as it would in an application. Prints one JSON line.

const fs = require('node:fs');
const path = require('node:path');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const { tmpDir, writeTree, rm, kernel } = require('../helpers.js');

const slashed = (list) =>
  list.map((p) => String(p).split(path.sep).join('/')).sort();

const main = async () => {
  const root = writeTree(tmpDir('vfs-glob-kept'), {
    'pub/index.html': '<h1>',
    'stray/x.txt': 'x',
  });
  const k = await kernel(
    root,
    {
      pub: { fs: { ext: ['html'] } },
      mem: { provider: 'map', origin: 'virtual', fs: { writable: true } },
    },
    { strict: true },
  );
  k.fs('mem').writeFile('/m.txt', 'm');
  const loadedBefore = process.moduleLoadList.includes(
    'NativeModule internal/fs/glob',
  );
  fsPatch.install(k);
  const installed = {
    virtual: slashed(fs.globSync('mem/*', { cwd: root })),
    top: slashed(fs.globSync('*', { cwd: root })),
  };
  fsPatch.uninstall();
  k.close();
  const uninstalled = slashed(fs.globSync('*', { cwd: root }));
  rm(root);
  process.stdout.write(
    JSON.stringify({ loadedBefore, installed, uninstalled }) + '\n',
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
