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
  writeFile: null,
  writeFileSync: null,
  unlink: null,
  unlinkSync: null,
  mkdirSync: null,
  promises: {
    readFile: null,
    stat: null,
    writeFile: null,
    unlink: null,
  },
};

const getFileData = (filePath) => {
  if (typeof filePath !== 'string') return null;
  const resolved = kernel.resolveFsPath(filePath);
  if (!resolved) return null;
  const { place, fileKey } = resolved;
  const file = place.files.get(fileKey);
  if (!file) return null;
  if (file.data === null) return null; // disk entry — passthrough
  return file;
};

const getFileStat = (filePath) => {
  if (typeof filePath !== 'string') return null;
  const resolved = kernel.resolveFsPath(filePath);
  if (!resolved) return null;
  const { place, fileKey } = resolved;
  const file = place.files.get(fileKey);
  if (!file) return null;
  return file;
};

// Strict-mode gate. Returns an EACCES Error when the path is denied by the
// kernel sandbox, otherwise null. Callers throw (sync) or pass to callback.
const denied = (filePath, syscall) => {
  if (!kernel.isStrictDenied(filePath)) return null;
  const err = new Error(
    `EACCES: permission denied (vfs strict), ${syscall} '${filePath}'`,
  );
  err.code = 'EACCES';
  err.errno = -13;
  err.syscall = syscall;
  err.path = filePath;
  return err;
};

// --- Patched functions ---

function patchedReadFile(filePath, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const err = denied(filePath, 'open');
  if (err) return process.nextTick(callback, err);
  const file = getFileData(filePath);
  if (!file) return originals.readFile.call(fs, filePath, options, callback);
  const encoding =
    typeof options === 'string' ? options : options?.encoding || null;
  const data = encoding ? file.data.toString(encoding) : Buffer.from(file.data);
  return process.nextTick(callback, null, data);
}

function patchedReadFileSync(filePath, options) {
  const err = denied(filePath, 'open');
  if (err) throw err;
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
  const err = denied(filePath, 'stat');
  if (err) return process.nextTick(callback, err);
  const file = getFileStat(filePath);
  if (!file) return originals.stat.call(fs, filePath, options, callback);
  return process.nextTick(callback, null, file.stat);
}

function patchedStatSync(filePath, options) {
  const err = denied(filePath, 'stat');
  if (err) throw err;
  const file = getFileStat(filePath);
  if (!file) return originals.statSync.call(fs, filePath, options);
  return file.stat;
}

function patchedExistsSync(filePath) {
  if (typeof filePath !== 'string') {
    return originals.existsSync.call(fs, filePath);
  }
  if (kernel.isStrictDenied(filePath)) return false;
  const resolved = kernel.resolveFsPath(filePath);
  if (!resolved) return originals.existsSync.call(fs, filePath);
  const { place, fileKey } = resolved;
  return place.exists(fileKey);
}

function patchedRealpathSync(filePath, options) {
  if (typeof filePath !== 'string') {
    return originals.realpathSync.call(fs, filePath, options);
  }
  const err = denied(filePath, 'lstat');
  if (err) throw err;
  const resolved = kernel.resolveFsPath(filePath);
  if (!resolved) return originals.realpathSync.call(fs, filePath, options);
  return path.resolve(filePath);
}

function patchedCreateReadStream(filePath, options) {
  const err = denied(filePath, 'open');
  if (err) throw err;
  const file = getFileData(filePath);
  if (!file) return originals.createReadStream.call(fs, filePath, options);
  const resolved = kernel.resolveFsPath(filePath);
  const { place, fileKey } = resolved;
  const stream = place.createReadStream(fileKey, options);
  if (!stream) return originals.createReadStream.call(fs, filePath, options);
  return stream;
}

// --- Promises ---

async function patchedPromisesReadFile(filePath, options) {
  const err = denied(filePath, 'open');
  if (err) throw err;
  const file = getFileData(filePath);
  if (!file)
    return originals.promises.readFile.call(fs.promises, filePath, options);
  const encoding =
    typeof options === 'string' ? options : options?.encoding || null;
  return encoding ? file.data.toString(encoding) : Buffer.from(file.data);
}

async function patchedPromisesStat(filePath, options) {
  const err = denied(filePath, 'stat');
  if (err) throw err;
  const file = getFileStat(filePath);
  if (!file)
    return originals.promises.stat.call(fs.promises, filePath, options);
  return file.stat;
}

// --- Writes (memory places only; passthrough otherwise) ---

const toBuffer = (data, options) => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  const encoding =
    typeof options === 'string' ? options : options?.encoding || 'utf8';
  return Buffer.from(String(data), encoding);
};

function patchedWriteFileSync(filePath, data, options) {
  if (typeof filePath !== 'string') {
    originals.writeFileSync.call(fs, filePath, data, options);
    return;
  }
  const denyErr = denied(filePath, 'open');
  if (denyErr) throw denyErr;
  const route = kernel.routeWrite(filePath);
  if (!route) {
    originals.writeFileSync.call(fs, filePath, data, options);
    return;
  }
  route.place.writeFile(route.fileKey, toBuffer(data, options));
}

function patchedWriteFile(filePath, data, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof filePath !== 'string') {
    return originals.writeFile.call(fs, filePath, data, options, callback);
  }
  const denyErr = denied(filePath, 'open');
  if (denyErr) return process.nextTick(callback, denyErr);
  const route = kernel.routeWrite(filePath);
  if (!route)
    return originals.writeFile.call(fs, filePath, data, options, callback);
  try {
    route.place.writeFile(route.fileKey, toBuffer(data, options));
    return process.nextTick(callback, null);
  } catch (err) {
    return process.nextTick(callback, err);
  }
}

function patchedUnlinkSync(filePath) {
  if (typeof filePath !== 'string') {
    originals.unlinkSync.call(fs, filePath);
    return;
  }
  const denyErr = denied(filePath, 'unlink');
  if (denyErr) throw denyErr;
  const route = kernel.routeWrite(filePath);
  if (!route) {
    originals.unlinkSync.call(fs, filePath);
    return;
  }
  if (!route.place.unlink(route.fileKey)) {
    const err = new Error(`ENOENT: no such file, unlink '${filePath}'`);
    err.code = 'ENOENT';
    throw err;
  }
}

function patchedUnlink(filePath, callback) {
  if (typeof filePath !== 'string') {
    return originals.unlink.call(fs, filePath, callback);
  }
  const denyErr = denied(filePath, 'unlink');
  if (denyErr) return process.nextTick(callback, denyErr);
  const route = kernel.routeWrite(filePath);
  if (!route) return originals.unlink.call(fs, filePath, callback);
  try {
    if (!route.place.unlink(route.fileKey)) {
      const err = new Error(`ENOENT: no such file, unlink '${filePath}'`);
      err.code = 'ENOENT';
      return process.nextTick(callback, err);
    }
    return process.nextTick(callback, null);
  } catch (err) {
    return process.nextTick(callback, err);
  }
}

function patchedMkdirSync(filePath, options) {
  // Memory places have a flat key namespace; mkdir is a no-op for them.
  if (typeof filePath === 'string' && kernel.routeWrite(filePath)) return;
  const denyErr = denied(filePath, 'mkdir');
  if (denyErr) throw denyErr;
  originals.mkdirSync.call(fs, filePath, options);
}

async function patchedPromisesWriteFile(filePath, data, options) {
  if (typeof filePath !== 'string') {
    await originals.promises.writeFile.call(
      fs.promises,
      filePath,
      data,
      options,
    );
    return;
  }
  const denyErr = denied(filePath, 'open');
  if (denyErr) throw denyErr;
  const route = kernel.routeWrite(filePath);
  if (!route) {
    await originals.promises.writeFile.call(
      fs.promises,
      filePath,
      data,
      options,
    );
    return;
  }
  route.place.writeFile(route.fileKey, toBuffer(data, options));
}

async function patchedPromisesUnlink(filePath) {
  if (typeof filePath !== 'string') {
    await originals.promises.unlink.call(fs.promises, filePath);
    return;
  }
  const denyErr = denied(filePath, 'unlink');
  if (denyErr) throw denyErr;
  const route = kernel.routeWrite(filePath);
  if (!route) {
    await originals.promises.unlink.call(fs.promises, filePath);
    return;
  }
  if (!route.place.unlink(route.fileKey)) {
    const err = new Error(`ENOENT: no such file, unlink '${filePath}'`);
    err.code = 'ENOENT';
    throw err;
  }
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
  originals.writeFile = fs.writeFile;
  originals.writeFileSync = fs.writeFileSync;
  originals.unlink = fs.unlink;
  originals.unlinkSync = fs.unlinkSync;
  originals.mkdirSync = fs.mkdirSync;
  originals.promises.readFile = fs.promises.readFile;
  originals.promises.stat = fs.promises.stat;
  originals.promises.writeFile = fs.promises.writeFile;
  originals.promises.unlink = fs.promises.unlink;

  fs.readFile = patchedReadFile;
  fs.readFileSync = patchedReadFileSync;
  fs.stat = patchedStat;
  fs.statSync = patchedStatSync;
  fs.existsSync = patchedExistsSync;
  fs.realpathSync = patchedRealpathSync;
  fs.createReadStream = patchedCreateReadStream;
  fs.writeFile = patchedWriteFile;
  fs.writeFileSync = patchedWriteFileSync;
  fs.unlink = patchedUnlink;
  fs.unlinkSync = patchedUnlinkSync;
  fs.mkdirSync = patchedMkdirSync;
  fs.promises.readFile = patchedPromisesReadFile;
  fs.promises.stat = patchedPromisesStat;
  fs.promises.writeFile = patchedPromisesWriteFile;
  fs.promises.unlink = patchedPromisesUnlink;

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
  fs.writeFile = originals.writeFile;
  fs.writeFileSync = originals.writeFileSync;
  fs.unlink = originals.unlink;
  fs.unlinkSync = originals.unlinkSync;
  fs.mkdirSync = originals.mkdirSync;
  fs.promises.readFile = originals.promises.readFile;
  fs.promises.stat = originals.promises.stat;
  fs.promises.writeFile = originals.promises.writeFile;
  fs.promises.unlink = originals.promises.unlink;

  kernel = null;
  installed = false;
};

module.exports = { install, uninstall };
