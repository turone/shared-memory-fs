'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const {
  watch,
  realpathSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} = require('node:fs');
const { stat } = require('node:fs/promises');

// Expand 8.3 segments. Directory realpath on Windows often keeps RUNNER~1;
// a child's realpath does not, and that is the prefix libuv later compares.
const longPath = (root) => {
  const resolved = path.resolve(root);
  try {
    const names = readdirSync(resolved);
    if (names.length > 0) {
      return path.dirname(realpathSync(path.join(resolved, names[0])));
    }
  } catch {
    // Fall through to a probe file when the directory is empty or unreadable.
  }
  const probe = path.join(resolved, '.vfs-watch');
  writeFileSync(probe, '');
  try {
    return path.dirname(realpathSync(probe));
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // Best-effort cleanup of the probe.
    }
  }
};

// DirWatcher — recursive directory watcher that batches raw fs.watch events
// into debounced epochs: after `timeout` ms of silence it emits
//   'epoch'  Map<absPath, 'change' | 'scan' | 'delete'>
// 'change' is a file, 'scan' a directory whose subtree needs rescanning,
// 'delete' a path that no longer exists. Watcher errors surface as 'error'.

class DirWatcher extends EventEmitter {
  constructor({ timeout = 1000 } = {}) {
    super();
    this.timeout = timeout;
    this.watchers = new Map(); // root → fs.FSWatcher
    this.queue = new Map(); // absPath → event
    this.timer = null;
  }

  watch(root) {
    if (this.watchers.has(root)) return;
    // Watch a long path. On Windows, os.tmpdir() is often an 8.3 name
    // (C:\Users\RUNNER~1\...); Node's directory realpath may keep that
    // form, and libuv in Node 24 then asserts when GetLongPathNameW of a
    // child no longer shares the prefix (nodejs/node#63638).
    let target;
    try {
      target = longPath(root);
    } catch (err) {
      return void this.emit('error', err);
    }
    let watcher;
    try {
      watcher = watch(target, { recursive: true }, (event, filename) => {
        this.#post(filename ? path.join(root, filename) : root);
      });
    } catch (err) {
      return void this.emit('error', err);
    }
    watcher.on('error', (err) => this.emit('error', err));
    this.watchers.set(root, watcher);
  }

  #post(target) {
    stat(target).then(
      (stats) => this.#enqueue(target, stats.isDirectory() ? 'scan' : 'change'),
      (err) => {
        if (err.code === 'ENOENT') this.#enqueue(target, 'delete');
        else this.emit('error', err);
      },
    );
  }

  #enqueue(target, event) {
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.queue.clear();
  }
}

module.exports = { DirWatcher, longPath };
