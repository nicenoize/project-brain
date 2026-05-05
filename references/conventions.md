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

## Token Budget

- Use Caveman `$caveman ultra` for internal agent progress, handoffs, investigation notes, and review notes when available.
- Keep user-facing summaries concise but clear enough to preserve order, risk, and decisions.
- Disable compression for destructive confirmations, security warnings, or places where terse wording becomes ambiguous.
