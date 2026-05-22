---
title: Retrieval module
status: canonical
layer: architecture
module: retrieval
date: 2026-05-22
---

# Retrieval module

The retrieval module turns an embedded query into a ranked list of records the agent can read. It lives in `scripts/retrieval.mjs` plus the per-store `search()` implementations in `scripts/store.mjs`.

## Public entry point

`retrieve(query, store, embedder, opts) → Promise<Record[]>` — see [[0003-dense-candidate-only-scoring]] for the candidate-set strategy.

Options:

- `topK` — how many records to return (default `8`, `BRAIN_TOP_K`).
- `candidates` — dense candidate set size (default `max(topK·8, 32)`).
- `filter` — `{ summaryOnly, modulesOnly, type, file }`.
- `alpha` — dense/keyword mix (`BRAIN_HYBRID_ALPHA`, default `0.7`).
- `symbol` / `expectedSymbol` — exact symbol names to boost.
- `maxChunksPerFile` — see [[0004-result-deduplication-per-file]].
- `broadCandidates` — bypass the candidate-set optimization (escape hatch).

## Scoring pipeline

1. **Embed the query** (local MiniLM or OpenAI, via `embed.mjs`).
2. **`store.search(queryVector, candidates, filter)`** returns the top-`candidates` by cosine.
3. **BM25** over the candidate pool ([[0002-bm25-keyword-scoring]]).
4. **Symbol match** — bonus when query tokens or `opts.symbol` overlap `record.symbols` / `exportedSymbols`.
5. **Metadata boosts** — recency (exponential decay), branch match, canonical brain paths, task/actor match, code-body, deprecation/synthetic penalty, test-path penalty for non-test queries.
6. **`hybridScore`** combines all four ([[0001-hybrid-score-normalization]]).
7. **`limitChunksPerFile`** caps non-summary chunks per file ([[0004-result-deduplication-per-file]]).
8. Top-`topK` returned.

## Files

- `scripts/retrieval.mjs` — `retrieve`, `tfidfScore` (BM25), `symbolScore`, `hybridScore`, `metadataBoost`, `recencyBoost`, `canonicalBrainBoost`, `slopPenalty`, `pathHeuristicAdjust`.
- `scripts/store.mjs` — `JsonStore.search`, `LanceStore.search`, `QdrantStore.search` — the dense-candidate source.
- `scripts/brain-search.mjs` — CLI wrapper around `retrieve()`.
- `scripts/brain-ask.mjs` / `brain-pack.mjs` — higher-level callers.
- `tests/retrieval.test.mjs` — invariants on tokenize, BM25, hybridScore.

## Tuning env vars

```
BRAIN_HYBRID_ALPHA=0.7
BRAIN_SYMBOL_WEIGHT=0.6
BRAIN_BM25_K1=1.2
BRAIN_BM25_B=0.75
BRAIN_MAX_CHUNKS_PER_FILE=2
BRAIN_BROAD_CANDIDATES=0
BRAIN_KEYWORD_SCALE=1
BRAIN_ARCH_KEYWORD_SCALE=1.15
BRAIN_TASK_BOOST=0.14
BRAIN_ACTOR_BOOST=0.06
BRAIN_CHANGED_FILE_BOOST=0.12
BRAIN_BRANCH_BOOST=0.08
BRAIN_RECENCY_MAX_BOOST=0.06
BRAIN_RECENCY_HALF_LIFE_DAYS=21
BRAIN_CANONICAL_ROOT_BOOST=0.05
BRAIN_SLOP_PENALTY=0.12
BRAIN_TEST_PATH_PENALTY=0.08
```

## Decisions

- [[0001-hybrid-score-normalization]]
- [[0002-bm25-keyword-scoring]]
- [[0003-dense-candidate-only-scoring]]
- [[0004-result-deduplication-per-file]]
