'use strict';

const {
  bytecodeFor,
  checkHierarchy,
  checkMkdir,
  prepareInput,
  subtreeMoves,
} = require('./pipeline.js');
const { fsError } = require('./errors.js');

// MapStore — the Map sink of the publication pipeline, for provider "map".
// Owns nothing shared: entries are owned Buffers in `place.files` and never
// leave the thread. It serves two callers:
//   origin virtual  application mutations (any thread, synchronous)
//   origin disk     the kernel's scanner / watcher (main thread) through
//                   publish(); mutations themselves go to disk
// A write into an extension a preparer owns runs that preparer first; a
// thread that was not given it (a worker without attach({ preparers }))
// refuses the write rather than publishing raw bytes as if prepared.

class MapStore {
  // Mutations complete synchronously: nothing crosses a thread boundary.
  sync = true;

  constructor(place) {
    this.place = place;
  }

  // The canonical input of raw bytes written under `key`: the preparer of
  // its extension runs once, here.
  #input(key, raw, syscall, mtimeMs = Date.now()) {
    const { place } = this;
    const stat = { size: raw.length, mtimeMs };
    const name = place.prepared(key);
    if (!name) return { data: raw, stat };
    const prepare = place.preparerOf(key);
    if (!prepare) {
      throw fsError(
        'ENOTSUP',
        syscall,
        place.pathOf(key),
        `preparer "${name}" is not registered in this thread ` +
          '(attach({ preparers }))',
      );
    }
    return prepareInput(place, key, { stat }, raw, prepare);
  }

  // Publish an already-canonical input `{ data, stat, scriptOptions?, meta? }`
  // with fresh companions, atomically: everything is computed first, so a
  // script flavor that does not compile leaves the previous version and its
  // companions untouched.
  publish(key, input) {
    const { place } = this;
    const { files } = place;
    const { data, stat, scriptOptions, meta } = input;
    const codes = [];
    for (const code of bytecodeFor(place, key, data, scriptOptions)) {
      if (code.data) codes.push(code);
      else if (code.domain === 'script') {
        throw fsError(
          'ENOTSUP',
          'open',
          place.pathOf(key),
          'source does not compile',
        );
      }
    }
    files.set(key, { data, stat, scriptOptions, meta });
    for (const companion of place.companions(key)) files.delete(companion);
    for (const code of codes) {
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

  // A write keeps the hierarchy (checkHierarchy): no file above its key,
  // no directory at it.
  write(key, data) {
    const abs = this.place.pathOf(key);
    checkHierarchy(this.place, key, (code) => fsError(code, 'open', abs));
    this.publish(key, this.#input(key, Buffer.from(data), 'open'));
  }

  // The raw input of a prepared file is not retained, so there is nothing
  // to append to.
  append(key, data) {
    const abs = this.place.pathOf(key);
    if (this.place.prepared(key)) {
      throw fsError('ENOTSUP', 'open', abs, 'prepared source');
    }
    checkHierarchy(this.place, key, (code) => fsError(code, 'open', abs));
    const current = this.place.files.get(key);
    const chunk = Buffer.from(data);
    const joined = current ? Buffer.concat([current.data, chunk]) : chunk;
    this.publish(key, this.#input(key, joined, 'open'));
  }

  unlink(key) {
    if (this.remove(key)) return;
    const code = this.place.isDirectory(key) ? 'EISDIR' : 'ENOENT';
    throw fsError(code, 'unlink', this.place.pathOf(key));
  }

  // Directories are implicit: mkdir creates no entry, but checks the
  // hierarchy all the same (checkMkdir).
  mkdir(key, options) {
    const fail = (code) => fsError(code, 'mkdir', this.place.pathOf(key));
    checkMkdir(this.place, key, options?.recursive, fail);
  }

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

  // A prepared source keeps no raw input and its bundle may embed the old
  // key (scriptOptions.filename, meta), so it cannot move. Any other source
  // is raw content: it is republished under the new key through the
  // pipeline — prepared when the new extension has a preparer — and keeps
  // its mtime, like a rename on disk. A directory moves when every source
  // under it can move as it is (subtreeMoves).
  rename(from, to) {
    const { place } = this;
    const current = place.files.get(from);
    if (!current && place.isDirectory(from)) {
      this.#moveTree(from, to);
      return;
    }
    const fail = (code, detail) =>
      fsError(code, 'rename', place.pathOf(from), detail, place.pathOf(to));
    if (place.prepared(from)) throw fail('ENOTSUP', 'prepared source');
    if (!current) throw fail('ENOENT');
    if (from === to) return;
    checkHierarchy(place, to, fail);
    const input = this.#input(to, current.data, 'rename', current.stat.mtimeMs);
    this.publish(to, input);
    this.remove(from);
  }

  // The same entries — sources and companions — under the new keys, swapped
  // in one step once the whole plan is known.
  #moveTree(from, to) {
    const { files } = this.place;
    const moves = subtreeMoves(this.place, from, to);
    const entries = moves.map(([key, newKey]) => [newKey, files.get(key)]);
    for (const [key] of moves) files.delete(key);
    for (const [newKey, entry] of entries) files.set(newKey, entry);
  }
}

module.exports = { MapStore };
