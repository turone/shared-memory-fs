'use strict';

const { sizeToBytes } = require('metautil');

// VfsConfig — resolves and validates the raw user config into a deep-frozen
// description of global settings and Places.
//
// A Place is one directory under appRoot; its key in `places` is at once its
// name, directory, mount, cache namespace and snapshot/delta identifier.
// Each Place has one provider and up to three domains — fs, require,
// import — which describe how the patched node:fs and the module hooks see
// the same raw files. A domain is `false`/absent (off), `true` (defaults)
// or an object (overrides).

const PROVIDERS = ['sab', 'memory', 'sea', 'disk', 'node-default'];
// Providers whose files are indexed in a Map (everything but passthrough).
const INDEXED = new Set(['sab', 'memory', 'sea']);
// Providers whose bytes live in pooled SharedArrayBuffer segments.
const SHARED = new Set(['sab', 'sea']);
const ENCODINGS = ['gzip', 'deflate', 'br', 'zstd'];

const REQUIRE_EXT = ['js', 'cjs', 'json'];
const IMPORT_EXT = ['js', 'mjs', 'json'];

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
    module: true,
  },
  watch: false,
  watchTimeout: 1000,
  strict: false,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// --- Generic helpers ---

const fail = (message) => {
  throw new Error(`[vfs config] ${message}`);
};

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
      typeof value === 'object' &&
      value !== null &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }
  return obj;
};

const mergeDeep = (target, source) => {
  if (!isObject(source)) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (Array.isArray(sv)) result[key] = [...sv];
    else if (isObject(sv)) result[key] = mergeDeep(isObject(tv) ? tv : {}, sv);
    else result[key] = sv;
  }
  return result;
};

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const setNested = (obj, path, value) => {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (UNSAFE_KEYS.has(part)) fail(`unsafe CLI key "${path}"`);
    if (i === parts.length - 1) {
      current[part] = value;
    } else {
      if (!isObject(current[part])) current[part] = {};
      current = current[part];
    }
  }
};

// --- Scalar validation ---

const sizeOf = (where, value) => {
  const bytes = typeof value === 'string' ? sizeToBytes(value) : value;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    fail(`${where} must be a positive integer size, got ${String(value)}`);
  }
  return bytes;
};

const booleanOf = (where, value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${where} must be a boolean`);
  return value;
};

const extListOf = (where, value) => {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where} must be a non-empty array of extensions`);
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !/^[A-Za-z0-9]+$/.test(item)) {
      fail(`${where} items must be alphanumeric extensions without dots`);
    }
    const ext = item.toLowerCase();
    if (!result.includes(ext)) result.push(ext);
  }
  return result;
};

const knownKeys = (where, obj, allowed) => {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${where}: unknown option "${key}". Valid: ${allowed.join(', ')}`);
    }
  }
};

// --- Global section ---

const resolveGlobal = (raw) => {
  const merged = mergeDeep(deepClone(DEFAULTS), raw);
  knownKeys('defaults', merged, Object.keys(DEFAULTS));
  const { memory, compaction, hooks } = merged;
  const threshold = compaction.threshold;
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) {
    fail('defaults.compaction.threshold must be a number in 0..1');
  }
  const { watchTimeout } = merged;
  if (!Number.isSafeInteger(watchTimeout) || watchTimeout < 0) {
    fail('defaults.watchTimeout must be a non-negative integer');
  }
  const global = {
    memory: {
      limit: sizeOf('defaults.memory.limit', memory.limit),
      segmentSize: sizeOf('defaults.memory.segmentSize', memory.segmentSize),
      maxFileSize: sizeOf('defaults.memory.maxFileSize', memory.maxFileSize),
    },
    compaction: { threshold },
    hooks: {
      fs: booleanOf('defaults.hooks.fs', hooks.fs, true),
      module: booleanOf('defaults.hooks.module', hooks.module, true),
    },
    watch: booleanOf('defaults.watch', merged.watch, false),
    watchTimeout,
    strict: booleanOf('defaults.strict', merged.strict, false),
  };
  if (global.memory.segmentSize > global.memory.limit) {
    fail('defaults.memory.limit must be at least one segmentSize');
  }
  if (global.memory.maxFileSize > global.memory.segmentSize) {
    fail('defaults.memory.maxFileSize must not exceed segmentSize');
  }
  return global;
};

// --- Place names ---

const validateName = (name) => {
  if (!NAME_RE.test(name)) {
    fail(
      `invalid place name "${name}": use ASCII letters, digits, ".", "_", ` +
        '"-" and start with a letter or digit',
    );
  }
  if (name.endsWith('.')) fail(`invalid place name "${name}": trailing dot`);
  if (WIN_RESERVED_RE.test(name)) {
    fail(`invalid place name "${name}": reserved device name on Windows`);
  }
};

// --- Domains ---

// Returns null when the user gave no options: the codec then runs with
// native zlib defaults.
const resolveCodecOptions = (where, encoding, raw) => {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail(`${where}.${encoding} must be an object`);
  knownKeys(`${where}.${encoding}`, raw, ['level']);
  if (raw.level === undefined) return null;
  const [min, max] = LEVEL_RANGE[encoding];
  if (!Number.isInteger(raw.level) || raw.level < min || raw.level > max) {
    fail(`${where}.${encoding}.level must be an integer in ${min}..${max}`);
  }
  return { level: raw.level };
};

const resolveCompressExt = (where, ext) => {
  if (ext === undefined || ext === null) return null;
  if (ext === 'compressible') return [...COMPRESSIBLE_EXT];
  return extListOf(where, ext);
};

const resolveCompress = (where, raw) => {
  if (raw === undefined || raw === false || raw === null) return null;
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, ['encodings', 'options', 'ext', 'retainRaw']);
  const { encodings, options = {} } = raw;
  if (!Array.isArray(encodings) || encodings.length === 0) {
    fail(`${where}.encodings must be a non-empty array`);
  }
  if (!isObject(options)) fail(`${where}.options must be an object`);
  const codecs = [];
  const seen = new Set();
  for (const encoding of encodings) {
    if (!ENCODINGS.includes(encoding)) {
      fail(
        `${where}.encodings: unknown encoding "${encoding}". ` +
          `Valid: ${ENCODINGS.join(', ')}`,
      );
    }
    if (seen.has(encoding)) fail(`${where}.encodings: duplicate "${encoding}"`);
    seen.add(encoding);
    const codecOptions = resolveCodecOptions(
      `${where}.options`,
      encoding,
      options[encoding],
    );
    codecs.push({ encoding, options: codecOptions });
  }
  for (const key of Object.keys(options)) {
    if (!seen.has(key)) {
      fail(`${where}.options.${key} is set but "${key}" is not in encodings`);
    }
  }
  return {
    codecs,
    ext: resolveCompressExt(`${where}.ext`, raw.ext),
    retainRaw: booleanOf(`${where}.retainRaw`, raw.retainRaw, true),
  };
};

const resolveFs = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'writable', 'zeroCopy', 'compress']);
  return {
    ext: raw.ext === undefined ? null : extListOf(`${where}.ext`, raw.ext),
    writable: booleanOf(`${where}.writable`, raw.writable, false),
    zeroCopy: booleanOf(`${where}.zeroCopy`, raw.zeroCopy, false),
    compress: resolveCompress(`${where}.compress`, raw.compress),
  };
};

const resolveRequire = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'compile']);
  return {
    ext:
      raw.ext === undefined
        ? [...REQUIRE_EXT]
        : extListOf(`${where}.ext`, raw.ext),
    compile: booleanOf(`${where}.compile`, raw.compile, true),
  };
};

const resolveImport = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext']);
  return {
    ext:
      raw.ext === undefined
        ? [...IMPORT_EXT]
        : extListOf(`${where}.ext`, raw.ext),
  };
};

// Extensions the scanner loads for a Place: null (everything) when fs is on
// without its own ext, otherwise the ordered union of enabled domain exts.
const scanExtOf = (place) => {
  const { fs, require: req, import: imp } = place;
  if (fs && !fs.ext) return null;
  const result = [];
  for (const domain of [fs, req, imp]) {
    if (!domain) continue;
    for (const ext of domain.ext) if (!result.includes(ext)) result.push(ext);
  }
  return result;
};

// --- Places ---

const PLACE_KEYS = [
  'enabled',
  'provider',
  'maxFileSize',
  'fs',
  'require',
  'import',
];

const validatePlace = (place, global) => {
  const { name, provider, fs, require: req } = place;
  const where = `places.${name}`;
  if (!fs && !req && !place.import) {
    fail(`${where}: enable at least one domain (fs, require, import)`);
  }
  const passthrough = provider === 'disk' || provider === 'node-default';
  if (SHARED.has(provider) && place.maxFileSize > global.memory.segmentSize) {
    fail(`${where}.maxFileSize must not exceed defaults.memory.segmentSize`);
  }
  if (fs && provider === 'node-default') {
    if (fs.ext || fs.writable || fs.zeroCopy || fs.compress) {
      fail(
        `${where}.fs: options are not applicable to provider "node-default"`,
      );
    }
  } else if (fs) {
    if (fs.writable && provider === 'sea') {
      fail(`${where}.fs.writable: SEA assets are read-only`);
    }
    if (fs.zeroCopy && !INDEXED.has(provider)) {
      fail(`${where}.fs.zeroCopy requires provider sab, memory or sea`);
    }
    if (fs.compress && !SHARED.has(provider)) {
      fail(`${where}.fs.compress requires provider "sab" or "sea"`);
    }
    if (fs.compress && !fs.compress.retainRaw) {
      if (provider !== 'sab') {
        fail(`${where}.fs.compress.retainRaw: false requires provider "sab"`);
      }
      if (req?.compile) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'require.compile — bytecode is built from the source kept in SAB',
        );
      }
    }
  }
  if (req?.compile && passthrough) {
    fail(
      `${where}.require: provider "${provider}" cannot store bytecode; ` +
        'use require: { compile: false }',
    );
  }
};

const resolvePlace = (name, raw, global) => {
  const where = `places.${name}`;
  validateName(name);
  if (!isObject(raw)) fail(`${where} must be an object`);
  knownKeys(where, raw, PLACE_KEYS);
  const provider = raw.provider === undefined ? 'sab' : raw.provider;
  if (!PROVIDERS.includes(provider)) {
    fail(
      `${where}.provider: unknown provider "${provider}". ` +
        `Valid: ${PROVIDERS.join(', ')}`,
    );
  }
  const place = {
    name,
    enabled: booleanOf(`${where}.enabled`, raw.enabled, true),
    provider,
    maxFileSize:
      raw.maxFileSize === undefined
        ? global.memory.maxFileSize
        : sizeOf(`${where}.maxFileSize`, raw.maxFileSize),
    fs: resolveFs(`${where}.fs`, raw.fs),
    require: resolveRequire(`${where}.require`, raw.require),
    import: resolveImport(`${where}.import`, raw.import),
  };
  if (raw.maxFileSize !== undefined && !SHARED.has(provider)) {
    fail(
      `${where}.maxFileSize applies to providers "sab" and "sea" only; ` +
        `"${provider}" does not store files in the SAB pool`,
    );
  }
  place.scanExt = scanExtOf(place);
  validatePlace(place, global);
  return place;
};

// Two names equal after lowercasing are a conflict on every platform: the
// directories would collide on case-insensitive filesystems.
const validateNames = (places) => {
  const seen = new Map();
  for (const { name } of places) {
    const lower = name.toLowerCase();
    const other = seen.get(lower);
    if (other) fail(`place names "${other}" and "${name}" differ only in case`);
    seen.set(lower, name);
  }
};

// --- CLI ---

// `--vfs.<path>=<value>` after the `--` separator. Values are strings; only
// "true"/"false" are coerced so they can flow through the same validation as
// a JS config.
const coerce = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
};

const parseArgv = (argv) => {
  const dash = argv.indexOf('--');
  const args = dash === -1 ? [] : argv.slice(dash + 1);
  const overrides = {};
  const enable = [];
  const disable = [];
  for (const arg of args) {
    if (!arg.startsWith('--vfs.')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    const key = arg.substring(6, eq);
    const value = arg.substring(eq + 1);
    if (key === 'config') continue;
    if (key === 'enable' || key === 'disable') {
      const list = key === 'enable' ? enable : disable;
      list.push(
        ...value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (!key.startsWith('defaults.') && !key.startsWith('places.')) {
      fail(`unknown CLI key "--vfs.${key}"`);
    }
    setNested(overrides, key, coerce(value));
  }
  return { overrides, enable, disable };
};

class VfsConfig {
  #raw;
  #global;
  #places;

  constructor(raw = {}) {
    if (!isObject(raw)) fail('config must be an object');
    knownKeys('config', raw, ['defaults', 'places']);
    this.#raw = deepFreeze(deepClone(raw));
    const global = resolveGlobal(raw.defaults || {});
    const places = new Map();
    if (raw.places !== undefined && !isObject(raw.places)) {
      fail('places must be an object');
    }
    for (const [name, placeRaw] of Object.entries(raw.places || {})) {
      places.set(name, resolvePlace(name, placeRaw, global));
    }
    validateNames([...places.values()]);
    this.#global = deepFreeze(global);
    this.#places = places;
    for (const place of places.values()) deepFreeze(place);
  }

  // The input this config was resolved from (CLI overrides applied);
  // structured-cloneable, so workers can rebuild the same VfsConfig.
  get raw() {
    return this.#raw;
  }

  get global() {
    return this.#global;
  }

  // Enabled places, in declaration order.
  get places() {
    return [...this.#places.values()].filter((place) => place.enabled);
  }

  get allPlaces() {
    return [...this.#places.values()];
  }

  place(name) {
    return this.#places.get(name) || null;
  }

  // Merge `--vfs.*` CLI overrides into `appConfig` and resolve.
  //   --vfs.defaults.memory.limit=512mib --vfs.defaults.strict=true
  //   --vfs.places.static.maxFileSize=2mib --vfs.enable=a,b --vfs.disable=c
  static fromArgv(argv, appConfig = {}) {
    const { overrides, enable, disable } = parseArgv(argv);
    const raw = mergeDeep(deepClone(appConfig), overrides);
    if (enable.length > 0 || disable.length > 0) {
      raw.places = raw.places || {};
      const placeOf = (name) => {
        if (!isObject(raw.places[name])) fail(`unknown place "${name}"`);
        return raw.places[name];
      };
      if (enable.length > 0) {
        for (const place of Object.values(raw.places)) {
          if (isObject(place)) place.enabled = false;
        }
        for (const name of enable) placeOf(name).enabled = true;
      }
      for (const name of disable) placeOf(name).enabled = false;
    }
    return new VfsConfig(raw);
  }
}

module.exports = { VfsConfig, ENCODINGS, PROVIDERS, INDEXED, SHARED };
