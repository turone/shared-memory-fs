'use strict';

// Lazy stat/dirent facades for virtual entries. Entries persist only compact
// metadata ({ size, mtimeMs }); these objects are created per call and never
// cached, so they always reflect the entry currently published.

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;

class VfsStats {
  #directory;

  constructor(size, mtimeMs, directory = false) {
    this.size = size;
    this.mode = directory ? DIR_MODE : FILE_MODE;
    this.mtimeMs = mtimeMs;
    this.atimeMs = mtimeMs;
    this.ctimeMs = mtimeMs;
    this.birthtimeMs = mtimeMs;
    const date = new Date(mtimeMs);
    this.mtime = date;
    this.atime = date;
    this.ctime = date;
    this.birthtime = date;
    this.nlink = 1;
    this.uid = 0;
    this.gid = 0;
    this.dev = 0;
    this.ino = 0;
    this.rdev = 0;
    this.blksize = 0;
    this.blocks = 0;
    this.#directory = directory;
  }

  isFile() {
    return !this.#directory;
  }

  isDirectory() {
    return this.#directory;
  }

  isSymbolicLink() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }
}

const MS_PER_NS = 1_000_000n;

class VfsBigIntStats extends VfsStats {
  constructor(size, mtimeMs, directory) {
    super(size, mtimeMs, directory);
    this.size = BigInt(size);
    this.mode = BigInt(this.mode);
    const ms = BigInt(Math.trunc(mtimeMs));
    this.mtimeMs = ms;
    this.atimeMs = ms;
    this.ctimeMs = ms;
    this.birthtimeMs = ms;
    const ns = ms * MS_PER_NS;
    this.mtimeNs = ns;
    this.atimeNs = ns;
    this.ctimeNs = ns;
    this.birthtimeNs = ns;
    this.nlink = 1n;
    this.uid = 0n;
    this.gid = 0n;
    this.dev = 0n;
    this.ino = 0n;
    this.rdev = 0n;
    this.blksize = 0n;
    this.blocks = 0n;
  }
}

const statsOf = (size, mtimeMs, { directory = false, bigint = false } = {}) =>
  bigint
    ? new VfsBigIntStats(size, mtimeMs, directory)
    : new VfsStats(size, mtimeMs, directory);

class VfsDirent {
  #directory;

  constructor(name, parentPath, directory) {
    this.name = name;
    this.parentPath = parentPath;
    this.#directory = directory;
  }

  isFile() {
    return !this.#directory;
  }

  isDirectory() {
    return this.#directory;
  }

  isSymbolicLink() {
    return false;
  }

  isFIFO() {
    return false;
  }

  isSocket() {
    return false;
  }

  isBlockDevice() {
    return false;
  }

  isCharacterDevice() {
    return false;
  }
}

module.exports = { VfsStats, VfsBigIntStats, VfsDirent, statsOf };
