'use strict';

const { isMainThread, workerData } = require('node:worker_threads');
const { VfsConfig } = require('../config.js');
const { VfsKernel } = require('../kernel.js');
const fsPatch = require('../adapters/fs-patch.js');
const moduleHook = require('../adapters/module-hook.js');

// attach — worker-side counterpart of `kernel.link()`. Preload flags do not
// reach worker threads, so a worker calls this itself, first thing:
//
//   const { attach } = require('shared-memory-fs');
//   const kernel = attach();          // reads workerData.vfs
//
// Rebuilds a read-only projection over the shared segments, installs the
// hooks the config asks for, applies deltas from the link port and ACKs
// them, and publishes the kernel as `VfsKernel.current`.

const installHooks = (kernel) => {
  const { hooks } = kernel.config.global;
  if (hooks.fs) fsPatch.install(kernel);
  if (hooks.module) moduleHook.install(kernel);
};

const attach = (link = workerData?.vfs) => {
  if (VfsKernel.current) return VfsKernel.current;
  if (!link) {
    throw new Error(
      isMainThread
        ? '[vfs] attach() is for worker threads; use --import shared-memory-fs/register'
        : '[vfs] attach(): no link — pass kernel.link() as workerData.vfs',
    );
  }
  const config = new VfsConfig(link.config);
  const kernel = VfsKernel.fromSnapshot(link.snapshot, config, {
    appRoot: link.appRoot,
  });
  link.port.on('message', (msg) => {
    if (msg?.name !== 'vfs-update') return;
    kernel.handleDelta(msg);
    link.port.postMessage({ name: 'ack-update', updateId: msg.updateId });
  });
  link.port.unref();
  installHooks(kernel);
  VfsKernel.current = kernel;
  return kernel;
};

module.exports = { attach, installHooks };
