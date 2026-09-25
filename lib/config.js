'use strict';

const { sizeToBytes } = require('metautil');

// VfsConfig — resolves and validates the raw user config into a deep-frozen
// description of global settings and Places.
//
// A Place is one directory under appRoot; its key in `places` is at once its
// name, mount, cache namespace and snapshot/delta identifier. A Place has
// one `provider` (where bytes live), one `origin` (where content comes from)
// and up to three domains — fs, require, import — which describe how the
// patched node:fs and the module hooks see the same files. A domain is
// `false`/absent (off), `true` (defaults) or an object (overrides).
// Each domain may declare `prepare`: the preparer that turns the raw input of
// an extension into the file's one canonical content, shared by every domain.
// `fs.script` nests inside the fs domain: the sources the library compiles
// into `vm.Script` cached data.

const PROVIDERS = ['sab', 'map', 'sea', 'disk', 'node-default'];
// Providers whose files are indexed in a Map (everything but passthrough).
const INDEXED = new Set(['sab', 'map', 'sea']);
// Providers whose bytes live in pooled SharedArrayBuffer segments.
const SHARED = new Set(['sab', 'sea']);
// Providers that choose an origin; the rest have a fixed one.
const ORIGINED = new Set(['sab', 'map']);
const ORIGINS = ['disk', 'virtual'];
const ENCODINGS = ['gzip', 'deflate', 'br', 'zstd'];
const FALLBACKS = ['disk', 'deny'];

const REQUIRE_EXT = ['js', 'cjs', 'json'];
const IMPORT_EXT = ['js', 'mjs', 'json'];
const SCRIPT_EXT = ['js', 'cjs'];
const PREPARER_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

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

// `fs.script` — sources the library compiles into `vm.Script` cached data
// for callers that build their own script (`PlaceFs.script()`); `compile`
// builds that cached data from the canonical (prepared) source.
const resolveScript = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'compile']);
  return {
    ext:
      raw.ext === undefined
        ? [...SCRIPT_EXT]
        : extListOf(`${where}.ext`, raw.ext),
    compile: booleanOf(`${where}.compile`, raw.compile, true),
  };
};

const union = (...lists) => {
  const result = [];
  for (const list of lists) {
    for (const item of list) if (!result.includes(item)) result.push(item);
  }
  return result;
};

// The declared `fs.fallback`, or null; normalizeFallback() resolves it.
const resolveFallback = (where, raw) => {
  if (raw === undefined) return null;
  if (!FALLBACKS.includes(raw)) {
    fail(`${where} must be "disk" or "deny", got ${JSON.stringify(raw)}`);
  }
  return raw;
};

const resolveFs = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, [
    'ext',
    'writable',
    'zeroCopy',
    'compress',
    'script',
    'prepare',
    'fallback',
  ]);
  const script = resolveScript(`${where}.script`, raw.script);
  const own = raw.ext === undefined ? null : extListOf(`${where}.ext`, raw.ext);
  // Visible extensions are the union of plain files and script sources;
  // `ext` absent *and* no script means every file.
  const ext = script ? union(own || [], script.ext) : own;
  return {
    ext,
    writable: booleanOf(`${where}.writable`, raw.writable, false),
    zeroCopy: booleanOf(`${where}.zeroCopy`, raw.zeroCopy, false),
    compress: resolveCompress(`${where}.compress`, raw.compress),
    script,
    fallback: resolveFallback(`${where}.fallback`, raw.fallback),
  };
};

const resolveRequire = (where, raw) => {
  if (raw === undefined || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail(`${where} must be true, false or an object`);
  knownKeys(where, raw, ['ext', 'compile', 'prepare']);
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
  knownKeys(where, raw, ['ext', 'prepare']);
  return {
    ext:
      raw.ext === undefined
        ? [...IMPORT_EXT]
        : extListOf(`${where}.ext`, raw.ext),
  };
};

const resolveOrigin = (where, raw, provider) => {
  if (!ORIGINED.has(provider)) {
    if (raw !== undefined) {
      fail(
        `${where}.origin applies to providers "sab" and "map" only; ` +
          `"${provider}" has a fixed origin`,
      );
    }
    return null;
  }
  if (raw === undefined) return 'disk';
  if (!ORIGINS.includes(raw)) {
    fail(
      `${where}.origin: unknown origin "${raw}". Valid: ${ORIGINS.join(', ')}`,
    );
  }
  return raw;
};

// Extensions the scanner loads for a Place: null (everything) when fs is on
// without its own ext, otherwise the ordered union of enabled domain exts.
// `fs.ext` already unions in `fs.script.ext`.
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

// --- Preparation ---

const preparerName = (where, name) => {
  if (typeof name !== 'string' || !PREPARER_RE.test(name)) {
    fail(
      `${where}: invalid preparer name ${JSON.stringify(name)} ` +
        '(an identifier registered in the kernel option `preparers`)',
    );
  }
};

// An extension list that names every extension once (after lowercasing).
const distinctExtList = (where, value) => {
  const list = extListOf(where, value);
  if (list.length < value.length) {
    const seen = new Set();
    for (const item of value) {
      const ext = item.toLowerCase();
      if (seen.has(ext)) fail(`${where}: extension "${ext}" is listed twice`);
      seen.add(ext);
    }
  }
  return list;
};

// Extensions one domain's `prepare` assigns, as Map<ext, name>:
//   'name'              every extension of `scope`, the domain's own finite
//                       ext list — an unrestricted fs has none
//   { name: [ext, …] }  explicit routing; with a finite domain ext
//                       (`visible`) every listed extension must be in it
// Neither form adds extensions to the domain or removes any from it.
const domainPrepare = (where, raw, scope, visible) => {
  if (typeof raw === 'string') {
    preparerName(where, raw);
    if (!scope) {
      fail(
        `${where}: "${raw}" needs a finite ext list in this domain; ` +
          `route extensions explicitly: { ${raw}: [ext, …] }`,
      );
    }
    return new Map(scope.map((ext) => [ext, raw]));
  }
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    fail(
      `${where} must be a preparer name or { name: [ext, …] }` +
        (typeof raw === 'function' ? ', got a function' : ''),
    );
  }
  const result = new Map();
  for (const [name, list] of Object.entries(raw)) {
    preparerName(where, name);
    for (const ext of distinctExtList(`${where}.${name}`, list)) {
      if (visible && !visible.includes(ext)) {
        fail(`${where}.${name}: extension "${ext}" is not in the domain ext`);
      }
      const other = result.get(ext);
      if (other) {
        fail(
          `${where}: extension "${ext}" is assigned to both ` +
            `"${other}" and "${name}"`,
        );
      }
      result.set(ext, name);
    }
  }
  return result;
};

// The place's preparation index { [ext]: preparer } or null. `prepare` is
// declared by a domain but prepares the file itself, once, for every domain,
// so an extension may have one declaration in the whole place: two are an
// error even when they name the same preparer — no domain priority, no
// merging. The short form of fs covers the user's own `fs.ext`, never the
// `fs.script.ext` merged into it.
const resolvePrepare = (place, raw) => {
  const where = `places.${place.name}`;
  const own = isObject(raw.fs) && raw.fs.ext !== undefined;
  const declarations = [
    ['fs', raw.fs, own ? extListOf('fs.ext', raw.fs.ext) : null, place.fs],
    ['require', raw.require, place.require?.ext, place.require],
    ['import', raw.import, place.import?.ext, place.import],
  ];
  const declared = new Map(); // ext → [{ domain, name }]
  for (const [domain, rawDomain, scope, resolved] of declarations) {
    if (!isObject(rawDomain) || rawDomain.prepare === undefined) continue;
    const at = `${where}.${domain}.prepare`;
    const assigned = domainPrepare(at, rawDomain.prepare, scope, resolved.ext);
    for (const [ext, name] of assigned) {
      const list = declared.get(ext) || [];
      list.push({ domain, name });
      declared.set(ext, list);
    }
  }
  if (declared.size === 0) return null;
  const index = {};
  for (const [ext, list] of declared) {
    if (list.length > 1) {
      const all = list.map((d) => `${d.domain}.prepare → "${d.name}"`);
      fail(
        `${where}: extension "${ext}" has multiple preparer declarations: ` +
          all.join(', '),
      );
    }
    index[ext] = list[0].name;
  }
  return index;
};

// --- Places ---

const PLACE_KEYS = [
  'enabled',
  'provider',
  'origin',
  'maxFileSize',
  'fs',
  'require',
  'import',
];

const validatePlace = (place, global) => {
  const { name, provider, origin, fs, require: req } = place;
  const script = fs?.script || null;
  const where = `places.${name}`;
  if (!fs && !req && !place.import) {
    fail(`${where}: enable at least one domain (fs, require, import)`);
  }
  const passthrough = provider === 'disk' || provider === 'node-default';
  if (script && !INDEXED.has(provider)) {
    fail(
      `${where}.fs.script requires provider sab, map or sea; ` +
        `"${provider}" has no canonical VFS content`,
    );
  }
  if (place.prepare && !INDEXED.has(provider)) {
    fail(
      `${where}: prepare requires provider sab, map or sea; ` +
        `"${provider}" serves files from disk as they are`,
    );
  }
  if (origin === 'virtual') {
    if (!fs) {
      fail(
        `${where}: origin "virtual" requires the fs domain — ` +
          'content arrives through fs mutations',
      );
    }
    if (!fs.writable) {
      fail(
        `${where}: origin "virtual" requires fs.writable — ` +
          'a virtual place has no other content source',
      );
    }
  }
  if (SHARED.has(provider) && place.maxFileSize > global.memory.segmentSize) {
    fail(`${where}.maxFileSize must not exceed defaults.memory.segmentSize`);
  }
  if (fs && provider === 'node-default') {
    if (fs.ext || fs.writable || fs.zeroCopy || fs.compress || fs.fallback) {
      fail(
        `${where}.fs: options are not applicable to provider "node-default"`,
      );
    }
  } else if (fs) {
    if (fs.writable && provider === 'sea') {
      fail(`${where}.fs.writable: SEA assets are read-only`);
    }
    if (fs.zeroCopy && !INDEXED.has(provider)) {
      fail(`${where}.fs.zeroCopy requires provider sab, map or sea`);
    }
    if (fs.compress && !SHARED.has(provider)) {
      fail(`${where}.fs.compress requires provider "sab" or "sea"`);
    }
    if (fs.compress && !fs.compress.retainRaw) {
      if (provider !== 'sab') {
        fail(`${where}.fs.compress.retainRaw: false requires provider "sab"`);
      }
      if (origin !== 'disk') {
        fail(
          `${where}.fs.compress.retainRaw: false requires origin "disk" — ` +
            `provider "${provider}", origin "${origin}" keeps no raw file ` +
            'to serve the source from',
        );
      }
      if (req?.compile) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'require.compile — bytecode is built from the source kept in SAB',
        );
      }
      if (script) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'fs.script — its canonical sources and bytecode live in SAB',
        );
      }
      if (place.prepare) {
        fail(
          `${where}.fs.compress.retainRaw: false is incompatible with ` +
            'prepare — a prepared source exists only in memory',
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

// `fs.fallback` belongs to disk-origin places (provider sab / map reading a
// directory): 'deny' serves published canonical entries only; 'disk' also
// serves, from disk, the files its cache filters do not select. There the
// resolved value is always explicit — strict ? 'deny' : 'disk', the
// permissive default of a non-strict place. Elsewhere (virtual, sea, disk,
// node-default) there is no directory to fall back to: null.
const normalizeFallback = (place, global) => {
  const { fs, provider, origin } = place;
  if (!fs) return;
  const where = `places.${place.name}.fs.fallback`;
  if (!ORIGINED.has(provider) || origin !== 'disk') {
    if (fs.fallback === null) return;
    const from = origin
      ? `provider "${provider}", origin "${origin}"`
      : `provider "${provider}"`;
    fail(
      `${where} applies to disk-origin places (provider "sab" or "map", ` +
        `origin "disk"); ${from} has no directory to fall back to`,
    );
  }
  if (fs.fallback === 'disk' && !place.scanExt) {
    fail(
      `${where}: "disk" needs a finite ext list — an unrestricted place ` +
        'already caches every file',
    );
  }
  if (fs.fallback === null) fs.fallback = global.strict ? 'deny' : 'disk';
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
    origin: resolveOrigin(where, raw.origin, provider),
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
  place.prepare = resolvePrepare(place, raw);
  validatePlace(place, global);
  normalizeFallback(place, global);
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

module.exports = {
  VfsConfig,
  ENCODINGS,
  PROVIDERS,
  ORIGINS,
  INDEXED,
  SHARED,
  deepFreeze,
};
