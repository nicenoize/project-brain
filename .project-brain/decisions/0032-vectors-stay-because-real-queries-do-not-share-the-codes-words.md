---
title: The vectors stay — real questions do not use the code's words
status: canonical
layer: decision
module: brain-core
feature: retrieval
date: 2026-09-23
---

# 0032 — The vectors stay: real questions do not use the code's words

## Context

The embedder is the most expensive part of the brain: a 630 MB optional
dependency, a model load in every cold process, and most of the indexing time
(club-ops: ~15 minutes for 14k chunks). Since the lexical union (aca9f96) BM25
already searches the whole corpus, so it was fair to ask what the vectors
still add. If the answer was "little", the embedder could become optional and
the brain would get much cheaper.

`BRAIN_DENSE=0` (new, default on) switches `retrieve()` to lexical-only: no
query embedding and no vector search. Candidates are the BM25 top over the
whole corpus. Scoring is otherwise identical (pool BM25, symbol boost,
metadata, per-file cap), so the run isolates exactly what the vectors
contribute.

## Pre-registered (written before the run)

- P1: lexical-only recall@12 is at least 0.05 below hybrid.
- P2: the losses concentrate in the vocabulary-mismatch class.
- Decision rule: the vectors stay the default if hybrid wins the paired sign
  test on hit@12 at p < 0.05.

## Result

**Own cases (138, same corpus, back to back, top-12):**

| | hit@12 | MRR | hard hit | hard MRR |
|---|---|---|---|---|
| hybrid | 0.783 | 0.654 | 0.716 | 0.541 |
| lexical-only | 0.790 | 0.573 | 0.726 | 0.455 |

- Found or not: lexical-only wins 7 cases and loses 6 (sign p = 1.0). P1 fails.
- Vocabulary-mismatch: 51 lexical vs 49 hybrid. P2 fails.
- Rank: ΔMRR −0.080, t = −3.04; reciprocal rank is better in 16 cases and
  worse in 36 (sign p = 0.008). The vectors order the list; they do not find
  more files here.

By the rule as written, the vectors did not earn their place. **But the
pre-registration also named the club-ops cases, and they reverse the result:**

**club-ops (10 cases, a real product codebase, top-12):** hybrid 6/10,
lexical-only 2/10. Hybrid wins 4 and loses 0. The failures are telling:
"planning who works which shift" (hybrid rank 1, lexical miss) and
"translating the interface into another language" (rank 4 vs miss).

## Why the two corpora disagree

Our own cases are written by the people who wrote the code, in the code's own
vocabulary ("mirror", "lease", "corpusVersion"). BM25 is built for exactly
that. A product team asks in the product's vocabulary, and the code does not
use those words ("shift" vs `roster`, "interface in another language" vs
`i18n`). The vectors bridge that gap and BM25 cannot. The own-repo eval is the
easy case for lexical retrieval, and on it alone we would have deleted the
component the real users depend on.

## Decision

1. **The vectors stay the default.** They are not the lever for making the
   brain cheaper; the waste was elsewhere (#63: reads and writes nobody
   needed).
2. **`BRAIN_DENSE=0` stays as an ablation switch**, and as the path for
   installs without the embedder. It is better than the degraded
   `lexicalSearch` fallback because it keeps the whole hybrid scoring apart
   from the dense term.
3. **An eval that only uses our own repo cannot justify removing a retrieval
   component.** Every such decision needs a corpus whose questions come from
   people who did not write the code (today: the club-ops cases). This
   extends ADR 0031: a sign test on the wrong population is still the wrong
   answer.

## Consequences

- A "lexical first, vectors only when unsure" cascade could only save the
  query embedding (~5 ms warm) and a cold model load. It stays open as a
  latency idea for one-shot CLI calls, not as a way to drop the index.
- The club-ops case set (10) is too small to carry weight alone. Growing it
  with questions from people who did not write the code is worth more than
  more own-repo cases.
