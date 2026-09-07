'use strict';

// Disk-backed CJS loaded via the ESM translator under `node --import`.
// Nested require of a memory-only child must go through registerHooks;
// Node's default disk resolver cannot succeed because nested.js is never
// on disk.
module.exports = require('../scratch/nested.js');
