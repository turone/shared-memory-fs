'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { isCompanionKey } = require('./companion.js');
const { canonicalKey, dirOf } = require('./place.js');
const { SHARED } = require('./config.js');
const { fsError } = require('./errors.js');
const { statsOf, VfsDirent, encodeName } = require('./stats.js');

// Captured at load time: disk territory is read past the fs patch, which
// would otherwise route these very paths back here.
const { readdirSync, statSync } = fs;

const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

const NOOP = () => {};

// The place's own directory: its mount, which always exists and never moves
// or goes away.
const isRoot = (key) => typeof key === 'string' && dirOf(key) === '';

// The canonical key of a mutation, without the trailing slash that names a
// directory (see Mutations).
const dirKey = (key) =>
  canonicalKey(typeof key === 'string' ? dirOf(key) : key);

// PlaceFs — public, per-Place file API returned by `kernel.fs(name)`.
//
// Reads are synchronous Map lookups. Missing files yield null from readFile /
// stat / createReadStream / views; readdir throws Node-style ENOENT / ENOTDIR.
// readFile returns owned copies: safe to keep and to mutate.
//
// Shared bytes (sab, sea) are replaced by updates and reused afterwards, so
// every direct consumer pins the version it started with; an update
// publishes the new version for new readers while pinned ones finish the
// old. With `fs.zeroCopy: true` the *View methods return a lease
// `{ view, release, [Symbol.dispose] }`: `view` is a direct SAB Buffer,
// stable until release(), never to be mutated or used after it —
// `Buffer.from(view)` to keep the bytes. createReadStream returns a
// VfsReadStream: owned chunks, released with the stream, unless zero-copy
// is on (the place's fs.zeroCopy, or `{ zeroCopy }` per call); borrowed SAB
// chunks are released only through stream.release(), since a
// downstream socket may still hold the last ones after the stream ends.
// Map places hold owned Buffers the GC keeps alive: their leases and
// releases are no-ops.
//
// A partial disk cache (`fs.fallback: 'disk'`) also serves its disk
// territory — files of extensions it does not cache, and directories —
// straight from disk: reads, stat, exists and listings merged with what the
// VFS holds. Cached extensions stay VFS-only.
//
// Mutations go to the place's store (a per-thread Map, or the main kernel
// for a shared virtual place), to disk (disk-origin with fs.writable) or
// fail with EROFS. Shared virtual places publish through the allocator, so
// their mutations return a Promise that settles once the new version is
// published; every other place mutates synchronously and returns undefined.
// `await` is correct for both.
// Where a domain declares `prepare` for an extension, the prepared source is
// the canonical content: every read, stream, module load and `script()`
// bundle sees that version, and the raw input is not kept in the VFS.

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

// A Readable over one pinned version of a file. Owned chunks (copies, or
// strings with an encoding) outlive the pin: it is released as soon as the
// stream is destroyed — end, error, destroy(), AbortSignal. Borrowed chunks
// are direct SAB views a downstream socket may still hold after the stream
// ends, so only release() ends their lease:
//   try { await pipeline(stream, res); } finally { stream.release(); }
class VfsReadStream extends Readable {
  #release;

  constructor(data, range, options, borrowed, release) {
    const { start, end } = range;
    const highWaterMark = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
    let offset = start;
    super({
      highWaterMark,
      encoding: options.encoding,
      signal: options.signal,
      read() {
        if (offset > end) return void this.push(null);
        const stop = Math.min(offset + highWaterMark, end + 1);
        const view = data.subarray(offset, stop);
        this.push(borrowed ? view : Buffer.from(view));
        offset = stop;
      },
      destroy(err, callback) {
        if (!borrowed) release();
        callback(err);
      },
    });
    this.#release = release;
  }

  // Ends the lease on the pinned version, stopping the stream first if it
  // is still reading. Idempotent; borrowed chunks are invalid afterwards.
  release() {
    if (!this.destroyed) this.destroy();
    this.#release();
  }

  [Symbol.dispose]() {
    this.release();
  }

  [Symbol.asyncDispose]() {
    this.release();
    return Promise.resolve();
  }
}

// A disk-backed entry streams from disk with nothing to pin; release() only
// stops it, so callers treat every stream the same way.
const diskStream = (filePath, options) => {
  const stream = fs.createReadStream(filePath, options);
  const release = () => {
    if (!stream.destroyed) stream.destroy();
  };
  stream.release = release;
  stream[Symbol.dispose] = release;
  return stream;
};

const kernelClosed = () => {
  const err = new Error('[vfs] kernel closed');
  err.code = 'ERR_VFS_CLOSED';
  return err;
};

class PlaceFs {
  #place;
  #pins;
  #shared;
  #fallsBack;

  constructor(place, pins) {
    this.#place = place;
    this.#pins = pins;
    this.#shared = SHARED.has(place.provider);
    this.#fallsBack = place.config.fs?.fallback === 'disk';
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
    return Boolean(this.#place.config.fs?.writable);
  }

  get zeroCopy() {
    return Boolean(this.#place.config.fs?.zeroCopy);
  }

  // Absolute OS path of a key (also for entries that exist only in memory).
  pathOf(key) {
    return this.#place.pathOf(key);
  }

  // --- Lookup ---

  #file(key) {
    const place = this.#place;
    const file = place.entry(key);
    if (file && place.visible('fs', place.keyOf(key))) return file;
    return this.#diskFile(key);
  }

  // --- Disk territory (fs.fallback: 'disk') ---

  // Absolute path of a key inside the place directory, or null when the key
  // would leave it: disk territory never reaches past the place.
  #within(key) {
    const { root } = this.#place;
    const abs = path.join(root, key);
    const rel = path.relative(root, abs);
    if (rel === '..' || rel.startsWith('..' + path.sep)) return null;
    return path.isAbsolute(rel) ? null : abs;
  }

  #diskStat(key) {
    const abs = this.#fallsBack ? this.#within(key) : null;
    if (!abs) return null;
    try {
      return statSync(abs, { throwIfNoEntry: false }) || null;
    } catch {
      return null;
    }
  }

  // A file of an extension the place does not cache, as a disk entry.
  #diskFile(key) {
    if (!this.#fallsBack) return null;
    const place = this.#place;
    const canonical = place.keyOf(key);
    if (isCompanionKey(canonical) || place.cached(canonical)) return null;
    const stats = this.#diskStat(canonical);
    if (!stats?.isFile()) return null;
    const stat = { size: stats.size, mtimeMs: stats.mtimeMs };
    return { data: null, path: this.#within(canonical), stat };
  }

  #diskDir(key) {
    return Boolean(this.#diskStat(this.#place.keyOf(key))?.isDirectory());
  }

  // Disk entries of a directory into `names`: subdirectories and files of
  // extensions the place does not cache. False when it is not on disk.
  #diskEntries(dir, names, recursive) {
    const base = this.#fallsBack ? this.#within(dir || '/') : null;
    if (!base) return false;
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true, recursive });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const at = path.join(entry.parentPath ?? entry.path, entry.name);
      const rel = path.relative(base, at).split(path.sep).join('/');
      if (entry.isDirectory()) names.set(rel, true);
      else if (entry.isFile() && !this.#place.cached(rel)) {
        names.set(rel, false);
      }
    }
    return true;
  }

  #isDirectory(key) {
    return this.#place.isDirectory(key) || this.#diskDir(key);
  }

  #views() {
    if (this.zeroCopy) return;
    throw fsError('ENOTSUP', 'read', undefined, 'fs.zeroCopy is off');
  }

  // One consumer of a projected version: shared bytes are pinned until the
  // returned idempotent release; Map entries are owned Buffers the GC keeps
  // alive. `onClose` stops the consumer if the kernel closes first.
  #pin(file, onClose) {
    return this.#shared ? this.#pins.acquire(file, onClose) : NOOP;
  }

  #lease(file) {
    const release = this.#pin(file);
    return Object.freeze({
      view: file.data,
      release,
      [Symbol.dispose]: release,
    });
  }

  // Borrowed chunks: the place setting by default, per call with
  // `{ zeroCopy }` — true needs fs.zeroCopy on the place.
  #borrowed(options) {
    if (options.zeroCopy === undefined) return this.zeroCopy;
    if (options.zeroCopy) this.#views();
    return Boolean(options.zeroCopy);
  }

  #stream(file, options) {
    const borrowed = this.#borrowed(options) && !options.encoding;
    const range = rangeOf(options, file.data.length);
    let stream = null;
    const release = this.#pin(file, () => stream?.destroy(kernelClosed()));
    try {
      stream = new VfsReadStream(file.data, range, options, borrowed, release);
    } catch (err) {
      release();
      throw err;
    }
    return stream;
  }

  exists(key) {
    return this.#file(key) !== null || this.#isDirectory(key);
  }

  stat(key, options = {}) {
    const file = this.#file(key);
    if (file) return statsOf(file.stat.size, file.stat.mtimeMs, options);
    if (this.#isDirectory(key)) {
      return statsOf(0, 0, { ...options, directory: true });
    }
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

  // Lease over the current version: `{ view, release, [Symbol.dispose] }`;
  // null when the key is missing or kept on disk (not in memory).
  readFileView(key) {
    this.#views();
    const file = this.#file(key);
    return file?.data ? this.#lease(file) : null;
  }

  // The view of `key` for the duration of `fn` (sync or async); null without
  // calling `fn` when there is none.
  async withFileView(key, fn) {
    const lease = this.readFileView(key);
    if (!lease) return null;
    try {
      return await fn(lease.view);
    } finally {
      lease.release();
    }
  }

  // Options: { start, end (inclusive), encoding, highWaterMark, signal,
  // zeroCopy }, or an encoding string.
  createReadStream(key, options = {}) {
    const file = this.#file(key);
    if (!file) return null;
    const opts = typeof options === 'string' ? { encoding: options } : options;
    if (file.data === null) return diskStream(file.path, opts);
    return this.#stream(file, opts);
  }

  // Directory listing from the place's directory index (directories are
  // implicit), merged with the disk territory of a partial cache.
  // Deterministic lexicographic order of the string names, whatever the
  // requested encoding. Options: { withFileTypes, recursive, encoding }, or
  // an encoding string.
  readdir(key, opts) {
    const options = typeof opts === 'string' ? { encoding: opts } : opts || {};
    const place = this.#place;
    const dir = dirOf(key);
    if (dir !== '' && this.#file(dir))
      throw fsError('ENOTDIR', 'scandir', this.pathOf(dir));
    const names = new Map(); // relative name → isDirectory
    const onDisk = this.#diskEntries(dir, names, Boolean(options.recursive));
    if (!onDisk && !place.isDirectory(dir))
      throw fsError('ENOENT', 'scandir', this.pathOf(dir));
    const prefix = dir + '/';
    const { files } = place;
    const found = options.recursive ? files.below(dir) : files.children(dir);
    for (const [k, isDirectory] of found) {
      if (isDirectory || place.visible('fs', k)) {
        names.set(k.slice(prefix.length), isDirectory);
      }
    }
    const { encoding } = options;
    const sorted = [...names.keys()].sort();
    if (!options.withFileTypes) {
      return sorted.map((name) => encodeName(name, encoding));
    }
    return sorted.map((name) => {
      const slash = name.lastIndexOf('/');
      const parent = this.pathOf(
        slash === -1 ? dir : prefix + name.substring(0, slash),
      );
      const base = slash === -1 ? name : name.substring(slash + 1);
      return new VfsDirent(encodeName(base, encoding), parent, names.get(name));
    });
  }

  // --- Compressed representations (fs.compress) ---

  #codec(encoding) {
    const codecs = this.#place.config.fs?.compress?.codecs || [];
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
    for (const { encoding } of place.config.fs?.compress?.codecs || []) {
      if (place.compressed(place.keyOf(key), encoding)) result.push(encoding);
    }
    return result;
  }

  readFileCompressed(key, encoding) {
    const file = this.#compressed(key, encoding);
    return file ? Buffer.from(file.data) : null;
  }

  // Lease over the compressed bytes only: the source and the other
  // representations are not pinned.
  readFileCompressedView(key, encoding) {
    this.#views();
    const file = this.#compressed(key, encoding);
    return file ? this.#lease(file) : null;
  }

  // { size, sourceSize, encoding, mtimeMs } — size of the compressed bytes.
  statCompressed(key, encoding) {
    const file = this.#compressed(key, encoding);
    return file ? { ...file.stat } : null;
  }

  // Range addresses the compressed bytes; only that representation is
  // pinned.
  createReadStreamCompressed(key, encoding, options = {}) {
    const file = this.#compressed(key, encoding);
    return file ? this.#stream(file, options) : null;
  }

  // --- Script bundles (fs.script) ---

  // Everything needed to build a local `vm.Script` for a source fs.script
  // covers, as owned copies:
  //   { source: string, cachedData: Buffer | null, scriptOptions, meta }
  //   new vm.Script(source, { ...scriptOptions, cachedData })
  // `cachedData` was produced from exactly this `source` under exactly
  // these `scriptOptions` (the preparer's, or V8 defaults — the library
  // invents no filename), and is null when `fs.script.compile` is off. A
  // rejection (`script.cachedDataRejected`) can therefore only come from a
  // V8 version/flags mismatch. Null when the key is not a published script
  // source.
  script(key) {
    const place = this.#place;
    if (!place.config.fs?.script) {
      throw fsError('ENOTSUP', 'read', undefined, 'no fs.script domain');
    }
    const file = this.#file(key);
    if (!file || !place.scripted(place.keyOf(key))) return null;
    const canonical = place.keyOf(key);
    const data = file.data === null ? fs.readFileSync(file.path) : file.data;
    const code = place.bytecode(canonical, 'script');
    return {
      source: data.toString('utf8'),
      cachedData: code ? Buffer.from(code) : null,
      scriptOptions: file.scriptOptions ?? null,
      meta: file.meta ?? null,
    };
  }

  // Frozen metadata a preparer attached to the file, or null.
  meta(key) {
    return this.#file(key)?.meta ?? null;
  }

  // --- Mutations ---
  //
  // A key ending in '/' names a directory, as a path with a trailing
  // separator does on POSIX: a file named so is ENOTDIR, a file write to it
  // EISDIR. The store checks it when the mutation runs (`{ directory }`),
  // so a file written meanwhile is never taken for a directory. On disk,
  // node:fs answers for the path as named, by its own rules — on Windows
  // it ignores a trailing separator.

  // The place's mutation engine, or null when the write goes to disk.
  #mutable(syscall, key) {
    const place = this.#place;
    if (!this.writable) throw fsError('EROFS', syscall, this.pathOf(key));
    return place.virtual ? place.store : null;
  }

  writeFile(key, data, options) {
    return this.#write('write', key, data, options);
  }

  appendFile(key, data, options) {
    return this.#write('append', key, data, options);
  }

  // A key that names a directory, the place's own included, takes no file.
  #write(op, key, data, options) {
    if (isRoot(key)) throw fsError('EISDIR', 'open', this.pathOf(key));
    const canonical = dirKey(key);
    const store = this.#mutable('open', canonical);
    const buf = toBuffer(data, options);
    if (!store) {
      const write = op === 'write' ? fs.writeFileSync : fs.appendFileSync;
      return write(this.pathOf(key), buf);
    }
    if (key.endsWith('/')) {
      throw fsError('EISDIR', 'open', this.pathOf(canonical));
    }
    return store[op](canonical, buf);
  }

  unlink(key) {
    if (isRoot(key)) throw fsError('EISDIR', 'unlink', this.pathOf(key));
    const canonical = dirKey(key);
    const store = this.#mutable('unlink', canonical);
    if (!store) return fs.unlinkSync(this.pathOf(key));
    return store.unlink(canonical, { directory: key.endsWith('/') });
  }

  // Directories are implicit in indexed places: mkdir creates no entry,
  // but its store checks the hierarchy.
  mkdir(key, options) {
    const root = isRoot(key);
    if (root && !options?.recursive) {
      throw fsError('EEXIST', 'mkdir', this.pathOf(key));
    }
    if (!root) key = dirKey(key);
    const store = this.#mutable('mkdir', key);
    if (!store) return fs.mkdirSync(this.pathOf(key), options);
    // The place's own directory exists already: nothing reaches the store.
    return root ? undefined : store.mkdir(key, options);
  }

  rm(key, options = {}) {
    if (isRoot(key)) {
      throw fsError('ENOTSUP', 'rm', this.pathOf(key), 'place root');
    }
    const canonical = dirKey(key);
    const store = this.#mutable('rm', canonical);
    if (!store) return fs.rmSync(this.pathOf(key), options);
    return store.rm(canonical, { ...options, directory: key.endsWith('/') });
  }

  rename(from, to) {
    if (isRoot(from) || isRoot(to)) {
      const dest = this.pathOf(to);
      throw fsError('ENOTSUP', 'rename', this.pathOf(from), 'place root', dest);
    }
    const source = dirKey(from);
    const target = dirKey(to);
    const store = this.#mutable('rename', source);
    if (!store) return fs.renameSync(this.pathOf(from), this.pathOf(to));
    const directory = from.endsWith('/') || to.endsWith('/');
    return store.rename(source, target, { directory });
  }
}

module.exports = { PlaceFs, toBuffer, encodingOf };
