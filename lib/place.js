'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
const {
  bytecodeKey,
  compressedKey,
  isCompanionKey,
} = require('./companion.js');

// Place — one directory under appRoot, one provider, up to three domains.
// Internal: consumers get a PlaceFs facade through `kernel.fs(name)`.
//
// `files` is the live projection Map<key, { data, stat, path? }>:
//   shared entry  { data: Buffer (zero-copy SAB view), stat }
//   disk entry    { data: null, stat, path }
//   memory entry  { data: Buffer (owned), stat }
// The kernel replaces / mutates it on init and on every applied delta.

class Place {
  constructor(config, appRoot) {
    this.name = config.name;
    this.config = config;
    this.provider = config.provider;
    this.root = path.join(appRoot, config.name);
    this.files = new Map();
    // MemoryStore for provider "memory", set by the kernel.
    this.store = null;
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

  bytecode(key) {
    return this.files.get(bytecodeKey(key))?.data || null;
  }

  compressed(key, encoding) {
    return this.files.get(compressedKey(key, encoding)) || null;
  }

  // True iff a source key is visible to the given domain's ext policy.
  visible(domain, key) {
    const settings = this.config[domain];
    if (!settings) return false;
    if (isCompanionKey(key)) return false;
    return !settings.ext || settings.ext.includes(fileExt(key));
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
