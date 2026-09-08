'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';
const CLEANUP_MS = 3000;
const READY_MS = 8000;
const HTTP_MS = 8000;
const HOT_RELOAD_MS = 15000;
const MULTI_TENANT_MS = 10000;
const SEA_STATIC_MS = 10000;

const httpRequest = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        req.destroy();
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: chunks.join(''),
        });
      });
    });

    req.setTimeout(1000, () => {
      req.destroy(new Error(`timeout waiting for ${url}`));
    });
    req.on('error', reject);
  });

const waitForUrl = async (url, predicate, timeoutMs = HTTP_MS) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await httpRequest(url);
      if (predicate(res)) return res;
    } catch (error) {
      void error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
};

const attachOutput = (child) => {
  const stdoutChunks = [];
  const stderrChunks = [];
  const onStdout = (chunk) => stdoutChunks.push(String(chunk));
  const onStderr = (chunk) => stderrChunks.push(String(chunk));
  if (child.stdout) child.stdout.on('data', onStdout);
  if (child.stderr) child.stderr.on('data', onStderr);
  return {
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join(''),
    text: () => stdoutChunks.join('') + stderrChunks.join(''),
  };
};

const hasExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child, timeoutMs) =>
  new Promise((resolve) => {
    if (hasExited(child)) {
      resolve(true);
      return;
    }

    let settled = false;
    let timer = null;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });

const destroyStdio = (child) => {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.removeAllListeners();
    if (!stream.destroyed) stream.destroy();
  }
};

const requestStop = (child) => {
  if (!child.pid || hasExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch (error) {
    void error;
  }
};

const killTree = (pid) => {
  if (!pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 2000,
    });
    return;
  }
  spawnSync('pkill', ['-KILL', '-P', String(pid)], {
    stdio: 'ignore',
    timeout: 2000,
  });
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    void error;
  }
};

const stopChild = async (child) => {
  if (!child) return;
  const pid = child.pid;
  const budget = Date.now() + CLEANUP_MS;
  try {
    if (!hasExited(child)) {
      requestStop(child);
      const remaining = Math.max(0, budget - Date.now());
      const exited = await waitForExit(child, Math.min(1500, remaining));
      if (!exited && !hasExited(child)) {
        killTree(pid);
        const fallback = Math.max(0, budget - Date.now());
        const forceExited = await waitForExit(child, Math.min(1500, fallback));
        if (!forceExited && !hasExited(child)) {
          throw new Error(
            `child pid ${pid} did not exit within ${CLEANUP_MS}ms`,
          );
        }
      }
    }
  } finally {
    destroyStdio(child);
    child.removeAllListeners();
  }
};

const waitForChildReady = async (child, timeoutMs = READY_MS) => {
  const started = Date.now();
  const output = attachOutput(child);

  while (Date.now() - started < timeoutMs) {
    if (hasExited(child)) {
      throw new Error(
        `child exited early with code ${child.exitCode}\n${output.text()}`,
      );
    }

    const text = output.text();
    const match =
      text.match(/http:\/\/127\.0\.0\.1:(\d+)/i) ||
      text.match(/http:\/\/localhost:(\d+)/i);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`timeout waiting for listening output\n${output.text()}`);
};

const startExample = async (script, env = {}) => {
  const child = spawn(process.execPath, [script], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
  it(
    'hot-reload-routes server swaps handlers at runtime',
    { timeout: HOT_RELOAD_MS },
    async () => {
      const { child, port } = await startExample(
        'examples/hot-reload-routes/server.js',
        { PORT: '0' },
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
        );
        assert.equal(updated.statusCode, 200);
        assert.notEqual(updated.body, initial.body);
        assert.match(updated.body, /^updated hello! /);
      } finally {
        await stopChild(child);
      }
    },
  );

  it(
    'multi-tenant demo keeps each tenant isolated and strict appRoot denies unmanaged paths',
    { timeout: MULTI_TENANT_MS },
    async () => {
      const child = spawn(process.execPath, ['examples/multi-tenant/run.js'], {
        cwd: REPO,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const output = attachOutput(child);

      try {
        const exited = await waitForExit(child, MULTI_TENANT_MS - 1000);
        const stdout = output.stdout();
        const stderr = output.stderr();
        assert.equal(exited, true, `multi-tenant demo timed out\n${stdout}`);
        assert.equal(child.exitCode, 0, stderr || stdout);
        assert.equal(stderr, '');
        assert.match(stdout, /\[A\] own data\.txt: tenant-a secret/);
        assert.match(stdout, /\[B\] own data\.txt: tenant-b secret/);
        assert.match(stdout, /read config\.local\.json -> EACCES/);
        assert.match(stdout, /read README\.md -> EACCES/);
        assert.match(stdout, /stat\(os\.tmpdir\(\)\) -> ok \(passthrough\)/);
      } finally {
        await stopChild(child);
      }
    },
  );

  it(
    'sea-static example serves sab assets with expected content and headers',
    { timeout: SEA_STATIC_MS },
    async () => {
      const { child, port } = await startExample(
        'examples/sea-static/server.js',
        { PORT: '0' },
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
    },
  );
});
