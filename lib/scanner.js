'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { readdir, stat } = require('node:fs/promises');

const WIN = process.platform === 'win32';

// Place key of an absolute path under `rootPath`: forward slashes, leading '/'.
const keyOf = WIN
  ? (filePath, rootPath) =>
      filePath.substring(rootPath.length).replace(/\\/g, '/')
  : (filePath, rootPath) => filePath.substring(rootPath.length);

const addFile = async (ctx, filePath) => {
  const key = keyOf(filePath, ctx.rootPath);
  if (ctx.ext && !ctx.ext.includes(fileExt(key))) return;
  const stats = await stat(filePath).catch(() => null);
  if (!stats || !stats.isFile()) return;
  ctx.files.set(key, {
    path: filePath,
    stat: { size: stats.size, mtimeMs: stats.mtimeMs },
  });
};

const scanDir = async (ctx, dirPath) => {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await scanDir(ctx, filePath);
    } else if (entry.isFile()) {
      await addFile(ctx, filePath);
    } else if (entry.isSymbolicLink() && ctx.followSymlinks) {
      await addFile(ctx, filePath);
    }
  }
};

// scan(rootPath, { ext, startPath, followSymlinks }) → Map<key, FileInput>
//   FileInput: { path, stat: { size, mtimeMs } }         regular files only
//   ext:       null = every extension, else lowercase list without dots
//   startPath: scan only this subtree; keys stay relative to rootPath
// Symbolic links to directories are never traversed. Links to regular files
// are published only with `followSymlinks` (strict sandboxes turn it off).
// FIFOs, sockets and devices are never published.
const scan = async (rootPath, options = {}) => {
  const ctx = {
    rootPath,
    ext: options.ext || null,
    followSymlinks: options.followSymlinks === true,
    files: new Map(),
  };
  await scanDir(ctx, options.startPath || rootPath);
  return ctx.files;
};

module.exports = { scan, keyOf };
