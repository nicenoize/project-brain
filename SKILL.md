---
name: project-brain
description: Shared semantic project brain for web app development. Maintains a compressed project plan, feature/module memory, team active state (including multi-actor leases and workstreams), semantic search index, Git workflow hygiene, and clean-code guardrails.
---

# Project Brain Skill

Use this skill when working inside a software repository that contains `skills/project-brain/` and `.project-brain/`.

The goal is to keep agents aligned with the complete product and technical plan while using as few tokens as possible.

## Core principle

Do not repeatedly load the whole repository or full master plan. Always use the layered context strategy:

1. Load `.project-brain/context_index.md` first.
2. Load `.project-brain/active_state.md` second.
3. Use semantic search for relevant feature/module/decision/code context.
4. Load exact referenced files only when needed.
5. Load `.project-brain/master_plan.md` only for ambiguity, major planning, or re-ingestion.

The vector database is not the source of truth. The Git-tracked Markdown brain is the source of truth. The vector DB is a generated local retrieval cache.

## Default automation policy

Choose the smallest workflow command that matches the user's intent:

| User intent / situation | Default action |
|-------------------------|----------------|
| Ask a repo/context question | Load `context_index.md` + `active_state.md`, then run `npm run brain:ask -- "query"`. |
| Need exact implementation context | Use `brain:ask --pack --max-tokens 1200-3000`; fall back to direct file reads only for returned paths. |
| Start non-trivial implementation | Prefer `npm run brain:work -- start ...` so branch, session, workstream, leases, and initial pack stay aligned. |
| Task looks too large, vague, cross-module, or likely to overwhelm one agent | Run `npm run brain:ticket -- "task title" --packages N --write` before coding. Use its size score and package split. |
| User asks to create GitHub tickets/issues | Run `brain:ticket -- create ... --github` only when `gh` is installed/authenticated or the GitHub connector is available. Otherwise write the package plan locally. |
| User asks to pull issues/backlog and distribute work across agents | Run `npm run brain:orchestrate -- --limit N --concurrency M --write` first. Use `--refill` or `--watch` to keep worker slots full as tasks finish. Review the plan before `--spawn-worktrees` or `--launch-runners`. |
| Multiple agents/humans may edit overlapping files | Use `brain:lease -- add ...` before editing and `brain:lease -- list` before assigning work. |
| Parallel work on separate branches | Use `brain:ticket` first, then `brain:worktree -- spawn --count N ...`; each worker starts a session with the printed task/actor/tool. |
| Long session, compaction, or handoff | Run `npm run brain:compact` with `BRAIN_TASK`, `BRAIN_ACTOR`, and `BRAIN_TOOL` set. |
| Preparing a PR | Run `brain:maintain`, `brain:guard`, project checks, then `brain:pr -- prepare --write .project-brain/pr-body.md`. |
| Updating durable architecture/product facts | Update the specific feature/module/decision file and keep `context_index.md` compact. |

Do not create branches, GitHub issues, PRs, or destructive changes just because a command can do it. Use those modes when the user asks for implementation/workflow execution or when the existing repo workflow clearly requires them. For planning-only requests, use `brain:ticket --write`, `brain:work -- status`, `brain:lease -- list`, and `brain:ask`.

Heuristic for splitting work: if a task touches more than 5 files, more than 1 module, auth/billing/security/deploy/schema code, or has unclear ownership, create work packages first. Prefer discovery → implementation slice(s) → integration → verification.

## Source of truth files

**Hierarchy (trust order):** (1) Git-tracked `.project-brain/` root maps and plans — `context_index.md`, `active_state.md`, `product_plan.md`, `repo_context.md`, `master_plan.md`, optional hand-maintained `MODULE_MAP.md`; (2) structured subtrees — `decisions/`, `modules/`, `features/`, `work-packages/`, `orchestration/` (use frontmatter `status: canonical|draft|deprecated` and `layer: architecture|decision|session|generated` where helpful); (3) `sessions/` — ephemeral handoffs and auto-compact slices, **not** canonical until promoted. See `templates/brain/DECISIONS.md` for ADR discipline.

- `.project-brain/context_index.md` — compact low-token map of the whole project.
- `.project-brain/master_plan.md` — full imported project plan, if present.
- `.project-brain/product_plan.md` — structured product/roadmap summary.
- `.project-brain/repo_context.md` — stack, commands, architecture, conventions.
- `.project-brain/active_state.md` — who is working on what.
- `.project-brain/features/*.md` — feature specs and progress.
- `.project-brain/modules/*.md` — architecture/module specs.
- `.project-brain/decisions/*.md` — durable decisions and rationale. Discipline: `templates/brain/DECISIONS.md` (copied to `.project-brain/DECISIONS.md` on `brain:init` when missing). New ADR file: `npm run brain:adr -- "short title"`.
- `.project-brain/MODULE_MAP.md` — optional **hand-maintained** map of services/packages/deps (seed from `templates/brain/MODULE_MAP.md` on init); link it from `context_index.md` when you use it. Not auto-generated.
- `.project-brain/work-packages/*.md` — agent-ready ticket splits for large work.
- `.project-brain/orchestration/*.md` — backlog-to-worker orchestration plans.
- `.project-brain/sessions/*.md` — optional session handoffs.

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

## Token-saving communication

Use the external Caveman skill for compressed agent communication when available.

- Internal progress, handoffs, investigations, and reviews: prefer `$caveman ultra`.
- User-facing summaries: keep concise and understandable; do not hide risk or ordering for token savings.
- Temporarily drop compression for security warnings, destructive actions, or ambiguous multi-step instructions.
- Caveman affects wording only. Durable facts still belong in `.project-brain/*.md`.
- **`npm run brain:maintain`** optional logs: `BRAIN_MAINTAIN_CAVEMAN=1` and/or `BRAIN_MAINTAIN_WENYAN=1` (or `--caveman` / `--wenyan`) print terse hook/CI status lines only; they do not rewrite skill text or Markdown.

## Standard commands

When asked to initialize:

```bash
npm run brain:init
npm run brain:index
npm run brain:health
npm run brain:adr -- "short decision title"
```

When asked to search context, default to the smart router which picks the cheapest correct retrieval automatically:

```bash
npm run brain:ask -- "query text"
npm run brain:ask -- "query text" --pack --max-tokens 3000
npm run brain:ask -- "query text" --task issue-99-slug --actor cursor-worker-a --pack --max-tokens 3000
npm run brain:ask -- "query text" --explain          # show route decision without running
```

### Reasoning cache (`brain:explain`)

`brain:ask` answers are throwaway — the brain re-derives the same explanation every session. `brain:explain` is the reasoning cache: it captures a synthesized answer as a durable, cited `explainer` record under `.project-brain/explainers/<slug>.md` and tracks whether it has gone stale.

```bash
# Save an answer (text from stdin or --answer-file), citing the sources it came from.
npm run brain:ask -- "how does sync flush work" | npm run brain:explain -- save --query "how does sync flush work" --sources scripts/brain-sync.mjs,scripts/common.mjs --actor cursor-worker-a
npm run brain:explain -- save --query "..." --answer-file answer.md --sources a.mjs,b/c.md

# Re-check freshness: an explainer is STALE if any cited source's content changed or the file is gone.
npm run brain:explain -- check            # human report
npm run brain:explain -- check --json     # machine-readable
npm run brain:explain -- check --strict   # non-zero exit if any stale (CI / pre-commit gate)
npm run brain:explain -- list             # explainers with fresh/stale status
```

Each record stores `query`, `created`/`updated`, `actor`, and `sources:` as `{ path, sha256 }` where the hash is the cited file's content at save time. `check`/`list` re-hash each source's current content; a mismatch (or missing file) marks the cached answer STALE — the staleness invalidation that pairs with the brain's drift philosophy. `save` is idempotent by slug (re-save updates the body + `updated` + re-hashes sources, preserves `created`). v1 deliberately does NOT touch retrieval ranking; a search boost for explainers is a planned follow-up.

### Act axis: audit → enriched plan (`brain:audit` / `brain:improve`)

The brain is extractive (it retrieves); the act axis makes it executive. `brain:audit` is a 9-category audit scaffold (like `brain:adr`, the model does the judging); each confirmed problem becomes an indexed `finding`. `brain:improve` turns a finding into an `improve-plan` enriched from the brain's own index — real blast-radius, governing ADRs, the actual tests to run — then keeps the backlog honest. See `decisions/0017-build-native-improve-act-axis.md`.

```bash
# 1. Scaffold the audit, then record each confirmed problem as a finding.
npm run brain:audit -- run --quick                     # taxonomy + evidence commands (or --categories a,b)
npm run brain:audit -- add --title "..." --category performance --impact 4 \
    --symbols hybridScore,tfidfScore --module scripts/retrieval --sources scripts/retrieval.mjs --body "evidence + fix"
npm run brain:audit -- list                            # backlog by status/impact

# 2. Turn a finding into an enriched, self-contained plan a cheaper model can execute.
npm run brain:improve -- plan <finding-slug> --enrich  # injects buildImpact blast-radius + packPrompt context + buildPlan packages
npm run brain:improve -- list

# 3. Keep the backlog honest: cited sources gone → auto-resolved; changed → flagged stale for re-review.
npm run brain:improve -- reconcile                     # add --dry-run to preview, --json for machines

# 4. Execute / verify — REAL wiring over the existing coordinator + gate (decisions/0020):
npm run brain:improve -- execute <plan-slug>           # DRY preview: materializes work-packages, prints what it WOULD spawn
npm run brain:improve -- execute <plan-slug> --run     # spawns worktrees (brain:worktree); stops at the worktree boundary — no push/merge
npm run brain:improve -- review  <plan-slug>           # brain:guard + brain:verify (+ brain:eval:compare for retrieval-affecting plans)
```

Both record types are indexed and retrievable via `brain:search --type finding|improve-plan`:

| Type | Path | Holds |
|------|------|-------|
| `finding` | `.project-brain/findings/<slug>.md` | A problem: `category`, `impact`, `status` (open/planned/wontfix/resolved), cited `sources` (staleness anchors), `symbols`/`module` (drive enrichment). |
| `improve-plan` | `.project-brain/plans/<slug>.md` | A remediation: the enriched, self-contained plan body. Named `improve-plan`, not `plan`, to avoid colliding with the spec-kit `plan` type. |

`reconcile` reuses the explainer staleness machinery (`evaluateExplainers` + `hashSource`): a finding whose cited sources are all gone is auto-resolved; merely changed sources surface as stale (never auto-closed — avoids false-closing on churn). A `wontfix` finding stays indexed — the "what we decided NOT to do" record. Everything heavy (worktrees, orchestration, eval) is an existing `brain:*` primitive; the act axis adds no new dependency. A retrieval boost for these types is a planned, eval-gated follow-up.

#### Running the act axis as an autonomous loop

The act axis is a cycle — audit → plan → execute → verify → reconcile. Drive it with the `/loop` skill so the agent drains the backlog with minimal input:

```
/loop work the improvement backlog: run `brain:improve status`; if open findings exist run
`brain:improve next` (it plans the top one); if findings are planned, `brain:improve execute <plan> --run`
to spawn worktrees, do the work, then `brain:improve review <plan>`; if the backlog is clear,
`brain:audit run` to find more. Stop when status shows nothing open or planned.
```

- `npm run brain:improve -- status` — backlog dashboard (open/planned/wontfix/resolved + the next action). The loop's situational awareness and stop condition.
- `npm run brain:improve -- next` — advances the backlog ONE safe tick: plans the highest-impact open finding (the only auto-step). Never mutates code.
- `npm run brain:improve -- execute <plan> [--run]` — REAL wiring (decisions/0020): materializes work-packages and routes them to `brain:worktree spawn` as a subprocess. **DRY preview by default** (prints what it would spawn); `--run` spawns; either way **stops at the worktree boundary — no push/merge.**
- `npm run brain:improve -- review <plan> [--baseline f --variant f]` — the REAL gate: `brain:guard` + `brain:verify`, plus `brain:eval:compare --hard-only` for retrieval-affecting plans. It refuses regressions (a required-but-unproven eval gate FAILS) — that is what makes the loop effective rather than a token-burner.

The LLM stays in the loop by design: **auditing** (judging what's worth fixing) and **reviewing** a diff need judgment a CLI can't supply — `next`/`execute`/`review` do the mechanical planning/spawning/gating, the agent does the judgment. Autonomy ceiling: execution is worktree-isolated, and the loop **stops at the merge boundary** — you merge (house rule). See `decisions/0018-autonomous-act-axis-loop.md` and `decisions/0020-real-execute-review-loop-closure.md`.

### Diagrams (`brain:diagram`)

The brain already computes the graph, so a diagram is a projection of the index — no re-parsing. Default output is Mermaid (renders in `docs/*.md` and on GitHub, zero deps); `--format drawio` emits `.drawio` XML (the draw.io desktop CLI is only needed to rasterize to PNG, and the brain never calls it). See `decisions/0016-ecosystem-skill-axis-map.md` (recall axis).

```bash
npm run brain:diagram                                   # module/feature/project overview
npm run brain:diagram -- --module scripts/retrieval     # files + symbols inside one module
npm run brain:diagram -- --feature checkout             # files/modules/decisions for a feature
npm run brain:diagram -- --symbol hybridScore           # blast-radius ego-graph (reuses brain:impact)
npm run brain:diagram -- --fleet                        # cross-project edges (fleet mode)
npm run brain:diagram -- --module x --format drawio --out docs/diagrams/x.drawio
```

Pick at most one scope (default = overview). `--format mermaid|drawio|json`, `--direction TD|LR`, `--max-nodes N` (caps huge graphs). Writing a Mermaid block into a `.project-brain/**.md` round-trips it back into retrieval.

### Skill trust / supply-chain audit (`brain:skill-audit`)

Installing a third-party skill is a supply-chain risk. `brain:skill-audit <path|url>` shells out to [skillspector](https://github.com/NVIDIA/skillspector) (if installed) for a 0-100 risk score and gates adoption. OPT-IN and never vendored: install the scanner CLI, set `BRAIN_SKILLSPECTOR_BIN`, or run via Docker (`BRAIN_SKILLSPECTOR_DOCKER=1`, no local Python). Absent → the audit is skipped (a no-op, not an error), exactly like the `brain:guard` security scanners.

```bash
npm run brain:skill-audit -- ./path/to/skill                 # scan a local skill dir/file
npm run brain:skill-audit -- https://github.com/owner/skill  # scan a remote skill
npm run brain:skill-audit -- ./skill --max-risk 40 --json    # gate: exit 1 if risk > 40
```

First primitive of the trust axis / Constellation federation (`docs/vision-constellation.md`): verify-before-trust for any skill or brain fragment entering your brain. Dogfood it before adopting ecosystem skills (caveman, drawio-skill, ponytail, improve).

### Pre-touch / PR radar (`brain:radar`)

File-centric, deterministic, index-only (no LLM, no new embeddings) — surfaces what the brain already knows about files **before** you edit them. Turns the brain proactive.

```bash
npm run brain:radar -- --for scripts/retrieval.mjs   # one file (repeatable)
npm run brain:radar -- --staged                       # git-staged files (PR briefing)
npm run brain:radar                                    # working-tree changes; --json, --no-impact
```
Per file: active leases, governing ADRs (by module), downstream cross-project consumers, open findings citing it, and a one-line blast radius. Always exits 0 (advisory). Opt-in hook at `templates/hooks/brain-radar.sh` (`BRAIN_RADAR_ON_CHECKOUT=1` / `_ON_COMMIT=1`). See `decisions/0019`.

### Git archaeology (`brain:why`)

Make git history queryable so an agent can answer "why is this code like this?" instead of guessing. New indexed `history` record type.

```bash
npm run brain:why -- ingest [--limit N] [--since <ref>]   # git log → .project-brain/history/<sha>.md (then brain:index)
npm run brain:why -- "why was rerank added" [--json]      # retrieve the commits/PRs that explain it
```
Ingest is **explicit** (not on every sync). Enriches with PR bodies if `gh` is available; degrades silently otherwise. `.project-brain/history/` is regenerable → gitignored. See `decisions/0019`.

### Deterministic self-audit (`brain:gaps`)

What the brain does NOT know / where it's stale or self-contradictory — all from the index, no LLM. READ-ONLY by default.

```bash
npm run brain:gaps                       # grouped-by-severity report; --json; --strict (CI gate)
npm run brain:gaps -- --as-findings      # emit each gap as an indexed `finding` (feeds the act axis)
```
Three checks: coverage gaps (modules w/o ADR+doc, features w/o tests, empty rationales), decision-decay (old ADRs whose module churned), structural contradictions (doc names a missing symbol / cites a vanished file). Precision-biased (won't cry wolf). See `decisions/0019`.

### Synthesis: cross-source insights (`brain:insight`)

Where an `explainer` caches one answer, an `insight` is a SYNTHESIZED claim across multiple sources. A scaffold+recorder like `brain:adr` — **it never calls an LLM** (the agent synthesizes; the command records with guardrails). New indexed `insight` type.

```bash
npm run brain:insight -- scaffold "<topic>"            # guidance on what to synthesize + evidence cmds
npm run brain:insight -- add --title "..." --claim "..." --sources a.mjs,b.md --confidence 0.7 --body "..."
npm run brain:insight -- check [--strict] | list       # staleness via cited-source hashes
```
**Guardrail:** requires ≥2 cited sources (else refuses) + staleness tracking — a synthesized claim must be grounded, to protect the trust axis from hallucination. `.project-brain/insights/` is durable (committed). See `decisions/0019`.

### Learning axis: usage grows the benchmark (`brain:learn`)

Make the eval set learn from real usage **without ever changing ranking** (ranking stays human-approved + eval-gated — the house discipline). It grows only the *measurement*.

```bash
npm run brain:learn -- capture --query "..." --used a.mjs,b.mjs   # stage a usage-proven case
npm run brain:learn -- promote [--min-uses N] [--dry-run]         # append de-duped cases to eval.json
npm run brain:learn -- suggest                                     # propose an A/B knob to run via brain:eval:compare (applies nothing)
```
`capture` stages (gitignored); `promote` is the explicit, reviewable step that grows `eval.json` (file-level cases, not tagged `Hard:`). Nothing here changes ranking or runs automatically. See `decisions/0019`.

The router decides between direct file read, symbol search, doc summary, module summary, vector search, or budgeted pack. Only fall back to the lower-level commands when the router result is insufficient:

```bash
npm run brain:search -- "query text"
npm run brain:search -- "query text" --summary-only
npm run brain:search -- "query text" --modules-only
npm run brain:symbol -- SymbolName SymbolName
npm run brain:impact -- SymbolName
npm run brain:pack -- "query text" --max-tokens 3000
npm run brain:pack -- "query text" --print-budget
npm run brain:pack -- "resume current work" --mode resume --max-tokens 1200
npm run brain:pack -- "architecture map" --mode minimal --max-tokens 800
npm run brain:pack -- "query text" --task issue-99-slug --actor cursor-worker-a
npm run brain:ticket -- "large task title" --packages 4 --write
npm run brain:ticket -- create "large task title" --packages 4 --github
npm run brain:orchestrate -- --limit 6 --concurrency 3 --write
npm run brain:orchestrate -- --limit 6 --concurrency 3 --write --write-packages
npm run brain:orchestrate -- --refill --limit 6 --concurrency 3 --write
npm run brain:orchestrate -- --watch --interval 120 --concurrency 3 --write
npm run brain:orchestrate -- --refill --concurrency 3 --spawn-worktrees --launch-runners --runner-cmd 'codex exec {prompt}'
npm run brain:work -- start --issue 99 --slug checkout-hardening --actor codex --tool codex --files lib/auth.ts
npm run brain:lease -- add "lib/auth.ts" --task issue-99-checkout-hardening --actor codex
npm run brain:pr -- prepare --write .project-brain/pr-body.md
npm run brain:graph -- --format json
npm run brain:eval
npm run brain:maintain
npm run brain:maintain -- --strict
npm run brain:maintain -- --ci
npm run brain:compact
npm run brain:install-cursor-hooks
```

Retrieval ranks with dense vector similarity, keyword relevance, exact symbol matches, metadata, and current branch/diff boosts. Set `BRAIN_CONTEXT_FILES` to comma-separated files when the current task should favor a specific diff or changed-file set. Set `BRAIN_TASK` and/or `BRAIN_ACTOR` (or use `--task` / `--actor` on `brain:search`, `brain:pack`, `brain:ask`) to boost session handoffs and chunks whose frontmatter matches that workstream.

### Automated maintenance (outcome quality)

The skill and Markdown layers improve **answer** quality; **`npm run brain:maintain`** automates **index freshness + gates** so agents cite fewer ghosts. It does **not** change MiniLM, LanceDB chunking, or hybrid ranking weights—those still need deliberate `scripts/retrieval.mjs` (or config) work when `brain:eval` proves a blind spot.

| Command / mode | Behavior |
|----------------|----------|
| `npm run brain:maintain` | If `search_index.json` reports deleted paths or stale hashes (and not `BRAIN_FAST=1`), runs `brain:sync`, then `brain:health`, then removes expired session records. |
| `--strict` | After sync, runs `brain:health --strict-stale`, then **`brain:eval` with `BRAIN_EVAL_STRICT=1`** when `.project-brain/eval.json` exists. |
| `--ci` | Same as `--strict` for CI. If there is **no** `.project-brain/eval.json`, eval is skipped with a log line (add one from `skills/project-brain/templates/brain/eval.json` via `brain:init` or hand-author cases). |
| `--hook` | For Git hooks after pulls: sync when needed; **non-zero exits become 0** so merges are not blocked (inspect logs if retrieval feels wrong). |
| `--no-sync` | Health (and strict/eval when combined with `--strict`) only. |
| `--force-sync` | Passes `--force` into the first `brain:sync`. |
| `--clean-session-files` | Also deletes expired `.project-brain/sessions/*.md` files, not just expired index records. |
| Stale after sync | One automatic `brain:sync --force` retry when `--strict` / `--ci` before failing. |

`post-merge` and `post-checkout` (branch switch) hooks run **`npm run brain:update-skill`** then **`npm run brain:maintain -- --hook`**. The GitHub Actions template runs **`npm run brain:maintain -- --ci`** before `brain:guard`.

`npm run brain:health -- --json` emits machine-readable layout/stale/expiry fields for scripts.

### Auto-compact (token reload slice)

**`npm run brain:compact`** builds a **bounded resume-mode `brain:pack` slice** (default ~1200 token budget), writes `.project-brain/sessions/<branch>__auto-compact__<timestamp>.md`, and indexes it so the next agent turn can reload context without re-reading the whole repo. It excludes prior auto-compact snapshots by default to avoid recursive context bloat. Set `BRAIN_TASK`, `BRAIN_ACTOR`, and **`BRAIN_TOOL`** (`cursor`, `claude`, `gemini`, `codex`, …) in the environment so retrieval boosts match the active workstream.

- **Cursor (automatic):** run **`npm run brain:install-cursor-hooks`** once per repo. Hooks run on **`preCompact`** and **`stop`** (`npm run brain:compact -- --cursor-hook …`). Optional rule: `skills/project-brain/templates/cursor/rules/project-brain-compact.mdc` is copied beside `hooks.json` when the rule file is missing.
- **Claude Code / Codex CLI / Gemini CLI:** no IDE hook—run **`npm run brain:compact`** (same env vars) before `/compact`, thread reset, or ending a long terminal session. Copy-paste policy from **`skills/project-brain/templates/agents/COMPACT_INSTRUCTIONS.md`** into team docs or `CLAUDE.md` if desired.
- **CLI follow-up:** compact triggers **`npm run brain:sync`** by default so the index sees the new session file; Cursor hook mode skips sync for latency (set `BRAIN_COMPACT_SYNC=1` to force sync from hooks). Set **`BRAIN_QUIET=1`** is applied automatically for hook runs so stdout stays JSON-clean for Cursor.

### Performance modes

- `BRAIN_FAST=1` — fast iteration mode. Sync hooks become no-ops, retrieval uses the JSON store with summary-only results, and module/feature/project summaries are not rebuilt during indexing. Recommended local default during heavy edit loops; CI keeps it off so retrieval quality stays high.
- `BRAIN_BACKGROUND=1` — pre-commit hook sets this so `brain:sync` self-decides foreground vs detached background indexing instead of blocking the commit. Manual `npm run brain:sync` runs foreground by default.

### Polyglot symbols (Python + Go)

- `BRAIN_POLYGLOT_SYMBOLS=1` — **default OFF.** When set, `.py` and `.go` files are indexed as `type:code` records with regex/heuristic-extracted `symbols`, `exportedSymbols`, and `references`, so `brain:impact` and `brain:graph` work in Python/Go repos (today they are effectively TS/JS-only, since precise extraction runs through the TypeScript compiler). Python exports = top-level `def`/`class`/module assignments not prefixed with `_`; Go exports = capitalized identifiers. With the flag unset, the indexed file set and every record are byte-for-byte unchanged. The intent is to flip this default-on after validation. This first increment is regex-based (lightweight, no native deps); **tree-sitter precision is the planned follow-up** and will replace the heuristics behind the same record interface.

When asked to sync:

```bash
npm run brain:sync
```

When asked to update the reusable skill:

```bash
npm run brain:update-skill
```

Without a configured upstream branch (`git branch -u …`), this fast-forwards from **https://github.com/nicenoize/project-brain** via a Git remote named `project-brain-upstream` (set `PROJECT_BRAIN_UPSTREAM_URL` or `PROJECT_BRAIN_UPSTREAM_REMOTE` to override, or set `PROJECT_BRAIN_REMOTE` to use an existing remote such as `origin`).

When asked to guard/check:

```bash
npm run brain:guard
```

When asked to track short-lived work context (branch-scoped; use flags when several agents or humans share one branch):

```bash
npm run brain:session -- start [--task <workstream-id>] [--actor <label>] [--tool cursor|claude|gemini|codex|human|other] [--parent <orchestrator-id>]
npm run brain:session -- end [--task <workstream-id>]
npm run brain:session -- list [--json]
npm run brain:session -- clean [--files]
```

For retrieval that prefers the current workstream’s session chunks, set `BRAIN_TASK` / `BRAIN_ACTOR` or pass `--task` / `--actor` to `brain:search`, `brain:pack`, or `brain:ask`.

When asked for **parallel Claude Code / Cursor workers** on **separate branches** (Git worktrees: isolated directories, no stash dance):

```bash
npm run brain:worktree -- spawn --count 3 --base develop --type feature --issue 456 --slug checkout-hardening [--tool cursor|claude|gemini|codex|human|other] [--parent <orchestrator-id>]
npm run brain:worktree -- list
npm run brain:worktree -- remove <path-from-list>
npm run brain:worktree -- prune
```

Each worktree is a normal checkout: use one terminal or IDE window per tree, `cd` into its path, run `npm run brain:session -- start …` there with the printed `--task` / `--actor` / `--tool`, and keep `BRAIN_TASK` / `BRAIN_ACTOR` aligned when calling `brain:pack` / `brain:ask`. Default worktree parent is `<repo>/.worktrees/` (gitignored via setup); override with `--dir` or `BRAIN_WORKTREE_DIR`. Prefer `develop` as `--base` for GitFlow work branches. **`--tool`** (or env **`BRAIN_WORKTREE_TOOL`**) sets the session tool label and the `<tool>-worker-N` actor prefix for Cursor, Claude Code, Codex CLI, Gemini, etc. (defaults to `claude`). Aliases: `claude-code` → `claude`; `openai`, `gpt`, `codex-cli` → `codex`.

## Operating modes

### Initialize repository

When the user asks to initialize or audit a repo:

1. Inspect package manager files, framework, app structure, README/docs.
2. Create/update `.project-brain/repo_context.md`.
3. Create/update `.project-brain/context_index.md` as a compact map.
4. Create/update `.project-brain/product_plan.md`.
5. Create initial module pages under `.project-brain/modules/`.
6. Create feature pages only for clear features; mark uncertain items as `Needs Review`.
7. Run or request semantic indexing.

### Ingest master plan

When the user provides or references a master plan:

1. Save it as `.project-brain/master_plan.md` if not already present.
2. Extract durable product goals, modules, features, decisions, milestones, constraints.
3. Update `context_index.md` with a highly compressed representation.
4. Update `product_plan.md`, module pages, feature pages, and decision pages.
5. Keep exact details in the specific files, not in `context_index.md`.
6. Mark assumptions as `Needs Review`.
7. Run semantic indexing.

### Start feature work

When starting feature work:

1. Read `context_index.md` and `active_state.md`.
2. If the task is large or unclear, run `brain:ticket -- "task title" --packages N --write` before implementation.
3. Check `brain:lease -- list` and `active_state.md` for overlaps.
4. Semantic search for the feature name, related modules, related decisions, and nearby code.
5. Load only relevant feature/module/decision files.
6. Search GitHub issues for existing matching work when issue work is expected.
7. If the user wants issue creation and no suitable issue exists, create a GitHub issue/work packages with Project Brain references.
8. Use `npm run brain:work -- start ...` for the full workflow envelope: branch, session, workstream, optional leases, and initial resume pack.
9. Create or update the feature page and define scope boundaries/out-of-scope items.
10. Keep `active_state.md` current while work is active.

`brain:work -- start` creates/switches the GitFlow branch unless `--no-branch` is passed. Use `--no-branch` for dry runs, audits, or planning-only sessions.

### Split large work for agents

When a task is too large for one agent or spans multiple modules:

1. Run `npm run brain:ticket -- "task title" --packages N --write` to create an agent-ready work-package plan.
2. Read the size score: `small` can usually stay with one agent; `medium` should have explicit packages; `large` should start with discovery and a merge actor.
3. Use 2-6 packages by default: discovery, one or more implementation slices, integration, verification/handoff.
4. Keep each package small enough for one agent: clear objective, owned files/globs, dependencies, acceptance criteria, verification, and handoff rules.
5. If GitHub CLI is authenticated and the user wants issues created, run `npm run brain:ticket -- create "task title" --packages N --github`.
6. Use `brain:worktree -- spawn --count N --issue <id> --slug <slug> --tool <tool>` when packages can run in parallel.
7. One orchestrator or merge actor owns `active_state.md`, dependency reconciliation, and final PR preparation.

Do not parallelize tightly coupled edits just because several packages exist. Discovery or integration packages should run serially when they define or reconcile dependencies.

### Orchestrate issue backlog

When the user wants Project Brain to pull GitHub issues and distribute work across several agents:

1. Run `npm run brain:orchestrate -- --limit N --concurrency M --write` to fetch open issues with `gh issue list`, score them, split them into packages, and assign the first runnable package to each worker slot.
2. Use labels/search to control the queue, for example `--label agent-ready` or `--search "milestone:v1"`.
3. Review `.project-brain/orchestration/*.md` before spawning workers. The plan states which packages are runnable, serial, or blocked by discovery/integration.
4. Add `--write-packages` when each issue should also get a durable `.project-brain/work-packages/*.md` plan.
5. Use `--refill` to count active workstreams in `.project-brain/active_state.md` and assign only open slots.
6. Use `--watch --interval 120` when you want a local queue runner that keeps polling and refilling slots after workers call `brain:work -- end --task ...`.
7. Add `--spawn-worktrees` only after reviewing the plan; it creates worktrees for the current runnable worker slots and records those assignments in `active_state.md` immediately.
8. Add `--launch-runners --runner-cmd '...'` only when the user explicitly wants runner processes started. Runner command placeholders are shell-quoted: `{prompt}`, `{task}`, `{actor}`, `{tool}`, `{branch}`, `{issue}`, `{title}`, `{cwd}`.
9. Runner processes receive `BRAIN_TASK`, `BRAIN_ACTOR`, `BRAIN_TOOL`, `BRAIN_ISSUE`, `BRAIN_BRANCH`, and `BRAIN_RUNNER_PROMPT`; logs default to `.project-brain/runner-logs/`.
10. Keep `--concurrency` at the number of tickets/packages the team can actively review, not the maximum number of agents available.
11. After workers finish, either let `--watch` refill automatically or run `brain:orchestrate -- --refill` again.

The orchestrator plans and assigns work; it does not replace review, integration, or final PR ownership. It can spawn worktrees and launch configured CLI runner processes, but one merge actor should still reconcile `active_state.md`, package dependencies, and final PRs.

### Coordinate parallel edits

When multiple agents or humans may touch the same area:

1. Use `npm run brain:lease -- add "file-or-glob" --task <task> --actor <actor>` before editing shared files.
2. Use `npm run brain:lease -- list` before assigning a worker.
3. Use `npm run brain:lease -- release --task <task>` when the package is done.
4. The orchestrator should resolve overlaps before integration work begins.

### Proactive pre-touch brief

Everything else in the brain is *pull* (you ask). `brain:brief` is a *push*: before you touch a set of files, it surfaces what you should already know, so the brain taps you on the shoulder instead of waiting to be asked. It is **read-only** and never mutates state.

```bash
npm run brain:brief                          # default target = working-tree changes
npm run brain:brief -- --files src/auth.ts,lib/db.ts
npm run brain:brief -- --files src/auth.ts --json
npm run brain:brief -- --strict              # exit non-zero on a hard lease conflict
```

It groups advisories from existing brain state:

- **🚨/⚠ Leases & workstreams** — active file leases touching your files or their module (`🚨` when someone else holds the lease, `⚠` when it's yours), sourced from `active_state.md`.
- **📐 Governing ADRs** — `.project-brain/decisions/*.md` whose module or body references your files/module.
- **↯ Downstream impact** — indexed `cross-project-edge` records where this project is the upstream owner; "changing this may affect `<project>` via `<edgeKind>`".
- **🕑 Recent sessions** — best-effort: recent session docs that mention your files/modules.

The plain run always exits 0 (advisory). `--strict` exits non-zero only when someone else holds a lease on a file you're about to touch.

**Opt-in post-checkout hook.** `templates/hooks/post-checkout` ships a guarded snippet that runs `brain:brief` after a branch switch. It is additive (does not clobber existing hook content) and soft-exits 0 on any failure (never blocks checkout). It is **off by default** — enable it by exporting `BRAIN_BRIEF_ON_CHECKOUT=1`. We do not auto-install it.

### During implementation

Before making large changes:

1. Verify module ownership and conventions.
2. Add/confirm file leases for shared or risky files.
3. Avoid unrelated changes.
4. Keep commits small and logical.
5. Capture new decisions in `decisions/`.
6. Update feature/module pages after meaningful progress.
7. Run `npm run brain:compact` before handoff, compaction, or switching tools.

### Prepare PR

When preparing a PR:

1. Run `npm run brain:guard`.
2. Run project lint/typecheck/test commands from `repo_context.md` if available.
3. Update feature/module/decision pages.
4. Update `context_index.md` if the plan or architecture changed.
5. Generate PR body from `.github/PULL_REQUEST_TEMPLATE.md`.
6. Create a draft PR targeting `develop` by default.
7. Include `Closes #issue` or `Fixes #issue` so GitHub closes the issue on merge.
8. Include brain impact and test evidence.
9. Only target `main` for release or hotfix PRs.

Use `npm run brain:pr -- prepare --write .project-brain/pr-body.md` to generate a PR body from branch diff, active workstream state, sessions, touched modules, and verification expectations.

### Daily/team sync

When asked for a daily sync:

1. Read `active_state.md`.
2. Summarize active work by developer.
3. Identify blockers, overlaps, stale items, and features needing review.
4. Update `context_index.md` only if durable state changed.

## Clean code and web-app conventions

Default to modern web-app conventions unless repo_context overrides them:

- Next.js/App Router friendly structure.
- TypeScript-first.
- Prefer explicit types at module boundaries.
- Avoid `any` unless justified.
- Keep server-only code separate from client components.
- Do not expose secrets with public env vars unless intentionally public.
- Keep modules cohesive.
- Avoid large mixed-responsibility files.
- Do not add TODO comments without creating or referencing a tracked issue/task.
- Do not mix refactors and features in one commit unless the refactor is strictly local and necessary.

## Git conventions

Default branch model is GitFlow:

- `main` — protected production/release branch.
- `develop` — protected integration branch; default base and PR target for feature/fix/refactor/chore/docs/test work.
- `feature/<issue>-slug`, `fix/<issue>-slug`, `refactor/<issue>-slug`, `chore/<issue>-slug`, `docs/<issue>-slug`, `test/<issue>-slug` — issue-linked work branches.
- `release/<version-or-date>` — release stabilization branch targeting `main`.
- `hotfix/<issue>-slug` — urgent production fix from `main`; merge back to both `main` and `develop`.

Commit format:

```text
type(scope): short description
```

Allowed types:

- feat
- fix
- refactor
- chore
- docs
- test

Rules:

- lowercase after colon.
- imperative present tense.
- subject <= 72 chars.
- body explains why if needed.
- no direct commits to protected branches unless explicitly requested by the user.
- non-trivial work must have a GitHub issue before PR.
- PRs close issues through GitHub keywords (`Closes #123`, `Fixes #123`) rather than manual closure.

## Team memory conventions

- Project Brain Markdown is the shared Git-tracked source of truth.
- Cavemem may be used by each team member as local personal/session memory.
- Cavemem output is never authoritative until promoted into `.project-brain/*.md`.
- Do not store secrets, `.env*`, private customer data, dependency folders, build output, or generated Project Brain indexes in Cavemem.
- Caveman may be used for low-token communication; it is not memory and does not replace Project Brain or Cavemem.

## Collaboration rules (humans + Cursor + Claude + Gemini)

- `active_state.md` is the team radar: workstreams, leases, overlaps. Prefer **one person or lead agent** merging it to reduce git conflicts.
- If two actors touch the same module/feature, record overlap risk in `active_state.md` before implementing.
- **Parallel agents / split tools**: assign a stable `task_id` per stream. Each stream runs `brain:session -- start --task … --actor … --tool …` and ends with `brain:session -- end --task …`. Sub-agents may set `--parent` to the orchestrator run id. Run **`npm run brain:compact`** (or rely on Cursor hooks after `npm run brain:install-cursor-hooks`) before long compacts or handoffs so the next model load can use `.project-brain/sessions/*__auto-compact__*.md` plus `brain:pack` with the same `BRAIN_TASK` / `BRAIN_ACTOR`.
- **Parallel branches (Cursor, Claude Code, Codex, Gemini, humans)**: use `npm run brain:worktree -- spawn --count N … [--tool …]` so each worker gets its own directory and GitFlow branch off `develop` (or `--base`). Match the printed `<tool>-worker-N` actor and `--tool` per session; merge brain Markdown through normal PRs and still prefer **one merge point** for `active_state.md`.
- **Orchestrator pattern** (e.g. Cursor parent + workers, or any multi-step automation): parent runs `brain:pack` once with `BRAIN_TASK` / `BRAIN_ACTOR` (or flags) and passes the same blob to children; children write notes under `.project-brain/sessions/`; one actor merges durable facts into features/modules/decisions and updates `active_state.md`.
- Capture handoffs in `.project-brain/sessions/` when work is interrupted or handed off between tools or people.
- Update the brain before opening a PR.

## Fleet mode

When `scripts/projects.mjs#discoverProjects(ROOT)` finds ≥ 2 sibling projects under one fleet root (or `BRAIN_FLEET_MODE=1` forces it), the brain switches to **fleet mode** automatically — same install path, same `brain:update-skill`, no flag needed for the common case.

A typical fleet:

```
fleet-root/
├── .project-brain/         (the fleet brain)
├── skills/project-brain →  (global skill, symlink)
├── backend/                (Node/TS API, own .git)
├── workers/                (Python / Go pods, own .git)
├── k8s-orchestration/      (Helm + kustomize, own .git)
├── frontend/               (Next.js, own .git)
└── shared-schemas/         (.proto / openapi.yml, own .git)
```

What changes:

- Every indexed record carries `project: <name>` (single-project mode keeps `''`).
- Three new record kinds: `repo-summary` (`chunk:-7`), `fleet-summary` (`chunk:-8`), `cross-project-edge` (`chunk:-9`).
- 12 pluggable edge detectors under `scripts/edges/` populate the cross-project graph: `k8s-image`, `http-client`, `grpc-client`, `proto-schema`, `openapi-schema`, `env-var`, `k8s-env-injection`, `pubsub` (Kafka/RabbitMQ/Redis/SQS/PubSub), `db-shared`, `package-dep`, `go-replace` (+ `image-registry` registrar). `k8s-env-injection` emits **directed** edges from an orchestrator that injects a workload env (Go `corev1.EnvVar{Name:"X"}` or Helm `env:`) → the project that reads it (`os.Getenv`, viper `mapstructure:"x"`, `env:`/`envconfig:` tags) — the operator→pod seam that import/schema detectors can't see.
- `active_state.md` gets a `project` column on both workstreams + leases tables (legacy 6-/4-column files keep parsing).

CLI surface:

```bash
npm run brain:projects                       # list discovered projects + edge counts
npm run brain:edges                          # list materialized cross-project edges
npm run brain:edges -- --detect              # force-rerun every detector
npm run brain:edges -- --detector k8s-image  # run one detector (debug)
npm run brain:edges -- --min-confidence high

# every existing `brain:*` command accepts --project NAME (comma-list for OR):
npm run brain:search -- "X" --project backend
npm run brain:pack   -- "X" --project workers --mode resume
npm run brain:ask    -- "X" --project frontend,backend
npm run brain:work     -- start --project backend --issue 123 --slug auth
npm run brain:lease    -- add lib/auth.ts --project backend --task issue-123
npm run brain:worktree -- spawn --project backend --count 3 --base develop
npm run brain:impact   -- ChargeCard --cross-project
```

Configuration:

```
BRAIN_FLEET_MODE=0|1                      force off / on
BRAIN_FLEET_PROJECTS=backend,workers      discovery whitelist
BRAIN_FLEET_EXCLUDE=tooling,scripts       discovery blacklist
BRAIN_FLEET_NESTED_DIRS=modules           descend one level into marker-less
                                          container dirs (e.g. a modules/ monorepo
                                          of many go.mod) so each child is a project;
                                          default off = depth-1 scan unchanged
BRAIN_FLEET_SERVICE_URLS=backend=https://backend.svc,...
                                          high-confidence http-client resolution
BRAIN_EDGE_TIMEOUT_MS=30000               per-detector budget
BRAIN_AUTO_RECOVER=1                      Lance schema migration on first fleet index
```

See `modules/fleet.md` for the full module overview and `decisions/0009`–`0011` for the rationale.

## Spec-Kit integration

When a repo uses [`github/spec-kit`](https://github.com/github/spec-kit), brain auto-detects its artifacts and indexes them alongside `.project-brain/` content. No flag needed — `.specify/` and `specs/<id>/` paths are picked up by the indexer, and the new record types (`constitution` / `spec` / `plan` / `tasks-list` / `spec-support`) flow into the existing retrieval surface.

New record kinds:

| `type` | Source | Aggregates into |
|---|---|---|
| `constitution` | `.specify/memory/constitution.md` | canonical-root boost (×1.6 baseline) |
| `spec` | `specs/<id>/spec.md` | `feature-summary` (chunk:-3) via `feature: <id>` |
| `plan` | `specs/<id>/plan.md` | same `feature-summary` |
| `tasks-list` | `specs/<id>/tasks.md` | same `feature-summary` |
| `spec-support` | other files in `specs/<id>/` | same `feature-summary` |

CLI (only fires when `specs/<id>/` exists):

```bash
npm run brain:speckit -- import  <id>            # spec.md → .project-brain/features/<id>.md (cross-linked, idempotent)
npm run brain:speckit -- tasks   <id> --write    # tasks.md → .project-brain/work-packages/spec-<id>-wpN.md per US group
npm run brain:speckit -- tasks   <id> --github   # also open GH issues via gh issue create
npm run brain:speckit -- analyze <id>            # ADR scaffolds from specs/<id>/analyze.md headings
```

Three Claude Code slash commands installed automatically by `setup-claude-settings.mjs` (skip via `PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS=1`):

- `/brain-speckit-specify $ARGS` — wraps `/speckit.specify` + `brain:speckit import` + `brain:sync`.
- `/brain-speckit-tasks <id>` — wraps `/speckit.tasks` + `brain:speckit tasks <id> --write`.
- `/brain-speckit-implement <id>` — picks the next pending work-package, opens a brain workstream (`brain:work start --task spec-<id>-wpN`), runs `/speckit.implement` scoped to that package, then `brain:work end`.

Configuration:

```
BRAIN_SPEC_BOOST=0.04                          additive boost on spec/plan/tasks-list/constitution records for architectural queries
PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS=1           skip /brain-speckit-* command install during brain:update-skill
```

See [`modules/spec-kit.md`](.project-brain/modules/spec-kit.md) for the full module overview and [`decisions/0012-spec-kit-integration.md`](.project-brain/decisions/0012-spec-kit-integration.md) for the rationale.

## Recovery

If the index gets stuck (Lance schema errors, gigantic `search_index.json`, ghost paths in the thousands), reset it:

```bash
npm run brain:repair             # interactive
npm run brain:repair -- --yes    # non-interactive
npm run brain:repair -- --dry-run
npm run brain:index -- --force   # rebuild after repair
```

What gets removed (only generated artifacts):

- `.project-brain/vector-db/` — Lance table
- `.project-brain/search_index.json` (+ any leftover `.tmp.*` siblings)
- `.project-brain/index_manifest.json`
- `.project-brain/.fleet-cache/`

What stays: every Markdown file under `.project-brain/` (source of truth) and everything else in the repo.

Auto-recovery is on by default for Lance schema mismatches (typical after `brain:update-skill` adds new record fields). Opt out with `BRAIN_AUTO_RECOVER=0`. If the JSON mirror overflows Node's string limit (`ERR_STRING_TOO_LONG`), it's read-disabled with a warning — `brain:repair` is then the only recovery path.

Cap-tuning env vars (rarely needed):

```
BRAIN_JSON_MIRROR_MAX_BYTES=209715200    # 200 MB read cap
BRAIN_JSON_MIRROR_MAX_RECORDS=50000      # write cap
BRAIN_JSON_MIRROR=0                      # disable JSON mirror entirely (Lance/Qdrant primary)
```

## Performance

The indexer reuses previously-computed vectors for byte-identical chunks. A one-line edit to a 700-line file embeds **1 chunk**, not all 16 — typical cache hit rate is 80–95% during incremental sync. Background sync runs niced (lowest CPU priority, idle I/O on Linux) and is debounced + globally locked so the editor never sees two bg-syncs racing.

Perf tuning env vars:

```
BRAIN_REUSE_VECTORS=0                    # disable chunk-level vector reuse (force full re-embed)
BRAIN_SYNC_DEBOUNCE_MS=30000             # skip bg sync if manifest was updated within window
BRAIN_SYNC_NICE=0                        # disable nice/ionice wrapping for the bg child
```

## Response behavior

When using this skill, be direct and operational. Prefer concrete file updates, commands, and checks over abstract explanation. If facts are uncertain, mark them as `Needs Review` instead of inventing them.
