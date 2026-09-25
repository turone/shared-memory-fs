'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PlaceRegistry } = require('../lib/registry.js');

// Lexical containment: only a real `..` component leaves appRoot. Names that
// merely start with dots are ordinary names routed by the usual Place rules.

describe('PlaceRegistry.route: appRoot containment', () => {
  const appRoot = path.resolve('/srv/app');
  const registry = new PlaceRegistry(appRoot);
  const api = { name: 'api' };
  registry.register(api);
  const at = (...parts) => path.join(appRoot, ...parts);

  it('dot-prefixed names are inside appRoot, not parent traversal', () => {
    for (const name of ['..private', '..cache', '...data', 'file..js']) {
      assert.deepEqual(
        registry.route(at(name, 'secret.js')),
        { place: null, key: null },
        name,
      );
      assert.deepEqual(registry.route(at(name)), { place: null, key: null });
    }
  });

  it('the first component names the Place, dotted names below it are keys', () => {
    assert.deepEqual(registry.route(at('api', '..private', 'file.js')), {
      place: api,
      key: '/..private/file.js',
    });
    assert.deepEqual(registry.route(at('api', 'file..js')), {
      place: api,
      key: '/file..js',
    });
    assert.deepEqual(registry.route(at('api')), { place: api, key: '' });
    assert.deepEqual(registry.route(at('api', 'x.js')), {
      place: api,
      key: '/x.js',
    });
  });

  it('real parent paths stay outside appRoot', () => {
    assert.equal(registry.route(path.join(appRoot, '..', 'secret')), null);
    assert.equal(registry.route(path.join(appRoot, '..')), null);
    assert.equal(
      registry.route(path.join(path.dirname(appRoot), 'app-sibling', 'x')),
      null,
    );
    assert.equal(registry.route(at('api', '..', '..', 'secret')), null);
  });

  it('appRoot itself is the boundary, not the root of a Place', () => {
    assert.deepEqual(registry.route(appRoot), {
      place: null,
      key: null,
      root: true,
    });
    assert.deepEqual(
      registry.route(appRoot + path.sep),
      registry.route(appRoot),
    );
  });

  it('a path on another drive is outside appRoot', (t) => {
    if (process.platform !== 'win32') {
      t.skip('windows only');
      return;
    }
    const drive = appRoot[0].toUpperCase() === 'Z' ? 'Y:' : 'Z:';
    assert.equal(registry.route(`${drive}\\srv\\app\\api\\x.js`), null);
  });
});
