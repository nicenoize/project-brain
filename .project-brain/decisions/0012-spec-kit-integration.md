---
title: Spec-Kit integration via additive overlay
status: canonical
layer: decision
module: indexing
feature: spec-kit
date: 2026-05-25
---

# Spec-Kit integration via additive overlay

## Context

[`github/spec-kit`](https://github.com/github/spec-kit) is a Spec-Driven Development toolkit that walks **constitution → specify → plan → tasks → implement** for each feature. It produces `.specify/memory/constitution.md` plus `specs/<id>/{spec.md, plan.md, tasks.md}` and ships `/speckit.*` slash commands.

Project-brain has no front-loaded feature authoring workflow. The closest equivalents are `.project-brain/features/<name>.md` (product-scope) and `brain:ticket` (work-package splitting). Spec-kit's per-feature **technical plan** (`plan.md` with Technical Context, Constitution Check, Project Structure, Complexity Tracking) fills a real gap; its **tasks.md** with `T### [P?] [USn]` line shape is machine-parseable and lines up with `brain:ticket`'s work-package model.

The integration question: do we absorb spec-kit's vocabulary into brain, or treat it as an upstream consumer? Adopting wholesale duplicates effort and creates two surfaces (`features/<name>.md` vs `specs/<id>/spec.md`) that drift. Treating spec-kit as upstream — brain consumes its artifacts — keeps a single retrieval layer and lets teams pick spec-kit per project.

## Decision

**Additive overlay**, same shape as [[0009-fleet-mode-discovery]]:

- Brain gracefully indexes spec-kit artifacts when present. Repos without `.specify/` or `specs/<id>/` see byte-identical behavior.
- `scripts/infer.mjs` (extracted from brain-index.mjs so it's unit-testable) extends `inferType` to recognize five new types:
  - `constitution` — `.specify/memory/constitution.md`
  - `spec` — `specs/<id>/spec.md`
  - `plan` — `specs/<id>/plan.md`
  - `tasks-list` — `specs/<id>/tasks.md`
  - `spec-support` — anything else under `specs/<id>/`
- `inferFeature` extracts `<id>` from `specs/<id>/...` so every spec-kit file under one feature shares a feature key and participates in the existing `feature-summary` aggregate (`chunk:-3`) automatically.
- `CANONICAL_ROOT_NAMES` in `retrieval.mjs` adds `'constitution.md'`. `canonicalBrainBoost` accepts `.specify/memory/` alongside `.project-brain/`. A new `BRAIN_SPEC_BOOST` (default 0.04) adds a small additive boost when a spec/plan/tasks-list/constitution record is retrieved on an architectural query.
- `scripts/brain-speckit.mjs` ships three subcommands:
  - `import <id>` — reads `specs/<id>/spec.md`, extracts title/status/user stories/FR-NNN/SC-NNN/NEEDS CLARIFICATION, writes `.project-brain/features/<id>.md` (advisory, cross-linked, idempotent). Spec.md remains canonical.
  - `tasks <id> [--write] [--github]` — parses `tasks.md` `- [ ] T### [P?] [USn] description` lines into per-user-story brain work-packages via `brain-ticket.buildPlan` (now exported). `[P]` markers preserved. Optional GitHub issue creation.
  - `analyze <id>` — if `specs/<id>/analyze.md` exists, scaffolds one ADR per top-level heading via `brain:adr`.
- Three Claude Code slash commands (`/brain-speckit-specify`, `/brain-speckit-tasks`, `/brain-speckit-implement`) installed by `setup-claude-settings.mjs#syncClaudeCommands()` into `.claude/commands/`. Each wraps the equivalent `/speckit.*` command + the relevant `brain:speckit` step, so an agent gets one orchestrated flow.

## Consequences

- **Repos without spec-kit**: identical behavior. The new globs match no paths; the new CLI subcommands self-check and exit cleanly when `specs/<id>/` is missing; the slash commands fall through with a "run `specify init` first" message.
- **Repos with spec-kit**: every spec / plan / tasks-list / constitution file is indexed and searchable. `brain:search "constitution"` returns the file at rank 1 via the canonical-root boost. `brain:search "what does feature X spec require"` returns `specs/X/spec.md`. `brain:speckit import` mirrors specs into the brain's `features/` directory so the existing product-team surface stays familiar.
- **Tasks → workstreams**: `brain:speckit tasks <id> --write` produces `.project-brain/work-packages/spec-<id>-wpN.md` files matching the `tasks.md` US grouping. The taskId convention `spec-<id>-wpN` plugs into `brain:work start` unchanged.
- **No new record kinds**: spec-kit records use the existing chunk layout (file summaries, body chunks, feature-summary aggregate). Lance schema needs no migration.
- **Convention enforcement**: the slash commands and the CLI both self-check, so accidentally running them on a non-spec-kit repo gives a clear message rather than a silent no-op.

## Related

- [[0009-fleet-mode-discovery]] — same additive-overlay pattern.
- [[0010-cross-project-edge-detection]] — pluggable detector model that a future spec-link detector could follow.
- `scripts/brain-speckit.mjs`, `scripts/infer.mjs`, `scripts/setup-claude-settings.mjs`.
- `templates/claude-code/commands/brain-speckit-*.md`.
