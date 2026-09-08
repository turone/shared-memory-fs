'use strict';

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { isCompanionKey } = require('./companion.js');
const { canonicalKey } = require('./place.js');
const { fsError } = require('./errors.js');
const { statsOf, VfsDirent } = require('./stats.js');

const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

// PlaceFs — public, per-Place file API returned by `kernel.fs(name)`.
//
// Reads are synchronous Map lookups. Missing files yield null from readFile /
// stat / createReadStream; readdir throws Node-style ENOENT / ENOTDIR.
// readFile returns owned copies. With `fs.zeroCopy: true` the *View methods
// and stream chunks are borrowed views over shared memory: never mutate
// them, never keep them past the current operation, `Buffer.from(view)` to
// retain. Mutations go to the per-thread Map (memory), to disk (sab / disk
// with fs.writable) or fail with EROFS.

const encodingOf = (options) =>
  typeof options === 'string' ? options : options?.encoding || null;

const checkSignal = (options) => {
  const signal = typeof options === 'object' ? options?.signal : undefined;
  if (signal?.aborted) throw signal.reason;
};

const toBuffer = (data, options) => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array)
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), encodingOf(options) || 'utf8');
};

const isOffset = (value) => Number.isSafeInteger(value) && value >= 0;

// Validate { start, end } against `size`; end is inclusive. Only an explicit
// range is checked, so a default read of an empty file is still fine.
const rangeOf = (options, size) => {
  const explicit = options.start !== undefined || options.end !== undefined;
  const start = options.start ?? 0;
  const end = options.end ?? size - 1;
  if (!isOffset(start) || (options.end !== undefined && !isOffset(end))) {
    throw new RangeError(`invalid range: start ${start}, end ${end}`);
  }
  if (explicit && (start > end || end >= size)) {
    throw new RangeError(`range ${start}-${end} outside file of ${size} bytes`);
  }
  return { start, end };
};

const streamOf = (data, options, zeroCopy) => {
  const { start, end } = rangeOf(options, data.length);
  const highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
  let offset = start;
  return new Readable({
    highWaterMark,
    encoding: options.encoding,
    signal: options.signal,
    read() {
      if (offset > end) return void this.push(null);
      const stop = Math.min(offset + highWaterMark, end + 1);
      const view = data.subarray(offset, stop);
      this.push(zeroCopy ? view : Buffer.from(view));
      offset = stop;
    },
  });
};

class PlaceFs {
  #place;

  constructor(place) {
    this.#place = place;
  }

  get name() {
    return this.#place.name;
  }

  get root() {
    return this.#place.root;
  }

  get provider() {
    return this.#place.provider;
  }

  get writable() {
    return this.#place.config.fs.writable;
  }

  get zeroCopy() {
    return this.#place.config.fs.zeroCopy;
  }

  // Absolute OS path of a key (also for entries that exist only in memory).
  pathOf(key) {
    return this.#place.pathOf(key);
  }

  // --- Lookup ---

  #file(key) {
    const place = this.#place;
    const file = place.entry(key);
    if (!file || !place.visible('fs', place.keyOf(key))) return null;
    return file;
  }

  #views() {
    if (this.zeroCopy) return;
    throw fsError('ENOTSUP', 'read', undefined, 'fs.zeroCopy is off');
  }

  exists(key) {
    return this.#file(key) !== null || this.#place.isDirectory(key);
  }

  stat(key, options = {}) {
    const file = this.#file(key);
    if (file) return statsOf(file.stat.size, file.stat.mtimeMs, options);
    if (this.#place.isDirectory(key))
      return statsOf(0, 0, { ...options, directory: true });
    return null;
  }

  // --- Reads ---

  readFile(key, options = {}) {
    checkSignal(options);
    const file = this.#file(key);
    if (!file) return null;
    const encoding = encodingOf(options);
    const data =
      file.data === null ? fs.readFileSync(file.path) : Buffer.from(file.data);
    return encoding ? data.toString(encoding) : data;
  }

  readFileView(key) {
    this.#views();
    const file = this.#file(key);
    return file ? file.data : null;
  }

  createReadStream(key, options = {}) {
    const file = this.#file(key);
    if (!file) return null;
    if (file.data === null) return fs.createReadStream(file.path, options);
    return streamOf(file.data, options, this.zeroCopy);
  }

  // Directory listing computed from published keys; directories are
  // implicit. Deterministic lexicographic order.
  readdir(key, options = {}) {
    const place = this.#place;
    const dir =
      key === '' || key === '/' ? '' : place.keyOf(key).replace(/\/$/, '');
    if (dir !== '' && this.#file(dir))
      throw fsError('ENOTDIR', 'scandir', this.pathOf(dir));
    if (!place.isDirectory(dir))
      throw fsError('ENOENT', 'scandir', this.pathOf(dir));
    const prefix = dir + '/';
    const names = new Map(); // relative name → isDirectory
    for (const k of place.files.keys()) {
      if (isCompanionKey(k) || !k.startsWith(prefix)) continue;
      const rest = k.substring(prefix.length);
      const slash = rest.indexOf('/');
      if (options.recursive) {
        if (place.visible('fs', k)) names.set(rest, false);
        let at = slash;
        while (at !== -1) {
          names.set(rest.substring(0, at), true);
          at = rest.indexOf('/', at + 1);
        }
      } else if (slash === -1) {
        if (place.visible('fs', k)) names.set(rest, false);
      } else {
        names.set(rest.substring(0, slash), true);
      }
    }
    const sorted = [...names.keys()].sort();
    if (!options.withFileTypes) {
      return options.encoding === 'buffer'
        ? sorted.map((n) => Buffer.from(n))
        : sorted;
    }
    return sorted.map((name) => {
      const slash = name.lastIndexOf('/');
      const parent = this.pathOf(
        slash === -1 ? dir : prefix + name.substring(0, slash),
      );
      return new VfsDirent(
        slash === -1 ? name : name.substring(slash + 1),
        parent,
        names.get(name),
      );
    });
  }

  // --- Compressed representations (fs.compress) ---

  #codec(encoding) {
    const codecs = this.#place.config.fs.compress?.codecs || [];
    if (codecs.some((c) => c.encoding === encoding)) return;
    throw fsError(
      'ENOTSUP',
      'read',
      undefined,
      `encoding "${encoding}" is not configured`,
    );
  }

  #compressed(key, encoding) {
    this.#codec(encoding);
    const place = this.#place;
    if (!this.#file(key)) return null;
    return place.compressed(place.keyOf(key), encoding);
  }

  // Representations actually present, config order; 'raw' only when the
  // source itself is in memory.
  storedEncodings(key) {
    const file = this.#file(key);
    if (!file) return [];
    const result = file.data === null ? [] : ['raw'];
    const place = this.#place;
    for (const { encoding } of place.config.fs.compress?.codecs || []) {
      if (place.compressed(place.keyOf(key), encoding)) result.push(encoding);
    }
    return result;
  }

  readFileCompressed(key, encoding) {
    const file = this.#compressed(key, encoding);
    return file ? Buffer.from(file.data) : null;
  }

  readFileCompressedView(key, encoding) {
    this.#views();
    const file = this.#compressed(key, encoding);
    return file ? file.data : null;
  }

  // { size, sourceSize, encoding, mtimeMs } — size of the compressed bytes.
  statCompressed(key, encoding) {
    const file = this.#compressed(key, encoding);
    return file ? { ...file.stat } : null;
  }

  // Range addresses the compressed bytes.
  createReadStreamCompressed(key, encoding, options = {}) {
    const file = this.#compressed(key, encoding);
    return file ? streamOf(file.data, options, this.zeroCopy) : null;
  }

  // --- Mutations ---

  #mutable(syscall, key) {
    const place = this.#place;
    if (!this.writable) throw fsError('EROFS', syscall, this.pathOf(key));
    return place.provider === 'memory' ? place.store : null;
  }

  writeFile(key, data, options) {
    key = canonicalKey(key);
    const store = this.#mutable('open', key);
    const buf = toBuffer(data, options);
    if (store) store.write(key, buf);
    else fs.writeFileSync(this.pathOf(key), buf);
  }

  appendFile(key, data, options) {
    key = canonicalKey(key);
    const store = this.#mutable('open', key);
    const buf = toBuffer(data, options);
    if (store) store.append(key, buf);
    else fs.appendFileSync(this.pathOf(key), buf);
  }

  unlink(key) {
    key = canonicalKey(key);
    const store = this.#mutable('unlink', key);
    if (!store) return void fs.unlinkSync(this.pathOf(key));
    if (!store.unlink(key)) throw fsError('ENOENT', 'unlink', this.pathOf(key));
  }

  // Directories are implicit in memory places: mkdir succeeds without state.
  mkdir(key, options) {
    key = canonicalKey(key);
    const store = this.#mutable('mkdir', key);
    if (!store) fs.mkdirSync(this.pathOf(key), options);
  }

  rm(key, options = {}) {
    key = canonicalKey(key);
    const store = this.#mutable('rm', key);
    if (!store) return void fs.rmSync(this.pathOf(key), options);
    const abs = this.pathOf(key);
    if (store.unlink(key)) return;
    const children = store.keysUnder(key);
    if (children.length === 0) {
      if (!options.force) throw fsError('ENOENT', 'rm', abs);
      return;
    }
    if (!options.recursive) throw fsError('ENOTEMPTY', 'rm', abs);
    for (const child of children) store.unlink(child);
  }

  rename(from, to) {
    from = canonicalKey(from);
    to = canonicalKey(to);
    const store = this.#mutable('rename', from);
    if (!store) return void fs.renameSync(this.pathOf(from), this.pathOf(to));
    if (!store.rename(from, to))
      throw fsError('ENOENT', 'rename', this.pathOf(from));
  }
}

module.exports = { PlaceFs, toBuffer, encodingOf };
