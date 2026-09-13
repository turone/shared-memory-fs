'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
const {
  bytecodeKey,
  compressedKey,
  isCompanionKey,
} = require('./companion.js');

// Place — one directory under appRoot, one provider, one origin, up to
// three domains. Internal: consumers get a PlaceFs facade through
// `kernel.fs(name)`.
//
// `files` is the live projection Map<key, { data, stat, scriptOptions?,
// meta?, path? }>:
//   shared entry  { data: Buffer (zero-copy SAB view), stat }
//   disk entry    { data: null, stat, path }
//   map entry     { data: Buffer (owned), stat }
// The kernel replaces / mutates it on init and on every applied delta.
// `scriptOptions` and `meta` are the frozen cloneable objects a preparer
// attached to the file.

class Place {
  constructor(config, appRoot) {
    this.name = config.name;
    this.config = config;
    this.provider = config.provider;
    this.origin = config.origin;
    this.root = path.join(appRoot, config.name);
    this.files = new Map();
    // Mutation engine, set by the kernel: MapStore (map places, also the
    // publication sink of a map+disk scan), SabStore (main thread,
    // sab+virtual) or RemoteStore (worker, sab+virtual). Null when writes
    // go to disk or the place is read-only.
    this.store = null;
    // Preparer named by `fs.script.prepare`; main thread only (set by the
    // kernel). Workers never prepare, they only project prepared bundles.
    this.prepare = null;
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

  // True iff the fs.script pipeline applies to a source key.
  scripted(key) {
    const script = this.config.fs?.script;
    if (!script || isCompanionKey(key)) return false;
    return script.ext.includes(fileExt(key));
  }

  // True iff a preparer owns the content of a source key: its raw input is
  // not retained, so appends and blind renames cannot be honoured.
  prepared(key) {
    return Boolean(this.config.fs?.script?.prepare) && this.scripted(key);
  }

  // True iff key names an implicit directory (root or a prefix of any file).
  isDirectory(key) {
    if (key === '' || key === '/') return true;
    const prefix = key.endsWith('/') ? key : key + '/';
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix) && !isCompanionKey(k)) return true;
    }
    return false;
  }

  // Every source key under an implicit directory; companions follow their
  // source and are not listed.
  keysUnder(dir) {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const result = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix) && !isCompanionKey(key)) result.push(key);
    }
    return result;
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

module.exports = { Place, canonicalKey };
