---
title: Query-time staleness banner in search/pack
status: canonical
layer: decision
module: retrieval
feature: token-context
date: 2026-07-11
---

# 0025 — Query-time staleness banner in search/pack

## Context

Retrieval returned chunks with zero freshness signal. `scripts/retrieval.mjs`,
`brain-search.mjs`, and `brain-pack.mjs` never checked whether a result file had
changed since indexing, and the ambient route hook forces `noIndex=true`, so it
never warned either. Lazy-sync ([[0013-lazy-sync-performance]]) and
`brain:maintain` fix staleness *eventually* — nothing warned *at the moment of
consumption*. An agent could read a chunk, edit against it, and never learn the
on-disk file had already moved on. Index records already carry `mtime` + `hash`,
so the signal to detect this is present; it was simply never surfaced.

## Decision

Add a pure, exported helper `staleResults(records)` in `scripts/retrieval.mjs`
and surface its result as one warning line at consumption time. Default-on,
opt-out `BRAIN_STALE_BANNER=0`.

Two-stage check, bounded at ≤ 8 distinct file reads (topK):

1. **Stage 1 — mtime gate.** `fs.stat` each distinct result file; skip any whose
   on-disk `mtimeMs` is not newer than the recorded `record.mtime`. Cheap, and
   filters out the common unchanged case without any hashing.
2. **Stage 2 — hash confirm.** ONLY for mtime-newer files, compare
   `sha256(content)` vs `record.hash`. This kills the git-branch-switch false
   positive: a checkout rewrites file mtimes to "now" with byte-identical
   content, so stage 1 flags it but stage 2 clears it. A real unsynced edit
   changes the hash and is reported.

Records lacking both `mtime` and `hash` are skipped (nothing to compare), which
also naturally excludes synthetic aggregate records whose placeholder `file`
paths don't exist on disk. Missing files are skipped — a deleted result can't be
"read directly", and deletion-staleness stays the concern of common.mjs
`staleIndexFromRecords`. All stat/read errors are swallowed so the check can
never break a query.

`brain-search.mjs` and `brain-pack.mjs` prepend one line when applicable:

```
⚠ index stale for N file(s): a.ts, b.ts — read those files directly or run npm run brain:sync
```

`brain:search --json` gains a `stale: [...]` field; `brain:pack` returns `stale`
in its result object and rides the banner at the very top of the packed prompt.
`brain:ask` inherits the warning through its spawned search/pack children.

## Consequences

- **OUTPUT-ONLY, not a ranking change.** `staleResults` runs after `retrieve`
  and never feeds back into scoring. `npm run brain:eval:compare` is expected to
  report "no significant change" (hit@8 held at 0.762).
- Bounded cost: at most topK (≤8) `fs.stat`, and a hash read only for the subset
  that looks newer — negligible next to embedding + vector search.
- Deliberately **disjoint from common.mjs `staleIndexFromRecords`** (#32):
  that one is the whole-corpus, unbounded deletion+drift scan used by health
  tooling; this is the bounded hot-path variant used per query. Keeping the two
  surfaces separate avoids one being pulled toward the other's cost profile.
- Opt-out preserved (`BRAIN_STALE_BANNER=0`) for callers that pipe raw output.

## Related

- [[0013-lazy-sync-performance]] — the eventual-consistency sync story this
  extends with a point-of-consumption warning.
- `scripts/retrieval.mjs` — `staleResults`, `staleBanner`.
- `scripts/brain-search.mjs`, `scripts/brain-pack.mjs` — banner + `stale` field.
- `tests/stale-results.test.mjs` — two-stage + missing-file unit tests.
