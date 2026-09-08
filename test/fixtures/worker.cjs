'use strict';

// Worker for the bootstrap process test: attaches to the parent's link and
// reports what it can read from shared memory.
const { parentPort } = require('node:worker_threads');
const { attach } = require('shared-memory-fs');

const kernel = attach();
parentPort.postMessage(kernel.fs('static').readFile('/hello.txt', 'utf8').trim());
