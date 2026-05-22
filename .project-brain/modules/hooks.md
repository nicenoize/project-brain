---
title: Hooks + guardrails module
status: canonical
layer: architecture
module: hooks
date: 2026-05-22
---

# Hooks + guardrails module

Background automation that keeps the brain fresh and the workflow on the rails without relying on the agent or developer to remember.

## Git hooks

Installed by `npm run brain:install-hooks` from `templates/hooks/`:

- **pre-commit** — runs `brain:guard`. Validates branch base (`develop`, `dev`, `epic/<n>`, `feature/n-…`), checks `context_index.md` token budget, runs `brain:link-check` on any staged `.project-brain/**.md` (fails the commit on broken `lib/foo.ts`-style refs).
- **post-merge / post-checkout** — runs `brain:update-skill` to fast-forward the canonical skill checkout when a teammate pulled a brain bump.

## Claude Code hooks

Wired by `scripts/setup-claude-settings.mjs` into the consuming repo's `.claude/settings.json`:

- **SessionStart** — dumps `active_state.md` so Claude opens with current context.
- **PreCompact** + **Stop** — run `brain:digest` to scrape `## Decided:` / `## Memory:` / `## Followup:` lines out of the transcript into `.project-brain/sessions/YYYY-MM-DD-digest.md`. Failures surface on stderr (post-V1.5 audit fix) but never block the host workflow.
- **Stop** also runs `brain:prune --apply` so `Complete (≥30d)` bullets get moved out of `active_state.md` into `history/YYYY-MM.md`.
- **PreToolUse** on Edit/Write/MultiEdit — `brain:lint-conventions` enforces `.project-brain/conventions.json` regex rules.

## Cursor hooks

Wired by `npm run brain:install-cursor-hooks` (`scripts/install-cursor-hooks.mjs`):

- **preCompact** + **stop** — same digest-and-prune behavior as the Claude Code hooks, scoped to Cursor's `.cursor/hooks.json`.

## Guardrails (CLI)

- `brain:guard` — pre-commit + manual gate. Branch base check, context_index size, link-check.
- `brain:lint-conventions` — convention regex rules from `.project-brain/conventions.json`. `--scan` mode walks the working tree for CI use.
- `brain:link-check` — verifies `lib/foo.ts`-style refs in brain markdown resolve in the working tree.
- `brain:health` — read-only report (ghost paths, mirror drift, stale root docs, broken brain refs). `--check-brain-refs` for the markdown→code link audit.

## Update propagation

`brain:update-skill` (driven by `bin/update.sh`) fast-forwards the canonical skill checkout, then runs `setup-package.mjs` to merge new `brain:*` npm scripts into the host repo's `package.json` and `setup-claude-settings.mjs` to wire any new hooks. Idempotent and safe to re-run.

## Files

- `bin/install-hooks.sh`, `bin/setup.sh`, `bin/update.sh`.
- `templates/hooks/` — git hooks.
- `templates/claude-code/settings.recommended.json` — the auto-merged Claude Code wiring.
- `scripts/install-cursor-hooks.mjs`.
- `scripts/setup-claude-settings.mjs`.
- `scripts/setup-package.mjs`.
- `scripts/brain-guard.mjs`, `brain-health.mjs`, `brain-lint-conventions.mjs`, `brain-link-check.mjs`, `brain-prune.mjs`, `brain-session-digest.mjs`, `brain-maintain.mjs`.

## Decisions

(No standalone ADRs yet — guardrail policy is documented in `SKILL.md` and `CONTRIBUTING.md`.)
