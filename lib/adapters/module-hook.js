'use strict';

const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { fileURLToPath, pathToFileURL } = require('node:url');

// module-hook — one synchronous resolve/load pipeline for require() and
// import (module.registerHooks, in-thread, direct kernel access), plus a
// Module.prototype._compile patch that applies V8 cached data.
//
// VFS modules keep ordinary file: URLs — same identity as the file on disk,
// so import.meta.url, __filename and require.cache behave as usual; only
// the bytes come from shared memory. Bare and node: specifiers go to the
// default resolver. Extensions are mandatory for import; require gets the
// Node-like LOAD_AS_FILE / LOAD_AS_DIRECTORY order over published entries.

let kernel = null;
let hooks = null;
let originalCompile = null;

const CJS_EXT = ['.js', '.cjs', '.json'];
const CJS_INDEX = ['index.js', 'index.cjs', 'index.json'];

const isRelative = (s) =>
  s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');

// Absolute OS path a specifier designates, or null for bare / builtin ones.
const pathOf = (specifier, parentURL) => {
  if (specifier.startsWith('file:')) return fileURLToPath(specifier);
  if (path.isAbsolute(specifier)) return path.resolve(specifier);
  if (!isRelative(specifier) || !parentURL?.startsWith('file:')) return null;
  return path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
};

const formatOf = (filePath, domain) => {
  const ext = path.extname(filePath);
  if (ext === '.json') return 'json';
  if (domain === 'require' || ext === '.cjs') return 'commonjs';
  return 'module';
};

const notFound = (specifier, parentURL, domain) => {
  const err = new Error(
    `Cannot find module '${specifier}'` +
      (parentURL ? ` imported from ${parentURL}` : '') +
      ' (vfs: not published)',
  );
  err.code = domain === 'require' ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND';
  return err;
};

// Node's LOAD_AS_FILE then LOAD_AS_DIRECTORY (package.json "main", index.*)
// over published entries; exports/imports maps are not consulted.
function* cjsCandidates(base) {
  yield base;
  for (const ext of CJS_EXT) yield base + ext;
  const pkg = kernel.resolveModule(path.join(base, 'package.json'), 'require');
  if (pkg?.file) {
    let main = null;
    try {
      main = JSON.parse(pkg.file.data.toString('utf8')).main;
    } catch {
      main = null;
    }
    if (typeof main === 'string') {
      const target = path.resolve(base, main);
      yield target;
      for (const ext of CJS_EXT) yield target + ext;
      for (const index of CJS_INDEX) yield path.join(target, index);
    }
  }
  for (const index of CJS_INDEX) yield path.join(base, index);
}

const resolve = (specifier, context, next) => {
  const domain = context.conditions.includes('require') ? 'require' : 'import';
  const base = pathOf(specifier, context.parentURL);
  if (base === null) return next(specifier, context);
  const candidates = domain === 'require' ? cjsCandidates(base) : [base];
  let denied = false;
  for (const candidate of candidates) {
    const found = kernel.resolveModule(candidate, domain);
    if (!found) continue;
    if (found.denied) {
      denied = true;
      continue;
    }
    return {
      url: pathToFileURL(candidate).href,
      format: formatOf(candidate, domain),
      shortCircuit: true,
    };
  }
  if (denied) throw notFound(specifier, context.parentURL, domain);
  return next(specifier, context);
};

const load = (url, context, next) => {
  if (!url.startsWith('file:')) return next(url, context);
  const domain = context.conditions.includes('require') ? 'require' : 'import';
  const filePath = fileURLToPath(url);
  const found = kernel.resolveModule(filePath, domain);
  if (!found) return next(url, context);
  if (found.denied) throw notFound(url, undefined, domain);
  const format = context.format || formatOf(filePath, domain);
  if (
    format === 'json' &&
    domain === 'import' &&
    context.importAttributes?.type !== 'json'
  ) {
    const err = new TypeError(
      `Module "${url}" needs an import attribute of "type: json"`,
    );
    err.code = 'ERR_IMPORT_ATTRIBUTE_MISSING';
    throw err;
  }
  return { source: found.file.data, format, shortCircuit: true };
};

// Mirrors Node's internal makeRequireFunction for the given module.
const requireFor = (mod) => {
  const require = (id) => mod.require(id);
  require.resolve = (request, options) =>
    Module._resolveFilename(request, mod, false, options);
  require.resolve.paths = (request) => Module._resolveLookupPaths(request, mod);
  require.main = process.mainModule;
  require.extensions = Module._extensions;
  require.cache = Module._cache;
  return require;
};

// Bytecode is a best-effort optimisation: any problem preparing the wrapper
// falls back to the original compiler exactly once. The wrapper itself runs
// outside that guard — an exception thrown by the module body propagates
// and never re-executes the source.
function compile(content, filename, ...rest) {
  /* eslint-disable no-invalid-this */
  const cachedData = kernel.bytecode(filename);
  if (!cachedData)
    return originalCompile.call(this, content, filename, ...rest);
  let wrapper;
  try {
    const script = new vm.Script(Module.wrap(content), {
      filename,
      cachedData,
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    if (script.cachedDataRejected) {
      return originalCompile.call(this, content, filename, ...rest);
    }
    wrapper = script.runInThisContext({ displayErrors: true });
  } catch {
    return originalCompile.call(this, content, filename, ...rest);
  }
  const dirname = path.dirname(filename);
  const require = requireFor(this);
  return wrapper.call(
    this.exports,
    this.exports,
    require,
    this,
    filename,
    dirname,
  );
  /* eslint-enable no-invalid-this */
}

const install = (k) => {
  if (hooks) return;
  kernel = k;
  hooks = Module.registerHooks({ resolve, load });
  originalCompile = Module.prototype._compile;
  Module.prototype._compile = compile;
};

const uninstall = () => {
  if (!hooks) return;
  hooks.deregister();
  Module.prototype._compile = originalCompile;
  hooks = null;
  originalCompile = null;
  kernel = null;
};

module.exports = { install, uninstall };
