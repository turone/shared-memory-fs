'use strict';

const Module = require('node:module');
const path = require('node:path');

// require-hook — patches Module._resolveFilename to intercept require() calls.
// If VFS has the module cached → return the real file path (so Module._load reads it).
// For SAB-backed modules the fs-patch will intercept the subsequent fs.readFileSync.
// install(kernel) saves original and patches; uninstall() restores.

let installed = false;
let kernel = null;
let originalResolveFilename = null;

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

const install = (k) => {
  if (installed) return;
  kernel = k;
  originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = patchedResolveFilename;
  installed = true;
};

const uninstall = () => {
  if (!installed) return;
  Module._resolveFilename = originalResolveFilename;
  originalResolveFilename = null;
  kernel = null;
  installed = false;
};

module.exports = { install, uninstall };
