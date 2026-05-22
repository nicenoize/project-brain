---
title: Package summaries, decision clusters, and tighter folder embeddings
status: canonical
layer: decision
module: indexing
feature: aggregate-vectors
date: 2026-05-22
---

# Package summaries, decision clusters, and tighter folder embeddings

## Context

MiniLM (the default local embedder) has a ~256-token context. Module-summary `embeddingText` used to be a literal concat of every child file summary — for a 30-file directory ~6 000 chars, of which ~5 000 were silently truncated.

Two additional retrieval gaps:

1. **Monorepos** had no package-level anchor. A query like *"what does @scope/billing do"* hit scattered file summaries with no synthesizing vector.
2. **Cross-decision queries** ("all decisions about auth") had to grep individual ADRs because there was no cluster record.

## Decision

Introduce two new record kinds and tighten the existing folder embeddings.

| record | chunk | type | source |
|---|---|---|---|
| package-summary | `-5` | `package-summary` | `packages/*` + `apps/*` with `package.json` |
| decision-cluster | `-6` | `decision-cluster` | grouped by `module:` or `feature:` in ADR frontmatter |

`buildAggregateSummaryTexts()` (in `scripts/aggregate.mjs`) produces two distinct strings per aggregate:

- `text` — verbose child concat (shown by `brain:pack` to humans).
- `embeddingText` — intent-dense: title + key + optional README first paragraph + one-line per child ("- `name`: first sentence of intent") + union of exported symbol names, **capped at 1 080 chars** so the entire summary fits MiniLM's window.

Package summaries also embed `package.json` `description`, `keywords`, top-level exports from `src/index.ts`, and direct + peer dependencies.

Detection of packages is configurable via `BRAIN_PACKAGE_GLOBS` (default `packages/*,apps/*`). Decision clusters only fire when ≥ 2 ADRs share a `module:` or `feature:` value.

## Consequences

- The vector now covers the whole module/folder/package instead of half. Architectural queries hit aggregate records with higher confidence.
- Zero new records on a repo with no `packages/*` and no ADRs. The dispatcher early-returns.
- Per-record schema unchanged — `type: package-summary` / `type: decision-cluster` reuse existing fields. No store migration.
- Tested in `tests/aggregate.test.mjs` (22 cases covering the synthesizers, the FS detection, and the embedding-cap behavior).

## Related

- [[0007-incremental-summary-rebuild]] — aggregate records reuse the dirty-set plumbing.
- `scripts/aggregate.mjs` for the pure synthesizers.
