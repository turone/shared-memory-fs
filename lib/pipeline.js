'use strict';

const vm = require('node:vm');
const Module = require('node:module');
const { fileExt } = require('metautil');
const { bytecodeKey, isCompanionKey } = require('./companion.js');
const { deepFreeze } = require('./config.js');

// The single preparation pipeline, shared by every source of raw input
// (disk scan, watcher, SEA assets, virtual mutations):
//
//   raw input → fs.script applicability → optional prepare → canonical
//   source → optional script bytecode → optional require bytecode
//
// Storage differs per provider (pooled SAB segments or a per-thread Map) and
// belongs to the caller; what a file *is* is decided here, once.
//
//   prepare(raw: Buffer, file) → null | string | Uint8Array
//                              | { source, scriptOptions?, meta? }
//   file: frozen { place, key, path, ext, stat: { size, mtimeMs } }
//   null  → publish the raw bytes unchanged
//   scriptOptions → vm.Script options (filename, lineOffset, columnOffset…)
//           the library passes to V8 when producing the script cached data
//           and ships in the bundle (PlaceFs.script()). The library invents
//           none of them: without scriptOptions V8 defaults apply.
//           `cachedData` / `produceCachedData` / `importModuleDynamically`
//           are reserved (library- or caller-owned).
//   meta  → structured-cloneable; stored frozen with the entry and handed
//           back by PlaceFs.script() / PlaceFs.meta() in every thread
//
// Preparers are synchronous: they run inside the scanner / watcher pipeline
// and inside synchronous Map writes. Workers never receive them — only
// prepared bundles.

// Extensions Node's CommonJS loader compiles; `require:bytecode` is wrapped.
const REQUIRE_EXT = new Set(['js', 'cjs']);

const fail = (message) => {
  throw new Error(`[vfs] ${message}`);
};

class Preparers {
  #fns;

  constructor(preparers = {}) {
    if (preparers === null || typeof preparers !== 'object') {
      fail('option "preparers" must be an object of functions');
    }
    for (const [id, fn] of Object.entries(preparers)) {
      if (typeof fn !== 'function') fail(`preparers.${id} is not a function`);
    }
    this.#fns = new Map(Object.entries(preparers));
  }

  // Resolve every place's `fs.script.prepare` identifier once, at init.
  // Returns Map<placeName, fn>; a dangling identifier is a startup error.
  resolve(places) {
    const result = new Map();
    for (const pc of places) {
      const id = pc.fs?.script?.prepare;
      if (!id) continue;
      const fn = this.#fns.get(id);
      if (!fn) {
        fail(
          `places.${pc.name}.fs.script.prepare: no preparer "${id}" ` +
            '(pass it in the kernel option `preparers`)',
        );
      }
      result.set(pc.name, fn);
    }
    return result;
  }
}

const toBuffer = (source, where) => {
  if (typeof source === 'string') return Buffer.from(source, 'utf8');
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  }
  throw new TypeError(`${where}: source must be a string or Uint8Array`);
};

const RESERVED_SCRIPT_OPTIONS = [
  'cachedData',
  'produceCachedData',
  'importModuleDynamically',
];

// Cloned + frozen copy of a preparer-returned object, or null.
const cloneField = (value, where, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') {
    throw new TypeError(`${where}: ${name} must be an object`);
  }
  return deepFreeze(structuredClone(value));
};

const scriptOptionsOf = (value, where) => {
  const options = cloneField(value, where, 'scriptOptions');
  if (!options) return null;
  for (const name of RESERVED_SCRIPT_OPTIONS) {
    if (name in options) {
      throw new TypeError(`${where}: scriptOptions.${name} is reserved`);
    }
  }
  return options;
};

// Run the place's preparer for one file. Returns the FileInput to publish:
// `{ data, stat, scriptOptions?, meta? }` — `data` is the canonical
// content, `stat.size` its length, `stat.mtimeMs` the raw file's. Without
// an applicable preparer the input is returned untouched (a `{ path, stat }`
// input stays a path, so the SAB reader can still stream it from disk).
const prepareInput = (place, key, input, raw) => {
  const fn = place.prepare;
  if (!fn || !place.scripted(key)) return input;
  const where = `[vfs] place "${place.name}": prepare "${key}"`;
  const stat = Object.freeze({ ...input.stat });
  const file = Object.freeze({
    place: place.name,
    key,
    path: place.pathOf(key),
    ext: fileExt(key),
    stat,
  });
  const result = fn(raw, file);
  if (result === null || result === undefined) {
    return { data: raw, stat: input.stat };
  }
  if (typeof result.then === 'function') {
    throw new TypeError(`${where}: preparers must be synchronous`);
  }
  const bare = typeof result === 'string' || result instanceof Uint8Array;
  const data = toBuffer(bare ? result : result.source, where);
  const output = {
    data,
    stat: { size: data.length, mtimeMs: input.stat.mtimeMs },
  };
  if (bare) return output;
  // structuredClone both validates cloneability and detaches the copy.
  const scriptOptions = scriptOptionsOf(result.scriptOptions, where);
  const meta = cloneField(result.meta, where, 'meta');
  if (scriptOptions) output.scriptOptions = scriptOptions;
  if (meta) output.meta = meta;
  return output;
};

// --- V8 cached data ---
// Internal: cached data is always produced by the library from the canonical
// source it publishes, so source and bytecode can never diverge. Callers
// never supply their own; the public result is `PlaceFs.script(key)`.

// Compile to V8 cached data; null when the source does not parse.
const createBytecode = (source, options) => {
  try {
    return new vm.Script(source, options).createCachedData();
  } catch {
    return null;
  }
};

// Bytecode flavors `key` gets in `place`, in a stable order. Two independent
// mechanisms, one companion each, both built from the canonical source:
//   require  Module.wrap(source) under the module filename, consumed by the
//            _compile hook (`require.compile`); ext js / cjs.
//   script   the bare source under the preparer's scriptOptions, consumed
//            through PlaceFs.script() (`fs.script.compile`).
const bytecodeDomains = (place, key) => {
  if (isCompanionKey(key)) return [];
  const result = [];
  const { require: req, fs } = place.config;
  if (req?.compile && REQUIRE_EXT.has(fileExt(key))) {
    if (place.visible('require', key)) result.push('require');
  }
  if (fs?.script?.compile && place.scripted(key)) result.push('script');
  return result;
};

// Cached data companions of one canonical source, as
// `[{ domain, key, data }]`. `data` is null when the source does not parse:
// a require failure is best-effort (the caller retires the stale companion),
// a script failure invalidates the whole publication.
const bytecodeFor = (place, key, source, scriptOptions) => {
  const domains = bytecodeDomains(place, key);
  if (domains.length === 0) return [];
  const text = source.toString('utf8');
  const result = [];
  for (const domain of domains) {
    const wrapped = domain === 'require';
    const code = wrapped ? Module.wrap(text) : text;
    const options = wrapped
      ? { filename: place.pathOf(key) }
      : scriptOptions || {};
    const data = createBytecode(code, options);
    result.push({ domain, key: bytecodeKey(key, domain), data });
  }
  return result;
};

module.exports = {
  Preparers,
  prepareInput,
  bytecodeDomains,
  bytecodeFor,
  createBytecode,
};
