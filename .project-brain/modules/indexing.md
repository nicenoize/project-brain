---
title: Indexing module
status: canonical
layer: architecture
module: indexing
date: 2026-05-22
---

# Indexing module

Builds and maintains the local semantic index — the vector store + JSON mirror that retrieval queries. Lives in `scripts/brain-index.mjs` (orchestrator) and its delegates.

## Pipeline

```
listIndexableFiles  →  load TS semantic graph (ts-graph.mjs)
                    →  chunk.dispatchChunker
                    →  embed.embedBatch
                    →  store.upsert
                    →  rebuildModuleSummaries
                    →  rebuildPackageSummaries
                    →  rebuildDecisionClusters
                    →  rebuildFeatureAndProjectSummaries
                    →  write index_manifest.json
```

## Record kinds

| chunk | type | content |
|---|---|---|
| `0..N` | body | code/markdown body slice |
| `-1` | file-summary | `${filePath}\n${intent}\n${exports/symbols}` |
| `-2` | module-summary | per-directory aggregate (dirty-only rebuild) |
| `-3` | feature-summary | per `feature:` frontmatter tag |
| `-4` | project-summary | aggregates all module summaries |
| `-5` | package-summary | per `packages/*` / `apps/*` (monorepo only) |
| `-6` | decision-cluster | grouped ADRs by `module:` / `feature:` |

The aggregate kinds (`-2` through `-6`) all flow through `scripts/aggregate.mjs#buildAggregateSummaryTexts` so the embedding stays within MiniLM's 256-token context.

## Incrementality

- Per-file: `index_manifest.json` carries `{file: {hash, ids}}`. The indexer diffs `currentHashes` against the manifest and only re-chunks changed/deleted files.
- Per-aggregate: `dirtyDirs` (from `path.dirname` of changed files), `dirtyFeatures` (from frontmatter), `dirtyDecisions` (from `decisions/<name>.md` basenames) decide which aggregates rebuild. See [[0007-incremental-summary-rebuild]] and [[0008-aggregate-vector-records]].
- Override: `brain:index -- --force` rebuilds everything (used on embedder model swap).

## Chunking

- Markdown: section split on `## H2` / `### H3`, then `chunkText` with overlap.
- Code: top-level symbol slicing using ts-graph's `declaredSymbols` (with regex fallback). File summary embeds the JSDoc/intent sentence via `extractCodeIntent`.

## TypeScript semantic graph

`ts-graph.mjs#loadTsSemanticContext(root, indexableFiles)` loads the `typescript` package (optional dep), runs it over the indexable files, and produces per-file:

- `resolvedImports` — moduleSpecifier → relative path
- `crossFileRefs` — identifiers used in this file that resolve to declarations elsewhere
- `spans` — exact positions of cross-file references
- `declaredSymbols` — top-level declared symbols (shared with chunk.mjs to avoid double AST walks)

When `typescript` isn't installed, the indexer falls back to regex symbol detection (lower recall on nested declarations).

## Files

- `scripts/brain-index.mjs` — the orchestrator + the `rebuild*` aggregate functions.
- `scripts/chunk.mjs` — `dispatchChunker`, `chunkMarkdown`, `chunkCode`, `chunkSummary`, `extractCodeIntent`.
- `scripts/aggregate.mjs` — pure synthesizers for module/feature/package/decision aggregates.
- `scripts/embed.mjs` — `LocalProvider` (MiniLM) + `OpenAIProvider` (with backoff).
- `scripts/store.mjs` — `JsonStore`, `LanceStore`, `QdrantStore`.
- `scripts/ts-graph.mjs` — TypeScript semantic context.
- `scripts/brain-sync.mjs` — wrapper that computes change deltas before invoking `brain-index`.
- `tests/aggregate.test.mjs` + `tests/chunk.test.mjs` + `tests/store.test.mjs`.

## Decisions

- [[0007-incremental-summary-rebuild]]
- [[0008-aggregate-vector-records]]
