'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The bootstrap installs process-wide hooks, so it runs in child processes.

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const REGISTER = pathToFileURL(
  path.join(REPO, 'lib', 'bootstrap', 'register.mjs'),
).href;

const runIn = (cwd, entry, ...vfsArgs) => {
  const r = spawnSync(
    process.execPath,
    ['--import', REGISTER, entry, '--', ...vfsArgs],
    { cwd, encoding: 'utf8', timeout: 30000 },
  );
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

const run = (entry, ...vfsArgs) => runIn(FIXTURES, entry, ...vfsArgs);

describe('bootstrap: --import shared-memory-fs/register', () => {
  it('ESM entry: kernel ready before entry, static imports served from VFS, worker attaches', () => {
    const r = run('app.mjs', '--vfs.config=vfs.config.cjs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /OK esm read=hello-from-bootstrap-fixture facade=hello-from-bootstrap-fixture greet=hello vfs cjs=42 worker=hello-from-bootstrap-fixture/,
    );
    assert.equal(r.stderr, '');
  });

  it('CommonJS entry: require() served from VFS, memory modules requirable', () => {
    const r = run('app.cjs', '--vfs.config=vfs.config.cjs');
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /OK cjs read=hello-from-bootstrap-fixture cjs=42 generated=generated/,
    );
  });

  it('CLI overrides reach the config', () => {
    const r = run(
      'app.cjs',
      '--vfs.config=vfs.config.cjs',
      '--vfs.defaults.watchTimeout=25',
    );
    assert.equal(r.code, 0, r.stderr);
  });

  // With strict: true appRoot is the sandbox boundary, so the entry point and
  // its package metadata live outside it — here the sandbox root holds only
  // place directories and the entry is one level up.
  it('strict: entry point outside appRoot runs; unmanaged paths are denied', () => {
    const r = runIn(
      path.join(FIXTURES, 'sandbox'),
      path.join(FIXTURES, 'strict-app.cjs'),
      `--vfs.config=${path.join(FIXTURES, 'vfs.strict.cjs')}`,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stdout,
      /OK strict read=hello-from-strict-sandbox denied=EACCES,EACCES,EACCES/,
    );
  });

  it('a missing config file aborts startup before the entry runs', () => {
    const r = run('app.cjs', '--vfs.config=no-such.cjs');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /failed to load config/);
    assert.doesNotMatch(r.stdout, /OK/);
  });

  it('an invalid config aborts startup before the entry runs', () => {
    const r = run('app.cjs', '--vfs.config=vfs.bad.cjs');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /\[vfs config\]/);
    assert.doesNotMatch(r.stdout, /OK/);
  });

  it('attach() outside a worker explains itself', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', "require('./index.js').attach()"],
      { cwd: REPO, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /attach\(\) is for worker threads/);
  });
});
