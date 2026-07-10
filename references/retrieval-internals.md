# Project Brain — Retrieval Internals

> Part of the **project-brain** skill. Loaded on demand from the lean core `SKILL.md` — see its "Reference files" section for the full map.

How the local index works: generated files, embedding model, ranking limits, graph expansion, eval methodology, and contextual retrieval.

## Generated files

Do not commit:

- `.project-brain/vector-db/` — LanceDB tables when `BRAIN_STORE` resolves to `lance` (e.g. `brain_records.lance`).
- `.project-brain/index_manifest.json` — model, dimensions, backend, file↔chunk id map (row count can differ from total chunks).
- `.project-brain/search_index.json` — full record mirror for health/fallback JSON mode; can be large on big repos.

The local vector backend is selected with `BRAIN_STORE=auto|json|lance|qdrant`. `auto` prefers LanceDB when the optional dependency is installed and falls back to the JSON cache. `qdrant` uses `BRAIN_QDRANT_URL`, `BRAIN_QDRANT_COLLECTION`, and optional `BRAIN_QDRANT_API_KEY`.

Default retrieval requires no API keys: local MiniLM embeddings plus JSON/LanceDB local cache. OpenAI embeddings require `OPENAI_API_KEY`; hosted Qdrant usually requires `BRAIN_QDRANT_API_KEY`.

### Local retrieval (what the index is)

Treat the index as a **machine-local cache** built from Git-tracked `.project-brain/` markdown **and** application source (often a large share of chunks under `lib/`, `app/`, `components/`, `e2e/`, etc.). It is not “only product docs.”

Each **record** is: a **384-dimensional** embedding (`Xenova/all-MiniLM-L6-v2`), the **retrieval text** (one chunk/slice of a file, often near a heading—not the whole file in one vector), and **metadata** (path, record type, chunk index, symbols where applicable). Judge relevance from returned **text and paths**, not from vector floats.

**Freshness:** `npm run brain:health` may report indexed paths for **deleted files** or **stale content hashes**. Until you run `npm run brain:sync` (or a full re-index), answers can cite **ghost paths** or **old slices**. After meaningful edits, prefer sync before trusting retrieval-only answers.

**Drift:** `npm run brain:verify` is a read-only check for curated docs that have fallen out of sync with the code they describe — distinct from `brain:health` (index plumbing) and `brain:link-check` (markdown paths). It flags two things: **symbol-drift** (a decision/module/feature doc names a code symbol in backticks that no longer appears anywhere in indexed code — a rename/deletion signal) and **stale-summary** (a module/feature summary older than its newest underlying code file by more than `--stale-days`, default 14). Symbol-drift auto-skips when no code symbols are indexed (e.g. non-JS repos), so it won't cry wolf. `--json` for machine output, `--strict` to exit non-zero for CI/hooks. Stale context is worse than none — it confidently misleads the agent — so run this after large refactors before trusting doc-sourced answers.

**Ranking limits:** Hybrid scoring (dense similarity, keywords, symbol hits, metadata, branch/diff boosts) is good for many queries but not all. On natural-language conceptual queries the measured failure mode (docs/eval-failure-analysis.md; the older "tests outrank implementation" suspicion was NOT confirmed there) is **sibling files outranking the owning module**: plain-English tokens substring-match unrelated symbols and incidental keyword overlap outweighs a compressed dense signal. Mitigations (measured in docs/eval-failure-analysis.md): enable **`BRAIN_LEXICAL_UNION=1` + `BRAIN_RERANK=1` as a pair** — BM25 routes targets dense can't see into the candidate pool, then a local cross-encoder (~23 MB first-run download, ~0.5–2 s/query) re-judges the top 20; the full stack moved hard-subset hit@8 0.595→0.762 (CI-significant). `BRAIN_SYMBOL_SUBSTRING_GUARD=1` exists but measured net-harmful — leave it off. When top hits look like the wrong layer, use `npm run brain:symbol -- …`, narrower `brain:search` flags (e.g. `--modules-only`), `BRAIN_CONTEXT_FILES` for known touched files, or read the target file from `context_index.md` / module pages instead of assuming the first vector hit is canonical.

**Graph-expanded retrieval (opt-in, default OFF):** Set `BRAIN_GRAPH_EXPAND=1` to add a **one-hop graph expansion** on top of dense candidates. The top-N dense seeds (`BRAIN_GRAPH_EXPAND_SEEDS`, default 5) pull in structurally-adjacent records via the relationships already on records — `references`↔declared `symbols` (like `brain:graph` `calls:` edges), shared `imports`, and cross-project edges — capped at `BRAIN_GRAPH_EXPAND_MAX` (default 12). Neighbors are scored with the same hybrid pipeline plus a small, clamped graph-proximity bonus (`BRAIN_GRAPH_EXPAND_BONUS`, default 0.08) that cannot outrank a real dense hit. This surfaces code that is wired to the answer but doesn't embed near the query. It is **heavier**: it requires a full `store.getAll()`, so it's only worth enabling when symbol/structure adjacency matters. Default OFF keeps `retrieve()` unchanged (no `getAll`). Measure on the hard eval subset (`npm run brain:eval`) before turning it on by default.

**Not the same as in-app RAG:** Some applications keep a **separate** vector store for product features (e.g. venue-scoped rows in Postgres/pgvector with a different embedding model and dimensions). That system does not appear in `.project-brain/`; Project Brain local retrieval only sees what this repo’s indexer ingests.

**Measuring quality:** `npm run brain:eval` exercises the cases in `.project-brain/eval.json` (120 here: 36 easy + 84 hard vocabulary-mismatch cases tagged with a `Hard:` note). Beyond the aggregate it reports hard-subset metrics, and supports `--hard-only`, `--diagnose` (per-case failure classification: candidate-generation vs ranking miss, exact corpus-wide dense rank, distractor breakdown), and `--out <file>`. Validate any retrieval change with **`npm run brain:eval:compare -- baseline.json variant.json --hard-only`** — a seeded paired bootstrap with a 95% CI verdict; point estimates at this sample size have been misleading in both directions. Method: `docs/eval-methodology.md`; current failure taxonomy: `docs/eval-failure-analysis.md`. Expand the cases when you find repeatable blind spots so retrieval regressions stay visible in CI or local runs.

**Swappable local embedding model:** The local embedder is env-gated so a stronger/code-aware transformers.js model can be A/B-tested against the default on the hard conceptual eval subset (`npm run brain:eval`; methodology: `docs/eval-methodology.md` when present):

```bash
BRAIN_LOCAL_EMBED_MODEL=Xenova/all-MiniLM-L6-v2   # any transformers.js feature-extraction model id (default)
BRAIN_LOCAL_EMBED_DIMS=384                          # that model's output width (default)
```

Both unset → behavior is byte-for-byte identical (same MiniLM model, 384 dims, mean pooling + normalize). Switching models is a **new vector space**: model + dims are recorded in `index_manifest.json`, so `brain:index` auto-forces a full re-index on a model change (and `brain:search` warns if the index model ≠ current). Always re-index with `--force` after switching: `npm run brain:index -- --force`. Do not mix models in one index. (OpenAI embeddings remain controlled separately via `BRAIN_EMBED_PROVIDER=openai` / `BRAIN_OPENAI_EMBED_MODEL`.)

**Alternative model `Xenova/bge-small-en-v1.5` (384-dim, drop-in) — no significant difference at scale.** Early small-sample runs looked like a recall win (n=21: hit@8 0.81→0.905; n=42: 0.64→0.71), but a paired bootstrap over the full **84-case** hard subset put the difference inside the noise band: hit@8 Δ +0.024 (95% CI [−0.060, +0.107]), MRR Δ −0.026 (CI [−0.098, +0.044]). So bge-small is **statistically indistinguishable from the MiniLM default** here — not worth the forced re-index. It remains available via `BRAIN_LOCAL_EMBED_MODEL` for repos that want to A/B it themselves. Lesson (see `docs/eval-methodology.md`): validate retrieval changes with a confidence interval on a large hard set — n≤42 point estimates were misleading in both directions.

**Contextual Retrieval (opt-in, `BRAIN_CONTEXTUAL_CHUNKS=1`):** When set, the indexer prepends a short deterministic situating prefix (e.g. `[project-brain · module: retrieval · scripts/retrieval.mjs · hybridScore] `) to each chunk's **embedding input only**, so the dense vector carries the chunk's location/identity context (Anthropic's "Contextual Retrieval"). The stored/displayed `text` field is unchanged — agents still see the original chunk. **Default OFF**: with the var unset, indexing is byte-for-byte identical. Re-index (`npm run brain:index --force`) after toggling, and validate recall with `npm run brain:eval` before relying on it. `BRAIN_CONTEXTUAL_PROVIDER` is a reserved seam for a future LLM-generated blurb; only the deterministic generator is implemented today.
