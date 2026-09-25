'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VfsConfig } = require('../lib/config.js');
const { VfsKernel } = require('../lib/kernel.js');

// Shared test helpers: temp trees, quiet kernels, small configs.

const quiet = { log() {}, warn() {}, error() {}, debug() {} };

const tmpDir = (prefix = 'vfs') =>
  fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

// writeTree(root, { 'public/index.html': '<h1>', 'lib/a.js': '...' })
const writeTree = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
};

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SMALL_MEMORY = {
  limit: '4 mib',
  segmentSize: '256 kib',
  maxFileSize: '64 kib',
};

const config = (places, defaults = {}) =>
  new VfsConfig({ defaults: { memory: SMALL_MEMORY, ...defaults }, places });

const kernel = async (root, places, defaults = {}, options = {}) => {
  const k = new VfsKernel(config(places, defaults), {
    appRoot: root,
    console: quiet,
    ...options,
  });
  await k.initialize();
  return k;
};

// Collect a Readable into one Buffer.
const drain = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// Wait until `predicate()` is true or `ms` elapsed.
const until = async (predicate, ms = 3000, step = 25) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(step);
  }
  return predicate();
};

// A worker stand-in on a real link(), in this thread: records every message
// the main kernel posts and, unless `ack: false`, ACKs each vfs-update like
// an attached worker that reads nothing. `id` is its link id on main.
const tap = (k, { ack = true } = {}) => {
  const { vfs } = k.link();
  const id = [...k.links.keys()].at(-1);
  const messages = [];
  vfs.port.on('message', (msg) => {
    messages.push(msg);
    if (ack && msg.name === 'vfs-update') {
      vfs.port.postMessage({ name: 'vfs-ack', updateId: msg.updateId });
    }
  });
  vfs.port.unref();
  const updates = () => messages.filter((m) => m.name === 'vfs-update');
  return { id, port: vfs.port, messages, updates };
};

// A worker kernel attached to a real link(), in this thread: it projects the
// snapshot, applies deltas and ACKs them through the port exactly like
// attach(), without spawning a thread.
const worker = (k, options = {}) => {
  const { vfs } = k.link();
  const id = [...k.links.keys()].at(-1);
  const w = VfsKernel.fromSnapshot(vfs.snapshot, new VfsConfig(vfs.config), {
    appRoot: vfs.appRoot,
    console: quiet,
    port: vfs.port,
    ...options,
  });
  return { id, kernel: w, port: vfs.port, main: k.links.get(id) };
};

// Resolves once `port` has delivered its next message to every listener
// registered before this call (the kernel's own come first).
const nextMessage = (port) =>
  new Promise((resolve) => port.once('message', resolve));

module.exports = {
  quiet,
  tmpDir,
  writeTree,
  rm,
  sleep,
  config,
  kernel,
  drain,
  until,
  tap,
  worker,
  nextMessage,
  SMALL_MEMORY,
};
