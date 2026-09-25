'use strict';

const { fsError } = require('./errors.js');

// SabStore — mutations of a `sab + virtual` Place on the main thread. The
// kernel owns the allocator, the preparation pipeline, epoch publication and
// ACK-before-free; this store only validates node:fs semantics against the
// live projection and hands raw input to the kernel.
//
// Publication crosses the SAB allocator and (when configured) the
// compression threadpool, so mutations are asynchronous: every method
// returns a Promise that settles once the new version is published, before
// worker ACKs — those only govern when the replaced bytes are released.
//
// Ordering is per key, so the state a method validates against is the state
// its publication is applied to, while unrelated keys never wait. `rename`
// locks both keys at once; `rm` may delete a whole subtree and therefore
// takes an exclusive place barrier, which cannot race a write to a child.

class SabStore {
  sync = false;

  constructor(place, kernel) {
    this.place = place;
    this.kernel = kernel;
  }

  #run(keys, fn) {
    return this.kernel.enqueueMutation(this.place, keys, fn);
  }

  write(key, data) {
    const raw = Buffer.from(data);
    return this.#run([key], () =>
      this.kernel.publishVirtual(this.place, key, raw),
    );
  }

  // The raw input of a prepared file is not retained, so there is nothing
  // to append to.
  append(key, data) {
    const chunk = Buffer.from(data);
    return this.#run([key], () => {
      const { place } = this;
      if (place.prepared(key)) {
        throw fsError('ENOTSUP', 'open', place.pathOf(key), 'prepared source');
      }
      const current = place.files.get(key);
      const joined = current?.data
        ? Buffer.concat([current.data, chunk])
        : chunk;
      return this.kernel.publishVirtual(place, key, joined);
    });
  }

  unlink(key) {
    return this.#run([key], () => {
      const { place } = this;
      if (!place.files.has(key)) {
        throw fsError('ENOENT', 'unlink', place.pathOf(key));
      }
      return this.kernel.unpublishVirtual(place, [key]);
    });
  }

  // Directories are implicit: mkdir succeeds without state, so it orders
  // against nothing.
  mkdir() {
    return Promise.resolve();
  }

  // Exclusive: the key may name a subtree, and its children must not be
  // written while it is being collected.
  rm(key, options = {}) {
    return this.#run(null, () => {
      const { place } = this;
      if (place.files.has(key)) {
        return this.kernel.unpublishVirtual(place, [key]);
      }
      const children = place.keysUnder(key);
      if (children.length === 0) {
        if (!options.force) throw fsError('ENOENT', 'rm', place.pathOf(key));
        return Promise.resolve();
      }
      if (!options.recursive) {
        throw fsError('ENOTEMPTY', 'rm', place.pathOf(key));
      }
      return this.kernel.unpublishVirtual(place, children);
    });
  }

  // A prepared source keeps no raw input and its bundle may embed the old
  // key (scriptOptions.filename, meta), so it cannot move. Any other source
  // is raw content: the kernel republishes it under the new key through the
  // pipeline, prepared when the new extension has a preparer.
  rename(from, to) {
    return this.#run([from, to], () => {
      const { place } = this;
      const fail = (code, detail) =>
        fsError(code, 'rename', place.pathOf(from), detail, place.pathOf(to));
      if (place.prepared(from)) throw fail('ENOTSUP', 'prepared source');
      if (!place.files.has(from)) throw fail('ENOENT');
      return this.kernel.renameVirtual(place, from, to);
    });
  }
}

module.exports = { SabStore };
