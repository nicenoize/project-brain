---
title: Dispatch axis — the brain decides what to run next (brain:route)
status: canonical
layer: decision
module: route
feature: dispatch-axis
date: 2026-06-22
---

# Dispatch axis — the brain decides what to run next (brain:route)

## Context

Every other `brain:*` command answers "do X". The SKILL.md "Default automation
policy" table tells the *agent* which command to choose for a given intent — but
that is prose the agent must read and remember. The goal (Pocock's "harness >
model": invest in the harness so cheaper models succeed) is to make the brain
decide *for itself* which command to run next, intelligently and autonomously,
without crossing into unsafe auto-shipping.

Two facts shape the design:
1. **`brain:improve status/next` already proved the pattern** for ONE backlog: a
   deterministic "situational awareness + recommended next action" tick. `route`
   generalizes it from the improve backlog to the WHOLE command surface.
2. **The autonomy ceiling already exists** (decisions/0018): auto-run only
   read-only/idempotent work; stop at every mutating boundary; never auto-merge.
   Any dispatcher must inherit that ceiling, not bypass it.

## Decision

`brain:route` is a DETERMINISTIC sensor + rule engine — no LLM on the hot path.

- **`senseState()`** gathers signals cheaply: git working-tree/staged files +
  change band (mirrors `brain-ticket.mjs#scoreTask`), branch + commits-ahead-no-PR,
  the act-axis backlog (`loadFindings`/`loadPlans` — model-free), lease conflicts
  (`buildBrief` pure core), and — via ONE optional, soft index open — index
  staleness (`staleIndexFromRecords`) and self-audit gaps (`runGaps`). Every
  signal fails soft to empty.
- **`applyRules(signals)`** (pure, exported) maps signals → ranked recommendations,
  faithfully encoding the SKILL.md policy table: cold/stale brain gates everything
  (P0–P1), then lease conflicts, change-splitting, pre-touch brief, PR prep,
  backlog (`improve next`/grill/`execute`), and gaps/audit when clear. Each
  recommendation carries a printed reason (like `brain:ask --explain`).
- **`classifyBoundary(command, args)`** (pure, exported) is the single source of
  truth for auto vs human: read-only/advisory/idempotent → auto; any record write,
  branch/worktree/PR creation, or heavy rebuild → human. A record WRITE
  subcommand (`audit add`, `grill save`, `gaps --as-findings`, …) is human; its
  read-only sibling (`run`, `scaffold`, `check`) is auto. `improve next` is the
  one sanctioned auto-tick that writes (it plans the top finding — 0018).
- **Default posture:** plain `brain:route` RECOMMENDS only. `--auto` executes the
  auto subset in rank order and STOPS at the first human-boundary command,
  printing what it stopped before and why. It re-checks `classifyBoundary` before
  every execution (defense in depth) and never runs git commit/push/merge.

It composes by DELEGATION, never reimplementation: retrieval intents → recommend
`brain:ask` (which owns the retrieval router); backlog → recommend `brain:improve`
verbatim; pre-touch → the imported `buildBrief` pure core. `route` holds only
signal-aggregation + the rule table + the boundary classification.

## Consequences

### Positive
- The brain becomes self-directing: one command tells the agent (or `--loop`) the
  smallest correct next step, with reasons — the harness routes itself.
- Safety is inherited, not re-implemented: same 0018 worktree/merge ceiling; the
  boundary classification is unit-tested for every command.
- No new dependency; every action it points at is an existing `brain:*` primitive.

### Negative / Tradeoffs
- The rule table is a deterministic encoding of current policy; new workflows need
  a new rule (by design — it stays auditable, not an opaque LLM router).
- The optional index open loads the embedder; `--no-index` / `BRAIN_FAST=1` skip
  it (dropping the stale/gaps signals) for a snappy model-free run.

## Alternatives Considered
- **An LLM that reads state and picks the command:** rejected — non-deterministic,
  puts an LLM on the hot path, and is harder to trust at an auto-execution boundary
  than an auditable rule table.
- **Auto-run through mutating boundaries on green signals:** rejected — violates
  the 0018 human-merge ceiling; `--auto` must stop at the first write/spawn/PR.

## Related
- [[0018-autonomous-act-axis-loop]]
- [[0017-build-native-improve-act-axis]]
- [[0021-grill-adversarial-axis]]
- [[0016-ecosystem-skill-axis-map]]
