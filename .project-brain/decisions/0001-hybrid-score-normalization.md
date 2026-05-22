---
title: Normalize the hybrid retrieval score
status: canonical
layer: decision
module: retrieval
feature: search
date: 2026-05-22
---

# Normalize the hybrid retrieval score

## Context

The original `hybridScore` (see `scripts/retrieval.mjs`) summed four signals additively:

```
α·dense + (1 − α)·keyword + sw·symbol + metadata
```

With default α = 0.7 and `sw = 0.6` (`BRAIN_SYMBOL_WEIGHT`), the upper bound was ≈ 1.3 — and a high symbol score could outrank a near-perfect dense hit on its own. Metadata boosts (recency, branch, canonical-brain, task/actor) were unclamped and could compound to drown both relevance signals.

## Decision

Symbol becomes a **multiplier**, not a fourth summand. Metadata is **clamped to ±0.5**. The final score is **capped to `[0, 2]`**.

```js
base   = α·dense + (1 − α)·keyword            // 0..1
score  = base · (1 + sw·symbol) + clamp(meta, ±0.5)
score  = clamp(score, 0, 2)
```

`base` keeps dense and keyword on the same scale. Symbol amplifies an already-relevant chunk instead of replacing it. Metadata is a small additive nudge that cannot dominate the underlying relevance.

## Consequences

- A perfect dense hit (1.0) always outranks a perfect-symbol-only candidate.
- Heavy metadata boosts (task match, changed-file, canonical-brain) can still meaningfully reorder ties but cannot swap a strong dense miss into the top-K.
- `BRAIN_HYBRID_ALPHA` and `BRAIN_SYMBOL_WEIGHT` retain their semantics; existing tuning carries over.
- Verified by `tests/retrieval.test.mjs` — three invariants: bounded `[0, 2]`, "symbol cannot drown dense", metadata clamp.

## Related

- [[0002-bm25-keyword-scoring]] tunes the keyword half of `base`.
- [[0003-dense-candidate-only-scoring]] decides which records the score is computed over.
