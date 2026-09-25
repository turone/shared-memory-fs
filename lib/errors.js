'use strict';

const { constants } = require('node:os');

// Node-style filesystem errors for virtual entries: same `code`, `errno`,
// `syscall`, `path` fields and message format as errors thrown by node:fs.

const MESSAGES = {
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty',
  EEXIST: 'file already exists',
  EACCES: 'permission denied',
  EROFS: 'read-only file system',
  ENOTSUP: 'operation not supported',
  EXDEV: 'cross-device link not permitted',
  EINVAL: 'invalid argument',
};

const fsError = (code, syscall, path, detail, dest) => {
  const reason = detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code];
  let where = path === undefined ? '' : ` '${path}'`;
  if (dest !== undefined) where += ` -> '${dest}'`;
  const err = new Error(`${code}: ${reason}, ${syscall}${where}`);
  err.code = code;
  err.errno = -(constants.errno[code] || 0);
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  if (dest !== undefined) err.dest = dest;
  return err;
};

// What node:fs throws for `rm` of a directory without `recursive`, empty
// or not: a SystemError coded ERR_FS_EISDIR, the EISDIR behind it in
// `info`.
const isDirectoryError = (syscall, path) => {
  const errno = constants.errno.EISDIR;
  const reason = `${syscall} returned EISDIR (is a directory) ${path}`;
  const message = 'is a directory';
  const info = { code: 'EISDIR', message, path, syscall, errno };
  return Object.assign(new Error(`Path is a directory: ${reason}`), {
    name: 'SystemError',
    code: 'ERR_FS_EISDIR',
    errno,
    syscall,
    path,
    info,
  });
};

module.exports = { fsError, isDirectoryError };
