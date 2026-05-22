---
title: Per-slot orchestration lease during worktree spawn
status: canonical
layer: decision
module: coordination
feature: multi-actor
date: 2026-05-22
---

# Per-slot orchestration lease during worktree spawn

## Context

`brain:orchestrate` built its plan from a single snapshot of `activeStateJson()`, then iterated `workerSlots` calling `brain:worktree spawn` for each. Two failure modes:

1. By the time we got to slot N, another agent (or a concurrent orchestrator) could have started a new workstream. We'd over-spawn past `concurrency`.
2. The worktree spawn itself is slow (multi-second `git worktree add` + npm install). During that window the workstream row for this slot hasn't been written yet, so a concurrent orchestrator sees the slot as open and races us.

## Decision

`spawnWorktrees()` now:

1. Re-reads `activeStateJson()` immediately before each slot and stops if live active workstreams have already reached `plan.concurrency`.
2. Acquires an `orchestration-slot/<n>` lease (via `addLease`, which goes through [[0005-active-state-exclusive-lock]]) before invoking the worktree spawner.
3. Releases the lease in `finally` regardless of spawn success — the workstream row (added by `recordSpawnedWorkstreams`) supersedes the lease once the worker is real.

Lease holder identifier: `orchestrator:<pid>`. Notes field: `spawning <task-id>` for human debugging in `active_state.md`.

## Consequences

- Two orchestrators racing for 2 slots cannot both win the same slot. Spawn fails fast in the loser instead of producing a duplicate worktree.
- A crashed orchestrator leaves the lease behind; the next mutator sees it as stale (60 s, via the underlying lock's takeover rule) and clears it.
- The `orchestration-slot/*` leases appear in `active_state.md` during the brief spawn window — `brain:lease list` will show them. They're cleared by the time the worktree is registered.

## Related

- [[0005-active-state-exclusive-lock]]
- `scripts/brain-orchestrate.mjs` lines around `spawnWorktrees`.
