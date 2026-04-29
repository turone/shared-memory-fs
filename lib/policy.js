'use strict';

// PolicyEngine — enforces readonly, write deny, diagnostics.
// Minimal in v1: readonly enforcement + diagnostics logging.
// Invariant: all checks run before provider execution.

class PolicyEngine {
  constructor(globalConfig, console) {
    this.allowWrite = globalConfig.policy.allowWrite;
    this.diagnostics = globalConfig.hooks.diagnostics;
    this.console = console || globalThis.console;
  }

  checkRead(place, key) {
    // Read is always allowed in v1
    if (this.diagnostics) {
      this.console.debug(`[vfs] read: place="${place.name}" key="${key}"`);
    }
  }

  checkWrite(place, key) {
    if (!this.allowWrite) {
      throw new Error(
        `[vfs] Write denied: global policy.allowWrite is false`,
      );
    }
    if (place.config.readonly) {
      throw new Error(
        `[vfs] Write denied: place "${place.name}" is readonly`,
      );
    }
    const ns = place.config.writeNamespace;
    if (ns) {
      const normalized = key.startsWith('/') ? key : '/' + key;
      const prefix = ns.startsWith('/') ? ns : '/' + ns;
      if (!normalized.startsWith(prefix)) {
        throw new Error(
          `[vfs] Write denied: key "${key}" outside writeNamespace "${ns}" ` +
          `for place "${place.name}"`,
        );
      }
    }
    if (this.diagnostics) {
      this.console.debug(`[vfs] write: place="${place.name}" key="${key}"`);
    }
  }

  logRoute(op, domain, filePath, place) {
    if (!this.diagnostics) return;
    if (place) {
      this.console.debug(
        `[vfs] route: ${op} domain="${domain}" path="${filePath}" → place="${place.name}"`,
      );
    } else {
      this.console.debug(
        `[vfs] passthrough: ${op} domain="${domain}" path="${filePath}"`,
      );
    }
  }
}

module.exports = { PolicyEngine };
