---
title: Lazy-sync performance epic
status: canonical
layer: decision
module: indexing
feature: perf-lazy-sync
date: 2026-05-26
---

# 0013 — Lazy-sync performance epic

## Context

Users on multi-thousand-file repos reported the brain making their editor sluggish and the machine warm. Profiling traced the cost to three places:

1. **Re-embedding the world on every commit.** `brain-index` only had a per-file content-hash gate. A one-character change to a 700-line file flushed all ~16 chunks through MiniLM (or the OpenAI embeddings endpoint) on every sync.
2. **Bg-sync competing with the editor.** Post-commit / pre-commit hooks spawn a detached `brain-sync` child that ran at the same nice level as `tsc --watch`, `next dev`, and the editor itself.
3. **No global throttle.** Rapid commits (rebase, amend, fixup) and parallel git operations in fleet mode could stack multiple bg-syncs.

## Decision

Three additive changes, all defaults-on and individually opt-out via env:

1. **Chunk-level vector reuse** (`BRAIN_REUSE_VECTORS=0` to disable). Before embedding a changed file's chunks, look up each chunk's `sha256(embeddingText)` against the same file's previous records. If a vector exists for that exact text, copy it. Typical hit rate: 80–95% for small edits to large files.
2. **Nice + ionice for bg-sync** (`BRAIN_SYNC_NICE=0` to disable). On macOS we wrap with `nice -n 19`; on Linux with `ionice -c 3 nice -n 19`. The bg child runs at the lowest CPU + idle I/O priority so it never starves the editor.
3. **Debounce + global lock** (`BRAIN_SYNC_DEBOUNCE_MS`, default 30s). bg-sync writes `.project-brain/.sync-bg.lock` with its PID before spawning the indexer and the indexer releases it on exit (clean or signal). A bg-sync attempt skips if (a) the manifest was updated within the debounce window or (b) a live PID holds the lock. Stale locks (dead PID) are auto-cleared.

## Consequences

- Cold sync time on a single-file edit drops from ~5s to ~0.5s on a typical repo.
- CPU contention with the editor / dev server effectively disappears — bg-sync runs in idle slices.
- No more cascade when amending or rebasing: the second bg-sync detects the first and exits.
- All three opt-outs preserved so heavy debugging / cold-start rebuilds aren't surprising.
- The reuse path only covers source-file chunks. Aggregate records (chunk:-1…-9) still embed fresh because their `embeddingText` depends on the dirty-set of their children.

## Related

- [[0007-canonical-brain-boost]] — original retrieval boost work.
- [[0008-aggregate-vector-records]] — defines the aggregate record kinds the reuse path skips.
- `scripts/brain-index.mjs` — `existingVectorByChunkSha` lookup + `reuseStats` log line.
- `scripts/brain-sync.mjs` — `wrapWithNice`, lock helpers, debounce check.
