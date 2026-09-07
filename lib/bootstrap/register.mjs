// register.mjs — the single bootstrap entry:
//   node --import shared-memory-fs/register app.js [-- --vfs.config=path --vfs.*=…]
//
// Loads config, creates and initializes the kernel, installs the fs patch and
// module hooks, publishes `VfsKernel.current`; only then does Node run the
// entry point (CommonJS or ESM alike). Any failure rolls the hooks back and
// aborts startup. Worker threads do not run preloads: they call `attach()`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VfsConfig } = require('../config.js');
const { VfsKernel } = require('../kernel.js');
const { installHooks } = require('./attach.js');
const fsPatch = require('../adapters/fs-patch.js');
const moduleHook = require('../adapters/module-hook.js');

const CONFIG_FILES = ['vfs.config.js', 'vfs.config.cjs', 'vfs.config.mjs', 'vfs.config.json'];

const configPathOf = (argv) => {
  const dash = argv.indexOf('--');
  for (const arg of dash === -1 ? [] : argv.slice(dash + 1)) {
    if (arg.startsWith('--vfs.config=')) return resolve(arg.slice(13));
  }
  return CONFIG_FILES.map((f) => resolve(f)).find((f) => existsSync(f)) || null;
};

const loadConfig = async (file) => {
  if (!file) return {};
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
  const mod = await import(pathToFileURL(file).href);
  return mod.default || mod;
};

const bootstrap = async () => {
  const file = configPathOf(process.argv);
  let raw;
  try {
    raw = await loadConfig(file);
  } catch (err) {
    console.error(`[vfs] failed to load config: ${file}`);
    throw err;
  }
  const config = VfsConfig.fromArgv(process.argv, raw);
  const kernel = new VfsKernel(config);
  try {
    await kernel.initialize();
    installHooks(kernel);
  } catch (err) {
    moduleHook.uninstall();
    fsPatch.uninstall();
    kernel.close();
    throw err;
  }
  VfsKernel.current = kernel;
  return kernel;
};

if (VfsKernel.current) throw new Error('[vfs] register: already bootstrapped');

await bootstrap();
