'use strict';

const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const { fileExt } = require('metautil');
// Captured at load time: the kernel must keep seeing the real disk even after
// fs-patch installs the strict sandbox on node:fs.
const { open, readFile, stat } = require('node:fs/promises');
const { FilesystemCache } = require('./cache.js');
const { CompressionCache } = require('./compression-cache.js');
const { compressedKey } = require('./companion.js');
const { PlaceRegistry, FsRouter } = require('./registry.js');
const { Place, canonicalKey } = require('./place.js');
const { PlaceFs } = require('./place-fs.js');
const { MapStore } = require('./map-store.js');
const { SabStore } = require('./sab-store.js');
const { MutationQueue } = require('./mutation-queue.js');
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
// assets or application mutations of a virtual place), runs preparers for
// fs.script sources, builds bytecode and compressed companions, watches
// disk-origin places for changes and broadcasts `vfs-update` deltas; frees
// replaced bytes only after every live worker ACKs.
// Worker thread: `VfsKernel.fromSnapshot()` projects the same segments
// read-only, applies deltas through `handleDelta()` and sends mutations of
// shared virtual places back over the link port.
// States: new → initializing → ready → closed (final).

const KERNEL = Symbol.for('shared-memory-fs');

// Companions are bounded by the segment size only, never by maxFileSize,
// and never fall back to a disk entry pointing at the raw file.
const COMPANION_ALLOC = { fallback: false, maxFileSize: Infinity };

const NOOP = () => {};

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

// The same stable read into a fresh Buffer — raw input for a preparer.
const readRaw = async (file) => {
  const raw = Buffer.allocUnsafe(file.stat.size);
  await readInto(file, raw);
  return raw;
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
    // Callbacks named by `places.<name>.fs.script.prepare`; main thread only.
    this.preparers = new Preparers(options.preparers);
    this.state = 'new';

    this.registry = new PlaceRegistry(this.appRoot);
    this.router = new FsRouter(this.registry, config.global.strict);
    this.facades = new Map(); // name → PlaceFs

    this.cache = null;
    this.compressionCache = null;
    this.segmentsMap = new Map(); // segmentId → SAB
    this.sources = new Map(); // name → Map<key, FileInput> (disk-origin)

    this.watcher = null;
    this.rechecks = new Map(); // absPath → Timeout
    this.links = new Map(); // linkId → MessagePort (workers created via link())
    this.nextLinkId = 0;
    this.nextUpdateId = 0;
    this.pendingFrees = new Map(); // updateId → { workerIds, entries }
    // Per-(place, key) ordering of virtual mutations; the commit section
    // that follows preparation is serialised on its own.
    this.mutations = new MutationQueue();
    this.commits = Promise.resolve();
    // Worker side of the mutation RPC; null on the main thread.
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
      this.compressionCache = new CompressionCache({
        cache: this.cache,
        projectInto,
        console: this.console,
      });
      const prepares = this.preparers.resolve(this.config.places);
      for (const pc of this.config.places) {
        const place = new Place(pc, this.appRoot);
        place.prepare = prepares.get(pc.name) || null;
        await this.#initPlace(place);
        this.registry.register(place);
      }
      for (const place of this.registry.all()) {
        if (!SHARED.has(place.provider)) continue;
        await this.#initBytecode(place);
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
    // Queued mutations reject on the closed kernel; workers learn through
    // the closed port.
    this.mutations.clear();
    if (this.mutationClient) {
      this.mutationClient.close('[vfs] kernel closed before publication');
    }
    this.pendingFrees.clear();
    this.segmentsMap.clear();
    this.sources.clear();
    this.facades.clear();
    for (const place of this.registry.all()) place.files.clear();
    this.cache = null;
    this.compressionCache = null;
  }

  // --- Providers ---

  // One place, filled from its origin. Virtual places start empty: their
  // content arrives through fs mutations, never from a scan.
  async #initPlace(place) {
    const { provider } = place;
    if (provider === 'sea') return void (await this.#initSea(place));
    if (provider === 'map') {
      place.store = new MapStore(place);
      if (!place.virtual) await this.#initMapDisk(place);
      return;
    }
    if (provider !== 'sab') return;
    if (place.virtual) {
      // An index even while empty: workers must project the place from the
      // snapshot and receive its first update like any other.
      this.cache.index(place.name);
      place.store = new SabStore(place, this);
      return;
    }
    await this.#initSabDisk(place);
  }

  // Prepared inputs carry their bytes only (`{ data }`, no path): they must
  // land in SAB or not be published at all — a disk fallback would serve
  // the raw file as if it were the prepared source.
  #allocOptions(place, input) {
    return {
      store: this.#storePredicate(place),
      maxFileSize: place.config.maxFileSize,
      fallback: input && !input.path ? false : undefined,
    };
  }

  // With `retainRaw: false` the source of a compressed file lives on disk
  // only; every other file keeps its raw bytes in SAB.
  #storePredicate(place) {
    const compress = place.config.fs?.compress;
    if (!compress || compress.retainRaw) return null;
    return (key) => !this.compressionCache.compressible(place, key);
  }

  async #initSabDisk(place) {
    const scanned = await scan(place.root, {
      ext: place.config.scanExt,
      followSymlinks: !this.config.global.strict,
    });
    this.sources.set(place.name, scanned);
    const files = await this.#inputs(place, scanned);
    await this.cache.load(place.name, files, this.#allocOptions(place));
    this.#project(place);
  }

  // A map place caches disk files as owned Buffers in one thread: no pool,
  // no snapshot, no ACK. The same pipeline prepares and compiles them.
  async #initMapDisk(place) {
    const scanned = await scan(place.root, {
      ext: place.config.scanExt,
      followSymlinks: !this.config.global.strict,
    });
    this.sources.set(place.name, scanned);
    for (const [key, file] of scanned) {
      place.store.publish(key, await this.#input(place, key, file));
    }
  }

  // Cached data for everything a shared place published at init. A script
  // flavor that does not compile or does not fit aborts initialize(): the
  // bundle would be incomplete. A require flavor stays best-effort.
  async #initBytecode(place) {
    for (const key of [...place.files.keys()]) {
      if (bytecodeDomains(place, key).length === 0) continue;
      const file = place.files.get(key);
      if (!file.data) continue;
      for (const code of bytecodeFor(
        place,
        key,
        file.data,
        file.scriptOptions,
      )) {
        const entry = code.data
          ? await this.cache.allocate(
              place.name,
              code.key,
              {
                data: code.data,
                stat: { size: code.data.length, mtimeMs: file.stat.mtimeMs },
              },
              COMPANION_ALLOC,
            )
          : null;
        if (entry) this.#projectInto(place, code.key, entry);
        else if (code.domain === 'script') {
          const reason = code.data ? 'does not fit in SAB' : 'does not compile';
          throw new Error(
            `[vfs] place "${place.name}": "${key}" ${reason} (fs.script.compile)`,
          );
        }
      }
    }
  }

  // The FileInput to publish for one scanned / changed / written file: the
  // raw `{ path, stat }` when the place stores it in SAB untouched (the SAB
  // reader streams it from disk), else `{ data, stat, scriptOptions?, meta? }`
  // \u2014 a map place always owns its bytes, and a prepared source is whatever
  // the preparer returned.
  async #input(place, key, file) {
    const prepared = Boolean(place.prepare) && place.scripted(key);
    if (!prepared && place.provider !== 'map') return file;
    const raw = file.data || (await readRaw(file));
    if (!prepared) return { data: raw, stat: file.stat };
    return prepareInput(place, key, file, raw);
  }

  // Init-time: every scanned input, prepared where applicable. A preparer
  // failure aborts initialize(), like any other unreadable source.
  async #inputs(place, scanned) {
    if (!place.prepare) return scanned;
    const files = new Map();
    for (const [key, file] of scanned) {
      files.set(key, await this.#input(place, key, file));
    }
    return files;
  }

  // SEA assets named `<place>/<key>` are loaded into SAB at init and then
  // behave exactly like a sab place (snapshot, zero-copy, no watcher).
  // Preparers run once here; the embedded assets never change afterwards.
  async #initSea(place) {
    const sea = this.seaModule || this.#loadSea();
    if (!sea) {
      this.console.warn(
        `[vfs] place "${place.name}": node:sea unavailable; place is empty`,
      );
      return;
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
    const files = await this.#inputs(place, assets);
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

  // The allocator, the index and epoch publication stay single-threaded:
  // mutations of different keys prepare in parallel, then commit one at a
  // time. The section holds no user code — only allocate → companions →
  // stage → flush.
  #commit(fn) {
    const run = () => fn();
    const done = this.commits.then(run, run);
    this.commits = done.then(NOOP, NOOP);
    return done;
  }

  // Publish one canonical version of a virtual key: prepare (outside the
  // commit section) → SAB → bytecode → compression, all staged into one
  // `vfs-update`. Rejects without publishing anything when a required step
  // fails; no debounce or coalescing — one accepted mutation, one update.
  async publishVirtual(place, key, raw) {
    const stat = { size: raw.length, mtimeMs: Date.now() };
    const file = { data: raw, stat };
    const input = await this.#input(place, key, file);
    return this.#commit(async () => {
      const ep = this.#newEpoch();
      await this.#store(ep, place, key, input, file);
      this.#flush(ep);
    });
  }

  // Retire sources and their companions in one message.
  unpublishVirtual(place, keys) {
    return this.#commit(() => {
      const ep = this.#newEpoch();
      for (const key of keys) {
        this.#retire(ep, place, key);
        for (const companion of place.companions(key)) {
          this.#retire(ep, place, companion);
        }
      }
      this.#flush(ep);
    });
  }

  // Move published bytes under a new key: the old version is retired and
  // the new one published (with fresh companions) in the same message.
  renameVirtual(place, from, to) {
    return this.#commit(async () => {
      const file = place.files.get(from);
      const data = Buffer.from(
        file.data ?? (await this.#sourceOf(place, from)),
      );
      const ep = this.#newEpoch();
      this.#retire(ep, place, from);
      for (const companion of place.companions(from)) {
        this.#retire(ep, place, companion);
      }
      const stat = { size: data.length, mtimeMs: Date.now() };
      await this.#publishEntry(ep, place, to, { data, stat });
      this.#flush(ep);
    });
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

  // One pipeline for every new or changed source, whatever produced the raw
  // input: stable read → preparer → canonical content → bytecode flavors →
  // compressed representations, all staged into the same epoch. A source
  // that cannot be read consistently, that its preparer rejects, that
  // fs.script cannot compile or whose canonical form does not fit in SAB
  // keeps its previous version and companions; one deferred recheck
  // follows, then only a real event retries.
  // A directory rescan and a file event may both reach a key: first wins.
  async #publish(ep, place, key, file, retry) {
    const seen = `${place.name}\0${key}`;
    if (ep.seen.has(seen)) return;
    ep.seen.add(seen);
    try {
      await this.#publishEntry(ep, place, key, file);
    } catch (err) {
      this.console.warn(
        `[vfs] place "${place.name}": "${key}" not published — ${err.message}`,
      );
      if (retry) this.#scheduleRecheck(place, key, file.path);
    }
  }

  // The publication itself; throws instead of warning, so virtual mutations
  // can reject and nothing partial is ever staged.
  async #publishEntry(ep, place, key, file) {
    const input = await this.#input(place, key, file);
    return this.#store(ep, place, key, input, file);
  }

  // Everything after preparation: the part virtual mutations run inside the
  // commit section. `file` is the source record the watcher tracks.
  async #store(ep, place, key, input, file) {
    if (place.provider === 'map') {
      place.store.publish(key, input);
      this.sources.get(place.name)?.set(key, file);
      return;
    }
    const oldEntry = this.cache.entry(place.name, key);
    const codes = [];
    let entry = null;
    try {
      entry = await this.cache.allocate(
        place.name,
        key,
        input,
        this.#allocOptions(place, input),
      );
      if (!entry) throw new Error('canonical source does not fit in SAB');
      await this.#bytecode(place, key, entry, input, codes);
    } catch (err) {
      for (const code of codes) {
        if (code.entry) {
          this.cache.rollback(place.name, code.key, code.entry, code.oldEntry);
        }
      }
      if (entry) this.cache.rollback(place.name, key, entry, oldEntry);
      throw err;
    }
    this.sources.get(place.name)?.set(key, file);
    this.#stage(ep, place, key, entry, oldEntry);
    for (const code of codes) {
      if (code.entry)
        this.#stage(ep, place, code.key, code.entry, code.oldEntry);
      else this.#retire(ep, place, code.key);
    }
    await this.#compress(ep, place, key, entry);
  }

  // Cached data companions of a freshly allocated canonical source, pushed
  // onto `codes` as they are allocated so a later failure can roll them
  // back. A script flavor that does not compile or does not fit invalidates
  // the whole publication; a require flavor is best-effort and only retires
  // its stale companion.
  async #bytecode(place, key, entry, input, codes) {
    if (bytecodeDomains(place, key).length === 0) return;
    const src = await this.#entryBytes(place, key, entry);
    if (!src) throw new Error(`cannot read "${key}" to compile`);
    for (const code of bytecodeFor(place, key, src, input.scriptOptions)) {
      const oldEntry = this.cache.entry(place.name, code.key);
      const stat = code.data
        ? { size: code.data.length, mtimeMs: entry.stat.mtimeMs }
        : null;
      const allocated = code.data
        ? await this.cache.allocate(
            place.name,
            code.key,
            { data: code.data, stat },
            COMPANION_ALLOC,
          )
        : null;
      codes.push({ key: code.key, entry: allocated, oldEntry });
      if (!allocated && code.domain === 'script') {
        const reason = code.data ? 'does not fit in SAB' : 'does not compile';
        throw new Error(`fs.script.compile: source ${reason}`);
      }
    }
  }

  async #compress(ep, place, key, entry) {
    if (!this.compressionCache.compressible(place, key)) return;
    const src = await this.#entryBytes(place, key, entry);
    const { built, failed } = src
      ? await this.compressionCache.compressBuffer(place, key, src, entry.stat)
      : {
          built: [],
          failed: place.config.fs.compress.codecs.map((c) => c.encoding),
        };
    for (const b of built) this.#stage(ep, place, b.key, b.entry, b.oldEntry);
    for (const encoding of failed) {
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

  // Delete a file or a whole subtree (key '' is the place root).
  #unpublish(ep, place, key, filePath) {
    const source = this.sources.get(place.name);
    const prefix = key.endsWith('/') ? key : key + '/';
    for (const k of [...source.keys()]) {
      if (k !== key && !k.startsWith(prefix)) continue;
      source.delete(k);
      this.#cancelRecheck(place.pathOf(k));
      if (place.provider === 'map') {
        place.store.remove(k);
        continue;
      }
      this.#retire(ep, place, k);
      for (const companion of place.companions(k))
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
    if (options.port) {
      kernel.mutationClient = new MutationClient(options.port);
    }
    for (const { id, sab } of snapshot?.segments || [])
      kernel.segmentsMap.set(id, sab);
    for (const pc of config.places) {
      const place = new Place(pc, kernel.appRoot);
      if (pc.provider === 'map') place.store = new MapStore(place);
      else if (pc.provider === 'sab' && pc.origin === 'virtual') {
        // Workers never allocate: mutations travel back over the link.
        const client = kernel.mutationClient;
        if (client) place.store = new RemoteStore(place, client);
      }
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

module.exports = { VfsKernel, KERNEL, readInto, readRaw };
