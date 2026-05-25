---
title: Spec-Kit integration
status: canonical
layer: architecture
module: indexing
feature: spec-kit
date: 2026-05-25
---

# Spec-Kit integration

Brain's downstream-consumer integration with [`github/spec-kit`](https://github.com/github/spec-kit). When a repo uses spec-kit, brain indexes the resulting artifacts and exposes them via the existing retrieval surface plus a new `brain:speckit` CLI and three `/brain-speckit-*` slash commands.

## Activation

Automatic: triggered by the presence of `.specify/` or `specs/<id>/` directories. Repos without either see no records emitted with the new types and no slash command changes (the commands self-check before doing anything).

## New record types

| `type` | Source | Boost path |
|---|---|---|
| `constitution` | `.specify/memory/constitution.md` | canonical-root (base × 1.6) + spec-kit boost |
| `spec` | `specs/<id>/spec.md` | spec-kit boost on architectural queries |
| `plan` | `specs/<id>/plan.md` | spec-kit boost on architectural queries |
| `tasks-list` | `specs/<id>/tasks.md` | spec-kit boost on architectural queries |
| `spec-support` | `specs/<id>/{research,data-model,quickstart}.md`, `specs/<id>/contracts/*` | no extra boost |

All spec-kit records carry `feature: <id>` so they participate in the existing `feature-summary` aggregate (`chunk:-3`) for free.

## `inferType` shape

Strict matches only — `specs/something.md` at the top level (no `<id>/` subdir) falls through to `type: 'doc'` as today. This keeps an app's existing test-spec directory from being mistaken for a spec-kit feature folder.

## CLI: `brain:speckit`

```bash
npm run brain:speckit -- import  <id>            # mirror spec.md → .project-brain/features/<id>.md
npm run brain:speckit -- tasks   <id> [--write] [--github] [--json]
npm run brain:speckit -- analyze <id>            # scaffold ADRs from specs/<id>/analyze.md headings
```

- `import` is idempotent. Re-run after every `/speckit.specify` edit.
- `tasks --write` emits one `.project-brain/work-packages/spec-<id>-wpN.md` per user-story group. `[P]` parallel markers are preserved.
- `tasks --github` runs `gh issue create` once per work-package.
- The taskId convention is `spec-<id>-wp<N>`. `npm run brain:work -- start --task spec-<id>-wp1 ...` plugs in unchanged.

## Slash commands

Installed automatically by `setup-claude-settings.mjs#syncClaudeCommands()` into `.claude/commands/`. Never clobber existing files.

| Command | Wraps | Then runs |
|---|---|---|
| `/brain-speckit-specify` | `/speckit.specify $ARGUMENTS` | `npm run brain:speckit -- import <id>` + `npm run brain:sync` |
| `/brain-speckit-tasks <id>` | `/speckit.tasks` | `npm run brain:speckit -- tasks <id> --write` (+ optional `--github`) |
| `/brain-speckit-implement <id>` | `/speckit.implement` (scoped to one work-package) | `brain:work start` before, `brain:work end` after |

## Configuration

```
BRAIN_SPEC_BOOST=0.04                         spec/plan/tasks-list/constitution boost on architectural queries
PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS=1          skip installing /brain-speckit-* commands during brain:update-skill
```

## Files

- `scripts/infer.mjs` — pure path/frontmatter inference (extracted from brain-index for testability).
- `scripts/brain-speckit.mjs` — `import` / `tasks` / `analyze` CLI.
- `scripts/brain-ticket.mjs` — exports `buildPlan` and `renderMarkdown` (reused by `brain:speckit tasks`).
- `scripts/retrieval.mjs` — `CANONICAL_ROOT_NAMES`, `canonicalBrainBoost`, `BRAIN_SPEC_BOOST`.
- `scripts/setup-claude-settings.mjs` — `syncClaudeCommands()`.
- `templates/claude-code/commands/brain-speckit-{specify,tasks,implement}.md` — the three slash commands.

## Decisions

- [[0012-spec-kit-integration]]
