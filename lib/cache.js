'use strict';

// FilesystemCache — pooled SharedArrayBuffer file cache. No Node API
// dependencies: bytes come either from `file.data` (Buffer) or from the
// injected `reader(file, view)` that fills a Uint8Array view over the SAB and
// throws when the source cannot be read completely and consistently.
//
// Placing bytes and publishing them are separate steps. allocate() returns an
// entry nobody else can see; put() / remove() change the index, which holds
// published entries only. snapshot() and compact() therefore never observe a
// publication in progress, and abandoning one is a plain free().
//
// Data contract:
//
// @typedef {Object} FileInput             // value handed to allocate()
// @property {Buffer} [data]               // in-memory content, or
// @property {string} [path]               // path handed to the reader
// @property {{size:number, mtimeMs?:number}} stat  // compact metadata
// @property {Object} [meta]               // frozen cloneable, travels with the entry
// @property {Object} [scriptOptions]      // frozen cloneable vm.Script options
//
// @typedef {Object} SharedEntry           // file placed in a SAB segment
// @property {'shared'} kind
// @property {number} segmentId
// @property {number} offset
// @property {number} length
// @property {Object} stat
// @property {Object} [meta]
// @property {Object} [scriptOptions]
//
// @typedef {Object} DiskEntry             // file left on disk
// @property {'disk'} kind
// @property {string|null} path
// @property {Object} stat
// @property {Object} [meta]
// @property {Object} [scriptOptions]
//
// @typedef {Object} FsIndex               // one namespace (place)
// @property {Map<string, SharedEntry|DiskEntry>} entries  // published only

// Preparer-attached fields travel with the entry as they are (frozen).
const withExtras = (entry, file) => {
  if (file.meta) entry.meta = file.meta;
  if (file.scriptOptions) entry.scriptOptions = file.scriptOptions;
  return entry;
};

const diskEntry = (file) =>
  withExtras({ kind: 'disk', path: file.path || null, stat: file.stat }, file);

const emptyEntry = (file) =>
  withExtras(
    { kind: 'shared', segmentId: 0, offset: 0, length: 0, stat: file.stat },
    file,
  );

class Pool {
  constructor(limit, segmentSize) {
    this.limit = limit;
    this.segmentSize = segmentSize;
    this.segments = new Map();
    // Fully freed segments are kept for reuse, never returned to the OS.
    this.emptySegmentIds = new Set();
    this.totalUsed = 0;
    this.nextSegmentId = 1;
  }

  createSegment() {
    for (const id of this.emptySegmentIds) {
      this.emptySegmentIds.delete(id);
      return this.segments.get(id);
    }
    const size = this.segmentSize;
    if (this.totalUsed + size > this.limit) return null;
    const id = this.nextSegmentId++;
    const segment = { id, sab: new SharedArrayBuffer(size) };
    this.segments.set(id, segment);
    this.totalUsed += size;
    return segment;
  }

  freeSegment(id) {
    if (this.segments.has(id)) this.emptySegmentIds.add(id);
  }

  getSegment(id) {
    return this.segments.get(id) || null;
  }

  snapshot() {
    const result = [];
    for (const { id, sab } of this.segments.values()) result.push({ id, sab });
    return result;
  }
}

// Extent bookkeeping per segment: `free` holds sorted free extents inside the
// used prefix, `tail` is the first never-used offset.
class SegmentRegistry {
  constructor(pool) {
    this.pool = pool;
    this.free = new Map(); // segmentId → [{ offset, length }]
    this.tail = new Map(); // segmentId → number
    // Segments being emptied by compaction: no new allocations land there,
    // but their bytes stay valid until every entry in them is released.
    this.closed = new Set();
  }

  register(segmentId) {
    this.free.set(segmentId, []);
    this.tail.set(segmentId, 0);
  }

  unregister(segmentId) {
    this.free.delete(segmentId);
    this.tail.delete(segmentId);
    this.closed.delete(segmentId);
  }

  // Best-fit free extent → tail of a partially used segment → new segment.
  // Returns null when nothing fits (size above segmentSize, or pool budget
  // exhausted). `noGrow` forbids creating segments (used by compaction).
  allocate(size, noGrow = false) {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new RangeError(`invalid allocation size: ${size}`);
    }
    if (size > this.pool.segmentSize) return null;
    let best = null;
    for (const [segmentId, extents] of this.free) {
      if (this.closed.has(segmentId)) continue;
      for (let i = 0; i < extents.length; i++) {
        const extent = extents[i];
        if (extent.length < size) continue;
        if (!best || extent.length < best.extent.length) {
          best = { segmentId, index: i, extent };
        }
      }
    }
    if (best) {
      const { segmentId, index, extent } = best;
      const offset = extent.offset;
      if (extent.length === size) {
        this.free.get(segmentId).splice(index, 1);
      } else {
        extent.offset += size;
        extent.length -= size;
      }
      return { segmentId, offset };
    }
    for (const [segmentId, tail] of this.tail) {
      if (this.closed.has(segmentId)) continue;
      if (tail + size <= this.pool.segmentSize) {
        this.tail.set(segmentId, tail + size);
        return { segmentId, offset: tail };
      }
    }
    if (noGrow) return null;
    const segment = this.pool.createSegment();
    if (!segment) return null;
    this.register(segment.id);
    this.tail.set(segment.id, size);
    return { segmentId: segment.id, offset: 0 };
  }

  release(segmentId, offset, length) {
    const extents = this.free.get(segmentId);
    if (!extents) return;
    let index = extents.findIndex((e) => e.offset > offset);
    if (index === -1) index = extents.length;
    extents.splice(index, 0, { offset, length });
    SegmentRegistry.mergeSiblings(extents, index);
  }

  static mergeSiblings(extents, index) {
    const current = extents[index];
    const next = extents[index + 1];
    if (next && current.offset + current.length === next.offset) {
      current.length += next.length;
      extents.splice(index + 1, 1);
    }
    const prev = extents[index - 1];
    if (prev && prev.offset + prev.length === current.offset) {
      prev.length += current.length;
      extents.splice(index, 1);
    }
  }

  used(segmentId) {
    const tail = this.tail.get(segmentId);
    if (!tail) return 0;
    let free = 0;
    for (const e of this.free.get(segmentId)) free += e.length;
    return tail - free;
  }
}

class FilesystemCache {
  // options: { limit, segmentSize, maxFileSize, reader }
  constructor(options = {}) {
    const { limit, segmentSize, maxFileSize, reader } = options;
    this.segmentSize = segmentSize;
    this.maxFileSize = maxFileSize;
    this.reader = reader || null;
    this.pool = new Pool(limit, segmentSize);
    this.registry = new SegmentRegistry(this.pool);
    this.indexes = new Map(); // name → FsIndex
  }

  get totalUsed() {
    return this.pool.totalUsed;
  }

  getSegment(id) {
    return this.pool.getSegment(id);
  }

  index(name) {
    let index = this.indexes.get(name);
    if (!index) {
      index = { entries: new Map() };
      this.indexes.set(name, index);
    }
    return index;
  }

  entry(name, key) {
    return this.indexes.get(name)?.entries.get(key) || null;
  }

  // Place one file without publishing it: a shared entry in a SAB segment,
  // else a disk entry — when `onDisk` keeps it there, it exceeds
  // `maxFileSize` (default: the cache-wide limit) or the pool is full. With
  // `fallback: false` such a file yields null instead: callers whose bytes
  // exist only in memory (bytecode, compressed representations, prepared
  // sources, SEA assets) must never get a disk entry pointing at a raw file.
  async allocate(file, options = {}) {
    const { maxFileSize = this.maxFileSize, fallback = true } = options;
    const entry = options.onDisk ? null : await this.#place(file, maxFileSize);
    if (entry) return entry;
    return fallback ? diskEntry(file) : null;
  }

  // A shared entry, or null when the bytes cannot live in SAB.
  async #place(file, maxFileSize) {
    const { data, stat } = file;
    if (data && stat.size !== undefined && stat.size !== data.length) {
      throw new Error(`size mismatch: stat ${stat.size}, data ${data.length}`);
    }
    const size = data ? data.length : stat.size;
    if (size > maxFileSize) return null;
    if (!data && !this.reader) return null;
    if (size === 0) return emptyEntry(file);
    const allocation = this.registry.allocate(size);
    if (!allocation) return null;
    const { segmentId, offset } = allocation;
    const view = new Uint8Array(
      this.pool.getSegment(segmentId).sab,
      offset,
      size,
    );
    try {
      if (data) view.set(data);
      else await this.reader(file, view);
    } catch (err) {
      this.#release(segmentId, offset, size);
      throw err;
    }
    return withExtras(
      { kind: 'shared', segmentId, offset, length: size, stat },
      file,
    );
  }

  // Publish `entry` under `key`; returns the entry it replaces, or null. An
  // entry that lands in a segment compaction closed meanwhile keeps that
  // segment live: it is reopened for allocation and later compaction.
  put(name, key, entry) {
    const { entries } = this.index(name);
    const previous = entries.get(key) || null;
    entries.set(key, entry);
    if (entry.kind === 'shared') this.registry.closed.delete(entry.segmentId);
    return previous;
  }

  // Unpublish `key`; returns the removed entry, or null.
  remove(name, key) {
    const index = this.indexes.get(name);
    if (!index) return null;
    const entry = index.entries.get(key);
    if (!entry) return null;
    index.entries.delete(key);
    return entry;
  }

  // Return an entry's bytes to the pool. Callers guarantee nobody still
  // reads it: never published, or retired, ACKed and released.
  free(entry) {
    if (!entry || entry.kind !== 'shared' || entry.length === 0) return;
    this.#release(entry.segmentId, entry.offset, entry.length);
  }

  #release(segmentId, offset, length) {
    if (!this.pool.getSegment(segmentId)) return;
    this.registry.release(segmentId, offset, length);
    if (this.registry.used(segmentId) === 0) {
      this.registry.unregister(segmentId);
      this.pool.freeSegment(segmentId);
    }
  }

  // Plan the relocation of every published entry of the least-utilised
  // segment (below `threshold`) into free space of the others; never grows
  // the pool. The bytes are copied and the source segment is *closed* — no
  // new allocations land there — but the index is left alone: the caller
  // publishes the moves and retires the old locations like any replaced
  // entry. Retired extents still awaiting ACKs or consumers stay in the
  // closed segment, which returns to the pool once the last is freed.
  // Returns [{ name, key, entry }], or null when nothing qualifies or not
  // everything fits (rolled back). One relocation per call — the kernel runs
  // it once per free cycle.
  // TODO(design): evaluate scheduled / repeated compaction to a target.
  compact(threshold) {
    if (!threshold) return null;
    let target = null;
    let minUtil = threshold;
    let count = 0;
    for (const [segmentId, tail] of this.registry.tail) {
      if (tail === 0 || this.registry.closed.has(segmentId)) continue;
      count++;
      const util = this.registry.used(segmentId) / this.segmentSize;
      if (util < minUtil) {
        minUtil = util;
        target = segmentId;
      }
    }
    if (count < 2 || target === null) return null;
    const items = [];
    for (const [name, index] of this.indexes) {
      for (const [key, entry] of index.entries) {
        if (entry.kind === 'shared' && entry.segmentId === target) {
          items.push({ name, key, entry });
        }
      }
    }
    if (items.length === 0) return null;
    this.registry.closed.add(target);
    const moves = [];
    for (const { name, key, entry } of items) {
      const allocation = this.registry.allocate(entry.length, true);
      if (!allocation) {
        for (const { entry: e } of moves) {
          this.registry.release(e.segmentId, e.offset, e.length);
        }
        this.registry.closed.delete(target);
        return null;
      }
      const src = new Uint8Array(
        this.pool.getSegment(target).sab,
        entry.offset,
        entry.length,
      );
      const dst = this.pool.getSegment(allocation.segmentId).sab;
      new Uint8Array(dst, allocation.offset, entry.length).set(src);
      const { segmentId, offset } = allocation;
      moves.push({ name, key, entry: { ...entry, segmentId, offset } });
    }
    return moves;
  }

  snapshot() {
    const places = {};
    for (const [name, { entries }] of this.indexes) {
      places[name] = { entries: [...entries] };
    }
    return { segments: this.pool.snapshot(), places };
  }

  stats() {
    const lines = [];
    for (const { id } of this.pool.segments.values()) {
      const used = this.registry.used(id);
      const pct = ((used / this.segmentSize) * 100).toFixed(1);
      const mark = this.pool.emptySegmentIds.has(id) ? ' [empty]' : '';
      lines.push(`  seg ${id}: ${used}/${this.segmentSize} (${pct}%)${mark}`);
    }
    return {
      segmentCount: this.pool.segments.size,
      emptyCount: this.pool.emptySegmentIds.size,
      totalUsed: this.pool.totalUsed,
      lines,
    };
  }

  static project(index, segmentsMap) {
    const files = new Map();
    const entries =
      index.entries instanceof Map ? index.entries : new Map(index.entries);
    for (const [key, entry] of entries) {
      files.set(key, FilesystemCache.projectEntry(entry, segmentsMap));
    }
    return files;
  }

  // Zero-copy view for shared entries; disk entries carry only their path.
  static projectEntry(entry, segmentsMap) {
    const { stat, meta, scriptOptions } = entry;
    if (entry.kind !== 'shared') {
      return { data: null, stat, meta, scriptOptions, path: entry.path };
    }
    const { segmentId, offset, length } = entry;
    if (length === 0) {
      return { data: Buffer.alloc(0), stat, meta, scriptOptions };
    }
    return {
      data: Buffer.from(segmentsMap.get(segmentId), offset, length),
      stat,
      meta,
      scriptOptions,
    };
  }
}

module.exports = { FilesystemCache };
