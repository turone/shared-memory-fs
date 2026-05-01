'use strict';

const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const fsp = require('node:fs/promises');
const { DirectoryWatcher } = require('metawatch');
const { fileExt } = require('metautil');
const { FilesystemCache } = require('./cache.js');
const { PlacementRegistry, mountOf, absPathOf } = require('./registry.js');
const { Place } = require('./place.js');
const { scan, getKey } = require('./scanner.js');

// VFSKernel — top-level VFS facade and cache orchestrator.
// Owns: config, registry, FilesystemCache, watcher, projection, ACK tracking.
// Invariants: config frozen at construction, workers never write SAB,
// ACK-before-free, segments never returned to OS, zero-copy projection.

const isCacheKey = (key) => key.endsWith('.cache');

// True iff `key` passes the place's extension whitelist (or no whitelist).
const extAllowed = (place, key) => {
  const ext = place.config.ext;
  return !ext || ext.includes(fileExt(key));
};

// Accumulator entry for diagnostics: { count, examples[≤3] } per extension.
const noteSkip = (skipped, key) => {
  const ext = fileExt(key) || '<no-ext>';
  let b = skipped.get(ext);
  if (!b) skipped.set(ext, (b = { count: 0, examples: [] }));
  b.count++;
  if (b.examples.length < 3) b.examples.push(key);
};

// Format the diagnostic message for files filtered out by `ext` whitelist.
// Aggregated by extension to avoid log spam on large trees.
const formatSkipped = (placeName, whitelist, skipped) => {
  const total = [...skipped.values()].reduce((s, b) => s + b.count, 0);
  const exts = [...skipped.entries()]
    .map(([ext, b]) => `${ext} (${b.count})`)
    .join(', ');
  const examples = [...skipped.values()]
    .flatMap((b) => b.examples)
    .slice(0, 5)
    .join(', ');
  return (
    `[vfs] place "${placeName}": ${total} file(s) outside ext whitelist ignored.\n` +
    `  unexpected extensions: ${exts}\n` +
    `  examples: ${examples}\n` +
    `  whitelist: ${whitelist.join(', ')}`
  );
};

// Apply the configured `extOnExtra` policy after a scan.
const reportSkipped = (place, skipped, console) => {
  if (!skipped || skipped.size === 0) return;
  const policy = place.config.extOnExtra;
  if (policy === 'silent') return;
  const msg = formatSkipped(place.name, place.config.ext, skipped);
  if (policy === 'error') throw new Error(msg);
  console.warn(msg);
};

// Map a SEA asset key to a Place file key.
// - mount === null (match.any): every asset key maps to '/' + assetKey.
// - mount string: assetKey must equal mount or start with mount+'/'; the rest
//   becomes the file key (with leading '/'). Returns null on no match.
const seaKeyToFileKey = (assetKey, mount) => {
  if (!mount) return '/' + assetKey;
  if (assetKey === mount) return '/';
  if (assetKey.startsWith(mount + '/')) {
    return '/' + assetKey.substring(mount.length + 1);
  }
  return null;
};

class VFSKernel {
  constructor(config, options = {}) {
    this.config = config;
    this.appRoot = options.appRoot
      ? path.resolve(options.appRoot)
      : process.cwd();
    this.console = options.console || globalThis.console;
    this.userBroadcast = options.broadcast || (() => {});
    this.getWorkerIds = options.getWorkerIds || (() => []);
    // Optional injected node:sea module (or compatible) for testing.
    this.seaModule = options.seaModule || null;

    this.registry = new PlacementRegistry(this.appRoot);

    this.cache = null;
    this.pathIndex = new Map(); // absPath → { place, key, fileKey }
    this.initialized = false;

    // SAB shared state
    this.segmentsMap = new Map(); // segmentId → SAB
    this.projected = new Map(); // mount → Map<key, {data, stat[, path]}>
    this.sources = new Map(); // mount → { rootPath, ext, files, dirs }

    this.watcher = null;

    this.nextUpdateId = 0;
    this.pendingFrees = new Map();
  }

  async initialize() {
    const { global: g } = this.config;

    const reader = async (filePath, sab, offset, size) => {
      const fh = await fsp.open(filePath, 'r');
      try {
        await fh.read(Buffer.from(sab, offset, size), 0, size, 0);
      } finally {
        await fh.close();
      }
    };

    this.cache = new FilesystemCache({
      limit: g.memory.limit,
      baseSegmentSize: g.memory.segmentSize,
      maxFileSize: g.memory.maxFileSize,
      reader,
    });

    for (const pc of this.config.places) {
      const place = new Place(pc.name, pc);
      if (pc.provider === 'sab') {
        await this.#initSabPlace(place);
      } else if (pc.provider === 'disk') {
        await this.#initDiskPlace(place);
      } else if (pc.provider === 'memory') {
        this.#initMemoryPlace(place);
      } else if (pc.provider === 'sea') {
        await this.#initSeaPlace(place);
      }
      // 'node-default' — passthrough, no files
      this.registry.register(place);
    }

    await this.#compileAll();
    this.#buildPathIndex();
    this.initialized = true;
  }

  async #initSabPlace(place) {
    const mount = mountOf(place);
    if (!mount) return;
    const rootPath = path.join(this.appRoot, mount);
    const { files, dirs, skipped } = await scan(rootPath, {
      ext: place.config.ext,
    });
    reportSkipped(place, skipped, this.console);
    this.sources.set(mount, {
      rootPath,
      ext: place.config.ext || null,
      files,
      dirs,
    });
    await this.cache.load(mount, files);
    const projected = this.#projectMount(mount);
    place.files = projected;
  }

  async #initDiskPlace(place) {
    const mount = mountOf(place) || place.name;
    const rootPath = path.join(this.appRoot, mount);
    const { files, skipped } = await scan(rootPath, { ext: place.config.ext });
    reportSkipped(place, skipped, this.console);
    const map = new Map();
    for (const [key, file] of files) {
      map.set(key, { data: null, stat: file.stat, path: file.path });
    }
    place.files = map;
  }

  // Memory places are per-thread, isolated, writable. No SAB, no broadcast,
  // no watcher. Each thread (main + each worker) owns its own empty instance.
  #initMemoryPlace(place) {
    place.files = new Map();
    place._onWrite = (key, data) => this.#memoryWrite(place, key, data);
    place._onDelete = (key) => this.#memoryDelete(place, key);
  }

  // SEA places: load embedded assets into SAB segments at init.
  // Uses node:sea (or an injected compatible module) to enumerate and read
  // assets. Asset keys whose prefix matches `match.dir` (or all keys when
  // match.any) are mapped to Place file keys '/<rest>'. Assets outside the
  // place's `ext` whitelist are dropped per `extOnExtra` policy.
  async #initSeaPlace(place) {
    const sea = this.seaModule || this.#loadSeaModule();
    if (!sea) {
      this.console.warn(
        `[vfs] place "${place.name}": node:sea unavailable; SEA place is empty`,
      );
      place.files = new Map();
      return;
    }
    const mount = mountOf(place);
    const files = new Map();
    const skipped = new Map();
    for (const assetKey of sea.getAssetKeys()) {
      const fileKey = seaKeyToFileKey(assetKey, mount);
      if (fileKey === null) continue;
      if (!extAllowed(place, fileKey)) {
        noteSkip(skipped, fileKey);
        continue;
      }
      const data = Buffer.from(sea.getAsset(assetKey));
      files.set(fileKey, { data, stat: { size: data.length } });
    }
    reportSkipped(place, skipped, this.console);
    await this.cache.load(mount, files);
    place.files = this.#projectMount(mount);
  }

  #loadSeaModule() {
    try {
      const sea = require('node:sea');
      return sea.isSea && sea.isSea() ? sea : null;
    } catch {
      return null;
    }
  }

  #memoryWrite(place, key, data) {
    if (!extAllowed(place, key)) {
      this.#enforceExt(place, `writeFile("${key}")`, true);
    }
    const buf = Buffer.from(data);
    const stat = { size: buf.length, mtimeMs: Date.now() };
    place.files.set(key, { data: buf, stat });
    if (place.config.domains.includes('fs')) this.#addToPathIndex(place, key);
    if (place.config.compile && fileExt(key) === 'js') {
      const bytecode = this.#createBytecode(buf.toString('utf8'), key);
      if (bytecode) {
        const cacheKey = key + '.cache';
        place.files.set(cacheKey, {
          data: bytecode,
          stat: { size: bytecode.length, mtimeMs: stat.mtimeMs },
        });
      }
    }
    return stat;
  }

  // Single-key ext policy. `throwable=false` downgrades 'error' to warn —
  // used by the watcher so a stray runtime file never crashes the server.
  #enforceExt(place, op, throwable) {
    const policy = place.config.extOnExtra;
    if (policy === 'silent') return;
    const msg =
      `[vfs] place "${place.name}": ${op} outside ext whitelist ` +
      `(${place.config.ext.join(', ')})`;
    if (policy === 'error' && throwable) throw new Error(msg);
    this.console.warn(msg);
  }

  #memoryDelete(place, key) {
    const had = place.files.delete(key);
    place.files.delete(key + '.cache');
    if (had && place.config.domains.includes('fs')) {
      this.#removeFromPathIndex(place, key);
    }
    return had;
  }

  // Project a mount's full entry set into `projected`. Used at init only.
  #projectMount(mount) {
    const index = this.cache.filesystems[mount];
    if (!index) {
      const empty = new Map();
      this.projected.set(mount, empty);
      return empty;
    }
    for (const segId of index.segmentIds) this.#registerSegment(segId);
    const files = FilesystemCache.project(index, this.segmentsMap);
    this.projected.set(mount, files);
    return files;
  }

  #registerSegment(segmentId) {
    if (this.segmentsMap.has(segmentId)) return null;
    const seg = this.cache.getSegment(segmentId);
    if (!seg) return null;
    this.segmentsMap.set(seg.id, seg.sab);
    return seg;
  }

  // --- Bytecode compilation ---

  async #compileAll() {
    for (const pc of this.config.places) {
      if (!pc.compile) continue;
      const mount = pc.match?.dir;
      if (!mount) continue;
      const place = this.registry.getPlace(pc.name);
      if (!place) continue;
      for (const key of [...place.files.keys()]) {
        if (isCacheKey(key) || fileExt(key) !== 'js') continue;
        await this.#compileEntry(mount, key, place);
      }
    }
  }

  async #compileEntry(mount, key, place) {
    const file = place.files.get(key);
    if (!file || !file.data) return;
    const bytecode = this.#createBytecode(file.data.toString('utf8'), key);
    if (!bytecode) return;
    const cacheKey = key + '.cache';
    const entry = await this.cache.allocate(mount, cacheKey, {
      stat: { size: bytecode.length },
      data: bytecode,
    });
    this.#projectInto(mount, cacheKey, entry, place.files);
  }

  #createBytecode(source, filename) {
    try {
      const wrapped = Module.wrap(source);
      const script = new vm.Script(wrapped, {
        filename,
        produceCachedData: true,
      });
      return script.createCachedData();
    } catch {
      return null;
    }
  }

  #isCompilable(mount, key) {
    if (fileExt(key) !== 'js') return false;
    const place = this.registry.getByMount(mount);
    return place?.config.compile === true;
  }

  // Project a single entry into the live files Map for a mount.
  #projectInto(mount, key, entry, files) {
    if (entry.kind === 'shared' && entry.segmentId) {
      this.#registerSegment(entry.segmentId);
    }
    const target = files || this.projected.get(mount);
    if (!target) return;
    target.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
  }

  // --- Path index ---

  #buildPathIndex() {
    this.pathIndex.clear();
    for (const place of this.registry.getPlaces()) {
      if (!place.config.domains.includes('fs')) continue;
      for (const fileKey of place.files.keys()) {
        this.#addToPathIndex(place, fileKey);
      }
    }
  }

  #addToPathIndex(place, fileKey) {
    if (isCacheKey(fileKey)) return;
    const abs = absPathOf(this.appRoot, place, fileKey);
    const mount = mountOf(place);
    const appKey = mount ? '/' + mount + fileKey : fileKey;
    this.pathIndex.set(abs, { place, key: appKey, fileKey });
  }

  #removeFromPathIndex(place, fileKey) {
    if (isCacheKey(fileKey)) return;
    const abs = absPathOf(this.appRoot, place, fileKey);
    this.pathIndex.delete(abs);
  }

  // --- Public dispatch (read-only routing) ---

  resolveFsPath(filePath) {
    const abs = path.resolve(filePath);
    return this.pathIndex.get(abs) || null;
  }

  // Strict-mode sandbox check.
  // Returns true iff strict mode is active AND the absolute path lies under
  // appRoot AND no configured place owns its prefix. fs-patch uses this to
  // raise EACCES, sealing the worker from arbitrary disk reads.
  // Paths outside appRoot are always allowed (libraries, node_modules, OS).
  isStrictDenied(filePath) {
    if (!this.config.global.strict) return false;
    if (typeof filePath !== 'string') return false;
    if (!path.isAbsolute(filePath)) return false;
    const rel = path.relative(this.appRoot, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return this.registry.routeByMount(filePath) === null;
  }

  // Route an absolute path for write. Returns { place, fileKey } only when the
  // owning place is writable (provider: 'memory'); otherwise null — caller
  // should fall through to the OS filesystem.
  routeWrite(filePath) {
    const route = this.registry.routeByMount(filePath);
    if (!route || route.place.config.provider !== 'memory') return null;
    return { place: route.place, fileKey: route.fileKey };
  }

  dispatchModuleResolve(specifier, parentPath) {
    const place = this.registry.resolveModule('require', specifier, parentPath);
    if (!place) return null;
    return { place, specifier };
  }

  dispatchModuleLoad(specifier, parentPath) {
    const place = this.registry.resolveModule('import', specifier, parentPath);
    if (!place) return null;
    return { place, specifier };
  }

  // --- Watch ---

  watch() {
    if (this.watcher) return;
    this.watcher = new DirectoryWatcher({
      timeout: this.config.global.watchTimeout,
    });

    for (const source of this.sources.values()) {
      for (const dir of source.dirs) this.watcher.watch(dir);
    }

    let epoch = null;

    this.watcher.on('before', () => {
      epoch = { updates: {}, deletes: {}, oldEntries: [], promises: [] };
    });

    this.watcher.on('change', (filePath) => {
      const route = this.#routeWatch(filePath);
      const ep = epoch;
      if (route && ep) {
        ep.promises.push(this.#processChange(ep, route, filePath));
      }
    });

    this.watcher.on('delete', (filePath) => {
      const route = this.#routeWatch(filePath);
      const ep = epoch;
      if (route && ep) this.#processDelete(ep, route, filePath);
    });

    this.watcher.on('after', () => {
      const current = epoch;
      epoch = null;
      if (!current) return;
      Promise.all(current.promises)
        .then(() => this.#flushEpoch(current))
        .catch((err) => this.console.error(`[vfs] epoch: ${err.message}`));
    });
  }

  // Watch routing: derive mount from absolute path; ignore unmanaged paths.
  #routeWatch(filePath) {
    const route = this.registry.routeByMount(filePath);
    if (!route) return null;
    const source = this.sources.get(route.mount);
    if (!source) return null;
    return { mount: route.mount, source, place: route.place };
  }

  async #processChange(ep, route, filePath) {
    const { mount, source, place } = route;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) return;

    if (stat.isDirectory()) {
      const before = new Set(source.files.keys());
      const { files: subFiles, dirs: subDirs } = await scan(source.rootPath, {
        ext: source.ext,
        startPath: filePath,
      });
      for (const [key, file] of subFiles) source.files.set(key, file);
      for (const dir of subDirs) {
        if (!source.dirs.has(dir)) {
          source.dirs.add(dir);
          if (this.watcher) this.watcher.watch(dir);
        }
      }
      for (const [key] of subFiles) {
        if (before.has(key)) continue;
        const newEntry = await this.cache.allocate(
          mount,
          key,
          source.files.get(key),
        );
        this.#stageUpdate(ep, mount, key, newEntry, place);
      }
      return;
    }

    if (!extAllowed(place, filePath)) {
      this.#enforceExt(place, `change "${filePath}"`, false);
      return;
    }
    const key = getKey(filePath, source.rootPath);
    source.files.set(key, { stat, path: filePath });
    const oldEntry = this.cache.filesystems[mount]?.entries.get(key);
    const newEntry = await this.cache.allocate(
      mount,
      key,
      source.files.get(key),
    );
    this.#stageUpdate(ep, mount, key, newEntry, place);
    if (oldEntry && oldEntry.kind === 'shared') ep.oldEntries.push(oldEntry);

    if (this.#isCompilable(mount, key) && newEntry.kind === 'shared') {
      const cacheKey = key + '.cache';
      const oldCache = this.cache.filesystems[mount]?.entries.get(cacheKey);
      const seg = this.cache.getSegment(newEntry.segmentId);
      const srcBuf = Buffer.from(seg.sab, newEntry.offset, newEntry.length);
      const bytecode = this.#createBytecode(srcBuf.toString('utf8'), key);
      if (bytecode) {
        const cacheEntry = await this.cache.allocate(mount, cacheKey, {
          stat: { size: bytecode.length },
          data: bytecode,
        });
        this.#stageUpdate(ep, mount, cacheKey, cacheEntry, place);
        if (oldCache && oldCache.kind === 'shared')
          ep.oldEntries.push(oldCache);
      }
    }
  }

  #stageUpdate(ep, mount, key, entry, place) {
    const group =
      ep.updates[mount] ||
      (ep.updates[mount] = { entries: [], segmentIds: new Set(), place });
    group.entries.push([key, entry]);
    if (entry.kind === 'shared' && entry.segmentId) {
      group.segmentIds.add(entry.segmentId);
    }
  }

  #processDelete(ep, route, filePath) {
    const { mount, source, place } = route;
    const prefix = getKey(filePath, source.rootPath);
    const keys = [];
    if (source.files.has(prefix)) {
      source.files.delete(prefix);
      keys.push(prefix);
    }
    const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    for (const key of source.files.keys()) {
      if (key.startsWith(dirPrefix)) {
        source.files.delete(key);
        keys.push(key);
      }
    }
    if (keys.length === 0) return;
    const group =
      ep.deletes[mount] || (ep.deletes[mount] = { keys: [], place });
    for (const key of keys) {
      group.keys.push(key);
      const old = this.cache.remove(mount, key);
      if (old && old.kind === 'shared') ep.oldEntries.push(old);
      const cacheKey = key + '.cache';
      const oldCache = this.cache.remove(mount, cacheKey);
      if (oldCache) {
        group.keys.push(cacheKey);
        if (oldCache.kind === 'shared') ep.oldEntries.push(oldCache);
      }
    }
  }

  // --- Broadcast + projection ---

  #flushEpoch(epoch) {
    const { updates, deletes, oldEntries } = epoch;
    let lastUpdateId = 0;

    for (const mount of Object.keys(updates)) {
      const { entries, segmentIds } = updates[mount];
      if (entries.length === 0) continue;
      const newSegments = [];
      for (const id of segmentIds) {
        const seg = this.cache.getSegment(id);
        if (seg) newSegments.push({ id: seg.id, sab: seg.sab });
      }
      lastUpdateId = ++this.nextUpdateId;
      this.#broadcast({
        name: 'file-update',
        target: mount,
        updateId: lastUpdateId,
        updates: entries,
        newSegments,
      });
    }

    for (const mount of Object.keys(deletes)) {
      const { keys } = deletes[mount];
      if (keys.length === 0) continue;
      lastUpdateId = ++this.nextUpdateId;
      this.#broadcast({
        name: 'file-delete',
        target: mount,
        updateId: lastUpdateId,
        keys,
      });
    }

    if (oldEntries.length > 0 && lastUpdateId > 0) {
      this.#trackUpdate(lastUpdateId, oldEntries);
    }
  }

  #broadcast(data) {
    try {
      if (data.name === 'file-update') this.#applyUpdate(data);
      else if (data.name === 'file-delete') this.#applyDelete(data);
    } catch (err) {
      this.console.error(`[vfs] projection error: ${err.message}`);
    }
    try {
      this.userBroadcast(data);
    } catch (err) {
      this.console.error(`[vfs] broadcast callback error: ${err.message}`);
    }
  }

  #applyUpdate(data) {
    const { target, updates, newSegments } = data;
    if (newSegments) {
      for (const seg of newSegments) this.segmentsMap.set(seg.id, seg.sab);
    }
    const files = this.projected.get(target);
    if (!files || !updates) return;
    const place = this.registry.getByMount(target);
    for (const [key, entry] of updates) {
      files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
      if (place) this.#addToPathIndex(place, key);
    }
  }

  #applyDelete(data) {
    const { target, keys } = data;
    const files = this.projected.get(target);
    if (!files || !keys) return;
    const place = this.registry.getByMount(target);
    for (const key of keys) {
      files.delete(key);
      if (place) this.#removeFromPathIndex(place, key);
    }
  }

  // --- ACK + compaction ---

  handleAck(updateId, workerId) {
    const pending = this.pendingFrees.get(updateId);
    if (!pending) return;
    pending.workerIds.delete(workerId);
    if (pending.workerIds.size === 0) {
      this.#freeEntries(pending);
      this.pendingFrees.delete(updateId);
    }
  }

  handleWorkerExit(workerId) {
    const toFree = [];
    for (const [updateId, pending] of this.pendingFrees) {
      pending.workerIds.delete(workerId);
      if (pending.workerIds.size === 0) toFree.push(updateId);
    }
    for (const updateId of toFree) {
      const pending = this.pendingFrees.get(updateId);
      this.pendingFrees.delete(updateId);
      this.#freeEntries(pending);
    }
  }

  #freeEntries(pending) {
    for (const entry of pending.entries) this.cache.free(entry);
    this.#tryCompact();
  }

  #tryCompact() {
    const threshold = this.config.global.compaction.threshold;
    const result = this.cache.compact(threshold);
    if (!result) return;
    const byMount = {};
    for (const { name, key, entry } of result.updates) {
      if (!byMount[name]) byMount[name] = [];
      byMount[name].push([key, entry]);
    }
    let lastUpdateId = 0;
    for (const mount of Object.keys(byMount)) {
      lastUpdateId = ++this.nextUpdateId;
      this.#broadcast({
        name: 'file-update',
        target: mount,
        updateId: lastUpdateId,
        updates: byMount[mount],
        newSegments: result.newSegments,
      });
    }
    if (result.oldEntries.length > 0 && lastUpdateId > 0) {
      this.#trackUpdate(lastUpdateId, result.oldEntries);
    }
  }

  #trackUpdate(updateId, entries) {
    const workerIds = new Set(this.getWorkerIds());
    if (workerIds.size === 0) {
      for (const entry of entries) this.cache.free(entry);
      return;
    }
    this.pendingFrees.set(updateId, { workerIds, entries });
  }

  // --- Snapshot ---

  snapshot() {
    if (!this.cache) return null;
    return this.cache.snapshot();
  }

  // --- Accessors ---

  getPlace(name) {
    return this.registry.getPlace(name);
  }

  getPlaces() {
    return this.registry.getPlaces();
  }

  close() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pendingFrees.clear();
    this.segmentsMap.clear();
    this.projected.clear();
    this.sources.clear();
    this.pathIndex.clear();
    this.initialized = false;
  }

  // --- Worker-side factory ---

  static fromSnapshot(snapshot, config, options = {}) {
    const kernel = new VFSKernel(config, options);
    if (snapshot?.segments) {
      for (const seg of snapshot.segments) {
        kernel.segmentsMap.set(seg.id, seg.sab);
      }
    }
    for (const pc of config.places) {
      const mount = pc.match?.dir;
      if (!mount) continue;
      const place = new Place(pc.name, pc);
      if (pc.provider === 'memory') {
        kernel.#initMemoryPlace(place);
        kernel.registry.register(place);
        continue;
      }
      // sab + sea + (anything else SAB-projected) come via snapshot
      const index = snapshot?.filesystems?.[mount];
      if (!index) continue;
      const files = FilesystemCache.project(index, kernel.segmentsMap);
      kernel.projected.set(mount, files);
      place.files = files;
      kernel.registry.register(place);
    }
    kernel.#buildPathIndex();
    kernel.initialized = true;
    return kernel;
  }

  // --- Worker-side delta handling ---

  handleDelta(msg) {
    if (msg.name === 'file-update') this.#applyUpdate(msg);
    else if (msg.name === 'file-delete') this.#applyDelete(msg);
  }
}

module.exports = { VFSKernel };
