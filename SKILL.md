---
name: project-brain
description: Shared semantic project brain for web app development. Maintains a compressed project plan, feature/module memory, team active state (including multi-actor leases and workstreams), semantic search index, Git workflow hygiene, and clean-code guardrails. This file is a lean router; detail lives in references/*.md, loaded on demand.
---

# Project Brain Skill

Use this skill when working inside a software repository that contains `skills/project-brain/` and `.project-brain/`.

The goal is to keep agents aligned with the complete product and technical plan while using as few tokens as possible. This core file is deliberately lean: it routes. Load a `references/*.md` file only when you need the detail.

## Core principle

Do not repeatedly load the whole repository or full master plan. Always use the layered context strategy:

1. Load `.project-brain/context_index.md` first.
2. Load `.project-brain/active_state.md` second.
3. Search the index (`brain:ask`) for relevant feature/module/decision/code context.
4. Load exact referenced files only when needed.
5. Load `.project-brain/master_plan.md` only for ambiguity, major planning, or re-ingestion.

The Git-tracked Markdown brain is the source of truth. The index (keyword search, embeddings optional) is a generated local cache.

## When unsure what to run

Run `npm run brain:route` — it senses git/index/backlog state and prints the ranked next `brain:*` action(s) with reasons (the full automation policy, made executable). `--auto` runs only the safe read-only subset and stops at the first mutating boundary. The complete intent→command policy table lives in [`references/workflows.md`](references/workflows.md).

Do not create branches, GitHub issues, PRs, or destructive changes just because a command can. Use those modes when the user asks for implementation/workflow execution or the repo workflow clearly requires them. For planning-only requests prefer `brain:ticket --write`, `brain:work -- status`, `brain:lease -- list`, and `brain:ask`.

## Most used

| Need | Command |
|---|---|
| Not sure what to run | `npm run brain:route` (`--auto` runs the safe subset) |
| A repo or context question | `npm run brain:ask -- "query"` (`--pack --max-tokens 2000` for a budgeted pack) |
| Something from earlier in this session, or lost in a compaction | MCP `brain_recall` / `npm run brain:recall -- "terms"` |
| One function of a big file | `npm run brain:outline -- <file> --symbol <name>` |
| An unfamiliar repo in under 2k tokens | `npm run brain:overview` |
| Before a PR | `npm run brain:guard` |
| Where tokens and memory go | `npm run brain:tokens` · `leanlamp receipt` · `leanlamp sessions` |

Every other command, one line each, by situation: [`references/command-map.md`](references/command-map.md).

## Reference files

Detail is bundled beside this skill and loaded only when needed — keep the core lean:

- [`references/command-map.md`](references/command-map.md) — every `brain:*` command in one line, and which to use when.
- [`references/commands.md`](references/commands.md) — full detail for every `brain:*` command (flags, examples, the automation/maintenance/compact/session/worktree runbooks, token-saving communication).
- [`references/workflows.md`](references/workflows.md) — the full automation-policy table, source-of-truth file layout, operating-mode runbooks (init, ingest, feature, split, orchestrate, coordinate, brief, implement, PR, sync), and clean-code / Git / team-memory / collaboration conventions.
- [`references/retrieval-internals.md`](references/retrieval-internals.md) — generated files, what the local index is, freshness/drift, ranking limits, graph-expanded retrieval, eval methodology, swappable embedding models, contextual retrieval.
- [`references/tuning.md`](references/tuning.md) — index recovery/reset and performance / cap-tuning environment variables.
- [`references/fleet.md`](references/fleet.md) — multi-repo fleet mode (cross-project edges) and spec-kit integration.
- [`references/hooks.md`](references/hooks.md) — ambient hooks: prompt-time routing (ADR 0023), the fail-open tool-time `PreToolUse` nudge toward `brain:search`/`brain:ask` (ADR 0026), and the `PostToolUse` post-edit dirty-file staging + opt-in post-commit `brain:sync --if-stale` that close the staleness window at the source (issue #35).
- [`references/external-tools.md`](references/external-tools.md) — honest trade-offs for optional third-party tools: RTK output compression (lossy, opt-in, inert example, `brain:*` exclusion, hook coexistence) and the Caveman reality note (saves output tokens, not thinking).

## Response behavior

When using this skill, be direct and operational. Prefer concrete file updates, commands, and checks over abstract explanation. If facts are uncertain, mark them as `Needs Review` instead of inventing them.
