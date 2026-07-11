# Ambient hooks — how the brain wires itself into the harness

The brain uses the agent's own hook surface so it is *consulted automatically*,
without the user asking. Two ambient layers, both fail-open and model-free:

## Prompt-time routing (ADR 0023)

`brain:route --hook` runs on **UserPromptSubmit** (every prompt) and
**SessionStart** (each new session). It senses git/index/backlog state and
injects the ranked next `brain:*` actions as `additionalContext`. Forces
`--no-index` (model-free), surfaces only interrupt-worthy items, and always
exits 0. Per-session dedup lives in `.project-brain/.route-hook-state.json`.

## Tool-time nudge (ADR 0026, issue #17)

`brain:route-tool.mjs` runs on **PreToolUse** for `Bash` (matcher `Bash`,
`--surface bash`) and `Read`/`Glob` (matcher `Read|Glob`, `--surface read`).
When the agent is about to `grep`/`find`/`rg`/`git grep`, or raw-`Read` an
indexed source file, and a fresh index exists, it injects a one-line
`additionalContext` nudge toward `brain:search`/`brain:ask`.

- **Never blocks.** It emits `additionalContext` only — never a
  `permissionDecision` — and **always exits 0**. Malformed stdin, a missing
  index, or any internal error all fall through to a silent exit 0 (unit-tested).
- **No model / no store on the hot path.** Freshness is *stat-level only*:
  the index manifest exists and a non-empty `search_index.json` (or a
  `vector-db/` dir) is present. It never loads the embedder or opens the store,
  so "stale" here means *missing/empty*, not the ghost/changed-path staleness
  that `brain:maintain` detects.
- **Matchers (pure, tested).** `looksLikeRawSearch(command)` recognises
  grep/egrep/fgrep (with a recursive flag or a path arg), rg/ag/ack, `git grep`,
  and a file-locating `find` (`-name`/`-path`/`-type`/`-regex`); it ignores a
  `grep` filtering piped output, a bare stdin `grep`, and `echo grep`.
  `looksLikeRawSourceRead(path)` is true for source/doc extensions outside
  `node_modules`/`.git`/`dist`/`.project-brain`/lockfiles.
- **Dedup.** At most once per session per pattern class (`rawSearch`,
  `rawSourceRead`), with a ~15-min TTL re-surface. It reuses the **same**
  `.project-brain/.route-hook-state.json` file as the prompt hook under a
  `toolNudges` namespace — one store, no second state file. Opt out with
  `BRAIN_TOOL_NUDGE_DEDUPE=0`.

### Installation & opt-out

Both layers are wired in `templates/claude-code/settings.recommended.json` and
merged additively into `.claude/settings.json` by `setup-claude-settings.mjs` on
`brain:update-skill` (install = opt-in, per ADR 0023). The PreToolUse groups sit
alongside the existing `Edit|Write|MultiEdit` convention-lint hook. Cursor's
pre-tool surface does not support this interception, so the tool-time nudge is
Claude Code-only; Cursor keeps the prompt-time rule
(`templates/cursor/rules/project-brain-route.mdc`).

Env toggles: `BRAIN_TOOL_NUDGE_DEDUPE=0` (re-emit every matching call),
`BRAIN_HOOK_DEDUPE=0` (prompt hook), `BRAIN_HOOK_MAX_BYTES` (injected-text cap).
