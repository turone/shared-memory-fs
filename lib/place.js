'use strict';

const { Readable } = require('node:stream');
const { companionKey, isCompanionKey } = require('./companion.js');

const STREAM_CHUNK = 65536;

// Place — logical namespace that owns cached file data.
// files Map is a live reference updated by the kernel on watch events.
// Invariant: config is frozen at construction.

class Place {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    // Mount key: first path segment under appRoot; cache namespace.
    this.mount = config.dir;
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
  // entry. Returns null if no companion exists.
  // Intended consumer: `vm.Script(source, { cachedData })`.
  getCachedData(key) {
    const file = this.files.get(companionKey(key, 'cache'));
    if (!file) return null;
    return file.data;
  }

  // Compressed representation of `key`, or null when this place does not
  // store that encoding for that file. Raw bytes stay behind readFile().
  readFileCompressed(key, encoding) {
    const file = this.files.get(companionKey(key, encoding));
    if (!file) return null;
    return file.data;
  }

  // { size, sourceSize, encoding, mtimeMs } — size is the compressed length,
  // mtimeMs is the source mtime.
  statCompressed(key, encoding) {
    const file = this.files.get(companionKey(key, encoding));
    if (!file) return null;
    return file.stat;
  }

  // Representations of `key` actually present in SAB, config order first.
  // 'raw' appears only when the source itself is SAB-backed; a disk-backed
  // source is served through the filesystem, not from memory.
  storedEncodings(key) {
    const result = [];
    const source = this.files.get(key);
    if (!source) return result;
    if (source.data !== null) result.push('raw');
    for (const { encoding } of this.config.compress?.codecs || []) {
      if (this.files.has(companionKey(key, encoding))) result.push(encoding);
    }
    return result;
  }

  stat(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.stat;
  }

  exists(key) {
    if (isCompanionKey(key)) return false;
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
      if (isCompanionKey(key)) continue;
      if (key === prefix || key.startsWith(p)) results.push(key);
    }
    return results;
  }

  createReadStream(key, options = {}) {
    return this.#stream(this.files.get(key), options);
  }

  // Range applies to the bytes of the chosen representation, not the source.
  createReadStreamCompressed(key, encoding, options = {}) {
    return this.#stream(this.files.get(companionKey(key, encoding)), options);
  }

  #stream(file, options) {
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
