'use strict';

const path = require('node:path');

const WIN = process.platform === 'win32';
const normalizePath = WIN
  ? (p) => p.replace(/\\/g, '/')
  : (p) => p;

// PlacementRegistry — stores active places, resolves domain+path → place.
// Built from frozen VfsConfig at init. Invariant: no runtime mutation after build.

class PlacementRegistry {
  constructor(appRoot) {
    this.appRoot = path.resolve(appRoot);
    // Map<domain, { dirs: Map<segment, place>, prefixes: [{prefix, place}], any: place|null }>
    this.domains = new Map();
    // Map<name, place>
    this.places = new Map();
  }

  register(place) {
    this.places.set(place.name, place);
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
      if (match.dir) {
        index.dirs.set(match.dir, place);
      } else if (match.prefix) {
        index.prefixes.push({ prefix: match.prefix, place });
      } else if (match.any) {
        index.any = place;
      }
    }
  }

  // Resolve domain + absolute path → place or null.
  // Fast reject for paths outside appRoot.
  resolve(domain, filePath) {
    const index = this.domains.get(domain);
    if (!index) return null;
    const abs = path.resolve(filePath);
    const rel = path.relative(this.appRoot, abs);
    // Outside appRoot → null (passthrough)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const normalized = normalizePath(rel);
    // Dir match: first path segment — O(1) Map lookup
    const sepIndex = normalized.indexOf('/');
    const segment = sepIndex === -1 ? normalized : normalized.substring(0, sepIndex);
    const dirPlace = index.dirs.get(segment);
    if (dirPlace) return dirPlace;
    // Prefix match
    for (const { prefix, place } of index.prefixes) {
      const p = prefix.startsWith('/') ? prefix.substring(1) : prefix;
      if (normalized === p || normalized.startsWith(p + '/')) return place;
    }
    // Fallback
    return index.any || null;
  }

  // Resolve domain + module specifier → place or null.
  // Relative specifier → resolve against parent, then dir match.
  // Bare specifier → only { any: true } fallback (node-default provider).
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

  getPlaces() {
    return [...this.places.values()];
  }
}

module.exports = { PlacementRegistry };
