# Copilot Agent Brief — shared-memory-fs

This document defines how GitHub Copilot Agent Mode must behave in this repository.
Agent Mode must always follow these rules and must never override `.github/copilot-instructions.md`.

## MISSION

Implement changes safely, keep external behavior stable, and validate them with tests.
When working in an area covered by `.github/instructions/*.instructions.md`, load the
applicable file and follow it as the implementation-detail source of truth.

## ABSOLUTE CONSTRAINTS

Agent Mode must NEVER:

- break existing public APIs or user-visible behavior without need
- rewrite large unrelated parts of the repository without need
- introduce avoidable cross-module coupling
- hardcode configuration that is already meant to be configurable
- add third-party npm dependencies beyond `metautil` and `metawatch`

All code must comply with `.github/copilot-instructions.md`.

## AGENT WORKFLOW

Agent Mode must follow this exact flow when performing multi-step tasks.

### Step 1: Context and discovery

Use workspace-wide context:

- identify all relevant files for the task
- inspect current code paths, architecture, and integration points
- confirm all API boundaries that must remain unchanged
- determine the current Git branch (`git branch --show-current`)
- load any applicable `.github/instructions/*.instructions.md` file before editing matching code
- if multiple instruction files match, use ONLY the one whose `branch` frontmatter
  matches the current Git branch; ignore non-matching branch-scoped files

### Step 2: Propose explicit plan (mandatory)

Before editing any code, the agent must:

- propose a multi-step execution plan
- list all files to be modified or created
- explain how the change affects behavior, architecture, and external API
- wait for user confirmation

### Step 3: Implement incrementally

Start from the lowest-level module that owns the behavior, then integrate outward.
Preserve existing boundaries and keep changes focused.

### Step 4: Integrate only after the local API is stable

Update dependent modules only after the owning module behavior is clear.

### Step 5: Validate behavior

Validate:

- targeted behavior changed by the task
- affected integrations still work
- that external API remains unchanged

### Step 6: Add tests

Add or update tests that cover the changed behavior and affected integration points.

## REQUIRED INVARIANTS

The agent must enforce these invariants:

- No consumer must see any API difference between old and new behavior unless the change explicitly requires it.
- No logic must break established fallback behavior or integration contracts.
- When subsystem-specific constraints exist, they are defined in the applicable `.github/instructions/*.instructions.md` file.

## COMMUNICATION PROTOCOL

Agent Mode must:

- ask clarifying questions if instructions allow multiple interpretations
- generate plans before code
- perform changes incrementally
- never rewrite large portions of the library all at once
- always ensure backward compatibility

## FINAL RULE

`AGENTS.md` defines workflow only. Branch- and subsystem-specific architecture belongs
in `.github/instructions/*.instructions.md` and must match the current branch code.
