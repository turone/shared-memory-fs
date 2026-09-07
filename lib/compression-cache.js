'use strict';

const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { availableParallelism } = require('node:os');
const { fileExt } = require('metautil');
const { compressedKey, isCompanionKey } = require('./companion.js');

// CompressionCache — pre-compressed representations for the fs domain,
// layered on the file cache. Owns nothing about SAB pooling or projection:
// both are injected. Each representation is a companion entry
// `compressedKey(key, encoding)` holding the compressed bytes of `<key>`.

const CODECS = {
  gzip: { compress: zlib.gzip, param: null },
  deflate: { compress: zlib.deflate, param: null },
  br: {
    compress: zlib.brotliCompress,
    param: zlib.constants.BROTLI_PARAM_QUALITY,
  },
  zstd: {
    compress: zlib.zstdCompress,
    param: zlib.constants.ZSTD_c_compressionLevel,
  },
};

// Companions are bounded by the segment size only, never by maxFileSize.
const ALLOC = { fallback: false, maxFileSize: Infinity };

// Async zlib runs on the libuv threadpool, shared with init-time file reads;
// oversubscribing it only raises peak heap.
const defaultConcurrency = () => {
  const pool = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  return Math.max(1, Math.min(pool, availableParallelism()));
};

// Translate the validated `{ level }` into the codec's own option shape.
// No options object at all when the user configured none: zlib defaults apply.
const zlibOptions = (encoding, options) => {
  if (!options) return null;
  const { param } = CODECS[encoding];
  if (!param) return { level: options.level };
  return { params: { [param]: options.level } };
};

class CompressionCache {
  // deps: { cache, projectInto, console, concurrency }
  constructor({ cache, projectInto, console, concurrency }) {
    this.cache = cache;
    this.projectInto = projectInto;
    this.console = console || globalThis.console;
    this.concurrency = concurrency || defaultConcurrency();
    this.codecs = new Map();
  }

  #codec(encoding) {
    let fn = this.codecs.get(encoding);
    if (fn) return fn;
    const { compress } = CODECS[encoding];
    if (!compress) {
      throw new Error(
        `[vfs] encoding "${encoding}" is unavailable in this Node.js build`,
      );
    }
    fn = promisify(compress);
    this.codecs.set(encoding, fn);
    return fn;
  }

  // True iff the place compresses this key: it must be visible to the fs
  // domain and, when `compress.ext` is set, match it.
  compressible(place, key) {
    const compress = place.config.fs?.compress;
    if (!compress || isCompanionKey(key)) return false;
    if (!place.visible('fs', key)) return false;
    return !compress.ext || compress.ext.includes(fileExt(key));
  }

  // Build every representation of one source buffer.
  // Returns { built: [{ encoding, key, entry, oldEntry }], failed: [encoding] }.
  // A representation that does not fit in SAB is skipped, never published as
  // a disk entry pointing at the raw file.
  async compressBuffer(place, key, src, srcStat) {
    const built = [];
    const failed = [];
    for (const { encoding, options } of place.config.fs.compress.codecs) {
      const cacheKey = compressedKey(key, encoding);
      const oldEntry = this.cache.entry(place.name, cacheKey);
      const data = await this.#compress(place, key, encoding, src, options);
      if (!data) {
        failed.push(encoding);
        continue;
      }
      const stat = {
        size: data.length,
        sourceSize: srcStat.size,
        encoding,
        mtimeMs: srcStat.mtimeMs,
      };
      const entry = await this.cache.allocate(
        place.name,
        cacheKey,
        { data, stat },
        ALLOC,
      );
      if (!entry) {
        this.#warn(place, key, encoding, 'does not fit in one SAB segment');
        failed.push(encoding);
        continue;
      }
      built.push({ encoding, key: cacheKey, entry, oldEntry });
    }
    return { built, failed };
  }

  async #compress(place, key, encoding, src, options) {
    const codec = this.#codec(encoding);
    const opts = zlibOptions(encoding, options);
    try {
      return opts ? await codec(src, opts) : await codec(src);
    } catch (err) {
      this.#warn(place, key, encoding, err.message);
      return null;
    }
  }

  #warn(place, key, encoding, reason) {
    this.console.warn(
      `[vfs] place "${place.name}": skipped ${encoding} for "${key}" — ${reason}`,
    );
  }

  // Init-time pass over one place; `readSource(key)` yields the source bytes
  // (a SAB view when raw is retained, a disk read otherwise).
  async compressPlace(place, readSource) {
    const keys = [...place.files.keys()].filter((key) =>
      this.compressible(place, key),
    );
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++];
        const src = await readSource(key);
        if (!src) continue;
        const { stat } = place.files.get(key);
        const { built } = await this.compressBuffer(place, key, src, stat);
        for (const { key: cacheKey, entry } of built) {
          this.projectInto(place, cacheKey, entry);
        }
      }
    };
    const size = Math.min(this.concurrency, keys.length);
    await Promise.all(Array.from({ length: size }, worker));
  }
}

module.exports = { CompressionCache };
