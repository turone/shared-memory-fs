'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  tmpDir,
  rm,
  kernel,
  tap,
  worker,
  nextMessage,
} = require('./helpers.js');

// A directory rename inside one virtual place moves a subtree of raw
// sources whole: every source and the companions it has — compressed
// representations — reappear under the new prefix with their bytes, stat
// and mtime, and the old keys go, in one publication. Nothing is prepared,
// compiled or compressed again. One source that cannot move as it is — a
// prepared one, one with bytecode, one with path-dependent metadata —
// refuses the whole subtree, and so do collisions and nesting: nothing
// changes before the plan is complete.

const PROVIDERS = {
  sab: { origin: 'virtual', fs: { writable: true } },
  map: { provider: 'map', origin: 'virtual', fs: { writable: true } },
};

const TREE = {
  '/d/a.txt': 'alpha',
  '/d/sub/b.css': 'b{}',
  '/d/sub/deep/c.txt': '',
};

const outcome = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err;
  }
};

// Runs `fn` with a kernel over one place `v` (plus `other` of the same
// config), then closes it.
const withPlace = async (config, fn, options = {}) => {
  const root = tmpDir('vfs-subtree');
  const k = await kernel(root, { v: config, other: config }, {}, options);
  try {
    await fn(k, k.fs('v'), (key) => path.join(root, 'v', key));
  } finally {
    k.close();
    rm(root);
  }
};

const write = async (v, files) => {
  for (const [key, content] of Object.entries(files)) {
    await v.writeFile(key, content);
  }
};

// Every key a place projects under a prefix, companions included.
const keysUnder = (k, name, prefix) =>
  [...k.registry.get(name).files.keys()]
    .filter((key) => key.startsWith(prefix))
    .sort();

// Settles once the microtasks queued so far — lock releases included — ran.
const drained = () => new Promise(setImmediate);

describe('virtual subtree rename', () => {
  for (const [name, config] of Object.entries(PROVIDERS)) {
    it(`${name}: a raw-only nested subtree moves whole, stat and mtime kept`, async () => {
      await withPlace(config, async (k, v) => {
        await write(v, TREE);
        const before = Object.keys(TREE).map((key) => v.stat(key));
        const realNow = Date.now;
        // However late the move, the entries keep the time of their write.
        Date.now = () => realNow() + 60_000;
        try {
          await v.rename('/d', '/e/f');
        } finally {
          Date.now = realNow;
        }
        for (const [i, [key, content]] of Object.entries(TREE).entries()) {
          const moved = key.replace('/d/', '/e/f/');
          assert.equal(v.readFile(moved, 'utf8'), content, moved);
          assert.equal(v.stat(moved).mtimeMs, before[i].mtimeMs, moved);
          assert.equal(v.stat(moved).size, before[i].size, moved);
          assert.equal(v.exists(key), false, key);
        }
        assert.equal(v.exists('/d'), false);
        assert.deepEqual(v.readdir('/e/f', { recursive: true }), [
          'a.txt',
          'sub',
          'sub/b.css',
          'sub/deep',
          'sub/deep/c.txt',
        ]);
        // Renaming a directory onto itself changes nothing.
        await v.rename('/e/f', '/e/f');
        assert.equal(v.readFile('/e/f/a.txt', 'utf8'), 'alpha');
      });
    });

    it(`${name}: one source that cannot move refuses the whole subtree`, async () => {
      const unsupported = {
        prepare: {
          ...config,
          fs: { ...config.fs, prepare: { wrap: ['js'] } },
        },
        'fs.script.compile': {
          ...config,
          fs: { ...config.fs, script: { ext: ['js'], compile: true } },
        },
        'require.compile': { ...config, require: { compile: true } },
      };
      const preparers = { wrap: (raw) => `(${raw})` };
      for (const [what, placeConfig] of Object.entries(unsupported)) {
        await withPlace(
          placeConfig,
          async (k, v, at) => {
            await write(v, { ...TREE, '/d/sub/deep/x.js': 'module.x = 1;' });
            const keys = keysUnder(k, 'v', '/');
            const err = await outcome(() => v.rename('/d', '/e'));
            assert.equal(err.code, 'ENOTSUP', what);
            assert.equal(err.syscall, 'rename');
            assert.equal(err.path, at('/d'));
            assert.equal(err.dest, at('/e'));
            assert.match(err.message, /\/d\/sub\/deep\/x\.js/);
            assert.deepEqual(keysUnder(k, 'v', '/'), keys, `${what}: intact`);
          },
          { preparers },
        );
      }
    });

    it(`${name}: collisions and nesting are refused before anything changes`, async () => {
      await withPlace(config, async (k, v, at) => {
        await write(v, { ...TREE, '/taken/t.txt': 't', '/file.txt': 'f' });
        const keys = keysUnder(k, 'v', '/');
        for (const [from, to, code] of [
          ['/d', '/taken', 'ENOTEMPTY'],
          ['/d', '/file.txt', 'ENOTDIR'],
          ['/d', '/d/sub/inner', 'EINVAL'],
          ['/d/sub', '/d', 'ENOTEMPTY'],
          ['/nothing', '/else', 'ENOENT'],
        ]) {
          const err = await outcome(() => v.rename(from, to));
          assert.equal(err.code, code, `${from} -> ${to}`);
          assert.equal(err.path, at(from));
          assert.equal(err.dest, at(to));
        }
        const err = await outcome(() => v.rename('/', '/x'));
        assert.equal(err.code, 'ENOTSUP', 'the place root');
        assert.deepEqual(keysUnder(k, 'v', '/'), keys, 'nothing changed');
      });
    });
  }

  it('sab: one vfs-update; a worker never sees half a move', async () => {
    await withPlace(PROVIDERS.sab, async (k, v) => {
      await write(v, TREE);
      const t = tap(k);
      const w = worker(k);
      try {
        const updates = t.updates().length;
        const next = nextMessage(t.port);
        const applied = nextMessage(w.port);
        await v.rename('/d', '/e');
        const msg = await next;
        await applied;
        assert.equal(msg.name, 'vfs-update');
        assert.equal(t.updates().length, updates + 1, 'one update');
        const { entries, removals, retired } = msg.places.v;
        assert.deepEqual(removals.sort(), Object.keys(TREE).sort());
        assert.deepEqual(
          entries.map(([key]) => key).sort(),
          Object.keys(TREE)
            .map((key) => key.replace('/d/', '/e/'))
            .sort(),
        );
        // Old versions with bytes retire; the empty file has none.
        assert.equal(retired.length, 2);
        const wv = w.kernel.fs('v');
        assert.equal(wv.readFile('/e/sub/b.css', 'utf8'), 'b{}');
        assert.equal(wv.exists('/d'), false);
      } finally {
        w.kernel.close();
      }
    });
  });

  it('sab: compressed representations move with their source, never recompressed', async () => {
    const config = {
      origin: 'virtual',
      fs: { writable: true, compress: { encodings: ['gzip'], ext: ['css'] } },
    };
    await withPlace(config, async (k, v) => {
      await write(v, { ...TREE, '/d/sub/big.css': 'x{}'.repeat(200) });
      const gzip = v.readFileCompressed('/d/sub/big.css', 'gzip');
      assert.ok(gzip.length > 0);
      let compressed = 0;
      const { compress } = k.compressor;
      k.compressor.compress = (...args) => {
        compressed++;
        return compress.apply(k.compressor, args);
      };
      await v.rename('/d', '/e');
      assert.equal(compressed, 0, 'no codec ran');
      assert.deepEqual(v.readFileCompressed('/e/sub/big.css', 'gzip'), gzip);
      assert.deepEqual(v.storedEncodings('/e/sub/big.css'), ['raw', 'gzip']);
      assert.deepEqual(v.storedEncodings('/d/sub/big.css'), []);
      assert.deepEqual(v.storedEncodings('/e/a.txt'), ['raw'], 'mixed tree');
      assert.deepEqual(keysUnder(k, 'v', '/d'), [], 'no companion stays');
    });
  });

  it('sab: an old version still read retires until it is released', async () => {
    const config = {
      origin: 'virtual',
      fs: { writable: true, zeroCopy: true },
    };
    await withPlace(config, async (k, v) => {
      await write(v, TREE);
      const lease = v.readFileView('/d/a.txt');
      await v.rename('/d', '/e');
      assert.deepEqual(
        k.retirements().map((r) => [r.key, r.waiting]),
        [['/d/a.txt', 'release']],
      );
      assert.equal(lease.view.toString(), 'alpha', 'the old bytes stay');
      lease.release();
      assert.equal(k.retired.size, 0);
      assert.equal(v.readFile('/e/a.txt', 'utf8'), 'alpha');
    });
  });

  it('sab: the place barrier orders the move and is released after failure and close', async () => {
    const config = {
      origin: 'virtual',
      fs: { writable: true, compress: { encodings: ['gzip'], ext: ['css'] } },
    };
    await withPlace(config, async (k, v) => {
      await write(v, TREE);
      // A write issued after the move lands after it, under the old name.
      const moved = v.rename('/d', '/e');
      const written = v.writeFile('/d/late.txt', 'late');
      await Promise.all([moved, written]);
      assert.equal(v.readFile('/d/late.txt', 'utf8'), 'late');
      assert.equal(v.readFile('/e/a.txt', 'utf8'), 'alpha');
      // A refused move holds nothing up.
      await v.writeFile('/e/p.css', 'p{}');
      await v.rename('/e', '/f');
      const refused = await outcome(() => v.rename('/f', '/d'));
      assert.equal(refused.code, 'ENOTEMPTY');
      await v.writeFile('/f/after.txt', 'after');
      await drained();
      assert.equal(k.mutations.size, 0);
    });
    await withPlace(config, async (k, v) => {
      await write(v, TREE);
      // A move queued behind a write in flight when the kernel closes.
      let open;
      const gate = new Promise((resolve) => {
        open = resolve;
      });
      const { compress } = k.compressor;
      k.compressor.compress = async (...args) => {
        await gate;
        return compress.apply(k.compressor, args);
      };
      const slow = v.writeFile('/d/slow.css', 's{}');
      const move = v.rename('/d', '/e');
      k.close();
      open();
      assert.match((await outcome(() => slow)).message, /closed/);
      assert.match((await outcome(() => move)).message, /ready kernel/);
      assert.equal(k.mutations.size, 0);
    });
  });
});
