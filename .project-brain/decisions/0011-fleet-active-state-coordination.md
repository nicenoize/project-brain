---
title: Fleet-aware coordination via project column in active_state.md
status: canonical
layer: decision
module: coordination
feature: fleet
date: 2026-05-22
---

# Fleet-aware coordination via project column in active_state.md

## Context

`active_state.md` is the shared coordination surface between human and agent workers ([[0005-active-state-exclusive-lock]]). In a fleet, two workstreams might both touch `lib/auth.ts` — but in different projects (e.g. `backend/lib/auth.ts` vs `frontend/lib/auth.ts`). Without a project column, leases on those files collide as if they were the same file.

Similarly, `brain:work start` needs to know which subproject's git tree to operate on — fleet root has no `.git`; each subproject does.

## Decision

Add a `project` column to both tables in `active_state.md`:

- **Workstreams**: 6 → 7 cols (`task_id | owner | tool | project | branch | scope / links | status`)
- **File Leases**: 4 → 5 cols (`path glob or file | project | locked_by | until | notes`)

`addWorkstream({ project })` / `addLease({ project })` / `releaseLeases({ project })` accept the new key (default `''` for backward-compat). `activeStateJson()` exposes it on every workstream/lease object.

Backward compatibility: `upgradeRows()` in `active-state.mjs` detects rows that still match the pre-fleet 6/4-column shape (one column short) and back-fills an empty cell at the new column index on read. Existing repos see no breakage — the first write rewrites the table to the new shape, preserving all data.

CLI plumbing (F5.2):

- `brain:work start --project NAME` — resolves the project's git root via `gitRootOf(project.dir)` and runs `git switch / -c` there. Writes `project: NAME` into the workstream row.
- `brain:lease add … --project NAME` — adds the new column on insert.
- `brain:worktree spawn --project NAME` — picks the project's git tree as the worktree source root.

In fleet mode, `--project` is recommended but not strictly required — omit and the workstream simply lacks a project tag. Future strict mode (`BRAIN_FLEET_REQUIRE_PROJECT=1`) can error on missing project.

## Consequences

- **Multi-project workstreams**: two agents working on `lib/auth.ts` in different projects no longer collide on the file lease.
- **Per-project git scope**: branch ops in `brain:work` and `brain:worktree` use the project's actual `.git`, not the fleet root.
- **Retrieval boost**: workstreams indexed into the brain expose the new column so `BRAIN_PROJECT=backend brain:pack` can favor backend session text.
- **Legacy parse tested**: existing 6-/4-column `active_state.md` files keep parsing; first mutation upgrades them. Round-trip test in `tests/active-state.test.mjs`.

## Related

- [[0005-active-state-exclusive-lock]] — the lock this all sits on top of.
- [[0006-orchestrator-slot-lease]] — orchestrator's per-spawn lease pattern, unchanged.
- `scripts/active-state.mjs` — `upgradeRows`, new `WORKSTREAM_HEADERS` / `LEASE_HEADERS`.
- `scripts/brain-work.mjs`, `scripts/brain-lease.mjs`, `scripts/brain-worktree.mjs`.
