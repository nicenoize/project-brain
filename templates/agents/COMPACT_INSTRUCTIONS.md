# Agent-agnostic context compaction (Project Brain)

Use this in **Claude Code**, **OpenAI Codex CLI**, **Google Gemini CLI**, or any terminal agent. **Cursor** users should install hooks (`npm run brain:install-cursor-hooks`) so `preCompact` / `stop` run this automatically.

## One command

From the **app repository root** (where `package.json` has Project Brain scripts):

```bash
export BRAIN_TASK="your-workstream-id"   # optional but recommended for parallel agents
export BRAIN_ACTOR="alice-or-agent-label"
export BRAIN_TOOL="claude"              # claude | codex | gemini | cursor | human | other
npm run brain:compact
```

Optional:

```bash
npm run brain:compact -- --max-tokens 1500 "Custom resume query focused on auth module"
```

## What it does

- Runs the same retrieval pack as `brain:pack` (bounded by `--max-tokens`, default 1200).
- Writes `.project-brain/sessions/<branch>__auto-compact__<timestamp>.md` and indexes it for search/pack boosts.
- Runs `npm run brain:sync` after (CLI only) so the mirror stays fresh; Cursor hooks skip sync for speed (set `BRAIN_COMPACT_SYNC=1` in the environment if you want sync from hooks).

## When to run (automatic discipline)

| Tool | Automation |
|------|------------|
| **Cursor** | `npm run brain:install-cursor-hooks` — runs on `preCompact` and `stop`. |
| **Claude Code** | Add a slash command, shell alias, or `UserPromptSubmit` habit: `npm run brain:compact` before `/compact` or new thread. |
| **Codex CLI** | Same: export `BRAIN_TOOL=codex`; run before long context resets. |
| **Gemini CLI** | Same: export `BRAIN_TOOL=gemini`. |

## Workflow discipline

- If the task is large, unclear, or spans multiple modules, run `npm run brain:ticket -- "task title" --packages N --write` before coding.
- If multiple agents or humans may touch the same files, check `npm run brain:lease -- list` and add leases before editing.
- For non-trivial implementation, prefer `npm run brain:work -- start ...` so task id, session, active state, leases, and context pack stay aligned.

## After compaction

1. `.project-brain/context_index.md`
2. `.project-brain/active_state.md`
3. Latest `*__auto-compact__*.md` for your branch (or `npm run brain:pack -- "…" --task …` again)

Keep durable facts in feature/module/decision Markdown—not only in chat or auto-compact files.
