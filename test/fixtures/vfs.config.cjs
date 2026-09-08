'use strict';

// Config for the bootstrap process tests (cwd = test/fixtures).
module.exports = {
  defaults: {
    memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
  },
  places: {
    static: { fs: true },
    modules: { require: true, import: true },
    scratch: { provider: 'memory', fs: { writable: true }, require: true },
  },
};
