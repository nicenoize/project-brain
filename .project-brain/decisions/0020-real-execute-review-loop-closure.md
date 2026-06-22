---
title: Real execute/review for the act-axis loop (subprocess coordinator + eval gate)
status: canonical
layer: decision
module: improve
feature: act-axis
date: 2026-06-22
---

# Real execute/review for the act-axis loop (subprocess coordinator + eval gate)

## Context

[[0017-build-native-improve-act-axis]] shipped `brain:improve execute`/`review` as
Phase-2 *guidance stubs* (they printed the commands a human should run), and
[[0018-autonomous-act-axis-loop]] left turning `execute` into a real spawner as "an
explicit, separately-authorized step." This closes that step — making the loop a real
cycle (status → next → execute → review → reconcile) — under the binding constraints
from 0017/0018: **reuse the existing coordinator and verifier (no new executor, no new
gate)** and **inherit the safety boundary** (worktree isolation; human merge).

## Decision

`execute` and `review` are thin orchestration over existing primitives, invoked as
**subprocesses** (`spawnSync(process.execPath, …)`) — never imported, because the
coordinator/verifier CLIs parse argv and exit at module top level (the recurring
isMain-on-import trap; cf. brain-graph/brain-impact). Sibling paths resolve relative
to `brain-improve.mjs` so it works in both dev and installed-symlink layouts.

- **`execute <plan> [--run]`** reads the `improve-plan`, re-derives work-packages via
  `buildPlan`/`renderMarkdown`, writes `.project-brain/work-packages/<slug>.md`, then
  routes to `brain:worktree spawn` (one isolated `feature/` branch per package).
  **DRY preview by default** (materializes + prints what it would spawn, spawns
  nothing); `--run` spawns; both modes **stop at the worktree boundary — no push, no
  merge.** (`brain:worktree` over `brain:orchestrate --from-file` because the latter
  parses GitHub-issue JSON, not a work-package plan; `execute` points at orchestrate
  for the fuller detached-runner path.)
- **`review <plan> [--baseline f --variant f]`** runs the real gate as subprocesses
  and aggregates: `brain:guard` + `brain:verify --strict`, plus `brain:eval:compare
  --hard-only` **only** for retrieval/quality-affecting plans (pure `needsEvalGate`:
  category performance|correctness AND touches `scripts/retrieval.mjs`). The eval
  verdict→pass mapping (pure `evalVerdictOk`) refuses *regressions* (a negative delta
  whose 95% CI excludes 0) but does not demand a *win*; a required-but-unrunnable gate
  (no reports) FAILS. Aggregation is pure `summarizeGate(...)`.
- **The eval gate is the loop's effectiveness mechanism** — it is what makes an
  autonomous loop worth running: it refuses to ship retrieval regressions, so the loop
  produces proven changes, not unverified token-burning churn.
- `needsEvalGate` / `evalVerdictOk` / `summarizeGate` are pure + exported (unit-tested
  with fixtures; importing the module runs no CLI). Supersedes the "Phase 2 / guidance
  only" note in 0017/0018.

## Consequences

### Positive
- The loop is closed end-to-end with **zero new infrastructure and zero new deps** —
  every heavy action is an existing `brain:*` subprocess.
- DRY-by-default + explicit `--run` makes the spawn boundary obvious; the no-push/
  no-merge ceiling is preserved verbatim. A retrieval change can't pass `review`
  without paired-bootstrap proof.

### Negative / Tradeoffs
- `execute --run` spawns worktrees but doesn't auto-launch runners / auto-implement;
  the detached-runner path stays `brain:orchestrate` (pointed to from output).
- `review` can't choose which baseline/variant to compare — the agent supplies them;
  their absence fails a required gate (deliberate).
- `execute` re-derives packages from the finding, so a hand-edited plan body isn't
  reflected in the materialized packages (the split is regenerated deterministically).

## Related
- [[0017-build-native-improve-act-axis]]
- [[0018-autonomous-act-axis-loop]]
- [[0015-cross-encoder-rerank]]
- [[0006-orchestrator-slot-lease]]
