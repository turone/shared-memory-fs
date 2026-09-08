'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const httpRequest = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: chunks.join(''),
        });
      });
    });

    req.setTimeout(2000, () => {
      req.destroy(new Error(`timeout waiting for ${url}`));
    });
    req.on('error', reject);
  });

const waitForUrl = async (url, predicate, timeoutMs = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await httpRequest(url);
      if (predicate(res)) return res;
    } catch {
      // Intentionally retry until the server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
};

const waitForChildReady = async (child, timeoutMs = 20000) => {
  const started = Date.now();
  const chunks = [];

  const onData = (chunk) => chunks.push(String(chunk));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      const output = chunks.join('');
      throw new Error(
        `child exited early with code ${child.exitCode}\n${output}`,
      );
    }

    const output = chunks.join('');
    const match =
      output.match(/http:\/\/127\.0\.0\.1:(\d+)/i) ||
      output.match(/http:\/\/localhost:(\d+)/i);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const output = chunks.join('');
  throw new Error(`timeout waiting for listening output\n${output}`);
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
};

const startExample = async (script, env = {}) => {
  const child = spawn(process.execPath, [script], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const port = await waitForChildReady(child);
    return { child, port };
  } catch (err) {
    await stopChild(child);
    throw err;
  }
};

describe('examples smoke', () => {
  it('hot-reload-routes server swaps handlers at runtime', async () => {
    const { child, port } = await startExample(
      'examples/hot-reload-routes/server.js',
      {
        PORT: '0',
      },
    );

    try {
      const initial = await waitForUrl(
        `http://127.0.0.1:${port}/hello`,
        (res) =>
          res.statusCode === 200 &&
          res.body === 'hello from hot-reloaded route\n',
      );
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.body, 'hello from hot-reloaded route\n');

      const time = await waitForUrl(
        `http://127.0.0.1:${port}/time`,
        (res) => res.statusCode === 200 && /^server time: /.test(res.body),
        15000,
      );
      assert.equal(time.statusCode, 200);
      assert.match(time.body, /^server time: /);

      const echo = await waitForUrl(
        `http://127.0.0.1:${port}/echo?x=1&y=2`,
        (res) => res.statusCode === 200 && res.body === '{"x":"1","y":"2"}\n',
      );
      assert.equal(echo.statusCode, 200);
      assert.equal(echo.body, '{"x":"1","y":"2"}\n');

      const updated = await waitForUrl(
        `http://127.0.0.1:${port}/hello`,
        (res) => res.statusCode === 200 && /^updated hello! /.test(res.body),
        15000,
      );
      assert.equal(updated.statusCode, 200);
      assert.notEqual(updated.body, initial.body);
      assert.match(updated.body, /^updated hello! /);
    } finally {
      await stopChild(child);
    }
  });

  it('multi-tenant demo keeps each tenant isolated and strict appRoot denies unmanaged paths', async () => {
    const child = spawn(process.execPath, ['examples/multi-tenant/run.js'], {
      cwd: REPO,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

    try {
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('multi-tenant demo timed out')),
          20000,
        );
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      assert.equal(exitCode, 0, stderr || stdout);
      assert.equal(stderr, '');
      assert.match(stdout, /\[A\] own data\.txt: tenant-a secret/);
      assert.match(stdout, /\[B\] own data\.txt: tenant-b secret/);
      assert.match(stdout, /read config\.local\.json -> EACCES/);
      assert.match(stdout, /read README\.md -> EACCES/);
      assert.match(stdout, /stat\(os\.tmpdir\(\)\) -> ok \(passthrough\)/);
    } finally {
      await stopChild(child);
    }
  });

  it('sea-static example serves sab assets with expected content and headers', async () => {
    const { child, port } = await startExample(
      'examples/sea-static/server.js',
      {
        PORT: '0',
      },
    );

    try {
      const root = await waitForUrl(
        `http://127.0.0.1:${port}/`,
        (res) => res.statusCode === 200 && /Hello from VFS/.test(res.body),
      );
      assert.equal(root.statusCode, 200);
      assert.match(root.body, /<h1>Hello from VFS<\/h1>/);
      assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(
        String(root.headers['content-length']),
        String(root.body.length),
      );

      const css = await waitForUrl(
        `http://127.0.0.1:${port}/style.css`,
        (res) =>
          res.statusCode === 200 && /font-family: system-ui/.test(res.body),
      );
      assert.equal(css.statusCode, 200);
      assert.match(css.body, /font-family: system-ui/);
      assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
      assert.equal(
        String(css.headers['content-length']),
        String(css.body.length),
      );
    } finally {
      await stopChild(child);
    }
  });
});
