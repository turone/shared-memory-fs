'use strict';

const vm = require('node:vm');
const Module = require('node:module');
const { fileExt } = require('metautil');
const { companionKey, isCompanionKey } = require('./companion.js');

// ModuleCache — V8 bytecode compilation layered on top of a file cache.
// Owns nothing about SAB pooling or projection: both are injected.
// For every compilable source `<key>` it produces a companion entry tagged
// 'cache' holding `vm.Script` cached data (CommonJS-wrapped).

const CACHE_TAG = 'cache';

const cacheKeyOf = (key) => companionKey(key, CACHE_TAG);

class ModuleCache {
  // deps: { cache, projectInto }
  // - cache: FilesystemCache-compatible ({ allocate, getSegment, filesystems })
  // - projectInto(mount, key, entry, files): project one entry into live Map
  constructor({ cache, projectInto }) {
    this.cache = cache;
    this.projectInto = projectInto;
  }

  // Compile CJS source to V8 cached data; null if source doesn't parse.
  createBytecode(source, filename) {
    try {
      const wrapped = Module.wrap(source);
      const script = new vm.Script(wrapped, {
        filename,
        produceCachedData: true,
      });
      return script.createCachedData();
    } catch {
      return null;
    }
  }

  // True iff the place opted into compilation and key is a JS source.
  isCompilable(place, key) {
    return place?.config.compile === true && fileExt(key) === 'js';
  }

  // Init-time: compile every JS source already projected for the place.
  async compilePlace(mount, place) {
    for (const key of [...place.files.keys()]) {
      if (isCompanionKey(key) || fileExt(key) !== 'js') continue;
      await this.compileEntry(mount, key, place);
    }
  }

  async compileEntry(mount, key, place) {
    const file = place.files.get(key);
    if (!file || !file.data) return;
    const bytecode = this.createBytecode(file.data.toString('utf8'), key);
    if (!bytecode) return;
    const cacheKey = cacheKeyOf(key);
    const entry = await this.cache.allocate(mount, cacheKey, {
      stat: { size: bytecode.length },
      data: bytecode,
    });
    this.projectInto(mount, cacheKey, entry, place.files);
  }

  // Watcher path: recompile from a freshly allocated shared source entry.
  // Returns { cacheKey, cacheEntry, oldCache } or null; staging is caller's.
  async compileFromEntry(mount, key, entry) {
    const seg = this.cache.getSegment(entry.segmentId);
    const srcBuf = Buffer.from(seg.sab, entry.offset, entry.length);
    const bytecode = this.createBytecode(srcBuf.toString('utf8'), key);
    if (!bytecode) return null;
    const cacheKey = cacheKeyOf(key);
    const oldCache = this.cache.filesystems[mount]?.entries.get(cacheKey);
    const cacheEntry = await this.cache.allocate(mount, cacheKey, {
      stat: { size: bytecode.length },
      data: bytecode,
    });
    return { cacheKey, cacheEntry, oldCache };
  }
}

module.exports = { ModuleCache, CACHE_TAG, cacheKeyOf };
