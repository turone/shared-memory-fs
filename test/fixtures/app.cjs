'use strict';

// CommonJS entry for the bootstrap process test. Run as:
//   node --import <repo>/lib/bootstrap/register.mjs app.cjs -- --vfs.config=vfs.config.cjs

const fs = require('node:fs');
const path = require('node:path');
const { kernel } = require('shared-memory-fs');

if (!kernel || kernel.state !== 'ready') {
  console.error('FAIL: kernel not ready before entry');
  process.exit(1);
}

const text = fs.readFileSync(path.join(process.cwd(), 'static', 'hello.txt'), 'utf8').trim();
const cjs = require('./modules/cjs.cjs');
const scratch = kernel.fs('scratch');
scratch.writeFile('/gen.js', 'module.exports = "generated";');
const generated = require(path.join(process.cwd(), 'scratch', 'gen.js'));

console.log(`OK cjs read=${text} cjs=${cjs.answer} generated=${generated}`);
