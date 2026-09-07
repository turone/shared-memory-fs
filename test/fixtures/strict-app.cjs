'use strict';

// Entry point for the strict bootstrap test. It lives OUTSIDE the sandbox
// root (test/fixtures/sandbox) on purpose: with strict: true appRoot is the
// boundary, so a trusted entry point and its package metadata must sit
// outside it or in an explicit node-default / disk place.

const fs = require('node:fs');
const path = require('node:path');
const { kernel } = require('shared-memory-fs');

const root = process.cwd();
const text = kernel.fs('assets').readFile('/hello.txt', 'utf8').trim();

const denied = (fn) => {
  try {
    fn();
    return 'ALLOWED';
  } catch (err) {
    return err.code;
  }
};

const results = [
  denied(() => fs.readFileSync(path.join(root, 'secret', 's.txt'))),
  denied(() => fs.readdirSync(path.join(root, 'secret'))),
  denied(() => fs.readFileSync(path.join(root, 'root-level.txt'))),
];

console.log(`OK strict read=${text} denied=${results.join(',')}`);
