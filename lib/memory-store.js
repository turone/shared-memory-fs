'use strict';

const { fileExt } = require('metautil');
const { bytecodeKey, isCompanionKey } = require('./companion.js');

const BYTECODE_EXT = new Set(['js', 'cjs']);

// MemoryStore — mutations of a per-thread memory Place. Owns nothing shared:
// entries are owned Buffers in `place.files`; bytecode is rebuilt on every
// write of a compilable source through the injected `bytecode(source, file)`.

class MemoryStore {
  constructor(place, { bytecode }) {
    this.place = place;
    this.bytecode = bytecode;
  }

  #compilable(key) {
    const { require: req } = this.place.config;
    return (
      Boolean(req?.compile) &&
      BYTECODE_EXT.has(fileExt(key)) &&
      this.place.visible('require', key)
    );
  }

  #publish(key, data) {
    const { files } = this.place;
    const stat = { size: data.length, mtimeMs: Date.now() };
    files.set(key, { data, stat });
    const cacheKey = bytecodeKey(key);
    files.delete(cacheKey);
    if (this.#compilable(key)) {
      const code = this.bytecode(data.toString('utf8'), this.place.pathOf(key));
      if (code)
        files.set(cacheKey, {
          data: code,
          stat: { size: code.length, mtimeMs: stat.mtimeMs },
        });
    }
    return stat;
  }

  write(key, data) {
    return this.#publish(key, Buffer.from(data));
  }

  append(key, data) {
    const current = this.place.files.get(key);
    const chunk = Buffer.from(data);
    return this.#publish(
      key,
      current ? Buffer.concat([current.data, chunk]) : chunk,
    );
  }

  // Removes the source and its companions; false when there was no source.
  unlink(key) {
    const { files } = this.place;
    if (!files.delete(key)) return false;
    files.delete(bytecodeKey(key));
    return true;
  }

  rename(from, to) {
    const current = this.place.files.get(from);
    if (!current) return false;
    this.unlink(from);
    this.#publish(to, current.data);
    return true;
  }

  // Every source key under an implicit directory (non-recursive listing of
  // sources only — companions follow their source).
  keysUnder(dir) {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const result = [];
    for (const key of this.place.files.keys()) {
      if (key.startsWith(prefix) && !isCompanionKey(key)) result.push(key);
    }
    return result;
  }
}

module.exports = { MemoryStore };
