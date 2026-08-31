'use strict';

const { sizeToBytes } = require('metautil');

const VALID_DOMAINS = ['fs', 'require', 'import'];
const VALID_PROVIDERS = ['sab', 'disk', 'node-default', 'memory', 'sea'];
const VALID_EXT_ON_EXTRA = ['silent', 'warn', 'error'];
const VALID_ENCODINGS = ['gzip', 'deflate', 'br', 'zstd'];

// Inclusive level bounds per codec, used to validate `compress.options`.
const LEVEL_RANGE = {
  gzip: [0, 9],
  deflate: [0, 9],
  br: [0, 11],
  zstd: [1, 22],
};

// Expansion of `compress.ext: 'compressible'` — formats that gain from
// compression. Already-compressed media (png, jpg, woff2, mp4) is excluded.
const COMPRESSIBLE_EXT = [
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'json',
  'map',
  'svg',
  'xml',
  'txt',
  'md',
  'csv',
  'wasm',
  'ttf',
  'otf',
  'webmanifest',
];

const DEFAULTS = {
  memory: {
    limit: '1 gib',
    segmentSize: '64 mib',
    maxFileSize: '10 mb',
  },
  compaction: {
    threshold: 0.3,
  },
  hooks: {
    fs: true,
    require: true,
    import: true,
  },
  watchTimeout: 1000,
  strict: false,
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
    if (
      value !== null &&
      typeof value === 'object' &&
      !Object.isFrozen(value)
    ) {
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
      result.enable = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (key === 'disable') {
      result.disable = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      setNested(result.overrides, key, value);
    }
  }
  return result;
};

const resolveGlobal = (raw) => {
  const base = deepClone(DEFAULTS);
  const merged = raw?.defaults ? mergeDeep(base, raw.defaults) : base;
  return {
    memory: {
      limit: parseSize(merged.memory.limit),
      segmentSize: parseSize(merged.memory.segmentSize),
      maxFileSize: parseSize(merged.memory.maxFileSize),
    },
    compaction: {
      threshold: Number(merged.compaction.threshold),
    },
    hooks: {
      fs: Boolean(merged.hooks.fs),
      require: Boolean(merged.hooks.require),
      import: Boolean(merged.hooks.import),
    },
    watchTimeout: Number(merged.watchTimeout),
    strict: Boolean(merged.strict),
  };
};

const resolveCompressExt = (name, ext) => {
  if (ext === undefined || ext === null) return null;
  if (ext === 'compressible') return [...COMPRESSIBLE_EXT];
  if (!Array.isArray(ext)) {
    throw new Error(
      `Place "${name}": compress.ext must be an array or 'compressible'`,
    );
  }
  for (const item of ext) {
    if (!item || typeof item !== 'string') {
      throw new Error(
        `Place "${name}": compress.ext items must be non-empty strings`,
      );
    }
  }
  return [...ext];
};

// Returns null when the user gave no options: the codec then runs with
// native zlib defaults.
const resolveCodecOptions = (name, encoding, raw) => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    throw new Error(
      `Place "${name}": compress.options.${encoding} must be an object`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'level') {
      throw new Error(
        `Place "${name}": unknown compress option "${key}" for ` +
          `"${encoding}". Only "level" is supported`,
      );
    }
  }
  if (raw.level === undefined) return null;
  const [min, max] = LEVEL_RANGE[encoding];
  if (!Number.isInteger(raw.level) || raw.level < min || raw.level > max) {
    throw new Error(
      `Place "${name}": compress.options.${encoding}.level must be an ` +
        `integer in ${min}..${max}`,
    );
  }
  return { level: raw.level };
};

const resolveCompress = (name, raw) => {
  if (raw === undefined || raw === null) {
    return { codecs: [], ext: null, retainRaw: true };
  }
  if (typeof raw !== 'object') {
    throw new Error(`Place "${name}": compress must be an object`);
  }
  const { encodings, options = {} } = raw;
  if (!Array.isArray(encodings) || encodings.length === 0) {
    throw new Error(
      `Place "${name}": compress.encodings must be a non-empty array`,
    );
  }
  const codecs = [];
  const seen = new Set();
  for (const encoding of encodings) {
    if (!VALID_ENCODINGS.includes(encoding)) {
      throw new Error(
        `Place "${name}": unknown encoding "${encoding}". ` +
          `Valid: ${VALID_ENCODINGS.join(', ')}`,
      );
    }
    if (seen.has(encoding)) {
      throw new Error(`Place "${name}": duplicate encoding "${encoding}"`);
    }
    seen.add(encoding);
    const codecOptions = resolveCodecOptions(name, encoding, options[encoding]);
    codecs.push({ encoding, options: codecOptions });
  }
  for (const key of Object.keys(options)) {
    if (!seen.has(key)) {
      throw new Error(
        `Place "${name}": compress.options has "${key}" which is not ` +
          `listed in compress.encodings`,
      );
    }
  }
  return {
    codecs,
    ext: resolveCompressExt(name, raw.ext),
    retainRaw: raw.retainRaw !== false,
  };
};

const resolvePlace = (name, raw, global) => {
  const config = {
    name,
    enabled: raw.enabled !== false,
    domains: Array.isArray(raw.domains) ? [...raw.domains] : [],
    dir: raw.dir || name,
    provider: raw.provider || 'sab',
    ext: Array.isArray(raw.ext) ? [...raw.ext] : null,
    extOnExtra: raw.extOnExtra || 'silent',
    maxFileSize:
      raw.maxFileSize != null
        ? parseSize(raw.maxFileSize)
        : global.memory.maxFileSize,
    compile: raw.compile === true,
    compress: resolveCompress(name, raw.compress),
  };
  if (config.compile && !config.domains.includes('require')) {
    config.domains.push('require');
  }
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

const validateExtOnExtra = (place) => {
  if (!VALID_EXT_ON_EXTRA.includes(place.extOnExtra)) {
    throw new Error(
      `Place "${place.name}": unknown extOnExtra "${place.extOnExtra}". ` +
        `Valid: ${VALID_EXT_ON_EXTRA.join(', ')}`,
    );
  }
};

const validateDir = (place) => {
  const { dir } = place;
  if (!dir || typeof dir !== 'string') {
    throw new Error(`Place "${place.name}": dir must be a non-empty string`);
  }
};

const validateCompress = (place) => {
  const { compress } = place;
  if (compress.codecs.length === 0) return;
  if (place.provider !== 'sab') {
    throw new Error(
      `Place "${place.name}": compress requires provider "sab", ` +
        `got "${place.provider}"`,
    );
  }
  if (!compress.retainRaw && place.compile) {
    throw new Error(
      `Place "${place.name}": compile requires retainRaw — bytecode is ` +
        `built from the source stored in SAB`,
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
    for (const place of domainPlaces) {
      const { dir } = place;
      if (dirs.has(dir)) {
        throw new Error(
          `Domain "${domain}": places "${dirs.get(dir)}" and ` +
            `"${place.name}" both match dir "${dir}"`,
        );
      }
      dirs.set(dir, place.name);
    }
  }
};

const applyCliOverrides = (global, placesMap, cli) => {
  if (cli.overrides.defaults) {
    const ov = cli.overrides.defaults;
    if (ov.memory) {
      if (ov.memory.limit) global.memory.limit = parseSize(ov.memory.limit);
      if (ov.memory.segmentSize) {
        global.memory.segmentSize = parseSize(ov.memory.segmentSize);
      }
      if (ov.memory.maxFileSize) {
        global.memory.maxFileSize = parseSize(ov.memory.maxFileSize);
      }
    }
    if (ov.compaction?.threshold) {
      global.compaction.threshold = Number(ov.compaction.threshold);
    }
    if (ov.watchTimeout) global.watchTimeout = Number(ov.watchTimeout);
    if (ov.strict != null) global.strict = ov.strict !== 'false';
  }
  if (cli.overrides.hooks) {
    const h = cli.overrides.hooks;
    if (h.fs != null) global.hooks.fs = h.fs !== 'false';
    if (h.require != null) global.hooks.require = h.require !== 'false';
    if (h.import != null) global.hooks.import = h.import !== 'false';
  }
  if (cli.overrides.place) {
    for (const [name, ov] of Object.entries(cli.overrides.place)) {
      const place = placesMap.get(name);
      if (!place) continue;
      if (ov.maxFileSize) place.maxFileSize = parseSize(ov.maxFileSize);
    }
  }
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
      validateDir(place);
      validateExtOnExtra(place);
      validateCompress(place);
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

module.exports = { VfsConfig, VALID_ENCODINGS };
