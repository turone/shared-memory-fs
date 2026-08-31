'use strict';

// Companion keys — internal derivatives of a source key stored in the same
// mount index (V8 bytecode, compressed representations).
// The NUL separator cannot occur in a real file name on any OS, so a scanned
// file can never collide with a companion.

const SEP = '\u0000';

const companionKey = (key, tag) => key + SEP + tag;

const isCompanionKey = (key) => key.includes(SEP);

const sourceKey = (key) => {
  const index = key.indexOf(SEP);
  return index === -1 ? key : key.substring(0, index);
};

module.exports = { SEP, companionKey, isCompanionKey, sourceKey };
