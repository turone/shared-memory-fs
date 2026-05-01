// Entry script for register (ESM) bootstrap test. Driven by:
//   node --import <repo>/lib/bootstrap/register.mjs \
//        <repo>/test/fixtures/register-app.mjs \
//        -- --vfs.config=<repo>/test/fixtures/vfs.config.cjs
//
// register.mjs initializes the kernel and installs hooks before this file
// runs (top-level await in the loader). We just verify the result.

import fs from 'node:fs';
import path from 'node:path';

const VFS_SYMBOL = Symbol.for('shared-memory-fs');
const kernel = process[VFS_SYMBOL];
if (!kernel) {
  console.error('FAIL: kernel not in process global');
  process.exit(1);
}

const places = kernel.getPlaces();
let total = 0;
for (const p of places) total += p.files.size;
const filePath = path.join(process.cwd(), 'static', 'hello.txt');
const data = fs.readFileSync(filePath, 'utf8').trim();
console.log(`OK places=${places.length} entries=${total} read=${data}`);
