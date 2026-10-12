---
title: Context lives in three layers; the brain owns the warm one
status: canonical
layer: decision
module: brain-core
feature: context-efficiency
date: 2026-10-12
---

# 0035 — Context lives in three layers; the brain owns the warm one

## Context

Long sessions are how the user works. They are also where the tokens went.
Measured over 30 days and 67.7k API requests (`brain:tokens`):

- Context per request: median 370k, p90 794k. On 1M-context models Claude
  Code auto-compacts at ≈ 967k, so in practice compaction never fired.
- 57 % of all input was spent in requests above 500k context.
- In a context above 300k, 54 % was tool output older than 100 calls; 5.5 %
  came from the last 20 calls; the conversation itself was ≈ 3 %.
- Tool output that a compression proxy (Headroom) shrinks well
  (json/log/search/html) was 17 % of tool output, which was 11 % of fresh
  input.
- Replayed on the real sessions, a 300k compaction window cut input by
  ≈ 66–69 % (500k: 47 %, 200k: 75 %). That is an upper bound, because
  compaction loses detail.

What Claude Code lets a tool control (docs, 2026-10-12): when compaction
happens (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`), what the summary keeps (CLAUDE.md
"Compact Instructions"), seeing it come (PreCompact: observe or block), and
re-injecting after it (SessionStart `compact`, additionalContext capped at
10,000 characters). A hook cannot compact, clear, or edit the summary. No
hook event carries the live context size; the status line JSON does.

## Decision

Context is managed in three layers.

- **Hot**: the current step. It lives in the context window and belongs to
  Claude Code.
- **Warm**: the session's state, ≤ 9,500 bytes. It holds the goal in the
  user's words, latest asks, where the agent stood, Decided/Followup tags,
  files edited and read with ranges, and last checks. The brain extracts it
  deterministically and incrementally on PreCompact and Stop
  (`brain-warm.mjs snapshot`), and re-injects it after every compaction
  (`rehydrate`).
- **Cold**: everything else, left where it already is: the transcript on
  disk. `brain_recall` searches it on demand, read-only, and nothing is
  copied or indexed.

The threshold is the safety net, task boundaries are the intelligence, and
the warm layer is the memory. The brain lowers the window to 300k only on
opt-in and together with the compact instructions. It nudges `/compact` at
task boundaries above 150k, suggests subagents for exploration in large
contexts, and shows the context size in the status line.

A tool that launches agents also collects them: runners stop as whole trees,
`brain:ps` judges idleness by the last real message, and new agents are held
under kernel memory pressure.

## Consequences

### Positive
- The measured lever (context length) is addressed and earlier compaction is
  made safe, without asking the user to work in short sessions.
- Nothing new is stored: tool output is never copied; the cold store is the
  transcript that already exists.
- Every piece is deterministic, without an LLM in a hook, and fails open: a
  parse failure means silence, never a broken session.

### Negative / Tradeoffs
- The transcript format is undocumented. snapshot, rehydrate, boundary,
  prompt and recall all read it, guarded, and `brain-session-digest` already
  depended on it.
- Compaction loses detail by nature. Kill criterion: if re-reads in the 50
  calls after a compaction eat more than ⅓ of what it dropped, or the user
  reports lost context twice in a week, the window goes back off and the
  warm layer is fixed. The window is never raised to hide lossy summaries.
  `brain:tokens` measures both machine-checkable halves ("Loss guards"):
  re-reads after compaction, and edits failing on stale or compressed file
  content. Baseline 2026-10-12 (old 967k compaction): re-reads ≈ 0.1–0.4 %
  of dropped; content edit failures 0.1 % of 5,268 edits in club-ops.
- K1/K4/K5/K7/K8 are Claude Code surfaces. Other hosts get the CLI
  (`brain:warm show`, `brain:recall`) and the existing `brain:compact`.

## Alternatives Considered
- **A compression proxy (Headroom) as the main lever.** Rejected by
  measurement: 17 % of 11 % is a few percent at best. `brain:tokens` now says
  per repo whether a proxy would pay (H1).
- **Compact-by-default MCP payloads with `brain_expand` (H2).** Measured and
  dropped: every brain MCP answer is already 90–784 tokens, which is noise
  against 370k contexts.
- **An LLM-written summary layer of our own.** Claude Code already
  summarizes; the brain's value is the deterministic state around it.
- **Indexing tool output into the brain.** Rejected for privacy (company code,
  secrets) and size; the transcript already is the cold store.
- **"Use shorter sessions."** It is the user's workflow, and a tool that
  fights the workflow gets switched off.
