'use strict';

const { bytecodeFor, prepareInput } = require('./pipeline.js');
const { fsError } = require('./errors.js');

// MapStore — the Map sink of the preparation pipeline, for provider "map".
// Owns nothing shared: entries are owned Buffers in `place.files` and never
// leave the thread. It serves two callers:
//   origin virtual  application mutations (any thread, synchronous)
//   origin disk     the kernel's scanner / watcher (main thread) through
//                   publish(); mutations themselves go to disk
// Writes into keys fs.script prepares go through the place's preparer first;
// a thread without the preparer (a worker) refuses them with ENOTSUP rather
// than publishing raw bytes as if they were prepared.

class MapStore {
  // Mutations complete synchronously: nothing crosses a thread boundary.
  sync = true;

  constructor(place) {
    this.place = place;
  }

  #input(key, raw, syscall) {
    const { place } = this;
    const stat = { size: raw.length, mtimeMs: Date.now() };
    if (!place.prepared(key)) return { data: raw, stat };
    if (!place.prepare) {
      throw fsError(
        'ENOTSUP',
        syscall,
        place.pathOf(key),
        'preparer is unavailable in this thread',
      );
    }
    return prepareInput(place, key, { stat }, raw);
  }

  // Publish an already-canonical input `{ data, stat, scriptOptions?, meta? }`
  // with fresh companions.
  publish(key, input) {
    const { place } = this;
    const { files } = place;
    const { data, stat, scriptOptions, meta } = input;
    files.set(key, { data, stat, scriptOptions, meta });
    for (const companion of place.companions(key)) files.delete(companion);
    for (const code of bytecodeFor(place, key, data, scriptOptions)) {
      if (!code.data) {
        if (code.domain === 'script') {
          this.remove(key);
          throw fsError(
            'ENOTSUP',
            'open',
            place.pathOf(key),
            'source does not compile',
          );
        }
        continue;
      }
      files.set(code.key, {
        data: code.data,
        stat: { size: code.data.length, mtimeMs: stat.mtimeMs },
      });
    }
    return stat;
  }

  // Removes the source and its companions; false when there was no source.
  remove(key) {
    const { files } = this.place;
    if (!files.delete(key)) return false;
    for (const companion of this.place.companions(key)) files.delete(companion);
    return true;
  }

  // Every source key under an implicit directory (non-recursive listing of
  // sources only — companions follow their source).
  keysUnder(dir) {
    return this.place.keysUnder(dir);
  }

  // --- Mutation API (PlaceFs); keys are canonical, errors node:fs-shaped ---

  write(key, data) {
    this.publish(key, this.#input(key, Buffer.from(data), 'open'));
  }

  // The raw input of a prepared file is not retained, so there is nothing
  // to append to.
  append(key, data) {
    const abs = this.place.pathOf(key);
    if (this.place.prepared(key)) {
      throw fsError('ENOTSUP', 'open', abs, 'prepared source');
    }
    const current = this.place.files.get(key);
    const chunk = Buffer.from(data);
    const joined = current ? Buffer.concat([current.data, chunk]) : chunk;
    this.publish(key, this.#input(key, joined, 'open'));
  }

  unlink(key) {
    if (!this.remove(key))
      throw fsError('ENOENT', 'unlink', this.place.pathOf(key));
  }

  // Directories are implicit: mkdir succeeds without state.
  mkdir() {}

  rm(key, options = {}) {
    if (this.remove(key)) return;
    const abs = this.place.pathOf(key);
    const children = this.keysUnder(key);
    if (children.length === 0) {
      if (!options.force) throw fsError('ENOENT', 'rm', abs);
      return;
    }
    if (!options.recursive) throw fsError('ENOTEMPTY', 'rm', abs);
    for (const child of children) this.remove(child);
  }

  // A prepared bundle may embed the old key (scriptOptions.filename, meta),
  // and its raw input is gone, so it cannot be re-prepared under the new
  // name: moving it would publish a stale bundle.
  rename(from, to) {
    const { place } = this;
    if (place.prepared(from) || place.prepared(to)) {
      throw fsError('ENOTSUP', 'rename', place.pathOf(from), 'prepared source');
    }
    const current = place.files.get(from);
    if (!current) throw fsError('ENOENT', 'rename', place.pathOf(from));
    this.remove(from);
    this.publish(to, current);
  }
}

module.exports = { MapStore };
