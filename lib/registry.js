'use strict';

const path = require('node:path');
const { INDEXED } = require('./config.js');

const WIN = process.platform === 'win32';
const toKey = WIN ? (rel) => rel.replace(/\\/g, '/') : (rel) => rel;

// Lexical containment: only a real `..` component leaves appRoot. `..private`,
// `...data` or `file..js` are ordinary names routed by the Place rules.
const PARENT = '..' + path.sep;
const outside = (rel) =>
  rel === '..' || rel.startsWith(PARENT) || path.isAbsolute(rel);

// appRoot itself: the boundary, never the root of a place.
const APP_ROOT = Object.freeze({ place: null, key: null, root: true });

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
  //   null                     outside appRoot — ordinary Node
  //   { place: null, key: null, root: true }  appRoot itself
  //   { place, key }           owned by a place; key is '/'-separated with a
  //                            leading '/', '' for the mount root itself
  //   { place: null, key: null }  under appRoot but owned by nobody
  // The third case is a managed denial at every depth: appRoot is the strict
  // routing boundary, so an unmanaged root-level file is as unroutable as a
  // file deep inside an unmanaged directory. Files the process legitimately
  // needs (entry point, package metadata) belong outside appRoot or in an
  // explicit node-default / disk place.
  route(filePath) {
    const abs = path.resolve(filePath);
    const rel = path.relative(this.appRoot, abs);
    if (outside(rel)) return null;
    if (rel === '') return APP_ROOT;
    const normalized = toKey(rel);
    const slash = normalized.indexOf('/');
    const mount = slash === -1 ? normalized : normalized.substring(0, slash);
    const place = this.places.get(mount);
    if (!place) return { place: null, key: null };
    return { place, key: slash === -1 ? '' : normalized.substring(slash) };
  }

  // True for appRoot and every directory above it: a walk from there
  // enters the places.
  encloses(filePath) {
    const rel = path.relative(path.resolve(filePath), this.appRoot);
    return rel === '' || !outside(rel);
  }
}

const deny = (code) => ({ kind: 'deny', code });
const PASSTHROUGH = Object.freeze({ kind: 'passthrough' });
const ROOT = Object.freeze({ kind: 'root' });
const UNSUPPORTED = Object.freeze({ kind: 'unsupported' });
const CROSSING = Object.freeze({ kind: 'crossing' });
const NOT_A_DIRECTORY = Object.freeze({ kind: 'deny', code: 'ENOTDIR' });

// A path that ends in a separator names a directory, as on POSIX — on every
// platform for what the VFS serves or stores; node:fs keeps its own rules.
const TRAILING = WIN ? /[\\/]$/ : /\/$/;

// FsRouter — turns an absolute path into one routing decision so adapters
// never interpret config themselves.
//
// read(absPath) →
//   { kind: 'file', place, key }   published source visible to the fs domain
//   { kind: 'dir',  place, key }   implicit directory of an indexed place
//   { kind: 'root' }               appRoot under strict: a managed root that
//                                  lists the enabled places and nothing else
//   { kind: 'disk', place, key }   disk territory of `fs.fallback: 'disk'`:
//                                  original node:fs, except that a listing
//                                  comes from the place, which never lists a
//                                  raw file of an extension it caches
//   { kind: 'passthrough' }        original node:fs handles it
//   { kind: 'deny', code }         EACCES under strict or `fs.fallback`;
//                                  ENOTDIR for a served file named with a
//                                  trailing separator
//
// mutate(absPath) →
//   { kind: 'store', place, key }  mutation owned by the place's store: a
//                                  per-thread Map, or the main kernel for a
//                                  shared virtual place (asynchronous, see
//                                  `place.store.sync`); a path named with a
//                                  trailing separator keeps it as a slash
//                                  on its key: a directory (see PlaceFs)
//   { kind: 'passthrough' }        disk write (disk-origin, disk, node-default)
//   { kind: 'deny', code }         EACCES (strict, appRoot itself included) /
//                                  EROFS (read-only place)
//
// copy(absPath, recursive) → where the raw input of a copy's source lives:
//   { kind: 'passthrough' }        on disk at that path — outside appRoot,
//                                  a passthrough place, a disk-origin place
//                                  (its raw source of truth, prepared or
//                                  not) or its disk territory
//   { kind: 'canonical', place, key }  in the VFS: an unprepared virtual or
//                                  SEA entry, whose canonical bytes are its
//                                  raw input
//   { kind: 'deny', code }         refused as a read
//   { kind: 'unsupported' }        no raw input to hand on — a prepared
//                                  virtual or SEA entry, a directory of the
//                                  places — and, for a recursive copy, a
//                                  managed path: a native walk reads and
//                                  writes raw files past the routing
//
// rename(fromPath, toPath) → a native rename, both paths having passed the
// mutation routing; it moves the raw file:
//   { kind: 'passthrough' }        node:fs renames it within its territory:
//                                  one indexed place, or none
//   { kind: 'crossing' }           it enters or leaves an indexed place:
//                                  node:fs moves a file, the raw source of
//                                  truth, into the destination's policy; a
//                                  directory, whose descendants would all
//                                  change policy at once, is unsupported
//   { kind: 'deny', code }         the source is hidden: moving it would
//                                  make it readable
//   { kind: 'unsupported' }        a tree that holds places
//
// link(fromPath, toPath) → a hard link names one physical file twice, while
// a place gives every name its own canonical content and companions:
//   { kind: 'passthrough' }        node:fs links it
//   { kind: 'deny', code }         a hidden source, a refused destination
//   { kind: 'unsupported' }        either name in an indexed place

class FsRouter {
  constructor(registry, strict) {
    this.registry = registry;
    this.strict = strict;
  }

  read(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    if (route.root) return this.strict ? ROOT : PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!place.config.fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (!INDEXED.has(place.provider)) return PASSTHROUGH;
    const file = place.files.get(key);
    if (file && place.visible('fs', key)) {
      if (TRAILING.test(filePath)) return NOT_A_DIRECTORY;
      // Disk-backed entries (oversize, retainRaw:false) are read from disk.
      if (file.data === null) return PASSTHROUGH;
      return { kind: 'file', place, key };
    }
    if (place.isDirectory(key)) return { kind: 'dir', place, key };
    return this.#miss(place, key);
  }

  // A path an indexed place does not serve. A disk-origin place decides by
  // `fs.fallback`: 'deny' refuses it; 'disk' serves it from disk — under
  // strict only outside the extensions the place caches, which stay
  // VFS-only so a raw file never stands in for its canonical (prepared)
  // content; the non-strict default stays permissive. A place with no
  // directory behind it (virtual, sea) follows the mode.
  #miss(place, key) {
    const { fallback } = place.config.fs;
    if (fallback === 'deny') return deny('EACCES');
    if (fallback === 'disk' && (!this.strict || !place.cached(key))) {
      return { kind: 'disk', place, key };
    }
    return this.strict ? deny('EACCES') : PASSTHROUGH;
  }

  mutate(filePath) {
    const route = this.registry.route(filePath);
    if (!route) return PASSTHROUGH;
    if (route.root) return this.strict ? deny('EACCES') : PASSTHROUGH;
    const { place, key } = route;
    if (!place) return this.strict ? deny('EACCES') : PASSTHROUGH;
    const { fs, provider } = place.config;
    if (!fs) return this.strict ? deny('EACCES') : PASSTHROUGH;
    if (provider === 'node-default') return PASSTHROUGH;
    if (!fs.writable) return deny('EROFS');
    // Disk-origin writes land on disk; the watcher republishes them.
    if (place.virtual) {
      const slash = key && TRAILING.test(filePath) ? '/' : '';
      return { kind: 'store', place, key: key + slash };
    }
    return PASSTHROUGH;
  }

  copy(filePath, recursive) {
    const route = this.read(filePath);
    if (route.kind === 'deny') return route;
    if (recursive) {
      const managed =
        this.#indexed(filePath) || this.registry.encloses(filePath);
      return managed ? UNSUPPORTED : PASSTHROUGH;
    }
    if (route.kind === 'dir' || route.kind === 'root') return UNSUPPORTED;
    if (route.kind !== 'file') return PASSTHROUGH;
    const { place, key } = route;
    if (!place.virtual && place.provider !== 'sea') return PASSTHROUGH;
    if (place.prepared(key)) return UNSUPPORTED;
    return { kind: 'canonical', place, key };
  }

  rename(fromPath, toPath) {
    const src = this.read(fromPath);
    if (src.kind === 'deny') return src;
    if (this.registry.encloses(fromPath)) return UNSUPPORTED;
    const stays = this.#indexed(fromPath) === this.#indexed(toPath);
    return stays ? PASSTHROUGH : CROSSING;
  }

  link(fromPath, toPath) {
    const src = this.read(fromPath);
    if (src.kind === 'deny') return src;
    const dst = this.mutate(toPath);
    if (dst.kind === 'deny') return dst;
    const managed = this.#indexed(fromPath) || this.#indexed(toPath);
    return managed || src.kind !== 'passthrough' ? UNSUPPORTED : PASSTHROUGH;
  }

  // The indexed place that owns a path, or null.
  #indexed(filePath) {
    const place = this.registry.route(filePath)?.place;
    return INDEXED.has(place?.provider) ? place : null;
  }
}

module.exports = { PlaceRegistry, FsRouter };
