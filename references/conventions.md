# Default Conventions

## Source Of Truth Layers

Project Brain has two layers:

- **Global Project Brain repo** (`project-brain`): reusable skill code, scripts, templates, GitFlow rules, guardrails, code conventions, and team-memory policy.
- **Application repo** (`.project-brain/`): project-specific product plan, architecture context, feature/module docs, decisions, active state, and handoffs.

Application repos should not fork global conventions unless they need a documented exception in `.project-brain/repo_context.md`.

## Git

Branch pattern:

```txt
type/123-kebab-case-description
release/2026-05-05
hotfix/123-kebab-case-description
```

Types:

- feature
- fix
- refactor
- chore
- docs
- test
- release
- hotfix

GitFlow:

- `main` is protected production/release.
- `develop` is protected integration.
- Feature/fix/refactor/chore/docs/test branches start from `develop` and target `develop`.
- Release branches target `main`.
- Hotfix branches start from `main` and must be merged back into `develop`.
- Non-trivial work requires a GitHub issue.
- PRs close issues with `Closes #123` or `Fixes #123`.

Commit format:

```txt
type(scope): short description
```

Allowed commit types:

- feat
- fix
- refactor
- chore
- docs
- test

## Web App / Next.js Defaults

- TypeScript-first.
- Keep server-only logic out of client components.
- Keep environment parsing centralized.
- Avoid `any`; use explicit domain types at module boundaries.
- Prefer cohesive modules over deep generic folder nesting.
- Avoid TODO/FIXME in committed code unless tracked in the brain or issue tracker.

## Team Memory

- Project Brain Markdown is the shared source of truth.
- Cavemem is optional local/session memory for each developer.
- Durable facts discovered via Cavemem must be promoted into `.project-brain/*.md`.
- Do not store secrets, `.env*`, private customer data, generated indexes, build output, or dependencies in Cavemem.

## Retrieval maintenance

- After pulls or branch switches, installed hooks run `brain:update-skill` and `brain:maintain --hook` so the local index can catch deleted files and hash drift.
- For CI-quality gates, commit `.project-brain/eval.json` (see `templates/brain/eval.json`) and let the Project Brain workflow run `brain:maintain --ci` before `brain:guard`.
- Ranking and embedding behavior still follow `scripts/retrieval.mjs` and embedder config; extend `eval.json` when you find repeatable retrieval misses.
- Before **Cursor context compaction** or when switching terminal agents, run **`npm run brain:compact`** (or install Cursor hooks so it runs automatically); set `BRAIN_TOOL` to `cursor`, `claude`, `gemini`, or `codex` per session.

## Multi-tool and multi-agent coordination

- Use a stable **task id** per parallel workstream (issue slug, feature name, or orchestrator run id).
- Start session handoffs with `brain:session -- start --task … --actor … --tool …` so Cursor, Claude, Gemini, and humans can each have a distinct session file on the same branch.
- For **parallel work on different branches** (e.g. multiple Cursor windows, Claude Code, Codex, or Gemini sessions), use `npm run brain:worktree -- spawn --count N [--tool …] …` so each worker gets its own checkout and branch; run `brain:session` **inside** that worktree with the suggested per-worker `--task`, `<tool>-worker-N` actor, and matching `--tool` (see **`BRAIN_WORKTREE_TOOL`** for a default).
- Prefer **one merge point** for `active_state.md`; use the leases / workstreams tables and `.project-brain/sessions/` for concurrent edits.
- When packing context for a specific stream, set `BRAIN_TASK` / `BRAIN_ACTOR` or pass `--task` / `--actor` to `brain:pack` / `brain:ask` / `brain:search`.

## Token Budget

- Use Caveman `$caveman ultra` for internal agent progress, handoffs, investigation notes, and review notes when available.
- Keep user-facing summaries concise but clear enough to preserve order, risk, and decisions.
- Disable compression for destructive confirmations, security warnings, or places where terse wording becomes ambiguous.
