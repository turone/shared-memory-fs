'use strict';

// Place — logical namespace that owns cached file data.
// files Map is a live reference updated by the kernel on watch events.
// Invariant: config is frozen at construction.

class Place {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    // Map<key, { data: Buffer|null, stat, path? }>
    // SAB entries: { data: Buffer (zero-copy view), stat }
    // Disk entries: { data: null, stat, path }
    this.files = new Map();
  }

  readFile(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.data;
  }

  stat(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.stat;
  }

  exists(key) {
    return this.files.has(key);
  }

  filePath(key) {
    const file = this.files.get(key);
    if (!file) return null;
    return file.path || null;
  }

  list(prefix = '/') {
    const results = [];
    const p = prefix.endsWith('/') ? prefix : prefix + '/';
    for (const key of this.files.keys()) {
      if (key === prefix || key.startsWith(p)) results.push(key);
    }
    return results;
  }
}

module.exports = { Place };
