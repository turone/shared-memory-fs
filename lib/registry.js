'use strict';

const path = require('node:path');
const { INDEXED } = require('./config.js');

const WIN = process.platform === 'win32';
const toKey = WIN ? (rel) => rel.replace(/\\/g, '/') : (rel) => rel;

// PlaceRegistry — owns places and maps absolute paths to (place, key).
// The first path segment under appRoot is the mount and equals the place name.

class PlaceRegistry {
  constructor(appRoot) {
    this.appRoot = path.resolve(appRoot);
    this.places = new Map(); // name → Place
  }

  register(place) {
    this.places.set(place.name, place);
  }

  get(name) {
    return this.places.get(name) || null;
  }

  all() {
    return [...this.places.values()];
  }

  // Absolute path → routing decision, without touching the disk:
  //   null                     outside appRoot — ordinary Node territory
  //   { place, key }           owned by a place; key is '/'-separated with a
  //                            leading '/', '' for the mount root itself
  //   { place: null, key: null }  under appRoot but owned by nobody
  // The third case is a managed denial at every depth: appRoot is the sandbox
  // boundary, so an unmanaged root-level file is as unroutable as a file deep
  // inside an unmanaged directory. Files the process legitimately needs
  // (entry point, package metadata) belong outside appRoot or in an explicit
  // node-default / disk place.
  route(filePath) {
    const abs = path.resolve(filePath);
    const rel = path.relative(this.appRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const normalized = toKey(rel);
    const slash = normalized.indexOf('/');
    const mount = slash === -1 ? normalized : normalized.substring(0, slash);
    const place = this.places.get(mount);
    if (!place) return { place: null, key: null };
    return { place, key: slash === -1 ? '' : normalized.substring(slash) };
  }
}

const deny = (code) => ({ kind: 'deny', code });
const PASSTHROUGH = Object.freeze({ kind: 'passthrough' });

// FsRouter — turns an absolute path into one routing decision so adapters
// never interpret config themselves.
//
// read(absPath) →
//   { kind: 'file', place, key }   published source visible to the fs domain
//   { kind: 'dir',  place, key }   implicit directory of an indexed place
//   { kind: 'passthrough' }        original node:fs handles it
//   { kind: 'deny', code }         EACCES under strict
//
// mutate(absPath) →
//   { kind: 'memory', place, key } per-thread Map mutation
//   { kind: 'passthrough' }        disk write (sab+writable, disk, node-default)
//   { kind: 'deny', code }         EACCES (strict) / EROFS (read-only place)

class FsRouter {
  constructor(registry, strict) {
    this.registry = registry;
    this.strict = strict;
  }

  read(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!place.config.fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!INDEXED.has(place.provider)) return PASSTHROUGH;
    const file = place.files.get(key);
    if (file && place.visible('fs', key)) {
      // Disk-backed entries (oversize, retainRaw:false) are read from disk.
      if (file.data === null) return PASSTHROUGH;
      return { kind: 'file', place, key };
    }
    if (place.isDirectory(key)) return { kind: 'dir', place, key };
    return this.strict ? deny('EACCES') : PASSTHROUGH;
  }

  mutate(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    const { fs, provider } = place.config;
    if (!fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (provider === 'node-default') return PASSTHROUGH;
    if (!fs.writable) return deny('EROFS');
    if (provider === 'memory') return { kind: 'memory', place, key };
    return PASSTHROUGH;
  }
}

module.exports = { PlaceRegistry, FsRouter };
