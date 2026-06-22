---
title: Grill axis — adversarial pre-implementation interview (brain:grill)
status: canonical
layer: decision
module: grill
feature: grill-axis
date: 2026-06-22
---

# Grill axis — adversarial pre-implementation interview (brain:grill)

## Context

The brain can already FIND problems (`brain:audit` judges what's worth fixing,
`brain:gaps` mechanically finds coverage holes / contradictions) and SYNTHESIZE
across sources (`brain:insight`). What it lacked is a primitive that CHALLENGES
an idea *before* it is built — Matt Pocock's "Grill Me": an adversarial
interviewer that flushes out issues while they are still cheap, before
implementation.

Two facts shape the design:
1. **The brain has a real edge over a generic "grill me" skill.** A generic
   grill asks the same questions every time. The brain can ground its questions
   in the index — the real callers of a symbol (`buildImpact`), the ADRs that
   govern the module, the tests that cover it, conflicting open findings — so the
   interview is *specific*, not boilerplate.
2. **House rule: the LLM stays at the edge.** Judging the *answers* to a grill is
   exactly the judgment a CLI can't supply. So this must be a scaffold+recorder
   like `brain:audit` / `brain:adr` / `brain:insight`, not an analyzer.

## Decision

`brain:grill` is a scaffold + recorder for a new durable `grill` record type.

- **`scaffold <finding|plan|decision-slug | --title "proposal">`** gathers grounded
  evidence and generates the adversarial questions DETERMINISTICALLY (the pure,
  exported `generateChallenges`): blast-radius contract/test questions per symbol
  (`buildImpact`, capped, soft), "respect or supersede?" per governing ADR,
  conflict questions per same-module open finding, a small category-tuned bank
  (mirroring `brain:audit`'s taxonomy), and always-asked Pocock fundamentals
  (simplest version? load-bearing assumption? scale/failure? rollback?). The
  AGENT answers them — that's the judgment.
- **`save`** records the Q&A as `.project-brain/grills/<slug>.md` with a `verdict`
  (`open`/`proceed`/`revise`/`block`) and cited `sources` ({path, sha256}).
- **`check`/`list`** reuse `evaluateExplainers` + `hashSource` (brain-explain.mjs):
  a grill goes STALE when its cited evidence drifts — the same invalidation
  explainers / findings / insights use.

Records are indexed (`inferType` → `grill`) and retrievable via
`brain:search --type grill`. No LLM on the hot path: `generateChallenges` /
`renderInterview` are pure. Evidence gathering is mostly model-free (ADRs and
related findings read from disk); only blast-radius needs the index, and it
degrades gracefully when the index is absent.

### Act-axis verzahnung

A grill on a `finding`/`improve-plan` flushes issues *before*
`brain:improve execute`. `brain:route` (decisions/0022) recommends grilling a
planned finding that has no `proceed` grill yet — a light, real coupling with no
hard dependency added to `brain:improve`.

## Consequences

### Positive
- Pre-implementation issues surface when they're cheap, grounded in the brain's
  own index — the brain's structural advantage over a generic grill skill.
- Zero new dependency; reuses `buildImpact`, `packPrompt`, the findings record
  machinery, and the explainer staleness machinery.

### Negative / Tradeoffs
- The question bank is curated and finite; it won't catch domain-specific issues
  a human/LLM would. That's by design — the generated questions are the prompt,
  the LLM supplies the depth in its answers.
- Blast-radius questions need an index; without one the grill is still useful
  (ADRs + related findings + category + fundamentals) but less specific.

## Alternatives Considered
- **An LLM-driven grill that generates AND answers its own questions:** rejected —
  it would bypass the agent's judgment (the whole point) and put an LLM on the hot
  path, violating the house "commands are scaffolds" rule.
- **Folding grill into `brain:audit`:** rejected — audit finds problems in
  existing code (post-hoc); grill challenges a proposal (pre-hoc). Different verb,
  different record, different lifecycle (verdict vs status).

## Related
- [[0017-build-native-improve-act-axis]]
- [[0019-sensing-synthesis-learning-wave]]
- [[0022-route-autonomous-dispatch-axis]]
- [[0016-ecosystem-skill-axis-map]]
