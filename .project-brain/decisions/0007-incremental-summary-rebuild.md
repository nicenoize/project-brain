---
title: Incremental rebuild of module / feature / project summaries
status: canonical
layer: decision
module: indexing
feature: brain-index
date: 2026-05-22
---

# Incremental rebuild of module / feature / project summaries

## Context

`brain:index` already detected per-file changes via the manifest hash, so changed body chunks re-embedded incrementally. But module-summary, feature-summary, and project-summary records were **deleted and re-embedded unconditionally on every run** in `rebuildModuleSummaries`. On large repos this dominated re-index latency.

## Decision

The indexer computes `dirtyDirs` and `dirtyFeatures` from `changedFiles ∪ deletedFiles` before invoking the rebuild path. Only summaries whose key falls in the dirty set are deleted and rebuilt.

- Module summary keyed by `dir = path.dirname(record.file)`.
- Feature summary keyed by the `feature:` frontmatter field (or `features/<name>.md` basename).
- Project summary is still always refreshed when *anything* changed — it aggregates all module summaries, so it's effectively dirty whenever any module summary changes.
- `brain:index -- --force` retains the original "rebuild all" behavior for embedder model changes or schema upgrades.

The same pattern was later extended to package summaries ([[0007-aggregate-vector-records]]) and decision clusters.

## Consequences

- Re-index on a single-file change becomes O(1 summary refresh) instead of O(N modules).
- `brain:fast` mode keeps skipping all rebuilds — incremental is an additional optimization, not a replacement.
- Manifest format unchanged. No migration needed.
- When no file changed (e.g. `brain:sync` called on an unchanged tree), the indexer prints `no changes — summaries left intact` and exits.

## Related

- [[0007-aggregate-vector-records]] reuses the dirty-set plumbing.
