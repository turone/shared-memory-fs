// register.mjs — ESM bootstrap entry point for VFS.
// Usage: node --import shared-memory-fs/register app.mjs [-- --vfs.config=path]
//
// Top-level await: creates VFSKernel, initializes (scans files into SAB),
// installs all hooks (fs-patch, require-hook, import-hook), seals kernel.
// App code runs AFTER cache is fully populated.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, register as moduleRegister } from 'node:module';

const VFS_SYMBOL = Symbol.for('shared-memory-fs');

// Avoid double-install
if (process[VFS_SYMBOL]) {
  throw new Error('[vfs] register.mjs: VFS already initialized');
}

const require = createRequire(import.meta.url);
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
  const resolved = resolve(configPath);
  try {
    const imported = await import(pathToFileURL(resolved).href);
    appConfig = imported.default || imported;
  } catch (err) {
    console.error(`[vfs] failed to load config: ${resolved}`);
    console.error(err.message);
    throw err;
  }
}

const config = VfsConfig.fromArgv(process.argv, appConfig);
const kernel = new VFSKernel(config, { appRoot: process.cwd() });

// Set global BEFORE initialize — import-hook reads it in initialize()
process[VFS_SYMBOL] = kernel;

await kernel.initialize();

// Install hooks based on config
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
  moduleRegister('../adapters/import-hook.mjs', import.meta.url);
}

let count = 0;
for (const place of kernel.getPlaces()) count += place.files.size;
console.log(`[vfs] ready, ${count} entries cached`);
