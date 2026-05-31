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

**Ranking limits:** Hybrid scoring (dense similarity, keywords, symbol hits, metadata, branch/diff boosts) is good for many queries but not all. Natural-language questions can sometimes rank **tests or e2e** above the **implementation module** that owns the behavior. When top hits look like the wrong layer, use `npm run brain:symbol -- …`, narrower `brain:search` flags (e.g. `--modules-only`), `BRAIN_CONTEXT_FILES` for known touched files, or read the target file from `context_index.md` / module pages instead of assuming the first vector hit is canonical.

**Not the same as in-app RAG:** Some applications keep a **separate** vector store for product features (e.g. venue-scoped rows in Postgres/pgvector with a different embedding model and dimensions). That system does not appear in `.project-brain/`; Project Brain local retrieval only sees what this repo’s indexer ingests.

**Measuring quality:** `npm run brain:eval` exercises smoke cases (from `.project-brain/eval.json` when present). Expand those cases when you find repeatable blind spots so retrieval regressions stay visible in CI or local runs.

**Swappable local embedding model:** The local embedder is env-gated so a stronger/code-aware transformers.js model can be A/B-tested against the default on the hard conceptual eval subset (`npm run brain:eval`; methodology: `docs/eval-methodology.md` when present):

```bash
BRAIN_LOCAL_EMBED_MODEL=Xenova/all-MiniLM-L6-v2   # any transformers.js feature-extraction model id (default)
BRAIN_LOCAL_EMBED_DIMS=384                          # that model's output width (default)
```

Both unset → behavior is byte-for-byte identical (same MiniLM model, 384 dims, mean pooling + normalize). Switching models is a **new vector space**: model + dims are recorded in `index_manifest.json`, so `brain:index` auto-forces a full re-index on a model change (and `brain:search` warns if the index model ≠ current). Always re-index with `--force` after switching: `npm run brain:index -- --force`. Do not mix models in one index. (OpenAI embeddings remain controlled separately via `BRAIN_EMBED_PROVIDER=openai` / `BRAIN_OPENAI_EMBED_MODEL`.)

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
- 11 pluggable edge detectors under `scripts/edges/` populate the cross-project graph: `k8s-image`, `http-client`, `grpc-client`, `proto-schema`, `openapi-schema`, `env-var`, `pubsub` (Kafka/RabbitMQ/Redis/SQS/PubSub), `db-shared`, `package-dep`, `go-replace` (+ `image-registry` registrar).
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
