'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { fileExt } = require('metautil');

const WIN = process.platform === 'win32';

const toKey = WIN
  ? (filePath, base) => filePath.substring(base.length).replace(/\\/g, '/')
  : (filePath, base) => filePath.substring(base.length);

const getKey = (filePath, basePath) => toKey(filePath, basePath);

const scan = async (rootPath, options = {}) => {
  const files = new Map();
  const dirs = new Set();
  const ext = options.ext || null;
  const startPath = options.startPath || rootPath;
  dirs.add(startPath);
  await scanDir(rootPath, startPath, files, dirs, ext);
  return { files, dirs };
};

const scanDir = async (rootPath, dirPath, files, dirs, ext) => {
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
      await scanDir(rootPath, filePath, files, dirs, ext);
    } else {
      if (ext && !ext.includes(fileExt(filePath))) continue;
      try {
        const stat = await fsp.stat(filePath);
        const key = toKey(filePath, rootPath);
        files.set(key, { stat, path: filePath });
      } catch {
        // Skip unreadable files
      }
    }
  }
};

module.exports = { scan, getKey };
