'use strict';

const { VfsConfig } = require('./lib/config.js');
const { VfsKernel } = require('./lib/kernel.js');
const { PlaceFs } = require('./lib/place-fs.js');
const { FilesystemCache } = require('./lib/cache.js');
const { VfsStats, VfsDirent } = require('./lib/stats.js');
const { attach } = require('./lib/bootstrap/attach.js');

module.exports = {
  VfsConfig,
  VfsKernel,
  PlaceFs,
  FilesystemCache,
  VfsStats,
  VfsDirent,
  attach,
  // Kernel published by `--import shared-memory-fs/register` or attach(), or null.
  get kernel() {
    return VfsKernel.current;
  },
};
