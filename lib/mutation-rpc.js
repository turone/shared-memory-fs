'use strict';

const { fsError } = require('./errors.js');

// Mutation RPC — worker → main writes for `sab + virtual` places.
//
// Workers never allocate in the SAB pool. A mutation travels over the same
// private MessagePort `kernel.link()` already uses for deltas and ACKs:
//
//   worker → main  { name: 'vfs-mutate', id, place, op, key, to?, options?,
//                    data? }   `data` is a Uint8Array over a transferred
//                              ArrayBuffer owned by the request
//   main → worker  { name: 'vfs-mutated', id, error? }
//
// The response arrives after the new version is published (one `vfs-update`
// for every thread), not after every worker ACKs: ACKs only govern when the
// replaced bytes are released. The bytes themselves are never echoed back —
// they are in SAB, and the delta carries projection metadata only.
//
// Ordering is the arrival order at the main kernel, which serialises every
// mutation (its own included) in one queue.

const MUTATE = 'vfs-mutate';
const MUTATED = 'vfs-mutated';

// A detached copy of the payload: the caller's Buffer is often a view into
// Node's shared pool, so transferring it directly would detach memory the
// caller still owns.
const payloadOf = (data) => {
  const src = Buffer.isBuffer(data) || ArrayBuffer.isView(data) ? data : null;
  const bytes = src
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(Buffer.from(String(data), 'utf8'));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

// Errors cross the port as plain cloneable records.
const errorOf = (err) => ({
  code: err.code || null,
  message: err.message,
  syscall: err.syscall || null,
  path: err.path || null,
});

const restore = (record) => {
  if (record.code) {
    const err = fsError(record.code, record.syscall || 'open', record.path);
    err.message = record.message;
    return err;
  }
  return new Error(record.message);
};

// MutationClient — worker end of the protocol; one per link port, shared by
// every virtual place of that link. The port is unref'd so an idle link
// never keeps a worker alive; a request in flight does, like any pending
// I/O, until its response or the link's end settles it.
class MutationClient {
  #port;
  #pending = new Map();
  #nextId = 0;
  #closed = null;

  constructor(port) {
    this.#port = port;
  }

  #settle(id) {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (this.#pending.size === 0) this.#port.unref();
    return pending;
  }

  // True when the message was a mutation response.
  handle(msg) {
    if (msg?.name !== MUTATED) return false;
    if (!this.#pending.has(msg.id)) return true;
    const pending = this.#settle(msg.id);
    if (msg.error) pending.reject(restore(msg.error));
    else pending.resolve(undefined);
    return true;
  }

  send(place, op, request, data) {
    if (this.#closed) return Promise.reject(new Error(this.#closed));
    const id = ++this.#nextId;
    const msg = { name: MUTATE, id, place, op, ...request };
    const transfer = [];
    if (data) {
      msg.data = data;
      transfer.push(data.buffer);
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (this.#pending.size === 1) this.#port.ref();
      try {
        this.#port.postMessage(msg, transfer);
      } catch (err) {
        this.#settle(id);
        reject(err);
      }
    });
  }

  // The link is gone (worker or kernel closing): nothing can be published
  // any more, so no request may stay pending.
  close(reason = '[vfs] link closed before the mutation was published') {
    this.#closed = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#port.unref();
    for (const { reject } of pending) reject(new Error(reason));
  }
}

// RemoteStore — worker-side mutation API of one `sab + virtual` place.
// Mirrors SabStore; every method returns a Promise settled by the main
// kernel. Validation happens there, against the state the publication is
// applied to.
class RemoteStore {
  sync = false;

  constructor(place, client) {
    this.place = place;
    this.client = client;
  }

  #send(op, request, data) {
    return this.client.send(this.place.name, op, request, data);
  }

  write(key, data) {
    return this.#send('write', { key }, payloadOf(data));
  }

  append(key, data) {
    return this.#send('append', { key }, payloadOf(data));
  }

  unlink(key) {
    return this.#send('unlink', { key });
  }

  mkdir(key) {
    return this.#send('mkdir', { key });
  }

  rm(key, options = {}) {
    const { force = false, recursive = false } = options;
    return this.#send('rm', { key, options: { force, recursive } });
  }

  rename(from, to) {
    return this.#send('rename', { key: from, to });
  }
}

const OPS = new Set(['write', 'append', 'unlink', 'mkdir', 'rm', 'rename']);

module.exports = {
  MUTATE,
  MUTATED,
  OPS,
  MutationClient,
  RemoteStore,
  errorOf,
  payloadOf,
};
