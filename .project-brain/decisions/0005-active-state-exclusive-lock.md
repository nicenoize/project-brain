---
title: Exclusive file lock on active_state.md mutations
status: canonical
layer: decision
module: coordination
feature: multi-actor
date: 2026-05-22
---

# Exclusive file lock on active_state.md mutations

## Context

`scripts/active-state.mjs` originally implemented every mutation as a plain read-filter-write cycle:

```
text = readActiveState()
text = updateTable(text, …)
write(ACTIVE_STATE, text)
```

Between `read` and `write`, a second process could complete its own cycle and the later writer would silently overwrite it. Under N concurrent agents (orchestrator + workers + humans on one repo), workstream rows and file leases were lost without trace.

## Decision

All mutators (`addWorkstream`, `endWorkstream`, `addLease`, `releaseLeases`) run inside `withStateLock(fn)`. The lock is an atomic exclusive create (`fs.openSync(LOCK_PATH, 'wx')`) on `.project-brain/.active_state.lock` containing the holder's PID and ISO timestamp.

- Contention waits up to `BRAIN_STATE_LOCK_WAIT_MS` (default 10 s) using `Atomics.wait` for non-spinning polling.
- Stale locks older than `BRAIN_STATE_LOCK_STALE_MS` (default 60 s) — typical sign of a crashed holder — are taken over.
- The lock file is always unlinked in `finally`.

## Consequences

- Concurrent `addLease` calls from 5+ subprocesses all survive (`tests/active-state.test.mjs`).
- Lock contention timeout surfaces as a thrown `active_state lock contention: …` error rather than silent data loss. Callers (`brain:lease`, `brain:work`, `brain:orchestrate`) treat this as a hard error.
- Adds a single small file to `.project-brain/`. Already in `.gitignore` via the `*.lock` pattern.
- The orchestrator additionally holds an `orchestration-slot/<n>` lease while spawning a worktree so concurrent orchestrators see the slot as taken even before the workstream row is written.

## Related

- [[0006-orchestrator-slot-lease]] for the per-spawn lease that builds on this lock.
- `scripts/brain-orchestrate.mjs` — re-reads `activeStateJson()` per slot under this lock.
