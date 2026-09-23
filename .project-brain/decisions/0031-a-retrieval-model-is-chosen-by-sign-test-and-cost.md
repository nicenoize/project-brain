---
title: A retrieval model is chosen by sign test and measured cost, never by a mean over ten cases
status: canonical
layer: decision
module: brain-core
feature: retrieval
date: 2026-09-05
---

# 0031 — A retrieval model is chosen by sign test and measured cost

## Context

The open question after the top-K work was whether a **code-aware embedding
model** would lift the four club-ops queries that no ranking weight could
rescue. Three models were measured on one deterministic corpus (621 files: the
21 ground-truth files plus 600 sampled distractors, every Nth file so a rerun
compares the same corpus), same code, same machine:

| model | dims | index ms/doc | query ms | top-5 | top-12 | MRR |
|---|---|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (incumbent) | 384 | 66 | 5.3 | 6/10 | 7/10 | 0.524 |
| `Xenova/bge-small-en-v1.5` | 384 | 120 | 12.8 | 7/10 | 7/10 | 0.524 |
| `jinaai/jina-embeddings-v2-base-code` | 768 | 1197 | 72.3 | 8/10 | 9/10 | 0.539 |

Read as a table, the code-aware model wins: +2 on top-12, +0.015 MRR.

## Why that reading is wrong

**Paired over the ten cases, the win is noise.** ΔMRR +0.015 at sd 0.64, t =
0.08. The code model **improves 4 queries and degrades 5** (one tie). Its mean
is positive only because two cases swing enormously (rank 131 → 1, 45 → 1)
while three swing almost as hard the other way. For bge the picture is flatter
still: t = −0.01, 2 better / 3 worse. Ten cases cannot separate these models.

**The pre-registered prediction failed.** Before running, the claim was: if
code-awareness is the missing ingredient, *these four* queries improve. One of
four did. The visible top-12 gain came from a query that was not in the
prediction at all. Without the pre-registration, that gain would have been
narrated as confirmation after the fact — which is precisely how a null result
gets published as a win.

**The cost is not noise.** 18× slower to index (club-ops' 14,145 chunks: ~15
minutes → over 4.5 hours), 14× slower per query — 72 ms of model time on every
`brain:search` where 5 ms stands today — and 768 instead of 384 dimensions,
doubling every stored vector.

## Decision

1. **`Xenova/all-MiniLM-L6-v2` remains the default.** The seam
   (`BRAIN_LOCAL_EMBED_MODEL` / `BRAIN_LOCAL_EMBED_DIMS`) stays, so anyone with
   a corpus where the trade pays can switch. The default does not move on an
   effect this size.

2. **A model change requires a sign test, not a mean.** Report how many cases
   improved and how many degraded. A candidate that loses more queries than it
   wins is not adopted regardless of its aggregate — a mean over ten cases is
   dominated by its two largest swings.

3. **Four numbers or no recommendation: recall/MRR, indexing time, query
   latency, index size.** Choosing on recall alone and discovering later that
   the tool became unusable is the same mistake as the mirror cap: optimising
   the number in view while the cost sat outside it.

4. **Pre-register which cases must improve, before running.** The prediction is
   what makes the result falsifiable; without it any outcome can be told as a
   success.

## Consequences

- The remaining hard queries stay hard, and we now know a different embedding
  model is not the lever. What the failures share is that the answer is spread
  across files rather than stated in one — that is a chunking and structure
  question, not a model question.
- This ADR is the reusable part. The verdict about one model will age; the rule
  that a ten-case mean is not evidence will not.
- The cheap harness is the method to keep: a full reindex per candidate cost 65
  CPU-minutes and produced nothing. Ten queries, the ground-truth files and a
  bounded distractor sample answer the model question in minutes. It measures
  whole-file cosine, not the product's chunked hybrid retrieval, and must not
  be reported as recall — it answers only "does this model put question and
  answer closer together".
