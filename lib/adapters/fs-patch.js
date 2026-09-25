'use strict';

/* eslint-disable consistent-return, no-invalid-this */
// Operation cores return PASS or the operation's result (often undefined);
// variant wrappers are installed on fs and forward the caller's `this`.

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');
const { fsError } = require('../errors.js');
const { statsOf, VfsDirent, encodeName } = require('../stats.js');

// fs-patch — routes node:fs calls through the kernel's FsRouter and executes
// its decision; it never interprets config itself.
//   'file' / 'dir'   served from the place's PlaceFs facade
//   'root'           the strict appRoot: lists the enabled places, stats as
//                    a directory, refuses everything else
//   'store'          mutation owned by the place's store (per-thread Map, or
//                    the main kernel for a shared virtual place)
//   'disk'           disk territory of `fs.fallback: 'disk'`: original
//                    node:fs, but a listing (readdir, opendir) is the
//                    place's merged listing
//   'passthrough'    original node:fs
//   'deny'           Node-style error (EACCES / EROFS)
// Implemented: readFile, stat, lstat, existsSync, access, realpath, readdir,
// opendir, open (denied for virtual entries), createReadStream, writeFile,
// appendFile, unlink, mkdir, rm, rename — sync, callback and promises forms
// where Node has them. A mutation that has to reach the main kernel cannot
// block, so the *Sync forms refuse it with ENOTSUP.
// Recognized but unsupported for managed territory (ENOTSUP, nothing read or
// written): a native operation runs only once every path it touches has
// been routed. So:
//   copyFile / cp / link from a source the kernel serves (FsRouter.copy),
//   a recursive cp into a tree that holds places;
//   watch of a managed directory, and a recursive watch of managed
//   territory;
//   recursive walks (readdir, opendir, watch, rm, rmdir, cp) and rename
//   from appRoot passed through or from a directory above it;
//   guarded mutations in a virtual place, whose entries only its store
//   changes.
// Guarded passthrough (chmod, utimes, symlink, readlink, statfs,
// truncate, rmdir, watchFile, glob): not implemented, they only ever refuse
// a routing decision the kernel denies, so strict routing or a read-only
// place cannot be bypassed — nor probed — through them; on the strict
// appRoot itself they are refused outright.
// Everything else, and every unrelated path outside appRoot, is untouched
// node:fs; full node:fs coverage is not promised.

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
// operation in errors. Disk territory is native except for a `listing`: a
// raw disk directory would show files the place serves only once published.
const readRoute = (p, syscall, listing = false) => {
  const filePath = pathOf(p);
  if (filePath === null) return PASS;
  const route = kernel.routeRead(filePath);
  if (route.kind === 'passthrough') return PASS;
  if (route.kind === 'disk' && !listing) return PASS;
  if (route.kind === 'deny') throw fsError(route.code, syscall, filePath);
  return route;
};

const mutationRoute = (p, syscall, sync) => {
  const filePath = pathOf(p);
  if (filePath === null) return PASS;
  const route = kernel.routeMutation(filePath);
  if (route.kind === 'passthrough') return PASS;
  if (route.kind === 'deny') throw fsError(route.code, syscall, filePath);
  if (sync && route.place.store?.sync === false) {
    throw fsError('ENOTSUP', syscall, filePath, 'asynchronous place');
  }
  return route;
};

// A mutation the patch does not implement: denied as routed, and refused in
// a virtual place — a native call would bypass the store that owns it.
const guardMutation = (p, syscall) => {
  if (mutationRoute(p, syscall) === PASS) return;
  throw fsError('ENOTSUP', syscall, pathOf(p), 'virtual place');
};

// A native operation that walks a tree — or acts on everything under its
// path — checks only that path. From appRoot passed through, or from a
// directory above it, the walk would enter the places past their routing.
const walkGuard = (p, syscall, dest) => {
  const filePath = pathOf(p);
  if (filePath === null || !kernel.enclosesPlaces(filePath)) return;
  throw fsError('ENOTSUP', syscall, filePath, 'walks into places', dest);
};

// cp / copyFile / link: node:fs copies (or links) the raw disk file, so a
// source the kernel serves is refused before anything is read, and a
// recursive copy never writes into a tree that holds places.
const copyOf = (src, dest, syscall, recursive) => {
  const from = pathOf(src);
  const to = pathOf(dest) ?? undefined;
  if (from !== null) {
    const route = kernel.routeCopy(from, recursive);
    if (route.kind === 'deny') throw fsError(route.code, syscall, from);
    if (route.kind === 'unsupported') {
      throw fsError('ENOTSUP', syscall, from, 'managed source', to);
    }
  }
  guardMutation(dest, syscall);
  if (recursive && to !== undefined && kernel.enclosesPlaces(to)) {
    throw fsError(
      'ENOTSUP',
      syscall,
      from ?? undefined,
      'walks into places',
      to,
    );
  }
  return PASS;
};

const optionsOf = (args) => (typeof args[0] === 'object' ? args[0] : {});

const isDirectoryRoute = (route) =>
  route.kind === 'dir' || route.kind === 'root';

// The strict appRoot lists the enabled places and nothing else. A recursive
// listing descends into each place through the patched fs itself, so every
// place applies its own routing; one it refuses lists as a bare name.
const readRoot = (root, options) => {
  const entries = new Map(); // relative '/'-separated name → isDirectory
  for (const name of kernel.rootEntries()) {
    entries.set(name, true);
    if (!options.recursive) continue;
    let children = [];
    try {
      children = fs.readdirSync(path.join(root, name), {
        recursive: true,
        withFileTypes: true,
      });
    } catch {
      // Denied, or no directory on disk.
    }
    for (const child of children) {
      const at = path.join(child.parentPath ?? child.path, child.name);
      const rel = path.relative(root, at).split(path.sep).join('/');
      entries.set(rel, child.isDirectory());
    }
  }
  const { encoding } = options;
  const names = [...entries.keys()].sort();
  if (!options.withFileTypes) {
    return names.map((rel) => encodeName(rel, encoding));
  }
  return names.map((rel) => {
    const slash = rel.lastIndexOf('/');
    const parent =
      slash === -1 ? root : path.join(root, rel.substring(0, slash));
    const base = encodeName(rel.substring(slash + 1), encoding);
    return new VfsDirent(base, parent, entries.get(rel));
  });
};

const dirClosed = () => {
  const err = new Error('Directory handle was closed');
  err.code = 'ERR_DIR_CLOSED';
  return err;
};

// fs.Dir over a routed listing — the territory readdir lists, taken when
// the directory is opened (node:fs does not promise to show entries changed
// during an iteration either). Reads, closes and their errors follow
// node:fs: a closed handle refuses reads and a second close; disposal of a
// closed handle is a no-op, and async iteration closes it.
class VfsDir {
  #path;
  #entries;
  #closed = false;

  constructor(dirPath, entries) {
    this.#path = dirPath;
    this.#entries = entries;
  }

  get path() {
    return this.#path;
  }

  readSync() {
    if (this.#closed) throw dirClosed();
    return this.#entries.shift() ?? null;
  }

  // Without a callback, a promise. With one, a closed handle throws and an
  // invalid callback is refused before an entry is consumed.
  read(callback) {
    if (callback === undefined) {
      return new Promise((resolve) => {
        resolve(this.readSync());
      });
    }
    if (this.#closed) throw dirClosed();
    process.nextTick(callback, null, this.#entries[0] ?? null);
    this.#entries.shift();
  }

  closeSync() {
    if (this.#closed) throw dirClosed();
    this.#closed = true;
    this.#entries = [];
  }

  close(callback) {
    if (callback === undefined) {
      return new Promise((resolve) => {
        this.closeSync();
        resolve();
      });
    }
    process.nextTick(callback, this.#closed ? dirClosed() : null);
    if (!this.#closed) this.closeSync();
  }

  async *entries() {
    try {
      for (let entry = await this.read(); entry; entry = await this.read()) {
        yield entry;
      }
    } finally {
      await this.close();
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }

  [Symbol.dispose]() {
    if (!this.#closed) this.closeSync();
  }

  async [Symbol.asyncDispose]() {
    if (!this.#closed) await this.close();
  }
}

// What a Dir lists: the strict appRoot, or a directory of a place.
const dirEntries = (route, dirPath, options) => {
  if (route.kind === 'root') return readRoot(dirPath, options);
  const files = facadeOf(route);
  const stat = files.stat(route.key);
  if (!stat) throw fsError('ENOENT', 'opendir', dirPath);
  if (!stat.isDirectory()) throw fsError('ENOTDIR', 'opendir', dirPath);
  return files.readdir(route.key, options);
};

const statOf = (p, args, syscall) => {
  const route = readRoute(p, syscall);
  if (route === PASS) return PASS;
  const options = optionsOf(args);
  if (route.kind !== 'root') return facadeOf(route).stat(route.key, options);
  return statsOf(0, 0, { ...options, directory: true });
};

// --- Operation cores: (path, args) → result | PASS, or throw ---

const ops = {
  readFile(p, [options]) {
    const route = readRoute(p, 'open');
    if (route === PASS) return PASS;
    if (isDirectoryRoute(route)) throw fsError('EISDIR', 'read');
    return facadeOf(route).readFile(route.key, options);
  },

  stat(p, args) {
    return statOf(p, args, 'stat');
  },

  lstat(p, args) {
    return statOf(p, args, 'lstat');
  },

  access(p, [mode = fs.constants.F_OK]) {
    const filePath = pathOf(p);
    const route = readRoute(p, 'access');
    if (route === PASS) return PASS;
    const { W_OK, X_OK } = fs.constants;
    if (mode & X_OK) throw fsError('EACCES', 'access', filePath);
    if (mode & W_OK && (route.kind === 'root' || !facadeOf(route).writable)) {
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
    const route = readRoute(p, 'scandir', true);
    const opts = typeof options === 'string' ? { encoding: options } : options;
    if (route === PASS) {
      if (opts?.recursive) walkGuard(p, 'scandir');
      return PASS;
    }
    if (route.kind === 'file') throw fsError('ENOTDIR', 'scandir', pathOf(p));
    if (route.kind === 'root') return readRoot(pathOf(p), opts || {});
    return facadeOf(route).readdir(route.key, opts || {});
  },

  // A Dir over the same listing; `recursive` walks the whole subtree.
  opendir(p, [options]) {
    const route = readRoute(p, 'opendir', true);
    const opts =
      typeof options === 'string' ? { encoding: options } : { ...options };
    if (route === PASS) {
      if (opts.recursive) walkGuard(p, 'opendir');
      return PASS;
    }
    const dirPath = pathOf(p);
    const entries = dirEntries(route, dirPath, {
      withFileTypes: true,
      recursive: Boolean(opts.recursive),
      encoding: opts.encoding,
    });
    return new VfsDir(Buffer.isBuffer(p) ? p : dirPath, entries);
  },

  // Virtual entries have no file descriptor.
  open(p) {
    const route = readRoute(p, 'open');
    if (route === PASS) return PASS;
    throw fsError('ENOTSUP', 'open', pathOf(p), 'virtual file');
  },

  writeFile(p, [data, options], sync) {
    const route = mutationRoute(p, 'open', sync);
    if (route === PASS) return PASS;
    return facadeOf(route).writeFile(route.key, data, options);
  },

  appendFile(p, [data, options], sync) {
    const route = mutationRoute(p, 'open', sync);
    if (route === PASS) return PASS;
    return facadeOf(route).appendFile(route.key, data, options);
  },

  unlink(p, args, sync) {
    const route = mutationRoute(p, 'unlink', sync);
    if (route === PASS) return PASS;
    return facadeOf(route).unlink(route.key);
  },

  mkdir(p, [options], sync) {
    const route = mutationRoute(p, 'mkdir', sync);
    if (route === PASS) return PASS;
    return facadeOf(route).mkdir(route.key, options);
  },

  rm(p, [options], sync) {
    const route = mutationRoute(p, 'rm', sync);
    if (route === PASS) {
      if (options?.recursive) walkGuard(p, 'rm');
      return PASS;
    }
    return facadeOf(route).rm(route.key, options || {});
  },

  // Guarded, not implemented; the deprecated `recursive` walks like rm.
  rmdir(p, [options]) {
    guardMutation(p, 'rmdir');
    if (options?.recursive) walkGuard(p, 'rmdir');
    return PASS;
  },

  copyFile(src, [dest]) {
    return copyOf(src, dest, 'copyfile', false);
  },

  // A hard link is a second name for the raw disk file: a copy by another
  // means.
  link(src, [dest]) {
    return copyOf(src, dest, 'link', false);
  },

  cp(src, [dest, options]) {
    return copyOf(src, dest, 'cp', Boolean(options?.recursive));
  },

  rename(from, [to], sync) {
    const src = mutationRoute(from, 'rename', sync);
    const dst = mutationRoute(to, 'rename', sync);
    if (src === PASS && dst === PASS) {
      // Moving a tree that holds places carries them out of the routing.
      walkGuard(from, 'rename', pathOf(to) ?? undefined);
      return PASS;
    }
    if (src === PASS || dst === PASS || src.place !== dst.place) {
      throw fsError('EXDEV', 'rename', pathOf(from));
    }
    return facadeOf(src).rename(src.key, dst.key);
  },
};

// --- Variant generators ---

const isThenable = (value) => typeof value?.then === 'function';

const syncVariant = (op, original) =>
  function (p, ...args) {
    const result = op(p, args, true);
    return result === PASS ? original.call(this, p, ...args) : result;
  };

const callbackVariant = (op, original) =>
  function (p, ...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    let result;
    try {
      result = op(p, args, false);
    } catch (err) {
      return void process.nextTick(callback, err);
    }
    if (result === PASS) return original.call(this, p, ...args, callback);
    if (isThenable(result)) {
      return void result.then(
        (value) => callback(null, value),
        (err) => callback(err),
      );
    }
    return void process.nextTick(callback, null, result);
  };

const promiseVariant = (op, original) =>
  async function (p, ...args) {
    const result = op(p, args, false);
    return result === PASS ? original.call(this, p, ...args) : result;
  };

const existsSync = (original) =>
  function (p) {
    const filePath = pathOf(p);
    if (filePath === null) return original.call(this, p);
    const { kind } = kernel.routeRead(filePath);
    if (kind === 'passthrough' || kind === 'disk') {
      return original.call(this, p);
    }
    return kind !== 'deny';
  };

// fs.createReadStream never throws: errors are emitted on the stream.
// node:fs callers never release a lease, so their chunks are always owned
// copies and the pin ends with the stream.
const createReadStream = (original) =>
  function (p, options) {
    let route;
    try {
      route = readRoute(p, 'open');
      if (route === PASS) return original.call(this, p, options);
      if (isDirectoryRoute(route)) throw fsError('EISDIR', 'read');
      const opts =
        typeof options === 'string' ? { encoding: options } : { ...options };
      opts.zeroCopy = false;
      return facadeOf(route).createReadStream(route.key, opts);
    } catch (err) {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(err));
      return stream;
    }
  };

// --- watch ---

// A managed path that is not a directory: a published entry, or a path of
// the disk territory that is not one (a missing path fails natively).
const isFileRoute = (route) => {
  if (route.kind === 'file') return true;
  if (route.kind !== 'disk') return false;
  return !facadeOf(route).stat(route.key)?.isDirectory();
};

// watch reports every entry of the directory it watches — names a place may
// hide — so a managed directory is recognized but unsupported, and so is a
// recursive watch of managed territory or of a tree that holds places. A
// single managed file keeps a native watcher.
const watchOp = (p, [options]) => {
  const recursive = Boolean(options?.recursive);
  const route = readRoute(p, 'watch', true);
  if (route === PASS) {
    if (recursive) walkGuard(p, 'watch');
    return PASS;
  }
  if (!recursive && isFileRoute(route)) return PASS;
  throw fsError('ENOTSUP', 'watch', pathOf(p), 'managed territory');
};

// An async iterator whose first step fails with `err`, then is done.
const failedIterator = (err) => {
  let failed = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (failed) return Promise.resolve({ value: undefined, done: true });
      failed = true;
      return Promise.reject(err);
    },
    return(value) {
      failed = true;
      return Promise.resolve({ value, done: true });
    },
  };
};

// fs.promises.watch returns an async iterator: as in node:fs, a refusal
// surfaces when it is iterated.
const watchPromises = (original) =>
  function (p, ...args) {
    try {
      watchOp(p, args);
    } catch (err) {
      return failedIterator(err);
    }
    return original.call(this, p, ...args);
  };

// --- Guards for APIs the patch does not implement ---

// Every path argument is routed and its decision enforced; the call itself
// continues to the original node:fs — except on the strict appRoot, which
// only this patch can present.
const guardOp = (syscall, roles) => (p, args) => {
  const paths = [p, ...args];
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] !== 'read') {
      guardMutation(paths[i], syscall);
      continue;
    }
    const route = readRoute(paths[i], syscall);
    if (route !== PASS && route.kind === 'root') {
      throw fsError('EACCES', syscall, pathOf(paths[i]));
    }
  }
  return PASS;
};

// glob takes patterns, not paths: its results are filtered instead. A
// string result is relative to the `cwd` option; a Dirent's parent path
// already includes it.
const allowedIn = (options) => {
  const cwd = (options?.cwd && pathOf(options.cwd)) || '';
  return (entry) => {
    // A glob still running when the patch is uninstalled ends as node:fs.
    if (kernel === null) return true;
    const filePath =
      typeof entry === 'string'
        ? path.resolve(cwd, entry)
        : path.resolve(entry.parentPath || entry.path || '', entry.name);
    return kernel.routeRead(filePath).kind !== 'deny';
  };
};

const globSync = (original) =>
  function (...args) {
    return original.apply(this, args).filter(allowedIn(args[1]));
  };

const globCallback = (original) =>
  function (...args) {
    const callback = args.pop();
    const allowed = allowedIn(args[1]);
    return original.call(this, ...args, (err, matches) => {
      if (err) return void callback(err);
      callback(null, matches.filter(allowed));
    });
  };

const globPromises = (original) =>
  async function* (...args) {
    const allowed = allowedIn(args[1]);
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
  ['opendir', ops.opendir],
  ['open', ops.open],
  ['writeFile', ops.writeFile],
  ['appendFile', ops.appendFile],
  ['unlink', ops.unlink],
  ['mkdir', ops.mkdir],
  ['rm', ops.rm],
  ['rename', ops.rename],
  ['copyFile', ops.copyFile],
  ['cp', ops.cp],
  ['rmdir', ops.rmdir],
  ['link', ops.link],
];

// [name, syscall, roles per path argument]
const GUARDS = [
  ['readlink', 'readlink', ['read']],
  ['statfs', 'statfs', ['read']],
  ['truncate', 'open', ['mutate']],
  ['utimes', 'utime', ['mutate']],
  ['lutimes', 'lutime', ['mutate']],
  ['chmod', 'chmod', ['mutate']],
  ['lchmod', 'chmod', ['mutate']],
  ['chown', 'chown', ['mutate']],
  ['lchown', 'chown', ['mutate']],
  ['symlink', 'symlink', ['read', 'mutate']],
];

// A reference taken while the patch is installed outlives uninstall() — a
// module's `const { readFile } = require('node:fs')`, or the functions glob
// keeps from its first use. With no kernel installed it is the original
// function again: same receiver and arguments, so every callback, promise
// and overload keeps node:fs behavior. Each install() patches the restored
// originals, so wrappers never stack.
const patch = (target, name, make) => {
  const original = target[name];
  installed.push({ target, name, original });
  const routed = make(original);
  const patched = function (...args) {
    const call = kernel === null ? original : routed;
    return call.apply(this, args);
  };
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
  // Watchers hand back their result synchronously (a watcher, or an async
  // iterator), so the callback and promise variants do not apply.
  patch(fs, 'watch', (orig) => syncVariant(watchOp, orig));
  patch(fs.promises, 'watch', watchPromises);
  const watchFile = guardOp('watch', ['read']);
  patch(fs, 'watchFile', (orig) => syncVariant(watchFile, orig));
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
