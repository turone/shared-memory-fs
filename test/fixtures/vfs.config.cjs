'use strict';

module.exports = {
  defaults: {
    memory: { limit: '256 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
    hooks: { fs: true, require: false, import: false },
  },
  places: {
    static: {
      domains: ['fs'],
      match: { dir: 'static' },
      provider: 'sab',
    },
  },
};
