# Project Brain — Workflows & Conventions

> Part of the **project-brain** skill. Loaded on demand from the lean core `SKILL.md` — see its "Reference files" section for the full map.

Full automation policy, source-of-truth layout, operating-mode runbooks, and clean-code / Git / team conventions.

## Default automation policy

Choose the smallest workflow command that matches the user's intent:

| User intent / situation | Default action |
|-------------------------|----------------|
| Unsure which command fits the current repo state | Run `npm run brain:route` — it senses git/index/backlog state and prints the ranked next `brain:*` action(s) with reasons (this table, made executable). `--auto` runs only the safe subset and stops at the first mutating boundary. |
| About to implement a finding/plan/risky idea | Run `npm run brain:grill -- scaffold <finding\|plan\|decision>` first — it generates grounded adversarial questions (real blast-radius, governing ADRs, tests) to flush out issues before coding. |
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
