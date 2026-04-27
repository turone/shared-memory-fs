---
name: "VFS v1 Architecture"
branch: VFS
description: "Use when evolving the SAB cache into VFS v1: global defaults, places, fs/static routing, module/app routing, disk fallback, node module fallback, bootstrap, CLI overrides, tests, and VFS documentation."
applyTo: lib/**, index.js, test/**, doc/**, config/**, .github/**
---

# VFS v1 Architecture

This file defines the branch-specific architecture for the `VFS` branch.

The implementation in this branch evolves the existing SharedArrayBuffer-backed
filesystem cache into a configurable VFS v1 architecture.

When this file conflicts with older docs or historical SAB-only assumptions,
current branch code and this file win.

---

## BRANCH GOAL

The goal of this branch is to evolve the current SAB cache into a production-oriented
VFS v1 without discarding the existing allocator, worker lifecycle safety, or
zero-copy semantics.

VFS v1 is configuration-driven and startup-configured.

It introduces:

- global defaults
- per-place defaults
- startup bootstrap
- CLI overrides
- place-based routing by subsystem and/or root
- fs/static place
- module/app place
- disk fallback place
- node module fallback place
- optional writable virtual place (disabled by default)

This branch is NOT intended to become a full replacement for all Node.js internals.

---

## VFS v1 HIGH-LEVEL MODEL

VFS v1 is composed of four conceptual layers:

1. **Storage / Cache Layer**
   - existing SAB-backed cache and allocator
   - segment pooling, extent reuse, compaction, disk fallback
   - zero-copy Buffer projection into workers

2. **Kernel / Routing Layer**
   - global resolved config
   - place registration
   - routing by domain and path/specifier
   - policy checks before provider execution

3. **Provider Layer**
   - SAB-backed provider
   - disk fallback provider
   - module/app source provider
   - optional writable virtual provider

4. **Adapter / Bootstrap Layer**
   - startup registration via preload/bootstrap
   - fs patch adapter
   - module loader integration
   - diagnostics hooks
   - config + CLI override loading

Preserve boundaries between these layers.

Do not collapse them into one large orchestrator module.

---

## CURRENT BASE TO PRESERVE

The current branch starts from an existing SAB cache architecture.

The following must be preserved unless the task explicitly changes them:

- workers never write SharedArrayBuffer
- write to SAB occurs only on the owning/main thread
- workers read published, already-written data
- old memory is freed only after ACK from all active workers or worker exit
- segments are not returned to the OS; they are retained and reused
- zero-copy Buffer views over SAB must remain valid within the current lifecycle rules
- disk fallback must remain supported
- compaction must remain ACK-safe
- `FilesystemCache` must remain free of Node.js built-in and external dependencies
- placement configurability must remain

These invariants are stronger than convenience refactors.

Do not weaken them.

---

## VFS BRANCH SCOPE

### In scope for this branch

- global VFS defaults
- per-place defaults
- config schema and config merging
- CLI overrides parsed from application arguments
- startup bootstrap modules
- VFS kernel / registry / policy layer
- wrapping the existing SAB cache as a provider
- fs/static place
- module/app place
- disk fallback place
- node module fallback place
- optional writable virtual place (disabled by default)
- documentation and tests for the above

### Out of scope for this branch unless explicitly requested

- full replacement of all `node:fs` APIs
- full virtualization of all Node.js internals
- write-heavy general-purpose VFS
- runtime dynamic reconfiguration after bootstrap
- removing the current slab allocator
- rewriting the worker update model around Atomics or lock-based shared mutation
- replacing current `SharedCache` safety model with a completely different lifecycle

---

## GLOBAL DEFAULTS

VFS v1 must have global defaults resolved at startup.

At minimum, support defaults for:

- `memory.limit`
- `memory.baseSegmentSize`
- `memory.gcThreshold`
- `mode` (`strict` or `overlay`)
- `readonlyByDefault`
- `enableFsPatch`
- `enableModulePatch`
- `appRoot`
- `diagnostics.enabled`

Global defaults must be overridable by:
1. branch/application config
2. CLI overrides supplied to the application at startup

Configuration must be frozen after bootstrap.

Do not add runtime mutable config that changes behavior after startup unless explicitly requested.

---

## PLACE MODEL

A **place** is the unit of routing and policy.

Each place must define at least:

- `name`
- `enabled`
- `domain`
- `provider`
- `match`
- `readonly`
- place-local overrides

### Supported domains in VFS v1

- `fs`
- `module`
- `static`

### Place-local settings may include

- roots / directories
- match predicates / path rules
- maxFileSize
- streamThreshold
- gc configuration
- source cache settings
- module invalidation settings
- writable enablement (for virtual write place)

Do not hardcode place behavior in unrelated modules.
Place behavior must come from resolved config plus provider contracts.

---

## REQUIRED VFS v1 PLACES

### 1. fs/static place

Purpose:
- read-mostly filesystem-facing place for static assets and similar resources
- backed primarily by SAB storage
- may fall back to disk when needed

Expected behavior:
- range requests and streaming remain supported via higher-level serving logic
- zero-copy projection remains the preferred fast path
- disk fallback remains valid for oversized or uncached files

This place should preserve the current strengths of the SAB cache.

---

### 2. module/app place

Purpose:
- application module graph loading for app-controlled code
- source bytes may come from SAB-backed storage or disk fallback
- separate logical cache from plain fs/static cache

Important:
- module/app place is not just another file path place
- it has distinct caching and invalidation semantics
- it must support future hot-reload / generation-aware loading

For this branch:
- prioritize application-local modules first
- do not try to virtualize all npm packages at once
- node module fallback must remain available

---

### 3. disk fallback place

Purpose:
- canonical fallback for reads that are not served by SAB-backed places
- acts as safe fallback for files outside active cached roots
- must preserve existing behavior where current implementation falls back to disk

Disk fallback is not an error path.
It is a supported place.

---

### 4. node module fallback place

Purpose:
- preserve default Node.js loader behavior for modules that do not belong to application-local module places
- avoid forcing the VFS to own the full external dependency graph in v1

This place is required to avoid overreaching and breaking ecosystem assumptions.

---

## OPTIONAL VIRTUAL WRITABLE PLACE

Writable places are NOT the primary case in this branch.

If implemented, they must follow these rules:

- disabled by default
- enabled only by config or CLI override at startup
- must be restricted to explicit roots/namespaces
- must not implicitly grant write access to arbitrary application roots
- must respect `readonlyByDefault`
- must integrate with policy checks before execution
- must not weaken SAB lifecycle guarantees

Writable support must remain clearly separated from the primary read-mostly design.

Do not let writable behavior distort the architecture of read-mostly places.

---

## KERNEL / REGISTRY / POLICY RULES

The VFS kernel layer owns:

- resolved configuration
- active place registration
- routing decisions
- policy checks
- provider dispatch

### Kernel responsibilities

The kernel must expose explicit routing entry points for at least:

- filesystem operations
- module resolve/load operations
- static-serving related lookups where applicable

### Registry responsibilities

The registry must:

- store active places
- resolve places deterministically
- avoid ambiguous routing
- keep place matching rules centralized

### Policy responsibilities

At minimum, policy must enforce:

- readonly restrictions
- place enablement
- domain restrictions
- write denial unless explicitly allowed

Do not let providers bypass policy.

Policy must run before provider execution.

---

## PROVIDER RULES

VFS v1 providers must remain focused and composable.

### SAB-backed provider

- wraps the existing SAB cache implementation
- reuses current SharedCache / FilesystemCache machinery
- preserves slab retention, ACK-safe free, compaction, and projection semantics
- does not invent a second allocator in parallel

### Disk provider

- simple fallback provider
- does not override current disk fallback semantics

### Module provider

- should build on top of source access rather than duplicating fs behavior
- must treat module loading as a separate logical concern from plain file reads

### Writable virtual provider

- optional
- isolated
- explicit
- constrained

Do not make every provider depend on every other provider directly.
Use the kernel/registry for coordination.

---

## EXISTING MODULES AND THEIR EVOLUTION

### `FilesystemCache`

Rules:
- remains self-contained
- no Node.js built-ins
- no external dependencies
- continues to own pooled SAB segment allocation behavior

In this branch:
- treat it as the storage engine
- do not force VFS concerns directly into it unless explicitly necessary
- prefer wrapping/adapting over polluting it with unrelated runtime logic

### `SharedCache`

Rules:
- may evolve into or under the VFS orchestration layer
- remains the owner of worker update lifecycle, ACK flow, and publish semantics
- startup config parsing may move upward, but worker safety behavior must remain intact

### `PlacementSource`

Rules:
- remains responsible for scanning and file discovery
- continues to produce normalized forward-slash keys
- stays source-oriented, not storage-oriented

---

## PROJECTION RULES

The current projection model is preserved in this branch.

Rules:
- worker-side projection remains eager unless a task explicitly changes it
- shared entries project to `Buffer.from(sab, offset, length)`
- disk entries project to `{ data: null, stat, path }`
- public file views used by consumers must remain stable in shape unless explicitly changed
- zero-byte file behavior remains explicit and allocation-free

Do not replace zero-copy projection with copy-based projection.

---

## UPDATE / BROADCAST / ACK RULES

The branch continues using publish-after-write semantics.

Rules:
- data is written before workers are notified
- workers never mutate the shared SAB contents
- updates are batched where possible
- old entries are tracked against the last update in the batch
- free occurs only after all ACKs or worker exit removal
- compaction remains batch-aware and ACK-safe
- `handleWorkerExit()` must continue to clean pending ACK ownership correctly

Do not introduce timeout-based forced free unless explicitly requested.

---

## MODULE / CODE CACHE RULES

Module loading must be treated separately from plain fs byte caching.

### Distinguish clearly:

#### Byte/source cache
- stores source bytes
- can be SAB-backed
- can be shared across workers

#### Module/runtime cache
- loader-visible cache
- may be generation-aware
- may be per-worker / per-runtime
- must not be assumed identical to byte cache

Do not merge byte cache semantics and module cache semantics into one implicit mechanism.

Future hot-reload support depends on keeping these concerns separate.

---

## BOOTSTRAP RULES

Bootstrap must happen at startup.

This branch supports early bootstrap modules for VFS initialization.

Bootstrap responsibilities may include:
- reading config
- parsing CLI overrides
- freezing resolved config
- creating kernel
- installing adapters (fs and/or module)
- exposing diagnostics

Rules:
- startup bootstrap must be deterministic
- do not rely on runtime late-patching after the application has already partially loaded its graph unless a task explicitly requires it
- keep bootstrap side effects explicit and testable

---

## CLI OVERRIDE RULES

CLI overrides are part of VFS v1.

Rules:
- CLI override syntax must be predictable and flat
- CLI overrides apply only at startup
- CLI overrides merge on top of config/defaults
- CLI parsing must not be scattered across unrelated modules
- validation errors must be human-readable

CLI overrides are intended for:
- enabling/disabling places
- adjusting place-local parameters
- overriding memory defaults
- enabling optional virtual writable places

Do not hardcode branch behavior that should be configured through this mechanism.

---

## FS PATCH RULES

This branch may patch selected application-facing fs APIs.

Rules:
- patch only canonical, intentional entry points first
- preserve fallback to original `node:fs`
- install patch exactly once
- keep original function references
- routing must go through kernel/place resolution
- diagnostics mode should make routing visible

Do not try to blindly patch every fs API in the first step.

Do not break default disk behavior for paths outside active fs places.

---

## MODULE PATCH / LOADER RULES

This branch may integrate with module loading for application-local modules.

Rules:
- prioritize application graph support
- keep node module fallback intact
- do not assume all external dependencies must be virtualized
- keep module loader behavior explicit
- loader integration must respect separate module cache semantics

Do not treat module loading as identical to plain `fs.readFile`.

---

## BACKWARD COMPATIBILITY RULES

Unless a task explicitly requires otherwise:

- preserve current public API where possible
- preserve `snapshot()`-style worker bootstrap semantics
- preserve delta broadcasting semantics
- preserve disk fallback behavior
- preserve forward-slash normalized keys
- preserve worker safety invariants
- preserve zero-copy behavior

New VFS APIs may be added, but existing consumers must not be broken accidentally.

---

## TESTS

When changing this branch, update or add tests for:

- config/default merge
- CLI overrides
- fs/static routing
- module/app routing
- disk fallback
- node module fallback
- writable virtual place gating
- projection invariants
- ACK lifecycle
- compaction safety
- worker exit cleanup
- diagnostics if behavior is exposed

Do not ship VFS architecture changes without tests for config and routing semantics.

---

## DOCUMENTATION

Keep docs aligned with this branch.

At minimum, docs must explain:

- VFS v1 overview
- global defaults
- per-place defaults
- startup bootstrap
- CLI overrides
- fs/static place
- module/app place
- disk fallback place
- node module fallback place
- optional writable virtual place
- preserved SAB invariants
- non-goals of v1

If branch architecture changes, update this file in the same change.

---

## DO NOT DO THESE THINGS

Do not:

- rewrite the allocator from scratch
- remove ACK-based safety
- convert the design into shared mutable writer logic
- add Node.js built-ins to `FilesystemCache.js`
- collapse fs/static/module behavior into one implicit cache
- make writable behavior the architectural default
- overreach into full Node internal virtualization in v1
- hardcode place definitions that should remain configurable

---

## FINAL RULE

In the `VFS` branch, the source of truth is:

1. current branch code
2. this instruction file
3. repository-wide baseline rules

If current code and this file evolve, keep them in sync.
