---
title: BM25 keyword scoring with document-length normalization
status: canonical
layer: decision
module: retrieval
feature: search
date: 2026-05-22
---

# BM25 keyword scoring with document-length normalization

## Context

The previous keyword scoring in `retrieval.mjs#tfidfScore` was raw TF·IDF: `tf · log((N+1) / (df+1)) + 1`. With no length normalization, a 10 KB file repeating a term 20 times outranked a 200-byte chunk that mentioned it once and was actually about the topic.

Code repos amplify this because long generated files (lockfiles, vendored modules, formatted JSON) commonly have spurious keyword density.

## Decision

Replace raw TF·IDF with BM25:

```
score(d, q) = Σ_{t in q}  idf(t)  ·  (tf · (k1 + 1)) / (tf + k1 · (1 − b + b · |d| / avgdl))
idf(t)      = log(1 + (N − df + 0.5) / (df + 0.5))
```

- `k1 = 1.2` (`BRAIN_BM25_K1`) — term-frequency saturation. After ~3 occurrences the marginal contribution drops sharply.
- `b = 0.75` (`BRAIN_BM25_B`) — full length normalization. Long docs are pro-rata penalized.
- `avgdl` is computed once per call across the candidate pool.

The `+1` form of `idf` keeps scores non-negative when `df > N/2`.

## Consequences

- Concise relevant chunks beat long spammy ones on shared terms (`tests/retrieval.test.mjs`).
- Empty corpus / empty query returns an empty Map (defensive — keeps the rest of the pipeline unbranched).
- Compatible with [[0001-hybrid-score-normalization]] — BM25 still produces 0..(several units), and the existing `keyword / maxKeyword` normalization in `retrieve()` brings it to 0..1 for the hybrid mixer.

## Related

- [[0001-hybrid-score-normalization]]
- [[0003-dense-candidate-only-scoring]] — BM25 now runs over the dense candidate set, not the full corpus.
