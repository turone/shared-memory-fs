'use strict';

const path = require('node:path');

const WIN = process.platform === 'win32';
const normalizePath = WIN ? (p) => p.replace(/\\/g, '/') : (p) => p;

// Returns the mount key for a place: match.dir or match.prefix (without leading /).
// Used as the cache namespace and the routing key from absolute paths.
const mountOf = (place) => {
  const m = place.config.match;
  if (m.dir) return m.dir;
  if (m.prefix)
    return m.prefix.startsWith('/') ? m.prefix.substring(1) : m.prefix;
  return null;
};

// Build absolute OS path for a (place, fileKey) under a given appRoot.
const absPathOf = (appRoot, place, fileKey) => {
  const mount = mountOf(place);
  const appKey = mount ? '/' + mount + fileKey : fileKey;
  const rel = appKey.startsWith('/') ? appKey.substring(1) : appKey;
  return path.resolve(appRoot, rel);
};

// PlacementRegistry — owns places and resolves domain+path → place.
// Built once from frozen VfsConfig; live mutation only via register().

class PlacementRegistry {
  constructor(appRoot) {
    this.appRoot = path.resolve(appRoot);
    // Map<domain, { dirs: Map<segment, place>, prefixes: [{prefix, place}], any }>
    this.domains = new Map();
    // Map<name, place>
    this.places = new Map();
    // Map<mount, place> — first segment under appRoot → place
    this.byMount = new Map();
  }

  register(place) {
    this.places.set(place.name, place);
    const mount = mountOf(place);
    if (mount) this.byMount.set(mount, place);
    const { domains, match } = place.config;
    for (const domain of domains) {
      if (!this.domains.has(domain)) {
        this.domains.set(domain, {
          dirs: new Map(),
          prefixes: [],
          any: null,
        });
      }
      const index = this.domains.get(domain);
      if (match.dir) index.dirs.set(match.dir, place);
      else if (match.prefix)
        index.prefixes.push({ prefix: match.prefix, place });
      else if (match.any) index.any = place;
    }
  }

  // Resolve domain + absolute path → place or null.
  resolve(domain, filePath) {
    const index = this.domains.get(domain);
    if (!index) return null;
    const abs = path.resolve(filePath);
    const rel = path.relative(this.appRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const normalized = normalizePath(rel);
    const sepIndex = normalized.indexOf('/');
    const segment =
      sepIndex === -1 ? normalized : normalized.substring(0, sepIndex);
    const dirPlace = index.dirs.get(segment);
    if (dirPlace) return dirPlace;
    for (const { prefix, place } of index.prefixes) {
      const p = prefix.startsWith('/') ? prefix.substring(1) : prefix;
      if (normalized === p || normalized.startsWith(p + '/')) return place;
    }
    return index.any || null;
  }

  // Map absolute path under appRoot → { place, mount, fileKey }.
  // fileKey is relative to mount (starts with '/' or empty for the root itself).
  // Returns null if outside appRoot or no place owns the mount.
  routeByMount(filePath) {
    const abs = path.resolve(filePath);
    const rel = path.relative(this.appRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const normalized = normalizePath(rel);
    const sepIndex = normalized.indexOf('/');
    const mount =
      sepIndex === -1 ? normalized : normalized.substring(0, sepIndex);
    const place = this.byMount.get(mount);
    if (!place) return null;
    const fileKey = sepIndex === -1 ? '' : normalized.substring(sepIndex);
    return { place, mount, fileKey };
  }

  // Resolve domain + module specifier → place or null.
  resolveModule(domain, specifier, parentPath) {
    const index = this.domains.get(domain);
    if (!index) return null;
    if (specifier.startsWith('.') && parentPath) {
      const resolved = path.resolve(path.dirname(parentPath), specifier);
      return this.resolve(domain, resolved);
    }
    return index.any || null;
  }

  getPlace(name) {
    return this.places.get(name) || null;
  }

  getByMount(mount) {
    return this.byMount.get(mount) || null;
  }

  getPlaces() {
    return [...this.places.values()];
  }
}

module.exports = { PlacementRegistry, mountOf, absPathOf };
