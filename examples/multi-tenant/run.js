'use strict';

// multi-tenant — two memory-backed tenant mounts under one appRoot, plus a
// global `strict: true` that turns appRoot into a place-only whitelist.
// Demonstrates:
//   1. Each tenant has its own writable in-memory namespace.
//   2. strict mode rejects any path under appRoot that no place owns.
//   3. Real cross-tenant isolation requires worker_threads (one place per
//      worker) — same-process places are accessible to anyone holding the
//      kernel; this example keeps everything on the main thread to stay short.
//
// Run:
//   node examples/multi-tenant/run.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { VfsConfig, VFSKernel } = require('../..');
const fsPatch = require('../../lib/adapters/fs-patch.js');
const requireHook = require('../../lib/adapters/require-hook.js');

const APP_ROOT = __dirname;

const config = new VfsConfig({
  defaults: {
    memory: { limit: '512 kib', segmentSize: '64 kib', maxFileSize: '8 kib' },
    hooks: { fs: false, require: false, import: false },
    strict: true,
  },
  places: {
    'tenant-a': {
      domains: ['fs', 'require'],
      match: { dir: 'tenant-a' },
      provider: 'memory',
    },
    'tenant-b': {
      domains: ['fs', 'require'],
      match: { dir: 'tenant-b' },
      provider: 'memory',
    },
  },
});

const kernel = new VFSKernel(config, { appRoot: APP_ROOT });

const tenantCode = (name) => `'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = function probe() {
  const own = fs.readFileSync(path.join(__dirname, 'data.txt'), 'utf8');
  console.log('  [${name}] own data.txt:', own.trim());
};
`;

(async () => {
  await kernel.initialize();
  fsPatch.install(kernel);
  requireHook.install(kernel);

  const a = kernel.getPlace('tenant-a');
  const b = kernel.getPlace('tenant-b');

  a.writeFile('/data.txt', Buffer.from('tenant-a secret'));
  a.writeFile('/index.js', Buffer.from(tenantCode('A')));
  b.writeFile('/data.txt', Buffer.from('tenant-b secret'));
  b.writeFile('/index.js', Buffer.from(tenantCode('B')));

  console.log('-- 1. each tenant runs and reads its own file --');
  require(path.join(APP_ROOT, 'tenant-a', 'index.js'))();
  require(path.join(APP_ROOT, 'tenant-b', 'index.js'))();

  console.log('-- 2. strict: path under appRoot but outside any place --');
  const stray = path.join(APP_ROOT, 'config.local.json');
  try {
    fs.readFileSync(stray);
    console.log('  read stray (UNEXPECTED — strict not enforced)');
  } catch (err) {
    console.log('  read stray ->', err.code, '(strict mode working)');
  }

  console.log('-- 3. paths OUTSIDE appRoot are unaffected by strict --');
  try {
    fs.statSync(os.tmpdir());
    console.log('  stat(os.tmpdir()) -> ok (passthrough)');
  } catch (err) {
    console.log('  stat(os.tmpdir()) ->', err.code);
  }

  console.log(
    '\nNote: real cross-tenant isolation needs worker_threads. ' +
      'Each worker should construct a kernel with only its own place attached.',
  );

  fsPatch.uninstall();
  requireHook.uninstall();
  kernel.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
