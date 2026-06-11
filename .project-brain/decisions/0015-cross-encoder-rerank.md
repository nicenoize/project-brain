---
title: Cross-encoder rerank of the scored head
status: canonical
layer: decision
module: retrieval
feature: search
date: 2026-06-11
---

# Cross-encoder rerank of the scored head

## Context

After [[0014-lexical-candidate-union]], the remaining hard-eval misses shifted
shape: lexical union gets the target *into* the pool, but 14 of 26 misses
were then ranking failures with final hybrid ranks 9–58 (ten inside 9–18).
The hybrid score can't fix this class — its components (pool-relative BM25,
clamped metadata, compressed dense range) are exactly what misorders these
targets (`docs/eval-failure-analysis.md`, class 2).

## Decision

`BRAIN_RERANK=1` (or `opts.rerank`) re-scores the top `BRAIN_RERANK_TOP`
(default 20) hybrid-scored records with a cross-encoder
(`Xenova/ms-marco-MiniLM-L-6-v2` by default, `BRAIN_RERANK_MODEL` to swap;
quantized ONNX, ~23 MB first-run download via the existing
`@xenova/transformers` dependency) before per-file capping. The cross-encoder
reads query and chunk together, so it judges relevance directly instead of
comparing pre-computed signals. Fails open: model errors log and fall back to
hybrid order. `scripts/rerank.mjs`; ordering step (`applyRerankOrder`) is
pure and unit-tested.

## Measured (hard subset n=84, paired bootstrap, seed 42)

- Rerank **alone**: nothing (hit@8 Δ 0). Without lexical union the class-2
  targets sit beyond the top-20 window or aren't in the pool at all.
- Union + rerank vs union: hit@8 0.690 → 0.762 (Δ +0.071, CI [0, +0.143]) —
  on the edge alone, but the components are synergists, not competitors.
- **Full stack (coverage + union + rerank) vs pre-fix baseline: hit@8
  0.595 → 0.762 (Δ +0.167, CI [+0.071, +0.262]); MRR 0.468 → 0.591
  (Δ +0.123, CI [+0.036, +0.213]) — significant on both metrics.**
- Full 120-case set: hit@8 0.733 → 0.825; easy subset 35/36 (the reranker
  repairs two of the three corpus-growth regressions from the coverage
  widening).

## Consequences

- Default OFF: CPU inference adds roughly 0.5–2 s per query at top-20 — fine
  for `brain:eval`/`brain:ask`-style calls, noticeable in tight interactive
  loops. Recommended ON together with `BRAIN_LEXICAL_UNION=1` for repos that
  care about conceptual NL queries; the two flags are designed to be enabled
  as a pair.
- First use downloads the model; offline environments keep the flag off or
  pre-warm the transformers cache.
- `opts.trace.scored` reflects the post-rerank order, so `brain:eval
  --diagnose` stays truthful under the flag.

## Related

- [[0014-lexical-candidate-union]]
- [[0003-dense-candidate-only-scoring]]
