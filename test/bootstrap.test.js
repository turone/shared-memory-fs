'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Bootstrap files install global hooks that pollute the test runner; we
// must run them in dedicated child processes.

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const PRELOAD = path.join(REPO, 'lib', 'bootstrap', 'preload.cjs');
const REGISTER_URL = pathToFileURL(
  path.join(REPO, 'lib', 'bootstrap', 'register.mjs'),
).href;
const CONFIG = path.join(FIXTURES, 'vfs.config.cjs');

const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: FIXTURES,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
};

describe('bootstrap: preload.cjs', () => {
  it('initializes kernel, installs fs-patch, serves files via patched fs', () => {
    const app = path.join(FIXTURES, 'preload-app.cjs');
    const r = run(['--require', PRELOAD, app, '--', `--vfs.config=${CONFIG}`]);
    if (r.code !== 0) {
      console.error('STDOUT:', r.stdout);
      console.error('STDERR:', r.stderr);
    }
    assert.equal(r.code, 0, 'exit code');
    assert.match(
      r.stdout,
      /OK places=1 entries=1 read=hello-from-bootstrap-fixture/,
    );
  });

  it('reports preload-ready message on stdout', () => {
    const app = path.join(FIXTURES, 'preload-app.cjs');
    const r = run(['--require', PRELOAD, app, '--', `--vfs.config=${CONFIG}`]);
    assert.match(r.stdout, /\[vfs\] preload ready/);
  });

  it('exits non-zero when config path is missing', () => {
    const app = path.join(FIXTURES, 'preload-app.cjs');
    const bogus = path.join(FIXTURES, 'no-such.cjs');
    const r = run(['--require', PRELOAD, app, '--', `--vfs.config=${bogus}`]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /failed to load config/);
  });
});

describe('bootstrap: register.mjs', () => {
  it('initializes kernel before app code runs', () => {
    const app = path.join(FIXTURES, 'register-app.mjs');
    const r = run([
      '--import',
      REGISTER_URL,
      app,
      '--',
      `--vfs.config=${CONFIG}`,
    ]);
    if (r.code !== 0) {
      console.error('STDOUT:', r.stdout);
      console.error('STDERR:', r.stderr);
    }
    assert.equal(r.code, 0, 'exit code');
    assert.match(
      r.stdout,
      /OK places=1 entries=1 read=hello-from-bootstrap-fixture/,
    );
    assert.match(r.stdout, /\[vfs\] ready, 1 entries cached/);
  });
});
