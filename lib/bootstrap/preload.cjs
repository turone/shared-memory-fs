'use strict';

// preload.cjs — CJS bootstrap entry point for VFS.
// Usage: node --require shared-memory-fs/preload app.js [-- --vfs.config=path]
//
// Synchronous: creates VFSKernel with frozen config, installs CJS hooks.
// Does NOT call kernel.initialize() — consumer must call it before spawning workers.
// Hooks passthrough safely while cache is empty (dispatch → null → original fs).

const path = require('node:path');

const VFS_SYMBOL = Symbol.for('shared-memory-fs');

// Avoid double-install
if (process[VFS_SYMBOL]) return;

const { VfsConfig } = require('../config.js');
const { VFSKernel } = require('../kernel.js');

// Parse --vfs.config=<path> from argv (after -- separator)
const findConfigPath = (argv) => {
  const dashIndex = argv.indexOf('--');
  const args = dashIndex === -1 ? [] : argv.slice(dashIndex + 1);
  for (const arg of args) {
    if (arg.startsWith('--vfs.config=')) {
      return arg.substring('--vfs.config='.length);
    }
  }
  return null;
};

const configPath = findConfigPath(process.argv);
let appConfig = {};

if (configPath) {
  const resolved = path.resolve(configPath);
  try {
    appConfig = require(resolved);
    // Support module.exports = { defaults, places } or default export
    if (appConfig && appConfig.__esModule && appConfig.default) {
      appConfig = appConfig.default;
    }
  } catch (err) {
    console.error(`[vfs] failed to load config: ${resolved}`);
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
}

const config = VfsConfig.fromArgv(process.argv, appConfig);
const kernel = new VFSKernel(config, { appRoot: process.cwd() });

// Install CJS hooks based on config
const { hooks } = config.global;

if (hooks.fs) {
  const fsPatch = require('../adapters/fs-patch.js');
  fsPatch.install(kernel);
}

if (hooks.require) {
  const requireHook = require('../adapters/require-hook.js');
  requireHook.install(kernel);
}

if (hooks.import) {
  console.warn(
    '[vfs] import hook requires ESM bootstrap: ' +
    'use --import shared-memory-fs/register instead of --require',
  );
}

process[VFS_SYMBOL] = kernel;

console.log(
  '[vfs] preload ready — call kernel.initialize() before spawning workers',
);
