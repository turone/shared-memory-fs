'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
const {
  bytecodeKey,
  compressedKey,
  isCompanionKey,
} = require('./companion.js');

// The projection of a place — Map<key, entry> — with the implicit
// directories its source keys imply, kept on every set and delete:
// Map<dir, Set<name>>, '' the place root. A directory lookup costs the
// depth of its key and a listing the size of what it lists, never the size
// of the place. Companions are no part of it.
class PlaceFiles extends Map {
  #dirs = new Map();

  set(key, entry) {
    if (!isCompanionKey(key) && !super.has(key)) this.#link(key);
    return super.set(key, entry);
  }

  delete(key) {
    if (!super.delete(key)) return false;
    if (!isCompanionKey(key)) this.#unlink(key);
    return true;
  }

  clear() {
    super.clear();
    this.#dirs.clear();
  }

  // True iff a source key lies below `dir` (a directory key, see dirOf).
  hasDirectory(dir) {
    return this.#dirs.has(dir);
  }

  // What `dir` holds directly: [key, isDirectory].
  *children(dir) {
    for (const name of this.#dirs.get(dir) ?? []) {
      const key = `${dir}/${name}`;
      if (super.has(key)) yield [key, false];
      if (this.#dirs.has(key)) yield [key, true];
    }
  }

  // Everything below `dir`, depth first: [key, isDirectory].
  *below(dir) {
    for (const [key, isDirectory] of this.children(dir)) {
      yield [key, isDirectory];
      if (isDirectory) yield* this.below(key);
    }
  }

  // Every directory above a new source key holds its next name.
  #link(key) {
    let at = 0;
    let next = key.indexOf('/', 1);
    while (next !== -1) {
      this.#name(key.slice(0, at), key.slice(at + 1, next));
      at = next;
      next = key.indexOf('/', at + 1);
    }
    this.#name(key.slice(0, at), key.slice(at + 1));
  }

  #name(dir, name) {
    const names = this.#dirs.get(dir);
    if (names) names.add(name);
    else this.#dirs.set(dir, new Set([name]));
  }

  // A name leaves its directory once nothing bears it; a directory left
  // empty leaves its own.
  #unlink(key) {
    let child = key;
    while (child !== '' && !super.has(child) && !this.#dirs.has(child)) {
      const at = child.lastIndexOf('/');
      const dir = child.slice(0, at);
      const names = this.#dirs.get(dir);
      if (!names?.delete(child.slice(at + 1)) || names.size > 0) return;
      this.#dirs.delete(dir);
      child = dir;
    }
  }
}

// The key of a directory: '' for the place root, else a leading slash and
// none at the end ('/a/b'), whatever form the caller used.
const dirOf = (key) => {
  const trimmed = key.replace(/\/+$/, '');
  if (trimmed === '' || trimmed.startsWith('/')) return trimmed;
  return '/' + trimmed;
};

// Place — one directory under appRoot, one provider, one origin, up to
// three domains. Internal: consumers get a PlaceFs facade through
// `kernel.fs(name)`.
//
// `files` is the live projection (PlaceFiles) Map<key, { data, stat,
// scriptOptions?, meta?, path? }>:
//   shared entry  { data: Buffer (zero-copy SAB view), stat }
//   disk entry    { data: null, stat, path }
//   map entry     { data: Buffer (owned), stat }
// The kernel fills it on init and mutates it on every applied delta.
// Each object is one physical version: stream and view pins key on it.
// `scriptOptions` and `meta` are the frozen cloneable objects a preparer
// attached to the file.

class Place {
  constructor(config, appRoot) {
    this.name = config.name;
    this.config = config;
    this.provider = config.provider;
    this.origin = config.origin;
    this.root = path.join(appRoot, config.name);
    this.files = new PlaceFiles();
    // Mutation engine, set by the kernel: MapStore (map places, also the
    // publication sink of a map+disk scan), SabStore (main thread,
    // sab+virtual) or RemoteStore (worker, sab+virtual). Null when writes
    // go to disk or the place is read-only.
    this.store = null;
    // Preparer callbacks of this thread, Map<ext, fn>, bound by the kernel:
    // all the place names on the main thread, those given to
    // attach({ preparers }) in a worker (local Map writes only).
    this.preparers = null;
  }

  // Content is created by the application; nothing backs it on disk.
  get virtual() {
    return this.origin === 'virtual';
  }

  // Source lookup: exact key first, then the legacy form without a leading
  // slash. Companions are never returned.
  entry(key) {
    if (isCompanionKey(key)) return null;
    const file = this.files.get(key);
    if (file || key.startsWith('/')) return file || null;
    return this.files.get('/' + key) || null;
  }

  // Canonical form of a key that resolved through entry().
  keyOf(key) {
    if (this.files.has(key) || key.startsWith('/')) return key;
    return '/' + key;
  }

  bytecode(key, domain = 'require') {
    return this.files.get(bytecodeKey(key, domain))?.data || null;
  }

  compressed(key, encoding) {
    return this.files.get(compressedKey(key, encoding)) || null;
  }

  // Every companion key this place may hold for a source key, whether or
  // not it is currently present.
  *companions(key) {
    const { require: req, fs } = this.config;
    if (req?.compile) yield bytecodeKey(key, 'require');
    if (fs?.script?.compile) yield bytecodeKey(key, 'script');
    for (const { encoding } of fs?.compress?.codecs || []) {
      yield compressedKey(key, encoding);
    }
  }

  // True iff a source key is visible to the given domain's ext policy.
  visible(domain, key) {
    const settings = this.config[domain];
    if (!settings) return false;
    if (isCompanionKey(key)) return false;
    return !settings.ext || settings.ext.includes(fileExt(key));
  }

  // True iff the place caches files of this key's extension (its scan
  // filter). The rest is disk territory, which a place with
  // `fs.fallback: 'disk'` serves from disk.
  cached(key) {
    const { scanExt } = this.config;
    return !scanExt || scanExt.includes(fileExt(key));
  }

  // True iff the fs.script pipeline applies to a source key.
  scripted(key) {
    const script = this.config.fs?.script;
    if (!script || isCompanionKey(key)) return false;
    return script.ext.includes(fileExt(key));
  }

  // Name of the preparer that owns the content of a source key, or null.
  // Its raw input is not retained, so appends and moves cannot be honoured.
  prepared(key) {
    const { prepare } = this.config;
    if (!prepare || isCompanionKey(key)) return null;
    const ext = fileExt(key);
    return Object.hasOwn(prepare, ext) ? prepare[ext] : null;
  }

  // The preparer callback for a source key in this thread, or null.
  preparerOf(key) {
    if (!this.preparers || isCompanionKey(key)) return null;
    return this.preparers.get(fileExt(key)) || null;
  }

  // True iff key names an implicit directory: the root, or a prefix of a
  // source key.
  isDirectory(key) {
    const dir = dirOf(key);
    return dir === '' || this.files.hasDirectory(dir);
  }

  // Every source key under an implicit directory; companions follow their
  // source and are not listed.
  keysUnder(dir) {
    const keys = [];
    for (const [key, isDirectory] of this.files.below(dirOf(dir))) {
      if (!isDirectory) keys.push(key);
    }
    return keys;
  }

  // Absolute OS path of a key ('' or '/' is the place directory itself).
  pathOf(key) {
    if (key === '' || key === '/') return this.root;
    return path.join(this.root, key);
  }
}

// Canonical source key for mutations: leading '/', no NUL, no '..' segments,
// forward slashes only. Throws on anything else — nothing is normalized away.
const canonicalKey = (key) => {
  if (typeof key !== 'string' || key === '' || key === '/') {
    throw new TypeError(`invalid key: ${String(key)}`);
  }
  if (key.includes('\u0000') || key.includes('\\')) {
    throw new TypeError(`invalid key: ${JSON.stringify(key)}`);
  }
  const canonical = key.startsWith('/') ? key : '/' + key;
  for (const segment of canonical.split('/')) {
    if (segment === '..') throw new TypeError(`invalid key: ${key}`);
  }
  return canonical;
};

module.exports = { Place, PlaceFiles, canonicalKey, dirOf };
