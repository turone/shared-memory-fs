'use strict';

/* eslint-disable consistent-return, no-invalid-this */
// Operation cores return PASS or the operation's result (often undefined);
// variant wrappers are installed on fs and forward the caller's `this`.

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');
const { fsError } = require('../errors.js');

// fs-patch — routes node:fs calls through the kernel's FsRouter and executes
// its decision; it never interprets config itself.
//   'file' / 'dir'   served from the place's PlaceFs facade
//   'memory'         mutation of a per-thread memory place
//   'passthrough'    original node:fs
//   'deny'           Node-style error (EACCES / EROFS)
// Implemented: readFile, stat, lstat, existsSync, access, realpath, readdir,
// open (denied for virtual entries), createReadStream, writeFile,
// appendFile, unlink, mkdir, rm, rename — sync, callback and promises forms
// where Node has them.
// The remaining path-taking APIs (copyFile, cp, opendir, rmdir, chmod,
// utimes, link, symlink, readlink, statfs, truncate, watch, glob) are
// *guarded*, not implemented: they only ever refuse a routing decision the
// kernel denies, so a strict sandbox or a read-only place cannot be bypassed
// — nor probed — through them.
// Everything else is untouched node:fs; full node:fs coverage is not promised.

const PASS = Symbol('passthrough');

let kernel = null;
let installed = null; // [{ target, name, original }]

const pathOf = (p) => {
  if (typeof p === 'string') return p;
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return p.toString();
  return null; // file descriptor
};

const facadeOf = (route) => kernel.fs(route.place.name);

// Read routing shared by every read-side operation. `syscall` names the
// operation in errors; `onDir` handles implicit directories.
const readRoute = (p, syscall) => {
  const filePath = pathOf(p);
  if (filePath === null) return PASS;
  const route = kernel.routeRead(filePath);
  if (route.kind === 'passthrough') return PASS;
  if (route.kind === 'deny') throw fsError(route.code, syscall, filePath);
  return route;
};

const mutationRoute = (p, syscall) => {
  const filePath = pathOf(p);
  if (filePath === null) return PASS;
  const route = kernel.routeMutation(filePath);
  if (route.kind === 'passthrough') return PASS;
  if (route.kind === 'deny') throw fsError(route.code, syscall, filePath);
  return route;
};

const optionsOf = (args) => (typeof args[0] === 'object' ? args[0] : {});

// --- Operation cores: (path, args) → result | PASS, or throw ---

const ops = {
  readFile(p, [options]) {
    const route = readRoute(p, 'open');
    if (route === PASS) return PASS;
    if (route.kind === 'dir') throw fsError('EISDIR', 'read');
    return facadeOf(route).readFile(route.key, options);
  },

  stat(p, args) {
    const route = readRoute(p, 'stat');
    if (route === PASS) return PASS;
    return facadeOf(route).stat(route.key, optionsOf(args));
  },

  lstat(p, args) {
    const route = readRoute(p, 'lstat');
    if (route === PASS) return PASS;
    return facadeOf(route).stat(route.key, optionsOf(args));
  },

  access(p, [mode = fs.constants.F_OK]) {
    const filePath = pathOf(p);
    const route = readRoute(p, 'access');
    if (route === PASS) return PASS;
    const { W_OK, X_OK } = fs.constants;
    if (mode & X_OK) throw fsError('EACCES', 'access', filePath);
    if (mode & W_OK && !facadeOf(route).writable) {
      throw fsError('EACCES', 'access', filePath);
    }
    return undefined;
  },

  realpath(p) {
    const route = readRoute(p, 'lstat');
    if (route === PASS) return PASS;
    return path.resolve(pathOf(p));
  },

  readdir(p, [options]) {
    const route = readRoute(p, 'scandir');
    if (route === PASS) return PASS;
    if (route.kind === 'file') throw fsError('ENOTDIR', 'scandir', pathOf(p));
    const opts = typeof options === 'string' ? { encoding: options } : options;
    return facadeOf(route).readdir(route.key, opts || {});
  },

  // Virtual entries have no file descriptor.
  open(p) {
    const route = readRoute(p, 'open');
    if (route === PASS) return PASS;
    throw fsError('ENOTSUP', 'open', pathOf(p), 'virtual file');
  },

  writeFile(p, [data, options]) {
    const route = mutationRoute(p, 'open');
    if (route === PASS) return PASS;
    return void facadeOf(route).writeFile(route.key, data, options);
  },

  appendFile(p, [data, options]) {
    const route = mutationRoute(p, 'open');
    if (route === PASS) return PASS;
    return void facadeOf(route).appendFile(route.key, data, options);
  },

  unlink(p) {
    const route = mutationRoute(p, 'unlink');
    if (route === PASS) return PASS;
    return void facadeOf(route).unlink(route.key);
  },

  mkdir(p, [options]) {
    const route = mutationRoute(p, 'mkdir');
    if (route === PASS) return PASS;
    return void facadeOf(route).mkdir(route.key, options);
  },

  rm(p, [options]) {
    const route = mutationRoute(p, 'rm');
    if (route === PASS) return PASS;
    return void facadeOf(route).rm(route.key, options || {});
  },

  rename(from, [to]) {
    const src = mutationRoute(from, 'rename');
    const dst = mutationRoute(to, 'rename');
    if (src === PASS && dst === PASS) return PASS;
    if (src === PASS || dst === PASS || src.place !== dst.place) {
      throw fsError('EXDEV', 'rename', pathOf(from));
    }
    return void facadeOf(src).rename(src.key, dst.key);
  },
};

// --- Variant generators ---

const syncVariant = (op, original) =>
  function (p, ...args) {
    const result = op(p, args);
    return result === PASS ? original.call(this, p, ...args) : result;
  };

const callbackVariant = (op, original) =>
  function (p, ...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    let result;
    try {
      result = op(p, args);
    } catch (err) {
      return void process.nextTick(callback, err);
    }
    if (result === PASS) return original.call(this, p, ...args, callback);
    return void process.nextTick(callback, null, result);
  };

const promiseVariant = (op, original) =>
  async function (p, ...args) {
    const result = op(p, args);
    return result === PASS ? original.call(this, p, ...args) : result;
  };

const existsSync = (original) =>
  function (p) {
    const filePath = pathOf(p);
    if (filePath === null) return original.call(this, p);
    const route = kernel.routeRead(filePath);
    if (route.kind === 'passthrough') return original.call(this, p);
    return route.kind !== 'deny';
  };

// fs.createReadStream never throws: errors are emitted on the stream.
const createReadStream = (original) =>
  function (p, options) {
    let route;
    try {
      route = readRoute(p, 'open');
      if (route === PASS) return original.call(this, p, options);
      if (route.kind === 'dir') throw fsError('EISDIR', 'read');
      return facadeOf(route).createReadStream(route.key, options || {});
    } catch (err) {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(err));
      return stream;
    }
  };

// --- Guards for APIs the patch does not implement ---

// Every path argument is routed and its decision enforced; the call itself
// always continues to the original node:fs.
const guardOp = (syscall, roles) => (p, args) => {
  const paths = [p, ...args];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    if (role === 'read') readRoute(paths[i], syscall);
    else mutationRoute(paths[i], syscall);
  }
  return PASS;
};

// glob takes patterns, not paths: its results are filtered instead.
const allowed = (entry) => {
  const filePath =
    typeof entry === 'string'
      ? entry
      : path.join(entry.parentPath || entry.path || '', entry.name);
  return kernel.routeRead(path.resolve(filePath)).kind !== 'deny';
};

const globSync = (original) =>
  function (...args) {
    return original.apply(this, args).filter(allowed);
  };

const globCallback = (original) =>
  function (...args) {
    const callback = args.pop();
    return original.call(this, ...args, (err, matches) => {
      if (err) return void callback(err);
      callback(null, matches.filter(allowed));
    });
  };

const globPromises = (original) =>
  async function* (...args) {
    for await (const entry of original.apply(this, args)) {
      if (allowed(entry)) yield entry;
    }
  };

// --- Install / Uninstall ---

const TABLE = [
  ['readFile', ops.readFile],
  ['stat', ops.stat],
  ['lstat', ops.lstat],
  ['access', ops.access],
  ['realpath', ops.realpath],
  ['readdir', ops.readdir],
  ['open', ops.open],
  ['writeFile', ops.writeFile],
  ['appendFile', ops.appendFile],
  ['unlink', ops.unlink],
  ['mkdir', ops.mkdir],
  ['rm', ops.rm],
  ['rename', ops.rename],
];

// [name, syscall, roles per path argument]
const GUARDS = [
  ['opendir', 'scandir', ['read']],
  ['readlink', 'readlink', ['read']],
  ['statfs', 'statfs', ['read']],
  ['rmdir', 'rmdir', ['mutate']],
  ['truncate', 'open', ['mutate']],
  ['utimes', 'utime', ['mutate']],
  ['lutimes', 'lutime', ['mutate']],
  ['chmod', 'chmod', ['mutate']],
  ['lchmod', 'chmod', ['mutate']],
  ['chown', 'chown', ['mutate']],
  ['lchown', 'chown', ['mutate']],
  ['copyFile', 'copyfile', ['read', 'mutate']],
  ['cp', 'copyfile', ['read', 'mutate']],
  ['link', 'link', ['read', 'mutate']],
  ['symlink', 'symlink', ['read', 'mutate']],
];

// Guards for APIs that hand back their result synchronously (a watcher or an
// async iterator), so the callback and promise wrappers do not apply.
const WATCHERS = [
  ['watch', 'watch', ['read']],
  ['watchFile', 'watch', ['read']],
];

const patch = (target, name, make) => {
  const original = target[name];
  installed.push({ target, name, original });
  const patched = make(original);
  // fs.realpath.native / fs.realpathSync.native stay reachable.
  if (original.native) patched.native = original.native;
  target[name] = patched;
};

const install = (k) => {
  if (installed) return;
  kernel = k;
  installed = [];
  for (const [name, op] of TABLE) {
    patch(fs, name, (orig) => callbackVariant(op, orig));
    patch(fs, `${name}Sync`, (orig) => syncVariant(op, orig));
    patch(fs.promises, name, (orig) => promiseVariant(op, orig));
  }
  for (const [name, syscall, roles] of GUARDS) {
    const op = guardOp(syscall, roles);
    if (typeof fs[name] === 'function') {
      patch(fs, name, (orig) => callbackVariant(op, orig));
    }
    if (typeof fs[`${name}Sync`] === 'function') {
      patch(fs, `${name}Sync`, (orig) => syncVariant(op, orig));
    }
    if (typeof fs.promises[name] === 'function') {
      patch(fs.promises, name, (orig) => promiseVariant(op, orig));
    }
  }
  if (typeof fs.globSync === 'function') {
    patch(fs, 'globSync', globSync);
    patch(fs, 'glob', globCallback);
    patch(fs.promises, 'glob', globPromises);
  }
  for (const [name, syscall, roles] of WATCHERS) {
    const op = guardOp(syscall, roles);
    patch(fs, name, (orig) => syncVariant(op, orig));
    if (typeof fs.promises[name] === 'function') {
      patch(fs.promises, name, (orig) => syncVariant(op, orig));
    }
  }
  patch(fs, 'existsSync', existsSync);
  patch(fs, 'createReadStream', createReadStream);
};

const uninstall = () => {
  if (!installed) return;
  for (const { target, name, original } of installed.reverse()) {
    target[name] = original;
  }
  installed = null;
  kernel = null;
};

module.exports = { install, uninstall };
