'use strict';

const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

// require-hook — patches Module._resolveFilename to intercept require() calls.
// If VFS has the module cached → return the real file path (so Module._load reads it).
// For SAB-backed modules the fs-patch will intercept the subsequent fs.readFileSync.
// If bytecode is available, _compile uses it via vm.Script({ cachedData }).
// install(kernel) saves original and patches; uninstall() restores.

let installed = false;
let kernel = null;
let originalResolveFilename = null;
let originalCompile = null;

function patchedResolveFilename(request, parent, isMain, options) {
  if (!parent || !parent.filename) {
    return originalResolveFilename.call(Module, request, parent, isMain, options);
  }
  const resolved = kernel.dispatchModuleResolve(request, parent.filename);
  if (!resolved) {
    return originalResolveFilename.call(Module, request, parent, isMain, options);
  }
  const { place, specifier } = resolved;
  // For relative specifiers, resolve against parent dir
  if (specifier.startsWith('.')) {
    const dir = path.dirname(parent.filename);
    const abs = path.resolve(dir, specifier);
    // Check if VFS has the file — try with and without extensions
    const exts = ['.js', '.json', '.node', ''];
    for (const ext of exts) {
      const tryPath = abs + ext;
      const rel = path.relative(kernel.appRoot, tryPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const fileKey = '/' + rel.replace(/\\/g, '/');
      const dirPrefix = place.config.match.dir;
      const placementKey = dirPrefix
        ? fileKey.substring(dirPrefix.length + 1)
        : fileKey;
      if (place.exists(placementKey)) return tryPath;
    }
  }
  // Fallback to original
  return originalResolveFilename.call(Module, request, parent, isMain, options);
}

function patchedCompile(content, filename) {
  const resolved = kernel.dispatchFsRead('readFile', filename);
  if (resolved) {
    const { place, fileKey } = resolved;
    const bytecode = place.readBytecode(fileKey);
    if (bytecode) {
      const wrapped = Module.wrap(content);
      try {
        const script = new vm.Script(wrapped, {
          filename,
          cachedData: bytecode,
          importModuleDynamically: vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        });
        if (!script.cachedDataRejected) {
          const compiledWrapper = script.runInThisContext({
            filename,
            lineOffset: 0,
            columnOffset: 0,
            displayErrors: true,
          });
          const dirname = path.dirname(filename);
          const require = Module.createRequire(filename);
          const args = [this.exports, require, this, filename, dirname];
          const result = compiledWrapper.apply(this.exports, args);
          this.loaded = true;
          return result;
        }
      } catch {
        // Bytecode rejected or error — fall through to original
      }
    }
  }
  return originalCompile.call(this, content, filename);
}

const install = (k) => {
  if (installed) return;
  kernel = k;
  originalResolveFilename = Module._resolveFilename;
  originalCompile = Module.prototype._compile;
  Module._resolveFilename = patchedResolveFilename;
  Module.prototype._compile = patchedCompile;
  installed = true;
};

const uninstall = () => {
  if (!installed) return;
  Module._resolveFilename = originalResolveFilename;
  Module.prototype._compile = originalCompile;
  originalResolveFilename = null;
  originalCompile = null;
  kernel = null;
  installed = false;
};

module.exports = { install, uninstall };
