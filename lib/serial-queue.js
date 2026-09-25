'use strict';

// SerialQueue — runs tasks strictly one at a time, in arrival order. A task
// that fails does not hold up the ones behind it; its rejection belongs to
// the caller of run().

const NOOP = () => {};

class SerialQueue {
  #tail = Promise.resolve();
  #size = 0;

  // Settles with the task's own result once every earlier task is done.
  run(task) {
    this.#size++;
    const done = this.#tail.then(task).finally(() => {
      this.#size--;
    });
    this.#tail = done.then(NOOP, NOOP);
    return done;
  }

  // Tasks queued or running.
  get size() {
    return this.#size;
  }

  // Settles once every task queued so far has finished.
  get idle() {
    return this.#tail;
  }
}

module.exports = { SerialQueue };
