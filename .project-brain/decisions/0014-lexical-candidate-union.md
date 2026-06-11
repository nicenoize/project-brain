---
title: Lexical candidate union — BM25 route into the dense candidate pool
status: canonical
layer: decision
module: retrieval
feature: search
date: 2026-06-11
---

# Lexical candidate union — BM25 route into the dense candidate pool

## Context

[[0003-dense-candidate-only-scoring]] limits scoring to the dense top-64
candidates and predicted that records outside the dense neighborhood are
"unlikely to be saved by keyword/symbol relevance anyway, and if they would
be, the right fix is to widen `candidates`". The first per-case failure
analysis (`docs/eval-failure-analysis.md`, n=84 hard subset) tested that
prediction: 13 of 34 misses were candidate-generation failures, and only the
shallow half (corpus dense ranks 65–187) is reachable by widening the pool.
The deep half (ranks 273–1656) is invisible to dense retrieval at any sane
pool width — MiniLM simply does not embed those targets near the query.

The existing escape hatch `BRAIN_BROAD_CANDIDATES=1` does not fix this:
records pulled in by the full-corpus scan keep `denseScore = 0`, and with
α = 0.7 the hybrid score buries them regardless of their BM25 relevance.

## Decision

`BRAIN_LEXICAL_UNION=1` (or `opts.lexicalUnion`) merges the BM25 top-N
(`BRAIN_LEXICAL_UNION_TOP`, default 24) over the full corpus into the
candidate pool, **with a real dense score** — `cosine(queryVector,
record.vector)` computed from the record's stored vector — so union records
compete on the same hybrid footing as dense candidates instead of starting
0.7 points behind.

Default OFF. The measured ship set is **index-coverage widening + lexical
union together**: against the pre-fix baseline the combination moved the hard
subset from hit@8 0.595 / MRR 0.468 to **0.690 / 0.533**, and the paired
bootstrap CI excludes zero on both metrics (hit@8 Δ +0.095, CI
[+0.024, +0.179]; MRR Δ +0.066, CI [+0.003, +0.131]) — the first
CI-significant retrieval change on this eval set. Lexical union alone, on top
of the coverage fix, is +0.036 hit@8 (ns at n=84); the bundle is what is
validated, per the change-set rule in `docs/eval-methodology.md`.

## Consequences

- Re-introduces an O(N) `getAll()` + BM25 pass per query **behind the flag
  only** — the 0003 fast path is untouched when unset. On this repo (~3 k
  records) the cost is tens of milliseconds; profile before enabling on
  ≥ 20 k-record indexes, and flip the default only after that profiling.
- Recommended ON for small/mid repos that care about conceptual NL queries
  (`BRAIN_LEXICAL_UNION=1` in the dev shell / CI env).
- `BRAIN_CANDIDATES=256` (pool widening, also added) recovers a similar
  hit-count on the shallow half without the O(N) pass, but showed no MRR
  benefit (+0.002) — union records entering with strong BM25 + real cosine
  also *rank* better, not just enter.
- Measured and rejected alongside: gating the fuzzy 0.45 symbol-substring
  tier (`BRAIN_SYMBOL_SUBSTRING_GUARD=1`) is **net harmful** (MRR Δ −0.049,
  CI excludes 0) — the tier injects noise on conceptual queries but earns it
  back by boosting targets whose symbols share a root with the query. The
  flag exists, stays OFF, and is documented as measured-negative.

## Related

- [[0003-dense-candidate-only-scoring]]
- [[0002-bm25-keyword-scoring]]
- [[0001-hybrid-score-normalization]]
