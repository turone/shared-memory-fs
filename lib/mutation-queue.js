'use strict';

// MutationQueue — ordering for mutations of virtual places.
//
// One queue identity per `(place, canonical key)`: mutations of one key run
// in the order the main kernel accepted them, mutations of different keys
// never wait for each other. A subtree operation (recursive `rm`) takes an
// exclusive **place barrier** instead, so it cannot race a write to a child.
//
// Every lock a task needs is taken in one shot at request time, so there is
// no hold-and-wait and no deadlock; `rename` simply lists both keys. A task
// that fails does not block the ones queued behind it: predecessors are
// awaited through `allSettled`.
//
// This orders *mutations*. Publications of different keys may overlap: their
// allocations stay private until the kernel's `#flush` commits each epoch to
// the index in one synchronous step.

const NOOP = () => {};
const FREE = Promise.resolve();

class MutationQueue {
  #places = new Map(); // name → { keys: Map<key, tail>, barrier }

  #locks(name) {
    let locks = this.#places.get(name);
    if (!locks)
      this.#places.set(name, (locks = { keys: new Map(), barrier: FREE }));
    return locks;
  }

  // Run `fn` once the locks it needs are free. `keys` is the list of
  // canonical keys it touches, or null for an exclusive place barrier.
  run(name, keys, fn) {
    const locks = this.#locks(name);
    const exclusive = keys === null;
    const held = exclusive ? [] : [...new Set(keys)].sort();
    const prior = [locks.barrier];
    if (exclusive) prior.push(...locks.keys.values());
    else {
      for (const key of held) {
        const tail = locks.keys.get(key);
        if (tail) prior.push(tail);
      }
    }
    const done = Promise.allSettled(prior).then(fn);
    const tail = done.then(NOOP, NOOP);
    if (exclusive) {
      // Key tails are subsumed: new key tasks wait on the barrier instead.
      locks.keys.clear();
      locks.barrier = tail;
    } else {
      for (const key of held) locks.keys.set(key, tail);
    }
    tail.then(() => this.#release(name, locks, tail, held, exclusive));
    return done;
  }

  // Records live only while a task is queued or running.
  #release(name, locks, tail, held, exclusive) {
    if (exclusive) {
      if (locks.barrier === tail) locks.barrier = FREE;
    } else {
      for (const key of held) {
        if (locks.keys.get(key) === tail) locks.keys.delete(key);
      }
    }
    if (locks.keys.size === 0 && locks.barrier === FREE) {
      if (this.#places.get(name) === locks) this.#places.delete(name);
    }
  }

  // Queued tasks still run (and reject on a closed kernel); this only drops
  // the bookkeeping.
  clear() {
    this.#places.clear();
  }

  get size() {
    let total = 0;
    for (const locks of this.#places.values()) total += locks.keys.size;
    return total;
  }
}

module.exports = { MutationQueue };
