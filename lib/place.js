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
    this.files = new Map();
  }

  readFile(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.data;
  }

  readBytecode(key) {
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
      return new Readable({ read() { this.push(null); } });
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
