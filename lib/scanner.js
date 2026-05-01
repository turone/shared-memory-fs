'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { fileExt } = require('metautil');

const WIN = process.platform === 'win32';

const toKey = WIN
  ? (filePath, base) => filePath.substring(base.length).replace(/\\/g, '/')
  : (filePath, base) => filePath.substring(base.length);

const getKey = (filePath, basePath) => toKey(filePath, basePath);

// scan() returns:
//   files: Map<key, { stat, path }>
//   dirs:  Set<absDir>
//   skipped: Map<extension, { count, examples: string[] }>
//     — files filtered out by `ext` whitelist; aggregated by extension,
//       up to 3 example keys per ext for diagnostics.
const scan = async (rootPath, options = {}) => {
  const files = new Map();
  const dirs = new Set();
  const skipped = new Map();
  const ext = options.ext || null;
  const startPath = options.startPath || rootPath;
  dirs.add(startPath);
  await scanDir(rootPath, startPath, files, dirs, ext, skipped);
  return { files, dirs, skipped };
};

const recordSkipped = (skipped, key, extName) => {
  const tag = extName || '<no-ext>';
  let bucket = skipped.get(tag);
  if (!bucket) {
    bucket = { count: 0, examples: [] };
    skipped.set(tag, bucket);
  }
  bucket.count++;
  if (bucket.examples.length < 3) bucket.examples.push(key);
};

async function scanDir(rootPath, dirPath, files, dirs, ext, skipped) {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      dirs.add(filePath);
      await scanDir(rootPath, filePath, files, dirs, ext, skipped);
    } else {
      if (ext && !ext.includes(fileExt(filePath))) {
        recordSkipped(skipped, toKey(filePath, rootPath), fileExt(filePath));
        continue;
      }
      try {
        const stat = await fsp.stat(filePath);
        const key = toKey(filePath, rootPath);
        files.set(key, { stat, path: filePath });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

module.exports = { scan, getKey };
