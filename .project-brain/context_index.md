# Context Index

Purpose: compact map agents load before search. Keep this under ~700 tokens; move detail to `repo_context.md`, `modules/`, `features/`, `decisions/`.

## Snapshot

- **What:** reusable Project Brain skill package consumed by app repos via `skills/project-brain/`.
- **Stack:** Node 20+ ESM, npm. Local MiniLM (default) or OpenAI embeddings. JSON / Lance / Qdrant stores.
- **Canonical:** Git-tracked Markdown under `.project-brain/`. Generated indexes are local caches, never committed.
- **Tests:** `npm test` → 45 cases, ~250 ms. CI: lint + test + setup smoke (`.github/workflows/ci.yml`).

## Current focus (2026-05)

Retrieval performance + multi-actor correctness + aggregate vectors. See `decisions/0001` through `0008` and `modules/retrieval.md` / `modules/indexing.md` / `modules/coordination.md`.

## Modules (overviews)

| Area | Doc | Key files |
|---|---|---|
| Retrieval | [[modules/retrieval]] | `scripts/retrieval.mjs`, `scripts/store.mjs`, `scripts/brain-search.mjs` |
| Indexing | [[modules/indexing]] | `scripts/brain-index.mjs`, `scripts/chunk.mjs`, `scripts/aggregate.mjs`, `scripts/ts-graph.mjs`, `scripts/embed.mjs` |
| Coordination | [[modules/coordination]] | `scripts/active-state.mjs`, `scripts/brain-orchestrate.mjs`, `scripts/brain-work.mjs`, `scripts/brain-worktree.mjs`, `scripts/brain-session.mjs` |
| Hooks + guardrails | [[modules/hooks]] | `scripts/brain-guard.mjs`, `scripts/brain-health.mjs`, `scripts/brain-lint-conventions.mjs`, `scripts/brain-session-digest.mjs`, `bin/install-hooks.sh` |
| **Fleet mode** | [[modules/fleet]] | `scripts/projects.mjs`, `scripts/edges/*.mjs`, `scripts/brain-edges.mjs`, `scripts/brain-projects.mjs` |

## Record kinds in the index

| chunk | type | source |
|---|---|---|
| `0..N` | body chunks | `dispatchChunker` per file |
| `-1` | file-summary | `chunkSummary` (uses `extractCodeIntent` for code) |
| `-2` | module-summary | per directory, rebuilt only when dirty |
| `-3` | feature-summary | by `feature:` frontmatter |
| `-4` | project-summary | aggregates module summaries |
| `-5` | package-summary | per `packages/*` / `apps/*` (monorepos only) |
| `-6` | decision-cluster | grouped ADRs by `module:` / `feature:` |
| `-7` | repo-summary | per fleet project (Node/Go/Python/K8s/Docker extractors) |
| `-8` | fleet-summary | one per fleet brain (aggregates repo-summaries + edges) |
| `-9` | cross-project-edge | one per detected cross-project edge |

All aggregate records use `aggregate.mjs#buildAggregateSummaryTexts` so the embedding fits MiniLM's ~256-token window.

## Retrieval invariants

- Scores compute over dense candidates (`topK·8`), not the full corpus. Escape: `BRAIN_BROAD_CANDIDATES=1`.
- `hybridScore = base · (1 + sw·symbol) + clamp(meta, ±0.5)`, capped `[0, 2]`. Symbol amplifies — never replaces — dense.
- BM25 (`k1=1.2`, `b=0.75`) instead of raw TF·IDF.
- Max 2 non-summary chunks per file (`BRAIN_MAX_CHUNKS_PER_FILE`).

See `decisions/0001` through `0004`.

## Coordination invariants

- Every mutation of `active_state.md` goes through `withStateLock` (`O_EXCL`, 60 s stale takeover).
- Orchestrator re-reads `activeStateJson()` per slot and holds an `orchestration-slot/<n>` lease during worktree spawn.

See `decisions/0005`, `0006`.

## Fleet mode invariants

- `discoverProjects(ROOT)` auto-activates fleet behavior when ≥ 2 projects detected (`BRAIN_FLEET_MODE=0|1` overrides).
- Every record carries `project: <name>` in fleet mode; single-project mode emits `''`.
- 11 pluggable edge detectors live in `scripts/edges/`. Each is an async generator with `AbortSignal.timeout(BRAIN_EDGE_TIMEOUT_MS||30s)`.
- Per-project git scope: `brain:work --project NAME` / `brain:worktree spawn --project NAME` route to the project's `.git`.

See `decisions/0009`, `0010`, `0011`.

## Commands (top-level)

```bash
npm run brain:ask    -- "where is X validated"   # routed search
npm run brain:search -- "X"                      # hybrid search
npm run brain:pack   -- "X" --mode resume        # token-budgeted context
npm run brain:index                              # full incremental index
npm run brain:sync                               # diff manifest, re-embed deltas
npm run brain:maintain                           # sync + health
npm run brain:guard                              # pre-commit gate
npm run brain:eval                               # retrieval recall@K vs eval.json
npm run brain:adr     "decision title"           # scaffold ADR
npm run brain:work    -- start ...               # workstream lifecycle
npm run brain:orchestrate -- --concurrency 3 ... # multi-agent spawn
npm run brain:worktree -- spawn --count N ...    # parallel branches
npm test                                         # 88 unit tests
# Fleet mode (only when 2+ sibling projects discovered):
npm run brain:edges                              # list cross-project edges
npm run brain:edges -- --detect                  # force-rerun all detectors
npm run brain:projects                           # projects + edge counts
```

## Retrieval hints

- For *"how does X work?"* → start with module overview (`modules/X.md`), then ADRs (`decisions/`).
- For symbol questions → use `brain:symbol <name>` or `brain:impact <name>`.
- For *"current work"* → load `active_state.md` (always small, always live).
- `master_plan.md` only on ambiguity or re-ingestion.
