---
title: Outcome-tagged learning loop — deterministic brain:reflect
status: canonical
layer: decision
module: reflect
feature: learning-loop
date: 2026-07-17
---

# 0027 — Outcome-tagged learning loop (`brain:reflect`)

## Context

The brain accumulates findings, insights, and explainers but never learns
whether any of them **helped**. An insight that repeatedly led agents astray
ranks identically to one that resolved three incidents — the usefulness signal is
invisible. Issue #18 asks to close that loop the way
[Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) does in
`reflect.py`: tag each answered query with an outcome, then run a deterministic
pass that aggregates outcomes into "lessons" — no LLM, fully reproducible.

Two hard constraints from the house rules shape the design:

- **Sidecar discipline (0020 / #20):** derived, experiential annotations must
  never mutate a durable record under `decisions/` or `findings/`. An outcome is
  exactly such an annotation.
- **Ranking is eval-gated (#8):** any change to retrieval ranking must clear the
  paired-bootstrap `brain:eval:compare --hard-only` gate before it can ship on by
  default. Using outcome scores as a retrieval boost is a ranking change.

## Decision

Add `scripts/brain-reflect.mjs` with two responsibilities, both model-free.

### 1. Outcome recorder (append-only sidecar)

`brain:reflect record <record-id> --outcome useful|dead_end|corrected [--note ..]
[--actor X] [--source path]` appends one JSON line to
`.project-brain/reflect/outcomes.jsonl`. It **never** opens the original record —
the event log lives in its own `reflect/` sidecar dir, so record-folder
discipline holds by construction (the sidecar-discipline linter confirms the
scripts tree stays clean). Each event carries `{ id, outcome, actor, source, note,
ts }`. The cited `source` (explicit `--source`, else the record-id when it is an
on-disk path) is what powers prune-on-missing later.

### 2. Deterministic aggregator

`brain:reflect [report]` reads the log and synthesizes lessons via **pure,
exported, unit-tested** scoring functions:

- **Time-decayed scoring** — `decayWeight(ageMs) = 0.5^(days/30)`, a 30-day
  half-life. A fresh corroboration outweighs an old refutation.
- **Corroboration gate** — a record becomes `preferred` only with **≥2
  INDEPENDENT corroborations** (distinct-actor `useful` events). One `useful`, or
  two from the same actor, stays `noted` (under-corroborated). `CORROBORATION_MIN
  = 2`.
- **Contested detection** — a record with BOTH positive and negative outcomes is
  **flagged** `contested`; recency decides the reported *direction*
  (`recencyOutcome`) but the conflict is surfaced, never silently resolved. A
  contested record can never be `preferred`.
- **Auto-prune** — a lesson whose cited sources have all vanished is dropped from
  the digest (reuses the `brain-explain.mjs#hashSource` existence pattern via a
  `sourceExists` predicate). Lessons with no known source are never pruned
  (nothing to verify), matching the explainer null-hash stance.

Output is a regenerable digest at `.project-brain/reflect/lessons.md` (record type
`lesson`, one-line addition to `inferType`; `outcomes.jsonl` is not `.md` so it
never indexes). Aggregation is **reproducible**: `now` is injected, never sampled,
so identical inputs produce byte-identical output regardless of event order.

`brain:reflect --if-stale` is a near-free `stat`-level no-op when `lessons.md` is
newer than `outcomes.jsonl` — the cheap re-check suitable for an opt-in
post-commit / SessionStart hook (wiring left opt-in; the flag is the mechanism).

### Ranking stays OUT of scope

Using outcome scores as a retrieval boost is a **ranking change** and is therefore
deliberately excluded from this ADR. It lives dormant behind
`BRAIN_REFLECT_BOOST` (default OFF, not wired into retrieval here) and, per #8,
must clear `npm run brain:eval:compare -- --hard-only` (paired bootstrap) before
any default consideration. That is a separate, later, eval-gated step.

## Consequences

### Positive
- The brain finally has a usefulness signal — a durable, deterministic record of
  what helped vs. misled, feeding the learn axis without any model on the path.
- Zero blast radius on existing behaviour: default-off (nothing runs unless you
  call `record`/`report`), no new deps, no ranking change, no record mutation.
- Byte-reproducible lessons make the aggregation auditable and testable.

### Negative / Tradeoffs
- Independence is proxied by `actor`; a single actor cannot self-corroborate to
  `preferred`. Honest but conservative — collusion across actor labels is
  possible but out of scope for a local tool.
- Prune is all-or-nothing per lesson (drop only when *every* cited source is
  gone); a partially-moved record surfaces via score/recency, not prune.
- The usefulness signal is inert until something consumes it — that consumer
  (the ranking boost) is intentionally deferred behind the eval gate.

## Alternatives Considered
- **Mutating the record with an outcome field:** rejected — violates sidecar
  discipline (0020) and destroys reproducibility of the source record.
- **Sampling `Date.now()` inside the aggregator:** rejected — breaks byte-identical
  reproducibility; `now` is injected instead.
- **Shipping the ranking boost in the same change:** rejected — ranking is
  eval-gated (#8); it must clear the paired bootstrap first, as a separate step.

## Related
- [[0019-sensing-synthesis-learning-wave]] — the learn axis this feeds
- [[0020-real-execute-review-loop-closure]] / #20 — the sidecar discipline it obeys
- [[0015-cross-encoder-rerank]] — the ranking surface the deferred boost would touch
- `brain-explain.mjs#hashSource` / `evaluateExplainers` — the staleness pattern reused for prune
