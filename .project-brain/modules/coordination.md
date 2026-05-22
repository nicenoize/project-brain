---
title: Coordination module
status: canonical
layer: architecture
module: coordination
date: 2026-05-22
---

# Coordination module

Lets multiple agents (humans + Cursor + Claude + Codex + Gemini + orchestrators) work on the same repo without losing track of who's doing what or stepping on each other's files. Lives in `scripts/active-state.mjs` plus the CLI surface in `brain-work`, `brain-lease`, `brain-session`, `brain-orchestrate`, `brain-worktree`.

## Authoritative state

`.project-brain/active_state.md` carries four tables / sections:

1. **Workstreams** — `task_id | owner | tool | branch | scope | status`. One row per active piece of work.
2. **File Leases** — `path glob | locked_by | until | notes`. Reservations on shared files.
3. **Blockers** — bullet list of cross-cutting issues.
4. **Overlaps** — bullet list of work-in-flight overlaps.

This file is the **shared coordination surface**. Retrieval also indexes it so any agent's `brain:ask` sees the live state.

## Locking

Every mutation (`addWorkstream`, `endWorkstream`, `addLease`, `releaseLeases`) goes through `withStateLock(fn)`. The lock is an `O_EXCL` create on `.project-brain/.active_state.lock` containing the holder's PID and timestamp. See [[0005-active-state-exclusive-lock]].

Stale locks (>60 s via `BRAIN_STATE_LOCK_STALE_MS`) are taken over. Contention waits up to 10 s before throwing.

## Worktrees + orchestration

`brain:worktree spawn --count N` creates N git worktrees with GitFlow branch names (`feature/<issue>-<slug>-wp<N>`) under `.worktrees/`. Each worktree's `skills/project-brain` symlink is rewritten atomically to point at the canonical source. `brain:worktree repair` re-fixes drifted symlinks and is a no-op when already canonical (V3.4 improvement).

`brain:orchestrate` reads runnable GitHub issues, plans worker slots up to `--concurrency`, and (with `--spawn-worktrees`) creates worktrees + workstreams. Per-slot leases ([[0006-orchestrator-slot-lease]]) close the race between plan and `recordSpawnedWorkstreams`.

## Sessions

`brain:session start --task <id> --actor <label> --tool <name>` writes a `.project-brain/sessions/<branch>-<task>-<ts>.md` with frontmatter. The frontmatter (`task_id`, `actor`, `tool`, `parent_run`) is indexed onto chunk records so retrieval can boost session text that matches the current `BRAIN_TASK` / `BRAIN_ACTOR` env vars.

## Files

- `scripts/active-state.mjs` — `withStateLock`, `addWorkstream`, `endWorkstream`, `addLease`, `releaseLeases`, `activeStateJson`.
- `scripts/brain-orchestrate.mjs`.
- `scripts/brain-work.mjs`.
- `scripts/brain-lease.mjs`.
- `scripts/brain-session.mjs`.
- `scripts/brain-worktree.mjs`.
- `tests/active-state.test.mjs`.

## Env vars

```
BRAIN_STATE_LOCK_STALE_MS=60000
BRAIN_STATE_LOCK_WAIT_MS=10000
BRAIN_TASK=issue-123-slug
BRAIN_ACTOR=cursor-worker-b
BRAIN_TOOL=cursor|claude|codex|gemini|human|other
BRAIN_WORKTREE_TOOL=claude
BRAIN_WORKTREE_DIR=.worktrees
BRAIN_SESSION_TTL_HOURS=72
```

## Decisions

- [[0005-active-state-exclusive-lock]]
- [[0006-orchestrator-slot-lease]]
