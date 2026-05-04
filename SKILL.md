---
name: project-brain
description: Shared semantic project brain for web app development. Maintains a compressed project plan, feature/module memory, team active state, semantic search index, Git workflow hygiene, and clean-code guardrails.
---

# Project Brain Skill

Use this skill when working inside a software repository that contains `skills/project-brain/` and `.project-brain/`.

The goal is to keep Claude aligned with the complete product and technical plan while using as few tokens as possible.

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

- `.project-brain/vector-db/`
- `.project-brain/index_manifest.json`
- `.project-brain/search_index.json`

## Standard commands

When asked to initialize:

```bash
npm run brain:init
npm run brain:index
npm run brain:health
```

When asked to search context:

```bash
npm run brain:search -- "query text"
```

When asked to sync:

```bash
npm run brain:sync
```

When asked to guard/check:

```bash
npm run brain:guard
```

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
5. Create or update the feature page.
6. Suggest a branch name using `type/kebab-case-description` or `type/issue-number-kebab-case-description` if an issue exists.
7. Define scope boundaries and out-of-scope items.
8. Update `active_state.md`.

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
6. Include brain impact and test evidence.

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

Default branch model:

- `main` — production/release branch.
- `develop` — optional integration branch if the repo uses it.
- `feature/*`, `fix/*`, `refactor/*`, `chore/*`, `docs/*`, `test/*` — work branches.

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

## Collaboration rules

- `active_state.md` must reflect who is working on what.
- If two developers touch the same module/feature, flag overlap before implementing.
- Capture handoffs in `.project-brain/sessions/` when work is interrupted.
- Update the brain before opening a PR.

## Response behavior

When using this skill, be direct and operational. Prefer concrete file updates, commands, and checks over abstract explanation. If facts are uncertain, mark them as `Needs Review` instead of inventing them.
