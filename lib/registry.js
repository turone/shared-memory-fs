'use strict';

const path = require('node:path');

const WIN = process.platform === 'win32';
const normalizePath = WIN ? (p) => p.replace(/\\/g, '/') : (p) => p;

// Build absolute OS path for a (place, fileKey) under a given appRoot.
const absPathOf = (appRoot, place, fileKey) => {
  const rel = place.mount + fileKey;
  return path.resolve(appRoot, rel);
};

// PlacementRegistry — owns places and resolves domain+path → place.
// Built once from frozen VfsConfig; live mutation only via register().

class PlacementRegistry {
  constructor(appRoot) {
    this.appRoot = path.resolve(appRoot);
    // Map<domain, Map<segment, place>>
    this.domains = new Map();
    // Map<name, place>
    this.places = new Map();
    // Map<mount, place> — first segment under appRoot → place
    this.byMount = new Map();
  }

  register(place) {
    this.places.set(place.name, place);
    this.byMount.set(place.mount, place);
    for (const domain of place.config.domains) {
      if (!this.domains.has(domain)) this.domains.set(domain, new Map());
      this.domains.get(domain).set(place.mount, place);
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
    return index.get(segment) || null;
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
    if (specifier.startsWith('.') && parentPath) {
      const resolved = path.resolve(path.dirname(parentPath), specifier);
      return this.resolve(domain, resolved);
    }
    return null;
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

module.exports = { PlacementRegistry, absPathOf };
