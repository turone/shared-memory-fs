'use strict';

const vm = require('node:vm');
const Module = require('node:module');
const { fileExt } = require('metautil');
const { bytecodeKey, isCompanionKey } = require('./companion.js');

// ModuleCache — V8 bytecode for CommonJS sources, layered on the file cache.
// Owns nothing about SAB pooling or projection: both are injected.
// Each compilable source `<key>` gets a companion entry `bytecodeKey(key)`
// holding `vm.Script` cached data of the CommonJS-wrapped source, compiled
// under the same absolute filename the require hook will use.

const BYTECODE_EXT = new Set(['js', 'cjs']);

// Companions are bounded by the segment size only, never by maxFileSize.
const ALLOC = { fallback: false, maxFileSize: Infinity };

// Compile CJS source to V8 cached data; null when the source does not parse.
const createBytecode = (source, filename) => {
  try {
    const script = new vm.Script(Module.wrap(source), {
      filename,
      produceCachedData: true,
    });
    return script.createCachedData();
  } catch {
    return null;
  }
};

class ModuleCache {
  // deps: { cache, projectInto }
  // - cache: FilesystemCache ({ allocate, getSegment, entry })
  // - projectInto(place, key, entry): project one entry into place.files
  constructor({ cache, projectInto }) {
    this.cache = cache;
    this.projectInto = projectInto;
  }

  // True iff the place compiles and `key` is a JS source the require domain
  // sees.
  compilable(place, key) {
    const { require: req } = place.config;
    if (!req?.compile || isCompanionKey(key)) return false;
    return BYTECODE_EXT.has(fileExt(key)) && place.visible('require', key);
  }

  // Init-time: compile every source already projected for the place.
  async compilePlace(place) {
    for (const key of [...place.files.keys()]) {
      if (!this.compilable(place, key)) continue;
      const file = place.files.get(key);
      if (!file.data) continue;
      const { entry } = await this.compile(place, key, file.data);
      if (entry) this.projectInto(place, bytecodeKey(key), entry);
    }
  }

  // Watcher path: compile from a freshly allocated shared source entry.
  // Returns { key, entry, oldEntry }; `entry` is null when compilation or
  // allocation failed, so the caller retires the stale companion.
  async compileFromEntry(place, key, sourceEntry) {
    const { sab } = this.cache.getSegment(sourceEntry.segmentId);
    const src = Buffer.from(sab, sourceEntry.offset, sourceEntry.length);
    return this.compile(place, key, src);
  }

  async compile(place, key, src) {
    const cacheKey = bytecodeKey(key);
    const oldEntry = this.cache.entry(place.name, cacheKey);
    const data = createBytecode(src.toString('utf8'), place.pathOf(key));
    if (!data) return { key: cacheKey, entry: null, oldEntry };
    const stat = { size: data.length, mtimeMs: Date.now() };
    const entry = await this.cache.allocate(
      place.name,
      cacheKey,
      { data, stat },
      ALLOC,
    );
    return { key: cacheKey, entry, oldEntry };
  }
}

module.exports = { ModuleCache, createBytecode };
