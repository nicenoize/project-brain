---
title: Sensing / synthesis / learning capability wave (radar, why, gaps, insight, learn)
status: canonical
layer: architecture
module: brain
feature: smarter
date: 2026-06-22
---

# Sensing / synthesis / learning capability wave (radar, why, gaps, insight, learn)

## Context

After the four axes ([[0016-ecosystem-skill-axis-map]]) the brain was still a
*librarian*: it fetched and organized on command but did not (a) surface things
unprompted, (b) form its own claims or notice gaps, (c) answer "why", or (d) get
smarter from being used. This wave adds five commands that move it toward a
*colleague* — built under one discipline: **default-off / read-only / no LLM on a
hot path / no new npm dep**, so none of them costs runtime tokens unless invoked,
and anything touching ranking stays eval-gated. Each was built as a self-contained
module by a parallel agent; shared registration was integrated sequentially.

## Decision

Add five commands, each thin over the existing index:

- **`brain:radar`** (proactive recall+trust) — file-centric pre-touch/PR briefing:
  active leases, governing ADRs, downstream cross-project consumers, open findings,
  one-line blast radius. Deterministic, index-only, always exits 0 (advisory). Opt-in
  hook. *Guardrail:* never blocks; no LLM/embeddings on the hook path.
- **`brain:why`** (temporal) — `ingest` turns `git log` (+PR bodies if `gh` present)
  into indexed `history` records; queries retrieve them. *Guardrail:* ingest is
  explicit (never on `brain:sync`); `history/` is regenerable → gitignored.
- **`brain:gaps`** (structure+trust) — deterministic self-audit: coverage gaps,
  decision-decay, structural contradictions (missing symbol / vanished cited file).
  Read-only; `--as-findings` feeds the act axis (reuses the `finding` type).
  *Guardrail:* precision-biased path/symbol drift (took 17→0 false positives on this
  repo) — "stale context is worse than none".
- **`brain:insight`** (synthesis) — records SYNTHESIZED cross-source claims as a new
  `insight` type. Scaffold+recorder like `brain:adr` — **the command never calls an
  LLM**; the agent synthesizes. *Guardrail (load-bearing):* refuses an insight citing
  <2 sources, and tracks staleness via cited-source hashes — a durable claim must be
  grounded and self-invalidating, or it poisons the trust axis.
- **`brain:learn`** (learning) — usage grows the *benchmark*: `capture` stages
  (query → useful files), `promote` appends de-duped cases to `eval.json`, `suggest`
  proposes an A/B for the human to run. *Guardrail (load-bearing):* it NEVER changes
  retrieval ranking or runs automatically — measurement learns; ranking stays
  human-approved + eval-gated (the house rule).

New record types via one-line `infer.mjs` additions each: `insight`, `history`
(collision-checked against the existing taxonomy). `gaps` reuses `finding`.

## Consequences

### Positive
- The brain becomes proactive (radar), historically-aware (why), self-critical
  (gaps), opinionated-but-grounded (insight), and self-improving-by-measurement
  (learn) — without a server, without new deps, without runtime cost unless invoked.
- All five default-off / read-only / explicit, so none can silently burn tokens —
  directly answering the "effective or just token-eating?" concern: the cheap
  deterministic ones (radar/why/gaps) are effective at ~zero runtime cost; the
  speculative ones (insight/learn) are gated so cost only follows proven value.

### Negative / Tradeoffs
- `insight`'s ≥2-source rule is a heuristic for "grounded", not a correctness proof;
  staleness catches drift, not bad synthesis — human/agent review remains the check.
- `gaps`/decay join decisions↔code by module name; where ADR module names and
  path-inferred modules differ, it under-reports (precision over recall).
- A retrieval boost for `insight`/`history` is deliberately deferred — must clear
  `brain:eval:compare --hard-only` before any default-on ranking change.

## Related
- [[0016-ecosystem-skill-axis-map]]
- [[0017-build-native-improve-act-axis]]
- [[0020-real-execute-review-loop-closure]]
