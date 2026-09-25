'use strict';

// Pins — the direct consumers of shared bytes in one thread: streams and
// view leases over a projected entry. Keys are projected file objects, so
// every physical version has its own record.
//
// Pinning the current version is local bookkeeping only. When an update
// retires a pinned version, the thread binds it to the retireId the main
// kernel assigned and reports it with its ACK; once the last consumer is
// done it sends one release. Nothing crosses threads per chunk, per pin or
// for a version that is never retired while in use.

class Pins {
  #counts = new Map(); // projected file → active consumers
  #retired = new Map(); // projected file → retireId, once retired while in use
  #closers = new Set(); // shutdown hooks of active streams
  #release; // (retireIds) → void

  constructor(release) {
    this.#release = release;
  }

  // One more consumer of `file`; returns its idempotent release. `onClose`
  // runs if the kernel closes while the consumer is still active.
  acquire(file, onClose = null) {
    this.#counts.set(file, (this.#counts.get(file) || 0) + 1);
    if (onClose) this.#closers.add(onClose);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (onClose) this.#closers.delete(onClose);
      this.#drop(file);
    };
  }

  #drop(file) {
    const count = this.#counts.get(file);
    if (count === undefined) return; // closed meanwhile
    if (count > 1) return void this.#counts.set(file, count - 1);
    this.#counts.delete(file);
    const id = this.#retired.get(file);
    if (id === undefined) return;
    this.#retired.delete(file);
    this.#release([id]);
  }

  // Called while an update retires `file`, before the projection drops it:
  // true when consumers still read it, which binds them to `retireId`.
  retain(file, retireId) {
    if (!file || !this.#counts.has(file)) return false;
    this.#retired.set(file, retireId);
    return true;
  }

  // Kernel shutdown: stop every active stream and forget every pin.
  close() {
    const closers = [...this.#closers];
    this.#closers.clear();
    this.#counts.clear();
    this.#retired.clear();
    for (const close of closers) close();
  }

  // Pinned versions (inspection).
  get size() {
    return this.#counts.size;
  }
}

module.exports = { Pins };
