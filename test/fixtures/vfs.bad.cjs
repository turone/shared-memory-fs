'use strict';

// Config whose initialization fails: node:sea assets are unavailable, but
// that only warns — so break it with an invalid segment budget instead.
module.exports = {
  defaults: { memory: { limit: '1 kib', segmentSize: '64 kib' } },
  places: { static: { fs: true } },
};
