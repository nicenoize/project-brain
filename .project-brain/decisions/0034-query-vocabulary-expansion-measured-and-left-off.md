---
title: Query vocabulary expansion is measured and left off
status: canonical
layer: decision
module: brain-core
feature: retrieval
date: 2026-09-23
---

# 0034 — Query vocabulary expansion: measured, and left off

## Context

Issue #19 asked whether the class-2 failures (vocabulary mismatch: the
question says it in words, the code in other words or in identifiers) could
be fixed on the query side, with the constraint that nothing is invented.
Two deterministic variants were built, both behind flags, default off:

- `BRAIN_QUERY_EXPAND=1`: adds word-form variants of query tokens
  ("validating" → validate, validation) and joins of adjacent tokens ("user
  session" → usersession, user_session), and only tokens that exist in the
  corpus vocabulary. At most 12 tokens are added, and they are printed to
  stderr.
- `BRAIN_SPLIT_IDENTIFIERS=1`: adds camelCase/snake parts of identifiers on
  both sides of BM25 (`getUserSession` → get, user, session). The tokenizer
  otherwise keeps `getusersession` whole, so a question in words never meets
  it.

## Pre-registered

- P1: expansion gains at least 2 hits net in the vocabulary-mismatch class of
  our own cases, and is neutral elsewhere.
- P2: splitting gains at least 1 club-ops case (words vs identifiers).
- Rule (ADR 0031/0032): a variant becomes the default only if it wins the
  own-set sign test on hit@12 at p < 0.05 AND does not lose on club-ops.

## Result (top-12, back to back, same corpus)

| variant | own hit@12 (138) | own MRR | club-ops hit (10) | club-ops MRR |
|---|---|---|---|---|
| base | 108 | 0.654 | 6 | 0.267 |
| expand | 113 (+6/−1, p = 0.125) | 0.630 (RR +14/−23, p = 0.19) | 6 (+1/−1) | 0.127 |
| split | 110 (+5/−3, p = 0.73) | **0.616 (RR +7/−22, p = 0.008)** | 6 | 0.215 |
| both | 110 (+5/−3) | **0.618 (RR +10/−27, p = 0.008)** | 6 | 0.140 |

- P1 holds in direction (vocabulary-mismatch +3) but the hit gain is not
  significant, and the ranking loses on both corpora.
- P2 fails: no club-ops case moves. Splitting finds a few more files but
  ranks them significantly worse, because it adds many common tokens ("get",
  "set", "user") that dilute BM25's weighting.

## Decision

1. **Neither variant becomes the default.** The code stays, dormant and
   byte-identical when the flags are unset, so a larger or different case set
   can re-run the same experiment in minutes.
2. **Identifier splitting is a negative result.** It significantly hurts
   ranking with no recall gain worth that. Do not enable it on this evidence.
3. **Expansion is the more promising of the two** (+6/−1 on recall). A
   follow-up could use its tokens for candidate generation only, leaving
   scoring alone, since the recall gain came from candidates and the MRR loss
   from scoring. That needs its own pre-registered run.
4. The club-ops failures that motivated #19 ("shift" vs roster code,
   "interface in another language" vs i18n) are synonym problems, not
   word-form problems. A constrained, deterministic expansion cannot bridge
   them, and the vectors (ADR 0032) are what does.
