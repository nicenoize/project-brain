---
title: Tool-time ambient nudge — fail-open PreToolUse hook toward brain:search/brain:ask
status: canonical
layer: decision
module: route
feature: token-context
date: 2026-07-11
---

# 0026 — Tool-time ambient nudge (fail-open PreToolUse hook)

## Context

Ambient routing (decisions/0023) makes the brain consult itself at **prompt
time** (UserPromptSubmit / SessionStart). But mid-turn, agents still reach for
`grep`/`find`/raw `Read` even when a fresh semantic index would answer faster and
with far less context. That is exactly the moment ADR 0023 does not cover — the
prompt has already been submitted; the agent is choosing tools.

Graphify solved this with a `PreToolUse` guard (`_run_hook_guard`,
`_claude_pretooluse_hooks`): matchers on `Bash` and `Read|Glob` inject an
`additionalContext` nudge **only** when an index exists and is fresh and the
command looks like a raw search. Fail-open, never blocks, no LLM. This delivers a
slice of #8's backlog item **C2 — proactive push via hooks**.

Claude Code contract: a PreToolUse hook may emit
`hookSpecificOutput.additionalContext` (context injection) and/or a
`permissionDecision`. We emit context ONLY and never a decision, so the hook is
structurally incapable of blocking a tool call.

## Decision

Add `scripts/brain-route-tool.mjs`, a dedicated fail-open PreToolUse hook, and
wire two matcher groups into `templates/claude-code/settings.recommended.json`
(merged additively by `setup-claude-settings.mjs`, same install-is-opt-in path as
0023): `Bash` (`--surface bash`) and `Read|Glob` (`--surface read`).

- **Pure, exported, unit-tested cores:** `looksLikeRawSearch(command)` (grep
  family with a recursive flag / path arg, rg/ag/ack, `git grep`, file-locating
  `find`; rejects a piped `grep`, a bare stdin `grep`, and `echo grep`) and
  `looksLikeRawSourceRead(path)` (source/doc extensions outside
  node_modules/.git/dist/.project-brain/lockfiles). `classifyToolNudge(envelope)`
  maps a hook envelope → `rawSearch` | `rawSourceRead` | null.
- **No model / no store on the hot path:** freshness is **stat-level only** —
  the manifest exists and a non-empty `search_index.json` (or `vector-db/`) is
  present (`indexFresh`). It never loads the embedder or opens the store.
  "Stale" here therefore means *missing/empty*, not the ghost/changed-path
  staleness `brain:maintain` detects (that requires reading records — forbidden
  on this path).
- **Always exit 0:** malformed stdin, missing index, and any internal error all
  fall through to a silent exit 0 (errors to stderr only). Unit tests cover the
  malformed-stdin and missing-index paths asserting no block.
- **Session dedup reuses ONE store:** at most once per session per pattern class
  (~15-min TTL re-surface), persisted under a `toolNudges` namespace in the same
  `.project-brain/.route-hook-state.json` the prompt hook (#22) uses — no second
  state file. `writeHookState` in `brain-route.mjs` was changed to MERGE so the
  two hooks never clobber each other. Opt out: `BRAIN_TOOL_NUDGE_DEDUPE=0`.

The nudge is advisory: the agent's tool call always runs. This is the
"procedures > abilities" stance extended to tool time — the brain is *consulted*,
the agent still *decides*.

## Consequences

### Positive
- Closes the mid-turn gap in ambient routing: the brain suggests `brain:search`/
  `brain:ask` at the exact moment an agent would otherwise grep/raw-read, cutting
  wasted context. Zero behaviour change for consumers who don't re-run settings
  setup. No new dependency.
- Safe by construction: context-only injection, model-free, stat-level checks,
  always exit 0, silent on a missing/stale index and on a quiet class.

### Negative / Tradeoffs
- Stat-level freshness can't detect ghost/changed-path staleness, so a nudge can
  fire against a technically-drifted-but-present index; the linked query-time
  staleness banner (0025) and `brain:maintain` cover that separately.
- The heuristics are deliberately conservative — false negatives (no nudge) are
  preferred over false positives; some raw searches won't be nudged.
- Adds a fast node spawn per Bash/Read/Glob call; stat-only work keeps it cheap,
  per-session dedup keeps it quiet, `BRAIN_TOOL_NUDGE_DEDUPE=0` is the escape.

## Alternatives Considered
- **A `--tool-hook` mode inside `brain:route`:** rejected in favour of a small
  dedicated script — the hot path stays minimal (no routing/sensing imports) and
  the two hooks keep independent, testable entry points.
- **Blocking the tool call (permissionDecision: deny) and forcing brain:search:**
  rejected — too aggressive and against the never-block discipline; a nudge
  preserves agent autonomy.
- **A second hook-state file for tool nudges:** rejected per the #17/#22
  coordination note — one store keyed by concern.

## Related
- [[0023-ambient-routing-activation]] — the prompt-time sibling this extends
- [[0025-query-time-staleness-banner]] — the freshness signal at consumption time
- [[0024-context-footprint-discipline]] — the hook byte-cap this reuses
- [[0022-route-autonomous-dispatch-axis]]
