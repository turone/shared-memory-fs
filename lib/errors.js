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

// A SystemError as node:fs builds one for a refusal of its own: `code`
// names the refusal, `info` the error behind it; fields and message are
// node's.
const systemError = (code, title, { code: cause, message, syscall, path }) => {
  const errno = constants.errno[cause];
  const info = { code: cause, message, path, syscall, errno };
  const reason = `${syscall} returned ${cause} (${message}) ${path}`;
  return Object.assign(new Error(`${title}: ${reason}`), {
    name: 'SystemError',
    code,
    errno,
    syscall,
    path,
    info,
  });
};

// `rm` of a directory without `recursive`, empty or not.
const isDirectoryError = (syscall, path) =>
  systemError('ERR_FS_EISDIR', 'Path is a directory', {
    code: 'EISDIR',
    message: 'is a directory',
    syscall,
    path,
  });

// `cp` onto an existing file with `errorOnExist`; named, as the next one,
// by the destination.
const cpExistsError = (dest) =>
  systemError('ERR_FS_CP_EEXIST', 'Target already exists', {
    code: 'EEXIST',
    message: `${dest} already exists`,
    syscall: 'cp',
    path: dest,
  });

// `cp` of a file onto a directory, whatever `force` says.
const cpOntoDirectoryError = (src, dest) =>
  systemError(
    'ERR_FS_CP_NON_DIR_TO_DIR',
    'Cannot overwrite directory with non-directory',
    {
      code: 'ENOTDIR',
      message: `cannot overwrite directory ${dest} with non-directory ${src}`,
      syscall: 'cp',
      path: dest,
    },
  );

module.exports = {
  fsError,
  isDirectoryError,
  cpExistsError,
  cpOntoDirectoryError,
};
