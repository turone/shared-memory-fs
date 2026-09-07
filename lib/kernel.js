'use strict';

const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const { fileExt } = require('metautil');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { open, readFile, stat } = require('node:fs/promises');
const { FilesystemCache } = require('./cache.js');
const { ModuleCache, createBytecode } = require('./module-cache.js');
const { CompressionCache } = require('./compression-cache.js');
const { bytecodeKey, compressedKey } = require('./companion.js');
const { PlaceRegistry, FsRouter } = require('./registry.js');
const { Place } = require('./place.js');
const { PlaceFs } = require('./place-fs.js');
const { MemoryStore } = require('./memory-store.js');
const { DirWatcher } = require('./watcher.js');
const { scan } = require('./scanner.js');
const { INDEXED, SHARED } = require('./config.js');

// VfsKernel — orchestrator and consumer facade.
// Main thread: scans places into pooled SAB segments, builds bytecode and
// compressed companions, watches for changes and broadcasts `vfs-update`
// deltas; frees replaced bytes only after every live worker ACKs.
// Worker thread: `VfsKernel.fromSnapshot()` projects the same segments
// read-only and applies deltas through `handleDelta()`.
// States: new → initializing → ready → closed (final).

const KERNEL = Symbol.for('shared-memory-fs');

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

// Map a SEA asset key to a place key: `<name>/<rest>` → `/<rest>`.
const seaKeyOf = (assetKey, name) =>
  assetKey.startsWith(name + '/') ? assetKey.substring(name.length) : null;

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
    this.broadcast = options.broadcast || (() => {});
    this.getWorkerIds = options.getWorkerIds || (() => []);
    // Injected node:sea-compatible module, for tests.
    this.seaModule = options.seaModule || null;
    this.state = 'new';

    this.registry = new PlaceRegistry(this.appRoot);
    this.router = new FsRouter(this.registry, config.global.strict);
    this.facades = new Map(); // name → PlaceFs

    this.cache = null;
    this.moduleCache = null;
    this.compressionCache = null;
    this.segmentsMap = new Map(); // segmentId → SAB
    this.sources = new Map(); // name → Map<key, FileInput> (sab places)

    this.watcher = null;
    this.rechecks = new Map(); // absPath → Timeout
    this.links = new Map(); // linkId → MessagePort (workers created via link())
    this.nextLinkId = 0;
    this.nextUpdateId = 0;
    this.pendingFrees = new Map(); // updateId → { workerIds, entries }
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
      const projectInto = (place, key, entry) =>
        this.#projectInto(place, key, entry);
      this.moduleCache = new ModuleCache({ cache: this.cache, projectInto });
      this.compressionCache = new CompressionCache({
        cache: this.cache,
        projectInto,
        console: this.console,
      });
      for (const pc of this.config.places) {
        const place = new Place(pc, this.appRoot);
        if (pc.provider === 'sab') await this.#initSab(place);
        else if (pc.provider === 'sea') await this.#initSea(place);
        else if (pc.provider === 'memory') this.#initMemory(place);
        this.registry.register(place);
      }
      for (const place of this.registry.all()) {
        if (!SHARED.has(place.provider)) continue;
        if (place.config.require?.compile)
          await this.moduleCache.compilePlace(place);
        if (place.config.fs?.compress) {
          const readSource = (key) => this.#sourceOf(place, key);
          await this.compressionCache.compressPlace(place, readSource);
        }
      }
      this.state = 'ready';
    } catch (err) {
      this.close();
      throw err;
    }
    if (this.#watchRequired()) this.watch();
  }

  // Final: stops watching, drops pending work and every projection. Nothing
  // reaches the pool afterwards (watcher stopped, ACK queue empty), so the
  // caches go too and the SAB segments become collectable.
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
    this.pendingFrees.clear();
    this.segmentsMap.clear();
    this.sources.clear();
    this.facades.clear();
    for (const place of this.registry.all()) place.files.clear();
    this.cache = null;
    this.moduleCache = null;
    this.compressionCache = null;
  }

  // --- Providers ---

  #allocOptions(place) {
    return {
      store: this.#storePredicate(place),
      maxFileSize: place.config.maxFileSize,
    };
  }

  // With `retainRaw: false` the source of a compressed file lives on disk
  // only; every other file keeps its raw bytes in SAB.
  #storePredicate(place) {
    const compress = place.config.fs?.compress;
    if (!compress || compress.retainRaw) return null;
    return (key) => !this.compressionCache.compressible(place, key);
  }

  async #initSab(place) {
    const files = await scan(place.root, {
      ext: place.config.scanExt,
      followSymlinks: !this.config.global.strict,
    });
    this.sources.set(place.name, files);
    await this.cache.load(place.name, files, this.#allocOptions(place));
    this.#project(place);
  }

  // SEA assets named `<place>/<key>` are loaded into SAB at init and then
  // behave exactly like a sab place (snapshot, zero-copy, no watcher).
  async #initSea(place) {
    const sea = this.seaModule || this.#loadSea();
    if (!sea) {
      this.console.warn(
        `[vfs] place "${place.name}": node:sea unavailable; place is empty`,
      );
      return;
    }
    const files = new Map();
    const mtimeMs = Date.now();
    const { scanExt } = place.config;
    for (const assetKey of sea.getAssetKeys()) {
      const key = seaKeyOf(assetKey, place.name);
      if (key === null) continue;
      if (scanExt && !scanExt.includes(fileExt(key))) continue;
      const data = Buffer.from(sea.getAsset(assetKey));
      files.set(key, { data, stat: { size: data.length, mtimeMs } });
    }
    await this.cache.load(place.name, files, {
      maxFileSize: place.config.maxFileSize,
    });
    this.#project(place);
  }

  #loadSea() {
    try {
      const sea = require('node:sea');
      return sea.isSea() ? sea : null;
    } catch {
      return null;
    }
  }

  // Memory places are per-thread and isolated: each thread owns an empty
  // instance, writes never leave it, nothing is broadcast.
  #initMemory(place) {
    place.store = new MemoryStore(place, { bytecode: createBytecode });
  }

  // --- Projection ---

  #project(place) {
    const index = this.cache.indexes.get(place.name);
    if (!index) return;
    for (const id of index.segmentIds) this.#registerSegment(id);
    place.files = FilesystemCache.project(index, this.segmentsMap);
  }

  #projectInto(place, key, entry) {
    if (entry.kind === 'shared') this.#registerSegment(entry.segmentId);
    place.files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
  }

  #registerSegment(id) {
    if (this.segmentsMap.has(id)) return;
    const segment = this.cache.getSegment(id);
    if (segment) this.segmentsMap.set(id, segment.sab);
  }

  // Source bytes of a projected key: SAB view, or a disk read for entries
  // kept out of SAB (retainRaw: false).
  async #sourceOf(place, key) {
    const file = place.files.get(key);
    if (!file) return null;
    if (file.data) return file.data;
    try {
      return await readFile(file.path);
    } catch (err) {
      this.console.warn(
        `[vfs] place "${place.name}": cannot read "${key}" — ${err.message}`,
      );
      return null;
    }
  }

  // Bytes of a just-allocated entry: SAB view, or a disk read for entries
  // left on disk (oversize, retainRaw: false).
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
    facade = new PlaceFs(place);
    this.facades.set(name, facade);
    return facade;
  }

  // { segments: [{ id, sab }], places: { name: { entries: [[key, entry]] } } }
  snapshot() {
    this.#ensureReady('snapshot()');
    if (!this.cache) throw new Error('[vfs] snapshot() is main-thread only');
    return this.cache.snapshot();
  }

  // Everything a worker needs, ready for `new Worker(file, { workerData:
  // { vfs }, transferList })`: snapshot, config, appRoot and a private
  // MessagePort. Deltas flow to the port, ACKs come back, and the worker's
  // exit closes the port — no manual broadcast / getWorkerIds plumbing.
  link() {
    const snapshot = this.snapshot();
    const { port1, port2 } = new MessageChannel();
    const id = `link:${++this.nextLinkId}`;
    port1.on('message', (msg) => {
      if (msg?.name === 'ack-update') this.handleAck(msg.updateId, id);
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

  // --- Adapter API ---

  routeRead(filePath) {
    return this.router.read(filePath);
  }

  routeMutation(filePath) {
    return this.router.mutate(filePath);
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

  bytecode(filePath) {
    const route = this.registry.route(filePath);
    return route?.place ? route.place.bytecode(route.key) : null;
  }

  // --- Watch ---

  #watchRequired() {
    if (this.config.global.watch) return true;
    return this.config.places.some(
      (pc) => pc.provider === 'sab' && pc.fs?.writable,
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
      this.#handleEpoch(events).catch((err) =>
        this.console.error(`[vfs] epoch: ${err.message}`),
      );
    });
    for (const name of this.sources.keys()) {
      this.watcher.watch(this.registry.get(name).root);
    }
  }

  #newEpoch() {
    return {
      updates: new Map(),
      segmentIds: new Set(),
      old: [],
      seen: new Set(),
    };
  }

  #group(ep, place) {
    let group = ep.updates.get(place.name);
    if (!group)
      ep.updates.set(place.name, (group = { entries: [], removals: [] }));
    return group;
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

  // One pipeline for every new or changed source: stable raw read → bytecode
  // → compressed representations, all staged into the same epoch. A source
  // that cannot be read consistently keeps its previous version and
  // companions; one deferred recheck follows, then only a real event retries.
  // A directory rescan and a file event may both reach a key: first wins.
  async #publish(ep, place, key, file, retry) {
    const seen = `${place.name}\0${key}`;
    if (ep.seen.has(seen)) return;
    ep.seen.add(seen);
    const oldEntry = this.cache.entry(place.name, key);
    let entry;
    try {
      entry = await this.cache.allocate(
        place.name,
        key,
        file,
        this.#allocOptions(place),
      );
    } catch (err) {
      this.console.warn(
        `[vfs] place "${place.name}": "${key}" not published — ${err.message}`,
      );
      if (retry) this.#scheduleRecheck(place, key, file.path);
      return;
    }
    this.sources.get(place.name).set(key, file);
    this.#stage(ep, place, key, entry, oldEntry);

    if (this.moduleCache.compilable(place, key)) {
      const result =
        entry.kind === 'shared'
          ? await this.moduleCache.compileFromEntry(place, key, entry)
          : { key: bytecodeKey(key), entry: null };
      if (result.entry)
        this.#stage(ep, place, result.key, result.entry, result.oldEntry);
      else this.#retire(ep, place, result.key);
    }

    if (this.compressionCache.compressible(place, key)) {
      const src = await this.#entryBytes(place, key, entry);
      const { built, failed } = src
        ? await this.compressionCache.compressBuffer(
            place,
            key,
            src,
            entry.stat,
          )
        : {
            built: [],
            failed: place.config.fs.compress.codecs.map((c) => c.encoding),
          };
      for (const b of built) this.#stage(ep, place, b.key, b.entry, b.oldEntry);
      for (const encoding of failed)
        this.#retire(ep, place, compressedKey(key, encoding));
    }
  }

  #stage(ep, place, key, entry, oldEntry) {
    this.#group(ep, place).entries.push([key, entry]);
    if (entry.kind === 'shared') ep.segmentIds.add(entry.segmentId);
    if (oldEntry?.kind === 'shared') ep.old.push(oldEntry);
  }

  // Remove a stale entry in the same message as the new source: a separate
  // delete would leave a window where workers see a new source next to an
  // old companion.
  #retire(ep, place, key) {
    const stale = this.cache.remove(place.name, key);
    if (!stale) return;
    this.#group(ep, place).removals.push(key);
    if (stale.kind === 'shared') ep.old.push(stale);
  }

  *#companionsOf(place, key) {
    if (place.config.require?.compile) yield bytecodeKey(key);
    for (const { encoding } of place.config.fs?.compress?.codecs || []) {
      yield compressedKey(key, encoding);
    }
  }

  // Delete a file or a whole subtree (key '' is the place root).
  #unpublish(ep, place, key, filePath) {
    const source = this.sources.get(place.name);
    const prefix = key.endsWith('/') ? key : key + '/';
    for (const k of [...source.keys()]) {
      if (k !== key && !k.startsWith(prefix)) continue;
      source.delete(k);
      this.#cancelRecheck(place.pathOf(k));
      this.#retire(ep, place, k);
      for (const companion of this.#companionsOf(place, k))
        this.#retire(ep, place, companion);
    }
    this.#cancelRecheck(filePath);
  }

  #scheduleRecheck(place, key, filePath) {
    if (this.rechecks.has(filePath)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(filePath);
      const ep = this.#newEpoch();
      this.#refresh(ep, place, key, filePath, false)
        .then(() => this.#flush(ep))
        .catch((err) => this.console.error(`[vfs] recheck: ${err.message}`));
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

  // --- Broadcast + projection ---

  // One `vfs-update` per epoch: every place's entries and removals travel
  // together, workers apply them synchronously and send one ACK.
  #flush(ep) {
    const places = {};
    for (const [name, group] of ep.updates) {
      if (group.entries.length || group.removals.length) places[name] = group;
    }
    if (Object.keys(places).length === 0) return;
    const newSegments = [];
    for (const id of ep.segmentIds)
      newSegments.push({ id, sab: this.cache.getSegment(id).sab });
    const updateId = ++this.nextUpdateId;
    this.#send({ name: 'vfs-update', updateId, places, newSegments });
    if (ep.old.length > 0) this.#track(updateId, ep.old);
  }

  #send(msg) {
    try {
      this.#apply(msg);
    } catch (err) {
      this.console.error(`[vfs] projection error: ${err.message}`);
    }
    for (const port of this.links.values()) port.postMessage(msg);
    try {
      this.broadcast(msg);
    } catch (err) {
      this.console.error(`[vfs] broadcast callback error: ${err.message}`);
    }
  }

  #apply({ places, newSegments }) {
    for (const { id, sab } of newSegments || []) this.segmentsMap.set(id, sab);
    for (const [name, { entries, removals }] of Object.entries(places)) {
      const place = this.registry.get(name);
      if (!place) continue;
      for (const [key, entry] of entries) {
        place.files.set(
          key,
          FilesystemCache.projectEntry(entry, this.segmentsMap),
        );
      }
      for (const key of removals) place.files.delete(key);
    }
  }

  // --- ACK + compaction ---

  handleAck(updateId, workerId) {
    const pending = this.pendingFrees.get(updateId);
    if (!pending) return;
    pending.workerIds.delete(workerId);
    if (pending.workerIds.size > 0) return;
    this.pendingFrees.delete(updateId);
    this.#free(pending.entries);
  }

  handleWorkerExit(workerId) {
    const done = [];
    for (const [updateId, pending] of this.pendingFrees) {
      pending.workerIds.delete(workerId);
      if (pending.workerIds.size === 0) done.push(updateId);
    }
    for (const updateId of done) {
      const { entries } = this.pendingFrees.get(updateId);
      this.pendingFrees.delete(updateId);
      this.#free(entries, workerId);
    }
  }

  #track(updateId, entries, goneId) {
    const workerIds = new Set([...this.getWorkerIds(), ...this.links.keys()]);
    if (goneId) workerIds.delete(goneId);
    if (workerIds.size === 0) {
      this.#free(entries, goneId);
      return;
    }
    this.pendingFrees.set(updateId, { workerIds, entries });
  }

  #free(entries, goneId) {
    for (const entry of entries) this.cache.free(entry);
    this.#compact(goneId);
  }

  // At most one relocation per free cycle; its old bytes are tracked against
  // the ACK of the message that moved them.
  #compact(goneId) {
    const result = this.cache.compact(this.config.global.compaction.threshold);
    if (!result) return;
    const places = {};
    for (const { name, key, entry } of result.updates) {
      const group =
        places[name] || (places[name] = { entries: [], removals: [] });
      group.entries.push([key, entry]);
    }
    const updateId = ++this.nextUpdateId;
    this.#send({
      name: 'vfs-update',
      updateId,
      places,
      newSegments: result.newSegments,
    });
    this.#track(updateId, result.oldEntries, goneId);
  }

  // --- Worker side ---

  static fromSnapshot(snapshot, config, options = {}) {
    const kernel = new VfsKernel(config, options);
    for (const { id, sab } of snapshot?.segments || [])
      kernel.segmentsMap.set(id, sab);
    for (const pc of config.places) {
      const place = new Place(pc, kernel.appRoot);
      if (pc.provider === 'memory') kernel.#initMemory(place);
      const index = SHARED.has(pc.provider)
        ? snapshot?.places?.[pc.name]
        : null;
      if (index)
        place.files = FilesystemCache.project(index, kernel.segmentsMap);
      kernel.registry.register(place);
    }
    kernel.state = 'ready';
    return kernel;
  }

  handleDelta(msg) {
    if (msg.name === 'vfs-update') this.#apply(msg);
  }
}

module.exports = { VfsKernel, KERNEL, readInto };
