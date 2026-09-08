'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { watch, realpathSync } = require('node:fs');
const { stat } = require('node:fs/promises');

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
    // Events are reported under `root`, so the rewrite stays invisible to the
    // kernel: place keys keep the namespace the caller configured.
    const target = watchPath(root);
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

module.exports = { DirWatcher, watchPath };
