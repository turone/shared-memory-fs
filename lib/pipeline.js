'use strict';

const vm = require('node:vm');
const Module = require('node:module');
const { fileExt } = require('metautil');
const { bytecodeKey, isCompanionKey } = require('./companion.js');
const { deepFreeze } = require('./config.js');
const { fsError } = require('./errors.js');

// What a file *is*, decided once per publication attempt, whatever produced
// its raw input (disk scan, watcher, SEA assets, virtual mutations):
//
//   raw input → the one preparer of its extension (if any) → canonical
//   content → script bytecode → require bytecode
//
// Storage belongs to the caller — pooled SAB segments (the kernel) or a
// per-thread Map (MapStore) — and so does compression (SAB only).
//
//   prepare(raw: Buffer, file) → null | undefined | string | Uint8Array
//                              | { source, scriptOptions?, meta? }
//   file: frozen { place, key, path, ext, stat: { size, mtimeMs } }
//   null  → publish the raw bytes unchanged
//   scriptOptions → vm.Script options (filename, lineOffset, columnOffset…)
//           the library passes to V8 when producing the fs.script cached
//           data and ships in the bundle (PlaceFs.script()). They never
//           enable fs.script by themselves. The library invents none of
//           them: without scriptOptions V8 defaults apply. `cachedData` /
//           `produceCachedData` / `importModuleDynamically` are reserved.
//   meta  → structured-cloneable; stored frozen with the entry and handed
//           back by PlaceFs.script() / PlaceFs.meta() in every thread
//
// A preparer is declared by one domain (`fs`, `require` or `import`) but
// prepares the file for all of them. It is synchronous: it runs inside the
// scanner / watcher pipeline and inside synchronous Map writes. Workers
// never prepare shared places — they project published canonical content.

// Extensions Node's CommonJS loader compiles; `require:bytecode` is wrapped.
const REQUIRE_EXT = new Set(['js', 'cjs']);

const NOOP = () => {};

const fail = (message) => {
  throw new Error(`[vfs] ${message}`);
};

class Preparers {
  #fns;

  constructor(preparers = {}) {
    if (preparers === null || typeof preparers !== 'object') {
      fail('option "preparers" must be an object of functions');
    }
    for (const [name, fn] of Object.entries(preparers)) {
      if (typeof fn !== 'function') fail(`preparers.${name} is not a function`);
    }
    this.#fns = new Map(Object.entries(preparers));
  }

  // The callbacks a place's `prepare` index names, as Map<ext, fn>, or null.
  // `strict` (main thread): every name must be registered — publication
  // needs them all before anything is read. Otherwise (a worker) only what
  // was given is bound; a local mutation that needs a missing one fails
  // then, never the attach.
  bind(place, strict) {
    const { prepare } = place.config;
    if (!prepare) return null;
    const bound = new Map();
    for (const [ext, name] of Object.entries(prepare)) {
      const fn = this.#fns.get(name);
      if (fn) bound.set(ext, fn);
      else if (strict) {
        fail(
          `places.${place.name}: preparer "${name}" is not registered ` +
            '(kernel option `preparers`)',
        );
      }
    }
    return bound;
  }
}

// Canonical bytes of a preparer result, owned by the library: a string is
// encoded, returned bytes are copied (the preparer may reuse its buffer), the
// raw input handed to it is taken as is.
const bytesOf = (source, raw, where) => {
  if (typeof source === 'string') return Buffer.from(source, 'utf8');
  if (source === raw) return raw;
  if (source instanceof Uint8Array) return Buffer.from(source);
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

// Run `prepare` once over the raw bytes of one file. Returns the FileInput
// to publish: `{ data, stat, scriptOptions?, meta? }` — `data` is the
// canonical content, `stat.size` its length, `stat.mtimeMs` the raw input's.
const prepareInput = (place, key, input, raw, prepare) => {
  const where = `[vfs] place "${place.name}": prepare "${key}"`;
  const stat = Object.freeze({ ...input.stat });
  const file = Object.freeze({
    place: place.name,
    key,
    path: place.pathOf(key),
    ext: fileExt(key),
    stat,
  });
  const result = prepare(raw, file);
  if (result === null || result === undefined) {
    return { data: raw, stat: input.stat };
  }
  if (typeof result.then === 'function') {
    // An async preparer's rejection must not surface as an unhandled one.
    if (result instanceof Promise) result.catch(NOOP);
    throw new TypeError(`${where}: preparers must be synchronous`);
  }
  const bare = typeof result === 'string' || result instanceof Uint8Array;
  if (!bare && typeof result !== 'object') {
    throw new TypeError(
      `${where}: result must be a string, a Uint8Array or { source }`,
    );
  }
  const data = bytesOf(bare ? result : result.source, raw, where);
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
// a require failure is best-effort (the caller drops the stale companion),
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

const NONE = new Set();

// True iff an ancestor of `key` is a file, published or being created.
const fileAbove = (place, key, creating) => {
  let at = key.lastIndexOf('/');
  while (at > 0) {
    const parent = key.slice(0, at);
    if (place.files.has(parent) || creating.has(parent)) return true;
    at = key.lastIndexOf('/', at - 1);
  }
  return false;
};

// A path is a file or a directory, never both. Before a primary key is
// created — written, copied or renamed into a virtual place — no ancestor
// may be a file (ENOTDIR) and the key itself may not be a directory
// (EISDIR). `creating` holds the keys whose publication has begun but not
// committed: they count as files already, so two concurrent mutations
// cannot both pass. Companions are no part of the hierarchy.
const checkHierarchy = (place, key, fail, creating = NONE) => {
  if (fileAbove(place, key, creating)) throw fail('ENOTDIR');
  if (place.files.has(key)) return;
  if (place.isDirectory(key)) throw fail('EISDIR');
  const prefix = key + '/';
  for (const other of creating) {
    if (other.startsWith(prefix)) throw fail('EISDIR');
  }
};

// An exclusive write ('x' flag) creates `key` only: a file or a directory
// there is EEXIST. A file above it leaves nothing there, and
// checkHierarchy answers ENOTDIR.
const checkExclusive = (place, key, fail) => {
  if (place.files.has(key) || place.isDirectory(key)) throw fail('EEXIST');
};

// Why a removal finds no file at `key`: the one there is named as a
// directory, with a trailing separator — ENOTDIR, as on POSIX, which `force`
// ignores as it does ENOENT — or there is none.
const absentCode = (place, key) =>
  place.files.has(key) ? 'ENOTDIR' : 'ENOENT';

// mkdir in a virtual place creates no entry, yet answers as a filesystem
// does: a file at the key is EEXIST, a file above it ENOTDIR, an existing
// directory EEXIST unless `recursive`.
const checkMkdir = (place, key, recursive, fail, creating = NONE) => {
  if (place.files.has(key) || creating.has(key)) throw fail('EEXIST');
  if (fileAbove(place, key, creating)) throw fail('ENOTDIR');
  if (!recursive && place.isDirectory(key)) throw fail('EEXIST');
};

// Why a published source cannot move under another key as it is — bytes,
// stat and mtime unchanged — or null: a prepared source keeps no raw input,
// and bytecode, scriptOptions and meta may name the old path. A compressed
// representation depends on the content alone, so it moves along.
const immovable = (place, key) => {
  if (place.prepared(key)) return 'prepared source';
  if (bytecodeDomains(place, key).length > 0) return 'compiled source';
  const file = place.files.get(key);
  if (file?.scriptOptions || file?.meta) return 'path-dependent metadata';
  return null;
};

// A directory rename inside one virtual place, planned before anything
// changes: every source under `from`, with the companions it has, re-keyed
// under `to` — `[[key, newKey]]`. The whole subtree moves or nothing does:
// one source that cannot move refuses it all (ENOTSUP).
const subtreeMoves = (place, from, to, creating) => {
  const fail = (code, detail) =>
    fsError(code, 'rename', place.pathOf(from), detail, place.pathOf(to));
  const sources = place.keysUnder(from);
  if (sources.length === 0) throw fail('ENOENT');
  if (to === from) return [];
  if (to.startsWith(from + '/')) {
    throw fail('EINVAL', 'a directory into itself');
  }
  if (place.files.has(to)) throw fail('ENOTDIR');
  if (place.isDirectory(to)) throw fail('ENOTEMPTY');
  checkHierarchy(place, to, fail, creating);
  const moves = [];
  for (const key of sources) {
    const reason = immovable(place, key);
    if (reason) throw fail('ENOTSUP', `${reason} ${key}`);
    const newKey = to + key.slice(from.length);
    moves.push([key, newKey]);
    for (const companion of place.companions(key)) {
      if (!place.files.has(companion)) continue;
      moves.push([companion, newKey + companion.slice(key.length)]);
    }
  }
  return moves;
};

module.exports = {
  Preparers,
  prepareInput,
  bytecodeDomains,
  bytecodeFor,
  createBytecode,
  checkHierarchy,
  checkExclusive,
  checkMkdir,
  absentCode,
  subtreeMoves,
};
