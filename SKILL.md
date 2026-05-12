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

## Source of truth files

- `.project-brain/context_index.md` — compact low-token map of the whole project.
- `.project-brain/master_plan.md` — full imported project plan, if present.
- `.project-brain/product_plan.md` — structured product/roadmap summary.
- `.project-brain/repo_context.md` — stack, commands, architecture, conventions.
- `.project-brain/active_state.md` — who is working on what.
- `.project-brain/features/*.md` — feature specs and progress.
- `.project-brain/modules/*.md` — architecture/module specs.
- `.project-brain/decisions/*.md` — durable decisions and rationale.
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

**Ranking limits:** Hybrid scoring (dense similarity, keywords, symbol hits, metadata, branch/diff boosts) is good for many queries but not all. Natural-language questions can sometimes rank **tests or e2e** above the **implementation module** that owns the behavior. When top hits look like the wrong layer, use `npm run brain:symbol -- …`, narrower `brain:search` flags (e.g. `--modules-only`), `BRAIN_CONTEXT_FILES` for known touched files, or read the target file from `context_index.md` / module pages instead of assuming the first vector hit is canonical.

**Not the same as in-app RAG:** Some applications keep a **separate** vector store for product features (e.g. venue-scoped rows in Postgres/pgvector with a different embedding model and dimensions). That system does not appear in `.project-brain/`; Project Brain local retrieval only sees what this repo’s indexer ingests.

**Measuring quality:** `npm run brain:eval` exercises smoke cases (from `.project-brain/eval.json` when present). Expand those cases when you find repeatable blind spots so retrieval regressions stay visible in CI or local runs.

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
```

When asked to search context, default to the smart router which picks the cheapest correct retrieval automatically:

```bash
npm run brain:ask -- "query text"
npm run brain:ask -- "query text" --pack --max-tokens 3000
npm run brain:ask -- "query text" --task issue-99-slug --actor cursor-worker-a --pack --max-tokens 3000
npm run brain:ask -- "query text" --explain          # show route decision without running
```

The router decides between direct file read, symbol search, doc summary, module summary, vector search, or budgeted pack. Only fall back to the lower-level commands when the router result is insufficient:

```bash
npm run brain:search -- "query text"
npm run brain:search -- "query text" --summary-only
npm run brain:search -- "query text" --modules-only
npm run brain:symbol -- SymbolName SymbolName
npm run brain:impact -- SymbolName
npm run brain:pack -- "query text" --max-tokens 3000
npm run brain:pack -- "query text" --task issue-99-slug --actor cursor-worker-a
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
| `npm run brain:maintain` | If `search_index.json` reports deleted paths or stale hashes (and not `BRAIN_FAST=1`), runs `brain:sync`, then `brain:health`. |
| `--strict` | After sync, runs `brain:health --strict-stale`, then **`brain:eval` with `BRAIN_EVAL_STRICT=1`** when `.project-brain/eval.json` exists. |
| `--ci` | Same as `--strict` for CI. If there is **no** `.project-brain/eval.json`, eval is skipped with a log line (add one from `skills/project-brain/templates/brain/eval.json` via `brain:init` or hand-author cases). |
| `--hook` | For Git hooks after pulls: sync when needed; **non-zero exits become 0** so merges are not blocked (inspect logs if retrieval feels wrong). |
| `--no-sync` | Health (and strict/eval when combined with `--strict`) only. |
| `--force-sync` | Passes `--force` into the first `brain:sync`. |
| Stale after sync | One automatic `brain:sync --force` retry when `--strict` / `--ci` before failing. |

`post-merge` and `post-checkout` (branch switch) hooks run **`npm run brain:update-skill`** then **`npm run brain:maintain -- --hook`**. The GitHub Actions template runs **`npm run brain:maintain -- --ci`** before `brain:guard`.

`npm run brain:health -- --json` emits machine-readable layout/stale/expiry fields for scripts.

### Auto-compact (token reload slice)

**`npm run brain:compact`** builds a **bounded `brain:pack` slice** (default ~1200 token budget), writes `.project-brain/sessions/<branch>__auto-compact__<timestamp>.md`, and indexes it so the next agent turn can reload context without re-reading the whole repo. Set `BRAIN_TASK`, `BRAIN_ACTOR`, and **`BRAIN_TOOL`** (`cursor`, `claude`, `gemini`, `codex`, …) in the environment so retrieval boosts match the active workstream.

- **Cursor (automatic):** run **`npm run brain:install-cursor-hooks`** once per repo. Hooks run on **`preCompact`** and **`stop`** (`npm run brain:compact -- --cursor-hook …`). Optional rule: `skills/project-brain/templates/cursor/rules/project-brain-compact.mdc` is copied beside `hooks.json` when the rule file is missing.
- **Claude Code / Codex CLI / Gemini CLI:** no IDE hook—run **`npm run brain:compact`** (same env vars) before `/compact`, thread reset, or ending a long terminal session. Copy-paste policy from **`skills/project-brain/templates/agents/COMPACT_INSTRUCTIONS.md`** into team docs or `CLAUDE.md` if desired.
- **CLI follow-up:** compact triggers **`npm run brain:sync`** by default so the index sees the new session file; Cursor hook mode skips sync for latency (set `BRAIN_COMPACT_SYNC=1` to force sync from hooks). Set **`BRAIN_QUIET=1`** is applied automatically for hook runs so stdout stays JSON-clean for Cursor.

### Performance modes

- `BRAIN_FAST=1` — fast iteration mode. Sync hooks become no-ops, retrieval uses the JSON store with summary-only results, and module/feature/project summaries are not rebuilt during indexing. Recommended local default during heavy edit loops; CI keeps it off so retrieval quality stays high.
- `BRAIN_BACKGROUND=1` — pre-commit hook sets this so `brain:sync` self-decides foreground vs detached background indexing instead of blocking the commit. Manual `npm run brain:sync` runs foreground by default.

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
npm run brain:session -- clean
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
2. Semantic search for the feature name, related modules, related decisions, and nearby code.
3. Load only relevant feature/module/decision files.
4. Check whether another developer is working on overlapping files/modules.
5. Search GitHub issues for existing matching work.
6. If no suitable issue exists and the work is non-trivial, create a GitHub issue with scope, acceptance criteria, and Project Brain references.
7. Create or update the feature page.
8. Create or switch to a branch from `develop` named `type/issue-number-kebab-description` for issue-linked work.
9. Define scope boundaries and out-of-scope items.
10. Update `active_state.md` with issue, branch, owner, overlap risks, and current status.

### During implementation

Before making large changes:

1. Verify module ownership and conventions.
2. Avoid unrelated changes.
3. Keep commits small and logical.
4. Capture new decisions in `decisions/`.
5. Update feature/module pages after meaningful progress.

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

## Response behavior

When using this skill, be direct and operational. Prefer concrete file updates, commands, and checks over abstract explanation. If facts are uncertain, mark them as `Needs Review` instead of inventing them.
