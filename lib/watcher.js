'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { watch, realpathSync } = require('node:fs');
const { stat } = require('node:fs/promises');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Watch a long path. Node's realpath on Windows keeps 8.3 segments
// (C:\Users\RUNNER~1\...); libuv then GetLongPathNameW's the child and
// asserts when the prefixes no longer match (nodejs/node#63638).
const longPath = (root) => {
  const resolved = path.resolve(root);
  if (process.platform !== 'win32') {
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
  const home = os.homedir();
  if (!home || /~[0-9]/.test(home)) return resolved;
  const re = new RegExp(
    `^(${escapeRe(path.dirname(home))}\\\\)[^\\\\]*~[0-9][^\\\\]*`,
    'i',
  );
  return resolved.replace(re, `$1${path.basename(home)}`);
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
