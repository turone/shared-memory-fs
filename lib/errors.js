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

const fsError = (code, syscall, path, detail) => {
  const reason = detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code];
  const where = path === undefined ? '' : ` '${path}'`;
  const err = new Error(`${code}: ${reason}, ${syscall}${where}`);
  err.code = code;
  err.errno = -(constants.errno[code] || 0);
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  return err;
};

module.exports = { fsError };
