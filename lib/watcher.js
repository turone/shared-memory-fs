'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { watch, readdirSync, lstatSync, realpathSync } = require('node:fs');
const { stat } = require('node:fs/promises');

// Recursive fs.watch is native on Windows and macOS. Elsewhere Node builds
// it in JavaScript over the public node:fs, which fs-patch routes: it would
// list the VFS instead of the disk, and a refusal would reach it as an
// uncaught exception. There the watcher walks the tree itself — one native
// watch per directory, over the functions captured here.
const NATIVE_RECURSIVE =
  process.platform === 'win32' || process.platform === 'darwin';

// One 8.3 alias segment, anchored to path separators: TEMP~1, RUNNER~1,
// PROGRA~1, LONGNA~12.txt. Backslash only — win32 path.resolve emits no '/'.
const ALIAS = /(?:^|\\)[^\\]{1,8}~\d{1,4}(?:\.[^\\]{1,3})?(?=\\|$)/;

// WORKAROUND (nodejs/node#63638). libuv's recursive fs.watch on Windows runs
// GetLongPathNameW over each event path and asserts that the result still
// starts with the watched directory string; a watched path carrying an 8.3
// alias fails that check and aborts the process. Regression from Node 24.16.0,
// reproduced here on 24.17.0 and 24.20.0; fixed upstream by libuv/libuv#5152
// and backported in nodejs/node#65118. fs.realpathSync keeps 8.3 segments,
// realpathSync.native (GetFinalPathNameByHandleW) expands them, so ask the OS
// rather than guess: the answer is the same directory, whatever its depth,
// drive or UNC prefix. Costs one syscall per watched root, only when an alias
// is present, never on the event path. Delete once the engines floor is past
// the last affected release of every supported line.
const watchPath = (root) => {
  const resolved = path.resolve(root);
  if (process.platform !== 'win32' || !ALIAS.test(resolved)) return resolved;
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

// DirWatcher — recursive directory watcher that batches raw fs.watch events
// into debounced epochs: after `timeout` ms of silence it emits
//   'epoch'  Map<absPath, 'change' | 'scan' | 'delete'>
// 'change' is a file, 'scan' a directory whose subtree needs rescanning,
// 'delete' a path that no longer exists. Watcher errors surface as 'error'.
// `walk` (by default where recursion is not native) watches each directory
// of the tree on its own: an event that shows a new one adds it, a deletion
// drops the watchers under the path; a link to a directory is not followed,
// as the scanner never traverses one.

class DirWatcher extends EventEmitter {
  #closed = false;
  #walk;

  constructor({ timeout = 1000, walk = !NATIVE_RECURSIVE } = {}) {
    super();
    this.timeout = timeout;
    this.#walk = walk;
    this.watchers = new Map(); // watched path → fs.FSWatcher
    this.queue = new Map(); // absPath → event
    this.timer = null;
  }

  watch(root) {
    if (this.#closed || this.watchers.has(root)) return;
    if (this.#walk) return void this.#watchTree(root);
    // Events are reported under `root`, so the rewrite stays invisible to the
    // kernel: place keys keep the namespace the caller configured.
    this.#open(root, watchPath(root), { recursive: true });
  }

  // A native watcher that reports its events under `dir`; false when there
  // is none (a missing directory is reported, but for a walked one that
  // vanished meanwhile, whose parent's event reports it).
  #open(dir, target, options, quiet = false) {
    let watcher;
    try {
      watcher = watch(target, options, (event, filename) => {
        this.post(filename ? path.join(dir, filename) : dir);
      });
    } catch (err) {
      if (!quiet || err.code !== 'ENOENT') this.emit('error', err);
      return false;
    }
    watcher.on('error', (err) => this.emit('error', err));
    this.watchers.set(dir, watcher);
    return true;
  }

  // `dir` and every directory under it; `quiet` below the root.
  #watchTree(dir, quiet = false) {
    if (this.#closed || this.watchers.has(dir)) return;
    if (!this.#open(dir, dir, {}, quiet)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Gone meanwhile: the parent's event reports it.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.#watchTree(path.join(dir, entry.name), true);
      }
    }
  }

  // The watchers of a path gone and of everything under it.
  #unwatch(target) {
    const below = target + path.sep;
    for (const [watched, watcher] of this.watchers) {
      if (watched === target || watched.startsWith(below)) {
        watcher.close();
        this.watchers.delete(watched);
      }
    }
  }

  // One raw event: its path is stat'ed, then queued as a change, a rescan or
  // a deletion. Settles once it is queued (or dropped). A walked tree
  // follows it: a new directory is watched, a deleted path is not.
  post(target) {
    return stat(target).then(
      (stats) => {
        const directory = stats.isDirectory();
        if (directory && this.#walk && !this.#closed) {
          const own = lstatSync(target, { throwIfNoEntry: false });
          if (own?.isDirectory()) this.#watchTree(target, true);
        }
        this.#enqueue(target, directory ? 'scan' : 'change');
      },
      (err) => {
        if (err.code !== 'ENOENT') {
          if (!this.#closed) this.emit('error', err);
          return;
        }
        if (this.#walk) this.#unwatch(target);
        this.#enqueue(target, 'delete');
      },
    );
  }

  // A stat that lands after close() queues nothing: no epoch, and no timer
  // that would hold the process open.
  #enqueue(target, event) {
    if (this.#closed) return;
    this.queue.set(target, event);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.timeout);
  }

  flush() {
    this.timer = null;
    if (this.queue.size === 0) return;
    const epoch = this.queue;
    this.queue = new Map();
    this.emit('epoch', epoch);
  }

  close() {
    this.#closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.queue.clear();
  }
}

module.exports = { DirWatcher, watchPath };
