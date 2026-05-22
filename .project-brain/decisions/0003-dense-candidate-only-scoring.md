---
title: Score retrieval only over the dense candidate set
status: canonical
layer: decision
module: retrieval
feature: search
date: 2026-05-22
---

# Score retrieval only over the dense candidate set

## Context

`retrieve()` previously called `await store.getAll()` on every query and then computed BM25 + symbol + metadata boosts **over the entire corpus**. For a 2 k-record index that's:

- O(N) tokenization for BM25
- O(N) regex-style symbol matching
- O(N) metadata boost calc

…on every search. With Lance, `getAll()` also pulls every vector into JS heap memory just to score and discard most of them.

## Decision

Score only over the dense candidate set returned by `store.search(queryVector, candidates, filter)` where `candidates = max(topK · 8, 32)`.

The vector store already ranks by cosine similarity and returns the top candidates; BM25 + symbol matching + metadata boosts then re-rank those candidates. Records that are far in vector space are unlikely to be saved by keyword/symbol relevance anyway, and if they would be, the right fix is to widen `candidates`, not to scan the whole corpus.

Escape hatch: `BRAIN_BROAD_CANDIDATES=1` (or `opts.broadCandidates`) restores the full-corpus scan for cases where dense recall is intentionally weak (cold queries, broken embeddings).

## Consequences

- 10–100× faster search on indexes ≥ 2 k records.
- Reduces JS heap churn — no full-table materialization per query.
- BM25 statistics (`df`, `avgdl`) are computed over the candidate pool, not the whole corpus. This is the right behavior for re-ranking but means cross-corpus relative TF·IDF is no longer directly observable from inside `retrieve()`.
- The candidate set still goes through the existing `recordMatches` filter so `type`/`file`/`summaryOnly` filters compose.

## Related

- [[0001-hybrid-score-normalization]]
- [[0002-bm25-keyword-scoring]]
- [[0004-result-deduplication-per-file]]
