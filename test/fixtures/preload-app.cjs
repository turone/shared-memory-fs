'use strict';

// Entry script for preload (CJS) bootstrap test. Driven by:
//   node --require <repo>/lib/bootstrap/preload.cjs \
//        <repo>/test/fixtures/preload-app.cjs \
//        -- --vfs.config=<repo>/test/fixtures/vfs.config.cjs
//
// preload.cjs creates the kernel synchronously but does NOT initialize it.
// We initialize here, then read a file via patched fs to prove fs-patch was
// installed. Output is parsed by the test runner.

const fs = require('node:fs');
const path = require('node:path');

const VFS_SYMBOL = Symbol.for('shared-memory-fs');
const kernel = process[VFS_SYMBOL];
if (!kernel) {
  console.error('FAIL: kernel not in process global');
  process.exit(1);
}

(async () => {
  await kernel.initialize();
  const places = kernel.getPlaces();
  let total = 0;
  for (const p of places) total += p.files.size;
  const filePath = path.join(process.cwd(), 'static', 'hello.txt');
  const data = fs.readFileSync(filePath, 'utf8').trim();
  console.log(`OK places=${places.length} entries=${total} read=${data}`);
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
