'use strict';

const { Readable } = require('node:stream');

const STREAM_CHUNK = 65536;

// Place — logical namespace that owns cached file data.
// files Map is a live reference updated by the kernel on watch events.
// Invariant: config is frozen at construction.

class Place {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    // Map<key, { data: Buffer|null, stat, path? }>
    // SAB entries: { data: Buffer (zero-copy view), stat }
    // Disk entries: { data: null, stat, path }
    // Memory entries: { data: Buffer (owned copy), stat }
    this.files = new Map();
    // Hooks installed by kernel for writable (memory) places.
    // null — place is read-only.
    this._onWrite = null;
    this._onDelete = null;
  }

  readFile(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.data;
  }

  writeFile(key, data) {
    if (!this._onWrite) {
      throw new Error(`Place "${this.name}" is read-only`);
    }
    return this._onWrite(key, data);
  }

  unlink(key) {
    if (!this._onDelete) {
      throw new Error(`Place "${this.name}" is read-only`);
    }
    return this._onDelete(key);
  }

  // V8 cached data (bytecode) for the source at `key`, stored as a companion
  // entry under `key + '.cache'`. Returns null if no companion exists.
  // Intended consumer: `vm.Script(source, { cachedData })`.
  getCachedData(key) {
    const file = this.files.get(key + '.cache');
    if (!file) return null;
    return file.data;
  }

  stat(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.stat;
  }

  exists(key) {
    return this.files.has(key);
  }

  filePath(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.path || null;
  }

  list(prefix = '/') {
    const results = [];
    const p = prefix.endsWith('/') ? prefix : prefix + '/';
    for (const key of this.files.keys()) {
      if (key === prefix || key.startsWith(p)) results.push(key);
    }
    return results;
  }

  createReadStream(key, options = {}) {
    const file = this.files.get(key);
    if (!file || file.data === null) return null;
    const data = file.data;
    const sab = data.buffer;
    const base = data.byteOffset;
    const total = data.byteLength;
    const start = base + (options.start ?? 0);
    const end = base + (options.end ?? total - 1);
    if (start > base + total - 1 || end < start) {
      return new Readable({
        read() {
          this.push(null);
        },
      });
    }
    let offset = start;
    return new Readable({
      read() {
        if (offset > end) return void this.push(null);
        const chunkEnd = Math.min(offset + STREAM_CHUNK, end + 1);
        this.push(Buffer.from(sab, offset, chunkEnd - offset));
        offset = chunkEnd;
      },
    });
  }
}

module.exports = { Place };
