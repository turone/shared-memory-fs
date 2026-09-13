'use strict';

// Companion keys — internal derivatives of a source key stored in the same
// place index: V8 bytecode for the require and script domains, compressed
// bytes for the fs domain. The NUL separator cannot occur in a file name on
// any OS, so a scanned file can never collide with a companion.

const SEP = '\u0000';
const BYTECODE_TAG = ':bytecode';
const COMPRESSED_PREFIX = 'fs:';

// `<src>\0require:bytecode` — cached data of the CommonJS-wrapped source;
// `<src>\0script:bytecode`  — cached data of the bare source (vm.Script).
const bytecodeKey = (source, domain = 'require') =>
  source + SEP + domain + BYTECODE_TAG;

const compressedKey = (source, encoding) =>
  source + SEP + COMPRESSED_PREFIX + encoding;

const isCompanionKey = (key) => key.includes(SEP);

const sourceOf = (key) => {
  const index = key.indexOf(SEP);
  return index === -1 ? key : key.substring(0, index);
};

module.exports = { SEP, bytecodeKey, compressedKey, isCompanionKey, sourceOf };
