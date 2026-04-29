import { fileURLToPath as nodeFileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve, relative, isAbsolute } from 'node:path';

// import-hook.mjs — ESM loader hooks for VFS.
// Registered via module.register() from bootstrap.
// resolve: maps specifiers to vfs: URLs when VFS has the module.
// load: returns source from SAB cache for vfs: URLs.

const VFS_SCHEME = 'vfs:';
const VFS_SYMBOL = Symbol.for('shared-memory-fs');

let kernel = null;

export function initialize() {
  kernel = process[VFS_SYMBOL] || null;
}

export async function resolve(specifier, context, next) {
  if (!kernel) return next(specifier, context);
  if (specifier.startsWith(VFS_SCHEME)) return next(specifier, context);

  const parentPath = context.parentURL
    ? safeFileURLToPath(context.parentURL)
    : null;

  const resolved = kernel.dispatchModuleLoad(specifier, parentPath);
  if (!resolved) return next(specifier, context);

  const { place } = resolved;

  // For relative specifiers, resolve to absolute path
  if (specifier.startsWith('.') && parentPath) {
    const dir = dirname(parentPath);
    const abs = pathResolve(dir, specifier);
    const rel = relative(kernel.appRoot, abs);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      const fileKey = '/' + rel.replace(/\\/g, '/');
      const dirPrefix = place.config.match.dir;
      const placementKey = dirPrefix
        ? fileKey.substring(dirPrefix.length + 1)
        : fileKey;
      if (place.exists(placementKey)) {
        return {
          shortCircuit: true,
          url: VFS_SCHEME + abs,
          format: specifier.endsWith('.json') ? 'json' : 'module',
        };
      }
    }
  }

  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith(VFS_SCHEME)) return next(url, context);
  if (!kernel) return next(url, context);

  const filePath = url.substring(VFS_SCHEME.length);
  const resolved = kernel.dispatchFsRead('load', filePath);
  if (!resolved) return next(url, context);

  const { place, fileKey } = resolved;
  const data = place.readFile(fileKey);
  if (data === null) return next(url, context);

  const source = data.toString();
  const format = context.format || (filePath.endsWith('.json') ? 'json' : 'module');

  return {
    shortCircuit: true,
    source,
    format,
  };
}

function safeFileURLToPath(url) {
  if (!url.startsWith('file://')) return null;
  try {
    return nodeFileURLToPath(url);
  } catch {
    return null;
  }
}
