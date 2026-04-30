'use strict';

const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const fsp = require('node:fs/promises');
const { DirectoryWatcher } = require('metawatch');
const { fileExt } = require('metautil');
const { FilesystemCache } = require('./cache.js');
const { PlacementRegistry } = require('./registry.js');
const { PolicyEngine } = require('./policy.js');
const { Place } = require('./place.js');
const { scan, getKey } = require('./scanner.js');

// VFSKernel — top-level VFS facade and cache orchestrator.
// Owns: config, registry, policy, FilesystemCache, watcher, projection, ACK.
// Invariants: config frozen at construction, workers never write SAB,
// ACK-before-free, segments never returned to OS, zero-copy projection.

class VFSKernel {
  constructor(config, options = {}) {
    this.config = config;
    this.appRoot = options.appRoot
      ? path.resolve(options.appRoot)
      : process.cwd();
    this.console = options.console || globalThis.console;
    this.userBroadcast = options.broadcast || (() => {});
    this.getWorkerIds = options.getWorkerIds || (() => []);

    this.registry = new PlacementRegistry(this.appRoot);
    this.policy = new PolicyEngine(config.global, this.console);

    this.cache = null;
    this.pathIndex = new Map();
    this.initialized = false;

    // SAB placement state
    this.segmentsMap = new Map();
    this.projected = new Map();
    this.placeToPlacement = new Map();
    this.placementToPlace = new Map();
    this.sources = new Map();

    // Watch state
    this.watcher = null;

    // ACK state
    this.nextUpdateId = 0;
    this.pendingFrees = new Map();
  }

  async initialize() {
    const { global: globalConfig } = this.config;

    const reader = async (filePath, sab, offset, size) => {
      const fh = await fsp.open(filePath, 'r');
      try {
        await fh.read(Buffer.from(sab, offset, size), 0, size, 0);
      } finally {
        await fh.close();
      }
    };

    this.cache = new FilesystemCache({
      limit: globalConfig.memory.limit,
      baseSegmentSize: globalConfig.memory.segment,
      maxFileSize: globalConfig.memory.maxFileSize,
      reader,
    });

    const sabPlaces = [];
    const diskPlaces = [];
    const defaultPlaces = [];

    for (const pc of this.config.places) {
      const p = pc.provider;
      if (p === 'sab' || p === 'sab-write') sabPlaces.push(pc);
      else if (p === 'disk') diskPlaces.push(pc);
      else if (p === 'node-default') defaultPlaces.push(pc);
    }

    // Scan and load SAB places into cache
    for (const pc of sabPlaces) {
      if (!pc.match.dir) continue;
      const placementName = pc.match.dir;
      this.placeToPlacement.set(pc.name, placementName);
      this.placementToPlace.set(placementName, pc.name);
      const rootPath = path.join(this.appRoot, placementName);
      const { files, dirs } = await scan(rootPath, { ext: pc.ext });
      this.sources.set(placementName, {
        rootPath,
        ext: pc.ext || null,
        files,
        dirs,
      });
      await this.cache.load(placementName, files);
    }

    // Build projection for all SAB placements at once
    this.#buildProjection();

    // Register SAB places
    for (const pc of sabPlaces) {
      const place = new Place(pc.name, pc);
      const placementName = this.placeToPlacement.get(pc.name);
      if (placementName) {
        place.files = this.projected.get(placementName) || new Map();
      }
      this.registry.register(place);
    }

    // Disk places — scan, all entries are disk-backed
    for (const pc of diskPlaces) {
      const rootPath = path.join(this.appRoot, pc.match.dir || pc.name);
      const { files } = await scan(rootPath, { ext: pc.ext });
      const diskFiles = new Map();
      for (const [key, file] of files) {
        diskFiles.set(key, { data: null, stat: file.stat, path: file.path });
      }
      const place = new Place(pc.name, pc);
      place.files = diskFiles;
      this.registry.register(place);
    }

    // Node-default — passthrough, no files
    for (const pc of defaultPlaces) {
      const place = new Place(pc.name, pc);
      this.registry.register(place);
    }

    this.#buildPathIndex();
    await this.compileModules();
    this.initialized = true;
  }

  async compileModules() {
    for (const pc of this.config.places) {
      if (!pc.compile) continue;
      const placementName = this.placeToPlacement.get(pc.name);
      if (!placementName) continue;
      const place = this.registry.getPlace(pc.name);
      if (!place) continue;
      for (const key of [...place.files.keys()]) {
        if (key.endsWith('.cache')) continue;
        if (fileExt(key) !== 'js') continue;
        await this.#compileEntry(placementName, key, place);
      }
    }
    this.#buildProjection();
    for (const pc of this.config.places) {
      if (!pc.compile) continue;
      const placementName = this.placeToPlacement.get(pc.name);
      if (!placementName) continue;
      const place = this.registry.getPlace(pc.name);
      if (place) place.files = this.projected.get(placementName) || place.files;
    }
  }

  async #compileEntry(placementName, key, place) {
    const file = place.files.get(key);
    if (!file || !file.data) return null;
    const source = file.data.toString('utf8');
    const bytecode = this.#createBytecode(source, key);
    if (!bytecode) return null;
    const cacheKey = key + '.cache';
    const entry = await this.cache.allocate(placementName, cacheKey, {
      stat: { size: bytecode.length },
      data: bytecode,
    });
    return entry;
  }

  #createBytecode(source, filename) {
    try {
      const wrapped = Module.wrap(source);
      const script = new vm.Script(wrapped, { filename, produceCachedData: true });
      const cachedData = script.createCachedData();
      return cachedData;
    } catch {
      return null;
    }
  }

  #isCompilable(placementName, key) {
    if (fileExt(key) !== 'js') return false;
    const placeName = this.placementToPlace.get(placementName);
    if (!placeName) return false;
    const place = this.registry.getPlace(placeName);
    return place?.config.compile === true;
  }

  #buildProjection() {
    const snap = this.cache.snapshot();
    this.segmentsMap.clear();
    for (const seg of snap.segments) {
      this.segmentsMap.set(seg.id, seg.sab);
    }
    this.projected.clear();
    for (const [name, index] of Object.entries(snap.filesystems)) {
      this.projected.set(name, FilesystemCache.project(index, this.segmentsMap));
    }
  }

  // --- Dispatch ---

  resolveFsPath(filePath) {
    const abs = path.resolve(filePath);
    return this.pathIndex.get(abs) || null;
  }

  resolveModule(domain, specifier, parentPath) {
    const place = this.registry.resolveModule(domain, specifier, parentPath);
    this.policy.logRoute('module', domain, specifier, place);
    if (!place) return null;
    return { place, specifier };
  }

  dispatchFsRead(op, filePath) {
    const resolved = this.resolveFsPath(filePath);
    if (!resolved) return null;
    this.policy.checkRead(resolved.place, resolved.key);
    return resolved;
  }

  dispatchFsWrite(op, filePath) {
    const resolved = this.resolveFsPath(filePath);
    if (!resolved) return null;
    this.policy.checkWrite(resolved.place, resolved.key);
    return resolved;
  }

  dispatchModuleResolve(specifier, parentPath) {
    return this.resolveModule('require', specifier, parentPath);
  }

  dispatchModuleLoad(specifier, parentPath) {
    return this.resolveModule('import', specifier, parentPath);
  }

  // --- Path index ---

  #buildPathIndex() {
    this.pathIndex.clear();
    for (const place of this.registry.getPlaces()) {
      if (!place.config.domains.includes('fs')) continue;
      const dirPrefix = place.config.match.dir || '';
      for (const fk of place.files.keys()) {
        this.#addToPathIndex(place, fk, dirPrefix);
      }
    }
  }

  #addToPathIndex(place, fileKey, dirPrefix) {
    if (fileKey.endsWith('.cache')) return;
    if (dirPrefix === undefined) dirPrefix = place.config.match.dir || '';
    const appKey = dirPrefix ? '/' + dirPrefix + fileKey : fileKey;
    const relPath = appKey.startsWith('/') ? appKey.substring(1) : appKey;
    const abs = path.resolve(this.appRoot, relPath);
    this.pathIndex.set(abs, { place, key: appKey, fileKey });
  }

  #removeFromPathIndex(place, fileKey) {
    const dirPrefix = place.config.match.dir || '';
    const appKey = dirPrefix ? '/' + dirPrefix + fileKey : fileKey;
    const relPath = appKey.startsWith('/') ? appKey.substring(1) : appKey;
    const abs = path.resolve(this.appRoot, relPath);
    this.pathIndex.delete(abs);
  }

  // --- Watch ---

  watch() {
    if (this.watcher) return;
    this.watcher = new DirectoryWatcher({
      timeout: this.config.global.watchTimeout,
    });

    for (const [, source] of this.sources) {
      for (const dir of source.dirs) {
        this.watcher.watch(dir);
      }
    }

    let epoch = null;

    this.watcher.on('before', () => {
      epoch = { updates: {}, deletes: {}, oldEntries: [], promises: [] };
    });

    this.watcher.on('change', (filePath) => {
      const found = this.#findSource(filePath);
      const ep = epoch;
      if (found && ep) {
        ep.promises.push(
          this.#processChange(ep, found.name, found.source, filePath),
        );
      }
    });

    this.watcher.on('delete', (filePath) => {
      const found = this.#findSource(filePath);
      const ep = epoch;
      if (found && ep) this.#processDelete(ep, found.name, found.source, filePath);
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

  #findSource(filePath) {
    const relPath = path.relative(this.appRoot, filePath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
      return null;
    }
    const sepIndex = relPath.indexOf(path.sep);
    const name = sepIndex === -1 ? relPath : relPath.substring(0, sepIndex);
    const source = this.sources.get(name);
    return source ? { name, source } : null;
  }

  async #processChange(ep, name, source, filePath) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) return;

    if (stat.isDirectory()) {
      const before = new Set(source.files.keys());
      const { files: subFiles, dirs: subDirs } = await scan(source.rootPath, {
        ext: source.ext,
        startPath: filePath,
      });
      for (const [key, file] of subFiles) {
        source.files.set(key, file);
      }
      for (const dir of subDirs) {
        if (!source.dirs.has(dir)) {
          source.dirs.add(dir);
          if (this.watcher) this.watcher.watch(dir);
        }
      }
      for (const [key] of subFiles) {
        if (before.has(key)) continue;
        const file = source.files.get(key);
        const newEntry = await this.cache.allocate(name, key, file);
        const group =
          ep.updates[name] ||
          (ep.updates[name] = { entries: [], segmentIds: new Set() });
        group.entries.push([key, newEntry]);
        if (newEntry.kind === 'shared' && newEntry.segmentId) {
          group.segmentIds.add(newEntry.segmentId);
        }
      }
      return;
    }

    // File change
    if (source.ext && !source.ext.includes(fileExt(filePath))) return;
    const key = getKey(filePath, source.rootPath);
    source.files.set(key, { stat, path: filePath });
    const oldEntry = this.cache.filesystems[name]?.entries.get(key);
    const newEntry = await this.cache.allocate(name, key, source.files.get(key));
    const group =
      ep.updates[name] ||
      (ep.updates[name] = { entries: [], segmentIds: new Set() });
    group.entries.push([key, newEntry]);
    if (newEntry.kind === 'shared' && newEntry.segmentId) {
      group.segmentIds.add(newEntry.segmentId);
    }
    if (oldEntry && oldEntry.kind === 'shared') {
      ep.oldEntries.push(oldEntry);
    }
    // Recompile bytecode for compilable JS files
    if (this.#isCompilable(name, key) && newEntry.kind === 'shared') {
      const cacheKey = key + '.cache';
      const oldCache = this.cache.filesystems[name]?.entries.get(cacheKey);
      const seg = this.cache.getSegment(newEntry.segmentId);
      const srcBuf = Buffer.from(seg.sab, newEntry.offset, newEntry.length);
      const bytecode = this.#createBytecode(srcBuf.toString('utf8'), key);
      if (bytecode) {
        const cacheEntry = await this.cache.allocate(name, cacheKey, {
          stat: { size: bytecode.length },
          data: bytecode,
        });
        group.entries.push([cacheKey, cacheEntry]);
        if (cacheEntry.kind === 'shared' && cacheEntry.segmentId) {
          group.segmentIds.add(cacheEntry.segmentId);
        }
        if (oldCache && oldCache.kind === 'shared') {
          ep.oldEntries.push(oldCache);
        }
      }
    }
  }

  #processDelete(ep, name, source, filePath) {
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
    const group = ep.deletes[name] || (ep.deletes[name] = []);
    for (const key of keys) {
      group.push(key);
      const old = this.cache.remove(name, key);
      if (old && old.kind === 'shared') ep.oldEntries.push(old);
      // Remove companion bytecode entry
      const cacheKey = key + '.cache';
      const oldCache = this.cache.remove(name, cacheKey);
      if (oldCache) {
        group.push(cacheKey);
        if (oldCache.kind === 'shared') ep.oldEntries.push(oldCache);
      }
    }
  }

  // --- Broadcast + projection ---

  #flushEpoch(epoch) {
    const { updates, deletes, oldEntries } = epoch;
    let lastUpdateId = 0;

    for (const name of Object.keys(updates)) {
      const { entries, segmentIds } = updates[name];
      if (entries.length === 0) continue;
      const newSegments = [];
      for (const id of segmentIds) {
        const seg = this.cache.getSegment(id);
        if (seg) newSegments.push({ id: seg.id, sab: seg.sab });
      }
      lastUpdateId = ++this.nextUpdateId;
      this.#broadcast({
        name: 'file-update',
        target: name,
        updateId: lastUpdateId,
        updates: entries,
        newSegments,
      });
    }

    for (const name of Object.keys(deletes)) {
      const keys = deletes[name];
      if (keys.length === 0) continue;
      lastUpdateId = ++this.nextUpdateId;
      this.#broadcast({
        name: 'file-delete',
        target: name,
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
      if (data.name === 'file-update') this.#handleUpdate(data);
      else if (data.name === 'file-delete') this.#handleDelete(data);
    } catch (err) {
      this.console.error(`[vfs] projection error: ${err.message}`);
    }
    try {
      this.userBroadcast(data);
    } catch (err) {
      this.console.error(`[vfs] broadcast callback error: ${err.message}`);
    }
  }

  #handleUpdate(data) {
    const { target, updates, newSegments } = data;
    if (newSegments) {
      for (const seg of newSegments) {
        this.segmentsMap.set(seg.id, seg.sab);
      }
    }
    const files = this.projected.get(target);
    if (!files || !updates) return;
    const placeName = this.placementToPlace.get(target);
    const place = placeName ? this.registry.getPlace(placeName) : null;
    for (const [key, entry] of updates) {
      files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
      if (place) this.#addToPathIndex(place, key);
    }
  }

  #handleDelete(data) {
    const { target, keys } = data;
    const files = this.projected.get(target);
    if (!files || !keys) return;
    const placeName = this.placementToPlace.get(target);
    const place = placeName ? this.registry.getPlace(placeName) : null;
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
    const result = this.cache.compact();
    if (!result) return;
    const byName = {};
    for (const { name, key, entry } of result.updates) {
      if (!byName[name]) byName[name] = [];
      byName[name].push([key, entry]);
    }
    let lastUpdateId = 0;
    for (const name of Object.keys(byName)) {
      lastUpdateId = ++this.nextUpdateId;
      this.#broadcast({
        name: 'file-update',
        target: name,
        updateId: lastUpdateId,
        updates: byName[name],
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
      // No workers — free immediately, no one to ACK
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
    if (snapshot.segments) {
      for (const seg of snapshot.segments) {
        kernel.segmentsMap.set(seg.id, seg.sab);
      }
    }
    if (snapshot.filesystems) {
      for (const pc of config.places) {
        const placementName = pc.match?.dir;
        if (!placementName) continue;
        kernel.placeToPlacement.set(pc.name, placementName);
        kernel.placementToPlace.set(placementName, pc.name);
        const index = snapshot.filesystems[placementName];
        if (!index) continue;
        const files = FilesystemCache.project(index, kernel.segmentsMap);
        kernel.projected.set(placementName, files);
        const place = new Place(pc.name, pc);
        place.files = files;
        kernel.registry.register(place);
      }
    }
    kernel.#buildPathIndex();
    kernel.initialized = true;
    return kernel;
  }

  // --- Worker-side delta handling ---

  handleDelta(msg) {
    if (msg.name === 'file-update') {
      const { target, updates, newSegments } = msg;
      if (newSegments) {
        for (const seg of newSegments) {
          this.segmentsMap.set(seg.id, seg.sab);
        }
      }
      const files = this.projected.get(target);
      if (!files || !updates) return;
      const placeName = this.placementToPlace.get(target);
      const place = placeName ? this.registry.getPlace(placeName) : null;
      for (const [key, entry] of updates) {
        files.set(key, FilesystemCache.projectEntry(entry, this.segmentsMap));
        if (place) this.#addToPathIndex(place, key);
      }
    } else if (msg.name === 'file-delete') {
      const { target, keys } = msg;
      const files = this.projected.get(target);
      if (!files || !keys) return;
      const placeName = this.placementToPlace.get(target);
      const place = placeName ? this.registry.getPlace(placeName) : null;
      for (const key of keys) {
        files.delete(key);
        if (place) this.#removeFromPathIndex(place, key);
      }
    }
  }
}

module.exports = { VFSKernel };
