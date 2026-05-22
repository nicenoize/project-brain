---
title: Cap non-summary chunks per file in retrieval results
status: canonical
layer: decision
module: retrieval
feature: search
date: 2026-05-22
---

# Cap non-summary chunks per file in retrieval results

## Context

Code-aware chunking can produce 3+ chunks per long source file. Without a per-file cap, a single relevant file occupied 3 of the top 8 slots with near-duplicate content — padding the LLM context with redundancy and starving cross-file recall.

This is also one of the easiest direct token-saving wins: a typical packed context shrinks ~30 % when the per-file cap is enforced.

## Decision

`limitChunksPerFile(records, opts)` is applied after the hybrid sort and before the `topK` slice. It keeps at most `maxChunksPerFile` (default `2`, `BRAIN_MAX_CHUNKS_PER_FILE`) non-summary chunks per file.

Summaries (`chunk: -1`, module/feature/project/package summaries, decision clusters) are never deduplicated against — a file's summary and its body chunks serve different purposes in the packed context.

Set the env var to `0` or `Infinity` to disable the cap for debugging.

## Consequences

- Top-K becomes more diverse. A query that matches one long file no longer crowds out the second-best file's chunk.
- Tokens saved per pack ≈ `(M − cap) · avg_chunk_tokens` for files with M > cap chunks. On typical retrieval this is ~30 %.
- Symbol/structural queries still surface their cluster because both the file summary and the symbol's chunk survive.

## Related

- [[0001-hybrid-score-normalization]]
- [[0003-dense-candidate-only-scoring]]
- [[0007-aggregate-vector-records]] — file/folder/package summaries are exempt from this cap.
