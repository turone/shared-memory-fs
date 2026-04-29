'use strict';

const { sizeToBytes } = require('metautil');

const VALID_DOMAINS = ['fs', 'require', 'import'];
const VALID_PROVIDERS = ['sab', 'disk', 'node-default', 'sab-write'];
const VALID_MODES = ['strict', 'overlay'];
const VALID_MATCH_TYPES = ['dir', 'prefix', 'any'];

const DEFAULTS = {
  memory: {
    limit: '1 gib',
    segment: '64 mib',
    maxFileSize: '10 mb',
  },
  gc: {
    enabled: true,
    threshold: 0.3,
  },
  hooks: {
    fs: true,
    require: true,
    import: true,
    diagnostics: false,
  },
  policy: {
    allowWrite: false,
  },
  mode: 'overlay',
  watchTimeout: 1000,
};

const parseSize = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return sizeToBytes(value);
  return value;
};

const deepClone = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const result = {};
  for (const key of Object.keys(obj)) result[key] = deepClone(obj[key]);
  return result;
};

const deepFreeze = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
};

const mergeDeep = (target, source) => {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (Array.isArray(sv)) {
      result[key] = [...sv];
    } else if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
      result[key] = mergeDeep(
        tv !== null && typeof tv === 'object' ? tv : {},
        sv,
      );
    } else {
      result[key] = sv;
    }
  }
  return result;
};

// Parse --vfs.* arguments from argv (after -- separator)
const parseCliArgs = (argv) => {
  const dashIndex = argv.indexOf('--');
  const args = dashIndex === -1 ? [] : argv.slice(dashIndex + 1);
  const result = { enable: null, disable: null, overrides: {} };
  for (const arg of args) {
    if (!arg.startsWith('--vfs.')) continue;
    const eqIndex = arg.indexOf('=');
    if (eqIndex === -1) continue;
    const key = arg.substring(6, eqIndex);
    const value = arg.substring(eqIndex + 1);
    if (key === 'enable') {
      result.enable = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (key === 'disable') {
      result.disable = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      setNested(result.overrides, key, value);
    }
  }
  return result;
};

const setNested = (obj, path, value) => {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
};

const resolveGlobal = (raw) => {
  const base = deepClone(DEFAULTS);
  const merged = raw?.defaults ? mergeDeep(base, raw.defaults) : base;
  return {
    memory: {
      limit: parseSize(merged.memory.limit),
      segment: parseSize(merged.memory.segment),
      maxFileSize: parseSize(merged.memory.maxFileSize),
    },
    gc: {
      enabled: Boolean(merged.gc.enabled),
      threshold: Number(merged.gc.threshold),
    },
    hooks: {
      fs: Boolean(merged.hooks.fs),
      require: Boolean(merged.hooks.require),
      import: Boolean(merged.hooks.import),
      diagnostics: Boolean(merged.hooks.diagnostics),
    },
    policy: {
      allowWrite: Boolean(merged.policy.allowWrite),
    },
    mode: VALID_MODES.includes(merged.mode) ? merged.mode : 'overlay',
    watchTimeout: Number(merged.watchTimeout),
  };
};

const resolvePlace = (name, raw, global) => {
  const config = {
    name,
    enabled: raw.enabled !== false,
    domains: Array.isArray(raw.domains) ? [...raw.domains] : [],
    match: raw.match ? { ...raw.match } : { any: true },
    provider: raw.provider || 'sab',
    ext: Array.isArray(raw.ext) ? [...raw.ext] : null,
    maxFileSize: raw.maxFileSize != null
      ? parseSize(raw.maxFileSize)
      : global.memory.maxFileSize,
    readonly: raw.readonly !== false,
    writeNamespace: raw.writeNamespace || null,
    mode: raw.mode && VALID_MODES.includes(raw.mode)
      ? raw.mode
      : global.mode,
    gc: {
      enabled: raw.gc?.enabled != null
        ? Boolean(raw.gc.enabled)
        : global.gc.enabled,
      threshold: raw.gc?.threshold != null
        ? Number(raw.gc.threshold)
        : global.gc.threshold,
    },
  };
  return config;
};

const validateDomains = (place) => {
  for (const d of place.domains) {
    if (!VALID_DOMAINS.includes(d)) {
      throw new Error(
        `Place "${place.name}": unknown domain "${d}". ` +
        `Valid: ${VALID_DOMAINS.join(', ')}`,
      );
    }
  }
};

const validateProvider = (place) => {
  if (!VALID_PROVIDERS.includes(place.provider)) {
    throw new Error(
      `Place "${place.name}": unknown provider "${place.provider}". ` +
      `Valid: ${VALID_PROVIDERS.join(', ')}`,
    );
  }
};

const validateMatch = (place) => {
  const { match } = place;
  const keys = Object.keys(match);
  if (keys.length !== 1) {
    throw new Error(
      `Place "${place.name}": match must have exactly one key ` +
      `(${VALID_MATCH_TYPES.join(', ')}), got: ${keys.join(', ')}`,
    );
  }
  if (!VALID_MATCH_TYPES.includes(keys[0])) {
    throw new Error(
      `Place "${place.name}": unknown match type "${keys[0]}". ` +
      `Valid: ${VALID_MATCH_TYPES.join(', ')}`,
    );
  }
};

const validateWriteNamespace = (place) => {
  if (!place.readonly && !place.writeNamespace) {
    throw new Error(
      `Place "${place.name}": writable place must specify writeNamespace`,
    );
  }
};

const validateOverlap = (places) => {
  const byDomain = new Map();
  for (const place of places) {
    if (!place.enabled) continue;
    for (const domain of place.domains) {
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push(place);
    }
  }
  for (const [domain, domainPlaces] of byDomain) {
    const dirs = new Map();
    const prefixes = [];
    let anyCount = 0;
    for (const place of domainPlaces) {
      const { match } = place;
      if (match.any) {
        anyCount++;
        if (anyCount > 1) {
          throw new Error(
            `Domain "${domain}": multiple places with { any: true } — ` +
            `only one fallback per domain allowed`,
          );
        }
      } else if (match.dir) {
        const dir = match.dir;
        if (dirs.has(dir)) {
          throw new Error(
            `Domain "${domain}": places "${dirs.get(dir)}" and ` +
            `"${place.name}" both match dir "${dir}"`,
          );
        }
        dirs.set(dir, place.name);
      } else if (match.prefix) {
        prefixes.push({ prefix: match.prefix, name: place.name });
      }
    }
    // Check prefix overlaps
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = i + 1; j < prefixes.length; j++) {
        const a = prefixes[i];
        const b = prefixes[j];
        if (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) {
          throw new Error(
            `Domain "${domain}": places "${a.name}" and "${b.name}" ` +
            `have overlapping prefixes "${a.prefix}" and "${b.prefix}"`,
          );
        }
      }
    }
  }
};

const applyCliOverrides = (global, placesMap, cli) => {
  // --vfs.defaults.* → override global
  if (cli.overrides.defaults) {
    const ov = cli.overrides.defaults;
    if (ov.memory) {
      if (ov.memory.limit) global.memory.limit = parseSize(ov.memory.limit);
      if (ov.memory.segment) {
        global.memory.segment = parseSize(ov.memory.segment);
      }
      if (ov.memory.maxFileSize) {
        global.memory.maxFileSize = parseSize(ov.memory.maxFileSize);
      }
    }
    if (ov.gc) {
      if (ov.gc.threshold) global.gc.threshold = Number(ov.gc.threshold);
    }
    if (ov.mode) global.mode = ov.mode;
    if (ov.watchTimeout) global.watchTimeout = Number(ov.watchTimeout);
  }
  // --vfs.hooks.* → override hooks
  if (cli.overrides.hooks) {
    const h = cli.overrides.hooks;
    if (h.fs != null) global.hooks.fs = h.fs !== 'false';
    if (h.require != null) global.hooks.require = h.require !== 'false';
    if (h.import != null) global.hooks.import = h.import !== 'false';
    if (h.diagnostics != null) {
      global.hooks.diagnostics = h.diagnostics !== 'false';
    }
  }
  // --vfs.place.<name>.* → override per-place
  if (cli.overrides.place) {
    for (const [name, ov] of Object.entries(cli.overrides.place)) {
      const place = placesMap.get(name);
      if (!place) continue;
      if (ov.maxFileSize) place.maxFileSize = parseSize(ov.maxFileSize);
      if (ov.readonly != null) place.readonly = ov.readonly !== 'false';
      if (ov.mode) place.mode = ov.mode;
    }
  }
  // --vfs.enable / --vfs.disable
  if (cli.enable) {
    for (const [, place] of placesMap) place.enabled = false;
    for (const name of cli.enable) {
      const place = placesMap.get(name);
      if (place) place.enabled = true;
    }
  }
  if (cli.disable) {
    for (const name of cli.disable) {
      const place = placesMap.get(name);
      if (place) place.enabled = false;
    }
  }
};

const SKIP = Symbol('skip');

class VfsConfig {
  #global;
  #places;

  constructor(raw = {}) {
    if (raw === SKIP) return;
    const global = resolveGlobal(raw);
    const placesMap = new Map();
    if (raw.places) {
      for (const [name, placeRaw] of Object.entries(raw.places)) {
        placesMap.set(name, resolvePlace(name, placeRaw, global));
      }
    }
    this.#global = global;
    this.#places = placesMap;
    this.#validate();
    deepFreeze(this.#global);
    for (const place of this.#places.values()) deepFreeze(place);
  }

  get global() {
    return this.#global;
  }

  place(name) {
    return this.#places.get(name) || null;
  }

  get places() {
    const result = [];
    for (const place of this.#places.values()) {
      if (place.enabled) result.push(place);
    }
    return result;
  }

  get allPlaces() {
    return [...this.#places.values()];
  }

  #validate() {
    for (const place of this.#places.values()) {
      validateDomains(place);
      validateProvider(place);
      validateMatch(place);
      if (!place.readonly) validateWriteNamespace(place);
    }
    validateOverlap([...this.#places.values()]);
  }

  static fromArgv(argv, appConfig = {}) {
    const cli = parseCliArgs(argv);
    const raw = deepClone(appConfig);
    if (!raw.places) raw.places = {};
    const global = resolveGlobal(raw);
    const placesMap = new Map();
    for (const [name, placeRaw] of Object.entries(raw.places)) {
      placesMap.set(name, resolvePlace(name, placeRaw, global));
    }
    applyCliOverrides(global, placesMap, cli);
    const config = new VfsConfig(SKIP);
    config.#global = global;
    config.#places = placesMap;
    config.#validate();
    deepFreeze(config.#global);
    for (const place of config.#places.values()) deepFreeze(place);
    return config;
  }
}

module.exports = { VfsConfig };
