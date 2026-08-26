# Ambient hooks — how the brain wires itself into the harness

The brain uses the agent's own hook surface so it is *consulted automatically*,
without the user asking. Three ambient layers, all fail-open and model-free:

## Prompt-time routing (ADR 0023)

`brain:route --hook` runs on **UserPromptSubmit** (every prompt) and
**SessionStart** (each new session). It senses git/index/backlog state and
injects the ranked next `brain:*` actions as `additionalContext`. Forces
`--no-index` (model-free), surfaces only interrupt-worthy items, and always
exits 0. Per-session dedup lives in `.project-brain/.route-hook-state.json`.

## SessionStart state digest (decisions/0024 follow-up)

`brain-state-digest.mjs` runs on **SessionStart** and prints a deterministic,
byte-capped digest of `.project-brain/active_state.md` (active workstreams, open
leases with owner/TTL, blockers, the 3 newest session pointers) instead of the
historical raw `cat` — which cost ≈7.5k tokens per session in a real consumer.
Hard cap: 8,000 B ≈ 2k tok (`BRAIN_STATE_DIGEST_BUDGET_BYTES`), CI-enforced by
`tests/footprint-budget.test.mjs`; finished/expired rows drop first, then lines
truncate with an explicit marker. Read-only, always exits 0. Distinct from
`brain-session-digest.mjs`, the PreCompact/Stop transcript digest.

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

## Post-edit dirty-file staging (issue #35)

`brain-stage-dirty.mjs` runs on **PostToolUse** for `Edit|Write|MultiEdit`. It
closes the staleness window *at the source*: the instant a file is edited, it
appends the touched repo-relative path to `.project-brain/.dirty-files`. ADR 0013
lazy-sync fixes the index at the *next query*; the #23 banner warns at
consumption; this is the cheapest complement — a producer that marks files dirty
the moment they change.

- **Append-only, no re-index in the hook.** It ONLY appends a line — NO embedder
  load, NO store open. The re-index happens later, in `brain:sync`.
- **Fail-open, never blocks.** Malformed stdin, a missing brain dir (it will not
  create one in a non-brain repo), or any internal error → silent **exit 0**
  (unit-tested). It never emits a `permissionDecision`.
- **Shared "which files changed" primitive.** The producer/consumer list lives
  in `common.mjs`: `dirtyPathFor()` (PURE normalise + filter — rejects
  vendored/build/generated/`.project-brain` paths and anything outside root),
  `appendDirtyFile()` (atomic via `atomicWrite`, deduped, bounded),
  `readDirtyFiles()`, `clearDirtyFiles()`. The decision core
  `stagedPathsFromEnvelope()` in the hook is PURE and exported. This is the
  write-time sibling of the #23 read-time drift detector
  (`retrieval.staleResults`).

### Consuming the list — `brain:sync --if-stale`

`brain:sync --if-stale` is a **near-free no-op when clean**: an empty/absent
dirty list exits instantly *without* the `listIndexableFiles` hash-scan. When
files are staged it falls through to the normal hash-diff sync (targeted
re-index of just the changed files) and **drains** the list on completion. The
manifest stays the source of truth, so clearing the list is safe even if a sync
fails — the next sync re-detects via hash-diff.

The opt-in git **post-commit** hook (`templates/hooks/post-commit`, default OFF)
runs `BRAIN_BACKGROUND=1 brain:sync --if-stale` when `BRAIN_SYNC_ON_COMMIT=1` —
near-free unless the commit left files staged. Advisory only; soft-exits 0.

### Installation & opt-out

All three layers are wired in `templates/claude-code/settings.recommended.json`
and merged additively into `.claude/settings.json` by `setup-claude-settings.mjs`
on `brain:update-skill` (install = opt-in, per ADR 0023). The PreToolUse groups
sit alongside the existing `Edit|Write|MultiEdit` convention-lint hook; the
PostToolUse dirty-staging group is a new `Edit|Write|MultiEdit` matcher. Cursor's
pre/post-tool surface does not support this interception, so both the tool-time
nudge and dirty-staging are Claude Code-only; Cursor keeps the prompt-time rule
(`templates/cursor/rules/project-brain-route.mdc`).

Env toggles: `BRAIN_TOOL_NUDGE_DEDUPE=0` (re-emit every matching call),
`BRAIN_HOOK_DEDUPE=0` (prompt hook), `BRAIN_HOOK_MAX_BYTES` (injected-text cap),
`BRAIN_SYNC_ON_COMMIT=1` (enable the post-commit `--if-stale` sync).
