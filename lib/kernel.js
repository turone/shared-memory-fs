'use strict';

const path = require('node:path');
const { availableParallelism } = require('node:os');
const { MessageChannel } = require('node:worker_threads');
const { fileExt } = require('metautil');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { open, readFile, stat } = require('node:fs/promises');
const { FilesystemCache } = require('./cache.js');
const { Compressor } = require('./compressor.js');
const { SEP, compressedKey } = require('./companion.js');
const { PlaceRegistry, FsRouter } = require('./registry.js');
const { Place, PlaceFiles, canonicalKey, dirOf } = require('./place.js');
const { PlaceFs } = require('./place-fs.js');
const { MapStore } = require('./map-store.js');
const { SabStore } = require('./sab-store.js');
const { MutationQueue } = require('./mutation-queue.js');
const { SerialQueue } = require('./serial-queue.js');
const { Pins } = require('./pins.js');
const {
  MUTATE,
  MUTATED,
  OPS,
  MutationClient,
  RemoteStore,
  errorOf,
} = require('./mutation-rpc.js');
const {
  Preparers,
  prepareInput,
  bytecodeDomains,
  bytecodeFor,
} = require('./pipeline.js');
const { fsError } = require('./errors.js');
const { DirWatcher } = require('./watcher.js');
const { scan } = require('./scanner.js');
const { INDEXED, SHARED } = require('./config.js');

// VfsKernel — orchestrator and consumer facade.
// Main thread: fills places from their origin (a disk scan, embedded SEA
// assets or application mutations of a virtual place) through one
// publication pipeline — raw input → the preparer of its extension →
// canonical content → bytecode and compressed companions → one epoch —
// watches disk-origin places and sends each epoch as one `vfs-update` to the
// linked workers. A version an update replaces or removes is retired: its
// bytes are freed only after every live worker ACKs the update and no
// thread still reads them.
// Worker thread: `VfsKernel.fromSnapshot()` projects the same segments
// read-only, applies the deltas arriving on its link port, ACKs each with
// the retired versions it still reads, and sends mutations of shared
// virtual places back over the same port.
// States: new → initializing → ready → closed (final).
//
// Protocol (link port):
//   vfs-update  main → worker  { updateId, places: { <name>: { entries,
//                              removals, retired: [[key, retireId]] } },
//                              newSegments }
//   vfs-ack     worker → main  { updateId, retained?: [retireId] }
//   vfs-release worker → main  { retireIds }
//   vfs-mutate / vfs-mutated   see mutation-rpc.js

const KERNEL = Symbol.for('shared-memory-fs');
const UPDATE = 'vfs-update';
const ACK = 'vfs-ack';
const RELEASE = 'vfs-release';
// Holder id of the main thread's own consumers of retired versions.
const MAIN = 'main';

// Companions are bounded by the segment size only, never by maxFileSize,
// and never fall back to a disk entry pointing at the raw file.
const COMPANION_ALLOC = { fallback: false, maxFileSize: Infinity };

const CLOSED = '[vfs] kernel closed before publication';

const sameSource = (stats, expected) =>
  stats.size === expected.size && stats.mtimeMs === expected.mtimeMs;

// Fill `view` with the file's bytes, refusing anything but a complete read
// of an unchanged file: stat before and after must match what the scanner
// saw, and a short read is an error, never a partially published entry.
const readInto = async (file, view) => {
  const fh = await open(file.path, 'r');
  try {
    if (!sameSource(await fh.stat(), file.stat)) {
      throw new Error(`source changed before read: ${file.path}`);
    }
    let done = 0;
    while (done < view.length) {
      const { bytesRead } = await fh.read(view, done, view.length - done, done);
      if (bytesRead === 0) throw new Error(`unexpected EOF: ${file.path}`);
      done += bytesRead;
    }
    if (!sameSource(await fh.stat(), file.stat)) {
      throw new Error(`source changed during read: ${file.path}`);
    }
  } finally {
    await fh.close();
  }
};

// Init publishes several files at a time, bounded by the libuv threadpool
// that serves both file reads and zlib: oversubscribing it only raises peak
// heap.
const initConcurrency = () => {
  const pool = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  return Math.max(1, Math.min(pool, availableParallelism()));
};

// Map a SEA asset key to a place key: `<name>/<rest>` → `/<rest>`.
const seaKeyOf = (assetKey, name) =>
  assetKey.startsWith(name + '/') && assetKey.length > name.length + 1
    ? assetKey.substring(name.length)
    : null;

// Readable label of a retired representation, for diagnostics only:
// `static:/video.mp4 [fs:br]#1847`. Never parsed back.
const labelOf = ({ place, key, id }) => {
  const at = key.indexOf(SEP);
  const name = at === -1 ? key : `${key.slice(0, at)} [${key.slice(at + 1)}]`;
  return `${place}:${name}#${id}`;
};

class VfsKernel {
  // The kernel published by the bootstrap (`--import shared-memory-fs/register`).
  static get current() {
    return globalThis[KERNEL] || null;
  }

  static set current(kernel) {
    if (kernel) globalThis[KERNEL] = kernel;
    else delete globalThis[KERNEL];
  }

  constructor(config, options = {}) {
    this.config = config;
    this.appRoot = path.resolve(options.appRoot || process.cwd());
    this.console = options.console || globalThis.console;
    // Injected node:sea-compatible module, for tests.
    this.seaModule = options.seaModule || null;
    // Callbacks the domains' `prepare` names; never part of the config.
    this.preparers = new Preparers(options.preparers);
    this.state = 'new';

    this.registry = new PlaceRegistry(this.appRoot);
    this.router = new FsRouter(this.registry, config.global.strict);
    this.facades = new Map(); // name → PlaceFs

    this.cache = null;
    this.compressor = null;
    this.segmentsMap = new Map(); // segmentId → SAB
    // name → PlaceFiles<key, FileInput> (disk-origin): what a watcher event
    // may unpublish, its directories indexed.
    this.sources = new Map();

    this.watcher = null;
    // Watcher epochs and rechecks, strictly one at a time.
    this.watchQueue = new SerialQueue();
    this.rechecks = new Map(); // absPath → Timeout
    this.links = new Map(); // linkId → MessagePort (workers created via link())
    this.nextLinkId = 0;
    this.nextUpdateId = 0;
    this.nextRetireId = 0;
    // ACK-before-free, per update and per retired version:
    //   acks     updateId → { pending: Set<linkId>, retired: [record] }
    //   retired  retireId → { id, updateId, place, key, entry, retiredAt,
    //                         holders: Set<linkId | 'main'> }
    // A record is freed once its update is ACKed and no holder is left.
    this.acks = new Map();
    this.retired = new Map();
    // Direct consumers of shared bytes in this thread (streams, leases).
    this.pins = new Pins((ids) => this.handleRelease(MAIN, ids));
    // Per-(place, key) ordering of virtual mutations.
    this.mutations = new MutationQueue();
    // Worker side of the link; null on the main thread.
    this.port = null;
    this.mutationClient = null;
  }

  get ready() {
    return this.state === 'ready';
  }

  #ensureReady(what) {
    if (this.state === 'ready') return;
    throw new Error(
      `[vfs] ${what} requires a ready kernel (state: ${this.state})`,
    );
  }

  // A publication that outlives close() stops at its next step.
  #alive() {
    if (this.state === 'closed') throw new Error(CLOSED);
  }

  // --- Lifecycle ---

  async initialize() {
    if (this.state !== 'new') {
      throw new Error(`[vfs] initialize() called in state "${this.state}"`);
    }
    this.state = 'initializing';
    try {
      const { memory } = this.config.global;
      this.cache = new FilesystemCache({
        limit: memory.limit,
        segmentSize: memory.segmentSize,
        maxFileSize: memory.maxFileSize,
        reader: readInto,
      });
      this.compressor = new Compressor({ console: this.console });
      for (const pc of this.config.places) {
        const place = new Place(pc, this.appRoot);
        // Every preparer an enabled place names must exist before anything
        // is read.
        place.preparers = this.preparers.bind(place, true);
        place.store = this.#storeOf(place);
        // Shared places are in every snapshot, even while empty.
        if (SHARED.has(place.provider)) this.cache.index(place.name);
        this.registry.register(place);
      }
      const ep = this.#newEpoch();
      for (const place of this.registry.all()) {
        const files = await this.#originOf(place);
        if (files) await this.#publishAll(ep, place, files);
      }
      this.#flush(ep);
      this.state = 'ready';
    } catch (err) {
      this.close();
      throw err;
    }
    if (this.#watchRequired()) this.watch();
  }

  // Final: stops watching, drops pending work, every projection and every
  // active stream. Nothing reaches the pool afterwards, so the caches go
  // too and the SAB segments become collectable.
  close() {
    this.state = 'closed';
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.rechecks.values()) clearTimeout(timer);
    this.rechecks.clear();
    for (const port of this.links.values()) port.close();
    this.links.clear();
    // Queued mutations reject on the closed kernel; workers learn through
    // the closed port.
    this.mutations.clear();
    // Nothing guards shared bytes any more: active streams stop.
    this.pins.close();
    if (this.mutationClient) this.mutationClient.close(CLOSED);
    // A worker's closed link reads as its exit on the main thread.
    if (this.port) this.port.close();
    this.acks.clear();
    this.retired.clear();
    this.segmentsMap.clear();
    this.sources.clear();
    this.facades.clear();
    for (const place of this.registry.all()) place.files.clear();
    this.cache = null;
    this.compressor = null;
  }

  // --- Providers ---

  // The mutation engine of a place in this thread: a per-thread Map, the
  // main kernel's allocator (sab + virtual) or the link to it (worker).
  // Null when writes go to disk or the place is read-only.
  #storeOf(place) {
    if (place.provider === 'map') return new MapStore(place);
    if (place.provider !== 'sab' || !place.virtual) return null;
    if (this.cache) return new SabStore(place, this);
    return this.mutationClient
      ? new RemoteStore(place, this.mutationClient)
      : null;
  }

  // Raw inputs of a place's origin at init: a disk scan or the embedded SEA
  // assets. Virtual places start empty: their content arrives through fs
  // mutations; disk and node-default places are never indexed.
  async #originOf(place) {
    const { provider } = place;
    if (provider === 'sea') return this.#seaAssets(place);
    if (!INDEXED.has(provider) || place.virtual) return null;
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      followSymlinks: !this.config.global.strict,
    });
    this.sources.set(place.name, new PlaceFiles());
    return files;
  }

  // SEA assets named `<place>/<key>` go through the pipeline once, at init;
  // the place then behaves exactly like a sab place (snapshot, zero-copy,
  // no watcher).
  #seaAssets(place) {
    const sea = this.seaModule || this.#loadSea();
    if (!sea) {
      this.console.warn(
        `[vfs] place "${place.name}": node:sea unavailable; place is empty`,
      );
      return null;
    }
    const assets = new Map();
    const mtimeMs = Date.now();
    const { scanExt } = place.config;
    for (const assetKey of sea.getAssetKeys()) {
      const key = seaKeyOf(assetKey, place.name);
      if (key === null) continue;
      if (scanExt && !scanExt.includes(fileExt(key))) continue;
      const data = Buffer.from(sea.getAsset(assetKey));
      assets.set(key, { data, stat: { size: data.length, mtimeMs } });
    }
    return assets;
  }

  #loadSea() {
    try {
      const sea = require('node:sea');
      return sea.isSea() ? sea : null;
    } catch {
      return null;
    }
  }

  // Init: every file of one origin through the pipeline, largest first (it
  // packs segments better), a few at a time. The first failure stops the
  // rest and aborts initialize(), like any unreadable source.
  async #publishAll(ep, place, files) {
    const queue = [...files].sort((a, b) => b[1].stat.size - a[1].stat.size);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < queue.length) {
        const [key, file] = queue[next++];
        try {
          await this.#publishEntry(ep, place, key, file);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    const size = Math.min(initConcurrency(), queue.length);
    await Promise.all(Array.from({ length: size }, worker));
  }

  // --- Consumer API ---

  // Per-Place file API; only for places with an fs domain on an indexed
  // provider — disk and node-default places are plain node:fs territory.
  fs(name) {
    this.#ensureReady('fs()');
    let facade = this.facades.get(name);
    if (facade) return facade;
    const place = this.registry.get(name);
    if (!place) throw new Error(`[vfs] unknown place "${name}"`);
    if (!place.config.fs)
      throw new Error(`[vfs] place "${name}" has no fs domain`);
    if (!INDEXED.has(place.provider)) {
      throw new Error(
        `[vfs] place "${name}" (${place.provider}) is served by node:fs directly`,
      );
    }
    facade = new PlaceFs(place, this.pins);
    this.facades.set(name, facade);
    return facade;
  }

  // { segments: [{ id, sab }], places: { name: { entries: [[key, entry]] } } }
  // Published entries only: a publication in progress is not part of it.
  snapshot() {
    this.#ensureReady('snapshot()');
    if (!this.cache) throw new Error('[vfs] snapshot() is main-thread only');
    return this.cache.snapshot();
  }

  // Everything a worker needs, ready for `new Worker(file, { workerData:
  // { vfs }, transferList })`: snapshot, config, appRoot and a private
  // MessagePort. Deltas flow to the port, ACKs and releases come back, and
  // the worker's exit closes the port.
  link() {
    const snapshot = this.snapshot();
    const { port1, port2 } = new MessageChannel();
    const id = `link:${++this.nextLinkId}`;
    port1.on('message', (msg) => {
      if (msg?.name === ACK) this.handleAck(msg.updateId, id, msg.retained);
      else if (msg?.name === RELEASE) this.handleRelease(id, msg.retireIds);
      else if (msg?.name === MUTATE) this.#serveMutation(id, port1, msg);
    });
    port1.on('close', () => {
      this.links.delete(id);
      this.handleWorkerExit(id);
    });
    port1.unref();
    this.links.set(id, port1);
    const vfs = {
      snapshot,
      config: this.config.raw,
      appRoot: this.appRoot,
      port: port2,
    };
    return { vfs, transferList: [port2] };
  }

  // Retired versions not yet freed, for diagnostics: which representation
  // is held, by whom, how large, for how long, and whether it still waits
  // for worker ACKs or only for consumers to release it.
  retirements() {
    const now = Date.now();
    const result = [];
    for (const record of this.retired.values()) {
      const { place, key, entry, retiredAt, holders } = record;
      const at = key.indexOf(SEP);
      const pending = this.acks.get(record.updateId)?.pending;
      result.push({
        id: record.id,
        label: labelOf(record),
        place,
        key: at === -1 ? key : key.slice(0, at),
        representation: at === -1 ? 'source' : key.slice(at + 1),
        bytes: entry.length,
        ageMs: now - retiredAt,
        waiting: pending ? 'ack' : 'release',
        pending: pending ? [...pending] : [],
        holders: [...holders],
      });
    }
    return result;
  }

  // --- Virtual places ---

  // Order one mutation against the others: per-key FIFO in arrival order,
  // or an exclusive place barrier when `keys` is null (subtree operations).
  // Worker requests and main-thread writes share the queue, so the state a
  // store validates against is the state its publication is applied to.
  enqueueMutation(place, keys, fn) {
    return this.mutations.run(place.name, keys, () => {
      this.#ensureReady('mutations');
      return fn();
    });
  }

  // Publish one canonical version of a virtual key through the pipeline, as
  // one `vfs-update`. Rejects without publishing anything when a required
  // step fails; no debounce or coalescing — one accepted mutation, one
  // update. Publications of different keys may overlap: allocations stay
  // private until #flush commits them.
  async publishVirtual(place, key, raw) {
    const ep = this.#newEpoch();
    const stat = { size: raw.length, mtimeMs: Date.now() };
    await this.#publishEntry(ep, place, key, { data: raw, stat });
    this.#flush(ep);
  }

  // Retire sources and their companions in one message.
  unpublishVirtual(place, keys) {
    const ep = this.#newEpoch();
    for (const key of keys) this.#unstage(ep, place, key);
    this.#flush(ep);
  }

  // Move a (raw, unprepared) source: the old key and its companions go and
  // the new key is published through the pipeline — prepared when its
  // extension has a preparer — in the same message. The mtime is kept, like
  // a rename on disk. A failure publishes nothing.
  async renameVirtual(place, from, to) {
    const file = place.files.get(from);
    const data = Buffer.from(file.data);
    const ep = this.#newEpoch();
    this.#unstage(ep, place, from);
    const stat = { size: data.length, mtimeMs: file.stat.mtimeMs };
    await this.#publishEntry(ep, place, to, { data, stat });
    this.#flush(ep);
  }

  // Move a subtree whose sources move as they are (subtreeMoves): each
  // source and companion is copied with its stat and mtime under its new
  // key — nothing is prepared, compiled or compressed again — and the old
  // keys go, in one message. The old versions retire like any replaced
  // version; a failure (the pool is full, the kernel closed) publishes
  // nothing.
  async renameVirtualTree(place, moves) {
    const copies = []; // [key, newKey, entry]
    try {
      for (const [key, newKey] of moves) {
        const { data, stat } = place.files.get(key);
        const entry = await this.cache.allocate(
          { data, stat: { ...stat } },
          COMPANION_ALLOC,
        );
        if (!entry) throw new Error(`"${key}" does not fit in SAB`);
        copies.push([key, newKey, entry]);
        this.#alive();
      }
    } catch (err) {
      if (this.cache) for (const [, , entry] of copies) this.cache.free(entry);
      throw err;
    }
    const ep = this.#newEpoch();
    for (const [key, newKey, entry] of copies) {
      this.#stage(ep, place, key, null);
      this.#stage(ep, place, newKey, entry);
    }
    this.#flush(ep);
  }

  // Worker mutation request. The worker's projection is read-only and never
  // authoritative, so place, origin, writability and key are re-validated
  // here before anything is allocated.
  #serveMutation(linkId, port, msg) {
    const reply = (error) => {
      if (!this.links.has(linkId)) return; // worker gone: drop the response
      try {
        port.postMessage({ name: MUTATED, id: msg.id, error });
      } catch {
        // The port closed between the check and the post.
      }
    };
    let result;
    try {
      result = this.#mutate(msg);
    } catch (err) {
      reply(errorOf(err));
      return;
    }
    Promise.resolve(result).then(
      () => reply(null),
      (err) => reply(errorOf(err)),
    );
  }

  #mutate({ place: name, op, key, to, options, data }) {
    if (!OPS.has(op)) throw new Error(`[vfs] unknown mutation "${op}"`);
    const place = this.registry.get(name);
    if (!place) throw new Error(`[vfs] unknown place "${name}"`);
    const canonical = canonicalKey(key);
    if (place.provider !== 'sab' || !place.virtual) {
      const detail = 'not a shared virtual place';
      throw fsError('ENOTSUP', op, place.pathOf(canonical), detail);
    }
    if (!place.config.fs.writable) {
      throw fsError('EROFS', op, place.pathOf(canonical));
    }
    const { store } = place;
    if (op === 'rename') return store.rename(canonical, canonicalKey(to));
    if (op === 'rm') return store.rm(canonical, options || {});
    if (op === 'write' || op === 'append') {
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      return store[op](canonical, bytes);
    }
    return store[op](canonical);
  }

  // --- Adapter API ---
  // Consumed by lib/adapters/*, not by application code: these return raw
  // routing decisions and borrowed views, without the ownership and ext
  // policies PlaceFs applies.

  routeRead(filePath) {
    return this.router.read(filePath);
  }

  routeMutation(filePath) {
    return this.router.mutate(filePath);
  }

  routeCopy(filePath, recursive) {
    return this.router.copy(filePath, recursive);
  }

  routeRename(fromPath, toPath) {
    return this.router.rename(fromPath, toPath);
  }

  routeLink(fromPath, toPath) {
    return this.router.link(fromPath, toPath);
  }

  // appRoot or a directory above it: a native walk from there enters the
  // places past their routing.
  enclosesPlaces(filePath) {
    return this.registry.encloses(filePath);
  }

  // What a strict appRoot lists: the enabled places, sorted.
  rootEntries() {
    return this.registry
      .all()
      .map((place) => place.name)
      .sort();
  }

  // Module lookup for the require / import hooks.
  //   { place, key, file }  published source visible to `domain`
  //   { denied: true }      strict sandbox: nothing published for this path
  //   null                  not ours — default Node loader
  resolveModule(filePath, domain) {
    const route = this.registry.route(filePath);
    if (!route) return null;
    const { place, key } = route;
    const denied = this.config.global.strict ? { denied: true } : null;
    if (!place) return denied;
    if (place.provider === 'node-default') return null;
    if (!place.config[domain]) return denied;
    if (place.provider === 'disk') return null;
    const file = place.files.get(key);
    if (!file || !place.visible(domain, key) || file.data === null)
      return denied;
    return { place, key, file };
  }

  // Borrowed SAB view of the V8 cached data for a CommonJS source, or null.
  // The compile hook hands it straight to `vm.Script` and drops it.
  bytecode(filePath) {
    const route = this.registry.route(filePath);
    return route?.place ? route.place.bytecode(route.key) : null;
  }

  // --- Watch ---

  // A disk-origin place that accepts writes must watch them back in: the
  // mutation lands on disk, the watcher republishes it.
  #watchRequired() {
    if (this.config.global.watch) return true;
    return this.config.places.some(
      (pc) => pc.origin === 'disk' && pc.fs?.writable,
    );
  }

  watch() {
    this.#ensureReady('watch()');
    if (this.watcher || this.sources.size === 0) return;
    this.watcher = new DirWatcher({ timeout: this.config.global.watchTimeout });
    this.watcher.on('error', (err) =>
      this.console.error(`[vfs] watcher: ${err.message}`),
    );
    this.watcher.on('epoch', (events) => {
      this.#serial('epoch', () => this.#handleEpoch(events));
    });
    for (const name of this.sources.keys()) {
      this.watcher.watch(this.registry.get(name).root);
    }
  }

  // Epochs and rechecks run strictly one after another, in arrival order:
  // an older epoch can never publish over a newer one. A task that finds the
  // kernel closed does nothing; a failing one is logged and does not hold up
  // the next. Deliberately separate from the mutation queue of virtual
  // places, which never share a key with a watched place.
  #serial(what, task) {
    this.watchQueue
      .run(() => (this.ready ? task() : undefined))
      .catch((err) => {
        if (this.ready) this.console.error(`[vfs] ${what}: ${err.message}`);
      });
  }

  #newEpoch() {
    return {
      changes: new Map(), // place name → Map<key, entry | null>
      seen: new Set(),
    };
  }

  async #handleEpoch(events) {
    const ep = this.#newEpoch();
    const jobs = [];
    for (const [filePath, event] of events) {
      const route = this.registry.route(filePath);
      if (!route?.place || !this.sources.has(route.place.name)) continue;
      const { place, key } = route;
      if (event === 'delete') jobs.push(this.#remove(ep, place, key, filePath));
      else if (event === 'scan') jobs.push(this.#rescan(ep, place, filePath));
      else jobs.push(this.#refresh(ep, place, key, filePath, true));
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected')
        this.console.error(`[vfs] update: ${r.reason.message}`);
    }
    this.#flush(ep);
  }

  // A delete event can describe a path that exists again: delete and re-create
  // inside one debounce window are two stats racing on the threadpool, and the
  // ENOENT one may land last. Re-check before unpublishing a live file.
  async #remove(ep, place, key, filePath) {
    const stats = await stat(filePath).catch(() => null);
    if (!stats) {
      this.#unpublish(ep, place, key, filePath);
      return;
    }
    if (stats.isDirectory()) await this.#rescan(ep, place, filePath);
    else await this.#refresh(ep, place, key, filePath, true);
  }

  // New files that appeared with a directory (move-in, unzip, mkdir -p).
  async #rescan(ep, place, dirPath) {
    const source = this.sources.get(place.name);
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      startPath: dirPath,
      followSymlinks: !this.config.global.strict,
    });
    for (const [key, file] of files) {
      if (!source.has(key)) await this.#publish(ep, place, key, file, true);
    }
  }

  async #refresh(ep, place, key, filePath, retry) {
    const { scanExt } = place.config;
    if (scanExt && !scanExt.includes(fileExt(key))) return;
    const stats = await stat(filePath).catch(() => null);
    if (!stats) {
      this.#unpublish(ep, place, key, filePath);
      return;
    }
    if (!stats.isFile()) return;
    const file = {
      path: filePath,
      stat: { size: stats.size, mtimeMs: stats.mtimeMs },
    };
    await this.#publish(ep, place, key, file, retry);
  }

  // A watched source that cannot be read consistently, that its preparer
  // rejects, that fs.script cannot compile or whose canonical form does not
  // fit in SAB keeps its previous version and companions; one deferred
  // recheck follows, then only a real event retries.
  // A directory rescan and a file event may both reach a key: first wins.
  async #publish(ep, place, key, file, retry) {
    const seen = `${place.name}\0${key}`;
    if (ep.seen.has(seen)) return;
    ep.seen.add(seen);
    try {
      await this.#publishEntry(ep, place, key, file);
    } catch (err) {
      if (this.state === 'closed') return;
      this.console.warn(
        `[vfs] place "${place.name}": "${key}" not published — ${err.message}`,
      );
      if (retry) this.#scheduleRecheck(place, key, file.path);
    }
  }

  // Delete a file or a whole subtree (key '' is the place root).
  #unpublish(ep, place, key, filePath) {
    const source = this.sources.get(place.name);
    const gone = source.has(key) ? [key] : [];
    for (const [k, isDirectory] of source.below(dirOf(key))) {
      if (!isDirectory) gone.push(k);
    }
    for (const k of gone) {
      source.delete(k);
      this.#cancelRecheck(place.pathOf(k));
      if (place.provider === 'map') place.store.remove(k);
      else this.#unstage(ep, place, k);
    }
    this.#cancelRecheck(filePath);
  }

  #scheduleRecheck(place, key, filePath) {
    if (this.rechecks.has(filePath)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(filePath);
      this.#serial('recheck', async () => {
        const ep = this.#newEpoch();
        await this.#refresh(ep, place, key, filePath, false);
        this.#flush(ep);
      });
    }, this.config.global.watchTimeout);
    timer.unref();
    this.rechecks.set(filePath, timer);
  }

  #cancelRecheck(filePath) {
    const timer = this.rechecks.get(filePath);
    if (!timer) return;
    clearTimeout(timer);
    this.rechecks.delete(filePath);
  }

  // --- Publication pipeline ---

  // One source, whatever produced its raw input (scan, watcher, SEA asset,
  // virtual write): canonical input — the preparer of its extension runs
  // exactly once — then storage and companions, staged into `ep`. Throws
  // instead of warning, so init and virtual mutations can fail; nothing
  // partial is ever staged. `file` is the source record the watcher tracks.
  async #publishEntry(ep, place, key, file) {
    const input = await this.#input(place, key, file);
    this.#alive();
    if (place.provider === 'map') place.store.publish(key, input);
    else await this.#storeShared(ep, place, key, input);
    this.sources.get(place.name)?.set(key, file);
  }

  // The FileInput to store: the raw `{ path, stat }` when the place keeps it
  // untouched (the SAB reader streams it from disk straight into its
  // segment), else `{ data, stat, scriptOptions?, meta? }` — a Map place owns
  // its bytes, and a prepared source is whatever its preparer returned.
  async #input(place, key, file) {
    const prepare = place.preparerOf(key);
    if (!prepare && place.provider !== 'map') return file;
    let raw = file.data;
    if (!raw) {
      raw = Buffer.allocUnsafe(file.stat.size);
      await this.cache.reader(file, raw);
    }
    if (!prepare) return { data: raw, stat: file.stat };
    return prepareInput(place, key, file, raw, prepare);
  }

  // Path-less inputs (prepared sources, SEA assets, virtual writes) must
  // land in SAB or not be published at all — a disk fallback would point at
  // a raw file, or at nothing. With `retainRaw: false` the source of a
  // compressed file lives on disk only.
  #allocOptions(place, key, input) {
    const compress = place.config.fs?.compress;
    const onDisk =
      Boolean(compress) &&
      !compress.retainRaw &&
      this.compressor.compressible(place, key);
    return {
      maxFileSize: place.config.maxFileSize,
      fallback: Boolean(input.path),
      onDisk,
    };
  }

  // SAB storage of one canonical input: the source, its bytecode flavors and
  // compressed representations, staged together into `ep`. Allocations stay
  // private until #flush commits them, so a failure only frees this
  // attempt's own bytes — the published version and its companions stay.
  async #storeShared(ep, place, key, input) {
    const allocated = []; // [key, entry] in staging order
    const dropped = []; // stale companion keys
    try {
      const options = this.#allocOptions(place, key, input);
      const entry = await this.cache.allocate(input, options);
      if (!entry) throw new Error('canonical source does not fit in SAB');
      allocated.push([key, entry]);
      this.#alive();
      await this.#bytecode(place, key, entry, input, allocated, dropped);
      await this.#compress(place, key, entry, allocated, dropped);
      this.#alive();
    } catch (err) {
      if (this.cache) for (const [, entry] of allocated) this.cache.free(entry);
      throw err;
    }
    for (const [k, entry] of allocated) this.#stage(ep, place, k, entry);
    for (const k of dropped) this.#stage(ep, place, k, null);
  }

  // Cached data of a freshly allocated canonical source, built from the
  // bytes just placed. A script flavor that does not compile or does not fit
  // invalidates the whole publication; a require flavor is best-effort and
  // only drops its stale companion.
  async #bytecode(place, key, entry, input, allocated, dropped) {
    if (bytecodeDomains(place, key).length === 0) return;
    const src = await this.#entryBytes(place, key, entry);
    if (!src) throw new Error(`cannot read "${key}" to compile`);
    for (const code of bytecodeFor(place, key, src, input.scriptOptions)) {
      const stat = code.data
        ? { size: code.data.length, mtimeMs: entry.stat.mtimeMs }
        : null;
      const companion = code.data
        ? await this.cache.allocate({ data: code.data, stat }, COMPANION_ALLOC)
        : null;
      if (companion) allocated.push([code.key, companion]);
      else if (code.domain === 'script') {
        const reason = code.data ? 'does not fit in SAB' : 'does not compile';
        throw new Error(`fs.script.compile: source ${reason}`);
      } else dropped.push(code.key);
    }
  }

  // Compressed representations; a codec that fails or does not fit drops
  // only its own stale companion.
  async #compress(place, key, entry, allocated, dropped) {
    if (!this.compressor.compressible(place, key)) return;
    const src = await this.#entryBytes(place, key, entry);
    const codecs = place.config.fs.compress.codecs;
    const built = src
      ? await this.compressor.compress(place, key, src)
      : codecs.map(({ encoding }) => ({ encoding, data: null }));
    this.#alive();
    for (const { encoding, data } of built) {
      const companionKey = compressedKey(key, encoding);
      const stat = data && {
        size: data.length,
        sourceSize: entry.stat.size,
        encoding,
        mtimeMs: entry.stat.mtimeMs,
      };
      const companion = data
        ? await this.cache.allocate({ data, stat }, COMPANION_ALLOC)
        : null;
      if (companion) allocated.push([companionKey, companion]);
      else {
        if (data) {
          this.compressor.warn(
            place,
            key,
            encoding,
            'does not fit in one SAB segment',
          );
        }
        dropped.push(companionKey);
      }
    }
  }

  // Bytes of a just-allocated entry: its SAB view, or a disk read for an
  // entry kept on disk (oversize, retainRaw: false).
  async #entryBytes(place, key, entry) {
    if (entry.kind === 'shared') {
      if (entry.length === 0) return Buffer.alloc(0);
      const { sab } = this.cache.getSegment(entry.segmentId);
      return Buffer.from(sab, entry.offset, entry.length);
    }
    try {
      return await readFile(entry.path);
    } catch (err) {
      this.console.warn(
        `[vfs] place "${place.name}": cannot read "${key}" — ${err.message}`,
      );
      return null;
    }
  }

  // Record one change of `ep`: an entry to publish, or null to unpublish. A
  // provisional entry superseded within the same epoch was never visible to
  // anyone and is freed at once.
  #stage(ep, place, key, entry) {
    let changes = ep.changes.get(place.name);
    if (!changes) ep.changes.set(place.name, (changes = new Map()));
    const previous = changes.get(key);
    if (previous) this.cache.free(previous);
    changes.set(key, entry);
  }

  // Stage the removal of a source and of every companion it may have.
  #unstage(ep, place, key) {
    this.#stage(ep, place, key, null);
    for (const companion of place.companions(key)) {
      this.#stage(ep, place, companion, null);
    }
  }

  // Commit `ep` in one step and tell every thread: the index takes the
  // changes, every shared version they replace or remove is retired under a
  // fresh retireId, and one `vfs-update` carries it all — source and
  // companions of a file never travel apart. Before initialize() completes
  // there is no link to tell; a closed kernel publishes nothing.
  #flush(ep) {
    if (this.state === 'closed') return;
    const places = {};
    const segments = new Set();
    const retired = [];
    const retiredAt = Date.now();
    for (const [name, changes] of ep.changes) {
      const entries = [];
      const removals = [];
      const retiring = [];
      for (const [key, entry] of changes) {
        const old = entry
          ? this.cache.put(name, key, entry)
          : this.cache.remove(name, key);
        if (entry) {
          entries.push([key, entry]);
          if (entry.kind === 'shared' && entry.length > 0) {
            segments.add(entry.segmentId);
          }
        } else if (old) {
          removals.push(key);
        }
        if (old?.kind === 'shared' && old.length > 0) {
          const id = ++this.nextRetireId;
          const holders = new Set();
          retiring.push([key, id]);
          retired.push({
            id,
            place: name,
            key,
            entry: old,
            retiredAt,
            holders,
          });
        }
      }
      if (entries.length > 0 || removals.length > 0) {
        places[name] = { entries, removals, retired: retiring };
      }
    }
    if (Object.keys(places).length === 0) return;
    const updateId = ++this.nextUpdateId;
    for (const record of retired) {
      record.updateId = updateId;
      this.retired.set(record.id, record);
    }
    const newSegments = [];
    for (const id of segments) {
      newSegments.push({ id, sab: this.cache.getSegment(id).sab });
    }
    const msg = { name: UPDATE, updateId, places, newSegments };
    for (const id of this.#apply(msg)) this.retired.get(id).holders.add(MAIN);
    for (const port of this.links.values()) port.postMessage(msg);
    this.#track(updateId, retired);
  }

  // Apply one update to this thread's projection. Retired versions a local
  // consumer still reads are bound to their retireId before the projection
  // drops them; returns those ids.
  #apply({ places, newSegments }) {
    for (const { id, sab } of newSegments || []) this.segmentsMap.set(id, sab);
    const retained = [];
    for (const [name, { entries, removals, retired }] of Object.entries(
      places,
    )) {
      const place = this.registry.get(name);
      if (!place) continue;
      const { files } = place;
      for (const [key, id] of retired || []) {
        if (this.pins.retain(files.get(key), id)) retained.push(id);
      }
      for (const [key, entry] of entries) {
        files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
      }
      for (const key of removals) files.delete(key);
    }
    return retained;
  }

  // --- Retirement: ACK-before-free ---

  // Retired versions wait for the ACK of every live worker; with none, only
  // for this thread's own consumers.
  #track(updateId, retired) {
    if (retired.length === 0) return;
    if (this.links.size > 0) {
      const pending = new Set(this.links.keys());
      this.acks.set(updateId, { pending, retired });
      return;
    }
    this.#settle(retired);
  }

  // A worker applied `updateId`. `retained` lists the retired versions it
  // still reads; they are held before its ACK can free anything.
  handleAck(updateId, linkId, retained) {
    for (const id of retained || []) this.retired.get(id)?.holders.add(linkId);
    const ack = this.acks.get(updateId);
    if (!ack || !ack.pending.delete(linkId) || ack.pending.size > 0) return;
    this.acks.delete(updateId);
    this.#settle(ack.retired);
  }

  // The last consumer of these retired versions in one thread is done.
  handleRelease(holder, retireIds) {
    const done = [];
    for (const id of retireIds || []) {
      const record = this.retired.get(id);
      if (record?.holders.delete(holder)) done.push(record);
    }
    this.#settle(done);
  }

  // A worker is gone: it will neither ACK nor read anything any more.
  handleWorkerExit(linkId) {
    const done = [];
    for (const [updateId, ack] of this.acks) {
      if (!ack.pending.delete(linkId) || ack.pending.size > 0) continue;
      this.acks.delete(updateId);
      done.push(...ack.retired);
    }
    for (const record of this.retired.values()) {
      if (record.holders.delete(linkId)) done.push(record);
    }
    this.#settle(done);
  }

  // Free every record neither an ACK nor a consumer holds any more, then
  // compact once. Nothing is ever freed on a timeout.
  #settle(records) {
    if (!this.cache) return;
    let freed = false;
    for (const record of records) {
      if (record.holders.size > 0 || this.acks.has(record.updateId)) continue;
      if (!this.retired.delete(record.id)) continue; // freed already
      this.cache.free(record.entry);
      freed = true;
    }
    if (freed) this.#compact();
  }

  // At most one relocation per free cycle: the moves are published like any
  // change, and their old locations are retired like any replaced version —
  // a consumer still reading one keeps it.
  #compact() {
    const moves = this.cache.compact(this.config.global.compaction.threshold);
    if (!moves) return;
    const ep = this.#newEpoch();
    for (const { name, key, entry } of moves) {
      this.#stage(ep, this.registry.get(name), key, entry);
    }
    this.#flush(ep);
  }

  // --- Worker side ---

  // Worker projection of `snapshot`. With `port` (the link end from
  // `link()`, wired by attach()) it applies deltas, ACKs them, releases
  // retired versions and sends mutations of shared virtual places. Only
  // local Map writes prepare in a worker: a preparer missing from
  // `options.preparers` fails such a write, never the projection.
  static fromSnapshot(snapshot, config, options = {}) {
    const kernel = new VfsKernel(config, options);
    for (const { id, sab } of snapshot?.segments || []) {
      kernel.segmentsMap.set(id, sab);
    }
    if (options.port) kernel.#connect(options.port);
    for (const pc of config.places) {
      const place = new Place(pc, kernel.appRoot);
      place.preparers = kernel.preparers.bind(place, false);
      place.store = kernel.#storeOf(place);
      const index = SHARED.has(pc.provider)
        ? snapshot?.places?.[pc.name]
        : null;
      if (index) {
        FilesystemCache.project(index, kernel.segmentsMap, place.files);
      }
      kernel.registry.register(place);
    }
    kernel.state = 'ready';
    return kernel;
  }

  #connect(port) {
    this.port = port;
    this.mutationClient = new MutationClient(port);
    this.pins = new Pins((retireIds) =>
      port.postMessage({ name: RELEASE, retireIds }),
    );
    port.on('message', (msg) => {
      if (msg?.name !== UPDATE) return void this.mutationClient.handle(msg);
      const retained = this.handleDelta(msg);
      const ack = { name: ACK, updateId: msg.updateId };
      if (retained.length > 0) ack.retained = retained;
      port.postMessage(ack);
    });
    // The main kernel is gone: nothing can be published any more.
    port.on('close', () => this.mutationClient.close());
    port.unref();
  }

  // Apply a `vfs-update`; returns the retireIds this thread still reads,
  // which its ACK must carry.
  handleDelta(msg) {
    return msg?.name === UPDATE ? this.#apply(msg) : [];
  }
}

module.exports = { VfsKernel, KERNEL, readInto };
