---
title: Autonomous act-axis loop (/loop + brain:improve next)
status: canonical
layer: decision
module: improve
feature: act-axis
date: 2026-06-22
---

# Autonomous act-axis loop (/loop + brain:improve next)

## Context

The act axis ([[0017-build-native-improve-act-axis]]) is a cycle: audit → plan →
execute → verify → reconcile. As one-shot commands it advances one finding per human
prompt. The goal is to let the agent "do more alone" — drain the backlog with minimal
input — without crossing into unsafe autonomous code-shipping.

Two facts shape the design:
1. **The LLM cannot leave the loop.** Auditing (judging what's worth fixing) and
   reviewing a diff need judgment a CLI can't supply. A pure-CLI loop could only ever
   replan; it could never *find* or *approve* work.
2. **The brain already has a hard safety boundary.** House rule (conventions +
   orchestrator): work happens in isolated worktrees, and merging to `main` requires
   explicit human authorization. Any loop must inherit that boundary, not bypass it.

## Decision

The loop is a composition, not a new engine: **harness `/loop` (scheduling) +
`brain:improve next`/`status` (the unit of work + dashboard) + the agent (judgment).**

- **`brain:improve status`** — backlog dashboard (open/planned/wontfix/resolved counts +
  the recommended next action). The loop's situational awareness and stop condition.
- **`brain:improve next`** — advances the backlog ONE safe tick: it plans the
  highest-impact `open` finding (the only auto-step) via the shared `planFinding`
  (enrich + `buildPlan`), flips that finding `open→planned`, and prints the next action.
  It **never mutates code**. When nothing is `open` it reports "execute the planned
  ones" or "audit for more" — handing the judgment step back to the agent.
- **Lifecycle via status:** `open` (found) → `planned` (has a plan) → execute →
  `resolved`/`wontfix`. `next` and `status` read this directly.
- **Autonomy ceiling:** the loop plans autonomously; execution stays explicit and
  routes through `brain:orchestrate`/`brain:worktree` (worktree-isolated); the loop
  **stops at the merge boundary**. No auto-push, no auto-merge.

The agent drives it with one `/loop` prompt: run `status`, `next` to plan, execute +
`review` planned items in worktrees, `audit` when empty, stop when clear.

## Consequences

### Positive
- The agent self-drives the planning backlog: each `/loop` tick produces one enriched,
  executable plan with zero new infrastructure (status/next are thin wrappers over the
  existing act-axis primitives).
- Safety is inherited, not re-implemented — same worktree isolation + human-merge gate
  the orchestrator already enforces.

### Negative / Tradeoffs
- Not "lights-out" autonomy: the agent must stay engaged for the audit and review
  judgment steps (by design — those are where correctness lives).
- `next`'s auto-step is planning only; turning Phase-2 `execute` into a real autonomous
  spawner (loop actually runs the worktree agents) is deliberately left as an explicit,
  separately-authorized step.

## Alternatives Considered
- **A single-process `brain:improve loop` that audits+executes end-to-end:** rejected —
  it would have to fake the judgment steps (audit/review) and would bypass the agent,
  producing low-quality findings and unreviewed diffs.
- **Auto-execute + auto-merge on green gates:** rejected — violates the house
  human-merge rule; the eval/guard/verify gates reduce but don't eliminate risk.

## Related
- [[0017-build-native-improve-act-axis]]
- [[0016-ecosystem-skill-axis-map]]
- [[0006-orchestrator-slot-lease]]
- [[0005-active-state-exclusive-lock]]
