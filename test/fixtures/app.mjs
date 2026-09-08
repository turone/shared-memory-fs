// ESM entry for the bootstrap process test. Run as:
//   node --import <repo>/lib/bootstrap/register.mjs app.mjs -- --vfs.config=vfs.config.cjs
// The kernel is ready before this file is evaluated: static imports below
// already go through the VFS module hook.

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import vfs from 'shared-memory-fs';
import { greet } from './modules/greet.mjs';
import cjs from './modules/cjs.cjs';

const { kernel } = vfs;
if (!kernel || kernel.state !== 'ready') {
  console.error('FAIL: kernel not ready before entry');
  process.exit(1);
}

const text = fs.readFileSync(path.join(process.cwd(), 'static', 'hello.txt'), 'utf8').trim();
const viaFacade = kernel.fs('static').readFile('/hello.txt', 'utf8').trim();

// A worker attaches to the shared segments and reads the same bytes.
const link = kernel.link();
const worker = new Worker(new URL('./worker.cjs', import.meta.url), {
  workerData: { vfs: link.vfs },
  transferList: link.transferList,
});
const fromWorker = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});

console.log(`OK esm read=${text} facade=${viaFacade} greet=${greet('vfs')} cjs=${cjs.answer} worker=${fromWorker}`);
