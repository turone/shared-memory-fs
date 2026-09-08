'use strict';

// Config for the strict bootstrap test; appRoot is test/fixtures/sandbox.
module.exports = {
  defaults: {
    memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
    strict: true,
  },
  places: { assets: { fs: true } },
};
