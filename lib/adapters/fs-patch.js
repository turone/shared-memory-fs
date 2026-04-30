'use strict';

const fs = require('node:fs');
const path = require('node:path');

// fs-patch — monkey-patches node:fs to intercept reads for VFS-managed files.
// install(kernel) saves originals and patches; uninstall() restores them.
// Passthrough: if kernel.dispatchFsRead returns null → call original fs.
// SAB files: return Buffer view (zero-copy) from Place.files.
// Disk files (data === null): passthrough to original fs.

let installed = false;
let kernel = null;

const originals = {
  readFile: null,
  readFileSync: null,
  stat: null,
  statSync: null,
  existsSync: null,
  realpathSync: null,
  createReadStream: null,
  promises: {
    readFile: null,
    stat: null,
  },
};

const getFileData = (filePath) => {
  if (typeof filePath !== 'string') return null;
  const resolved = kernel.dispatchFsRead('readFile', filePath);
  if (!resolved) return null;
  const { place, fileKey } = resolved;
  const file = place.files.get(fileKey);
  if (!file) return null;
  if (file.data === null) return null; // disk entry — passthrough
  return file;
};

const getFileStat = (filePath) => {
  if (typeof filePath !== 'string') return null;
  const resolved = kernel.dispatchFsRead('stat', filePath);
  if (!resolved) return null;
  const { place, fileKey } = resolved;
  const file = place.files.get(fileKey);
  if (!file) return null;
  return file;
};

// --- Patched functions ---

function patchedReadFile(filePath, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const file = getFileData(filePath);
  if (!file) return originals.readFile.call(fs, filePath, options, callback);
  const encoding =
    typeof options === 'string' ? options : options?.encoding || null;
  const data = encoding ? file.data.toString(encoding) : Buffer.from(file.data);
  process.nextTick(callback, null, data);
}

function patchedReadFileSync(filePath, options) {
  const file = getFileData(filePath);
  if (!file) return originals.readFileSync.call(fs, filePath, options);
  const encoding =
    typeof options === 'string' ? options : options?.encoding || null;
  return encoding ? file.data.toString(encoding) : Buffer.from(file.data);
}

function patchedStat(filePath, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const file = getFileStat(filePath);
  if (!file) return originals.stat.call(fs, filePath, options, callback);
  process.nextTick(callback, null, file.stat);
}

function patchedStatSync(filePath, options) {
  const file = getFileStat(filePath);
  if (!file) return originals.statSync.call(fs, filePath, options);
  return file.stat;
}

function patchedExistsSync(filePath) {
  if (typeof filePath !== 'string') {
    return originals.existsSync.call(fs, filePath);
  }
  const resolved = kernel.dispatchFsRead('existsSync', filePath);
  if (!resolved) return originals.existsSync.call(fs, filePath);
  const { place, fileKey } = resolved;
  return place.exists(fileKey);
}

function patchedRealpathSync(filePath, options) {
  if (typeof filePath !== 'string') {
    return originals.realpathSync.call(fs, filePath, options);
  }
  const resolved = kernel.dispatchFsRead('realpathSync', filePath);
  if (!resolved) return originals.realpathSync.call(fs, filePath, options);
  return path.resolve(filePath);
}

function patchedCreateReadStream(filePath, options) {
  const file = getFileData(filePath);
  if (!file) return originals.createReadStream.call(fs, filePath, options);
  const resolved = kernel.dispatchFsRead('createReadStream', filePath);
  const { place, fileKey } = resolved;
  const stream = place.createReadStream(fileKey, options);
  if (!stream) return originals.createReadStream.call(fs, filePath, options);
  return stream;
}

// --- Promises ---

async function patchedPromisesReadFile(filePath, options) {
  const file = getFileData(filePath);
  if (!file) return originals.promises.readFile.call(fs.promises, filePath, options);
  const encoding =
    typeof options === 'string' ? options : options?.encoding || null;
  return encoding ? file.data.toString(encoding) : Buffer.from(file.data);
}

async function patchedPromisesStat(filePath, options) {
  const file = getFileStat(filePath);
  if (!file) return originals.promises.stat.call(fs.promises, filePath, options);
  return file.stat;
}

// --- Install / Uninstall ---

const install = (k) => {
  if (installed) return;
  kernel = k;

  originals.readFile = fs.readFile;
  originals.readFileSync = fs.readFileSync;
  originals.stat = fs.stat;
  originals.statSync = fs.statSync;
  originals.existsSync = fs.existsSync;
  originals.realpathSync = fs.realpathSync;
  originals.createReadStream = fs.createReadStream;
  originals.promises.readFile = fs.promises.readFile;
  originals.promises.stat = fs.promises.stat;

  fs.readFile = patchedReadFile;
  fs.readFileSync = patchedReadFileSync;
  fs.stat = patchedStat;
  fs.statSync = patchedStatSync;
  fs.existsSync = patchedExistsSync;
  fs.realpathSync = patchedRealpathSync;
  fs.createReadStream = patchedCreateReadStream;
  fs.promises.readFile = patchedPromisesReadFile;
  fs.promises.stat = patchedPromisesStat;

  installed = true;
};

const uninstall = () => {
  if (!installed) return;

  fs.readFile = originals.readFile;
  fs.readFileSync = originals.readFileSync;
  fs.stat = originals.stat;
  fs.statSync = originals.statSync;
  fs.existsSync = originals.existsSync;
  fs.realpathSync = originals.realpathSync;
  fs.createReadStream = originals.createReadStream;
  fs.promises.readFile = originals.promises.readFile;
  fs.promises.stat = originals.promises.stat;

  kernel = null;
  installed = false;
};

module.exports = { install, uninstall };
