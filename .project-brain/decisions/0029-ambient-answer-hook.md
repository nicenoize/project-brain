---
title: Ambient answer hook — push intelligence at edit time, default-on under a measured budget
status: canonical
layer: decision
module: control-room
feature: ambient-answers
date: 2026-08-27
---

# 0029 — Ambient answer hook

## Context

The Control Room computes real answers (per-file danger, governing decisions,
co-change partners, foreign leases, next action) but they reached only the
human in the browser. The agent — the party actually about to edit the file —
saw none of it. Copy-buttons bridged that manually, which is a workaround, not
a design.

Competitors solve this by shipping an MCP server the agent must *call*. That is
a pull model: it works only when the agent thinks to ask, and it costs a
round-trip. Our differentiator (ADR 0022/0023/0026) is the opposite: the brain
consults itself and pushes what matters, ambiently.

The counter-force is ADR 0024: everything injected into a session costs the
user money on every single edit, forever. A default-on edit-time hook is the
highest-frequency injection point in the whole product.

## Decision

1. **Ship both surfaces.** The ambient hook (push) is the differentiator; an
   MCP server (pull) is the socket hosts expect. They are not alternatives.
2. **The answer hook is default-on**, wired as PreToolUse on Edit/Write/
   MultiEdit, opt-out via `BRAIN_ANSWER_HOOK=0`.
3. **Default-on is earned by measurement, not asserted.** `BUDGETS.answerBytes`
   = 700 B ≈ 175 tokens, enforced by `tests/brain-answer.test.mjs` (red build on
   breach) and reported by `brain:health`'s footprint audit
   (`measureAnswerHook`, alongside the two session hooks). Measured worst case
   on this repo at adoption: 605 B (75 % of budget), 50–160 ms.
4. **It can never block.** The hook emits `additionalContext` only — no
   `permissionDecision`, no `decision` — so it is structurally incapable of
   stopping an edit. Blocking stays with `brain-lint-conventions` (ADR 0026),
   where it is an explicit convention violation, not an advisory.
5. **Safety outranks budget.** Truncation drops tail-first in the order
   `next → partners → governing → danger`; foreign **leases are never dropped**,
   because an unseen lease is the one failure that costs real work.
6. **Fail-open, always.** No stdin, malformed JSON, no `.project-brain/`, no git
   history: exit 0, emit nothing. An ambient hook that breaks an edit is worse
   than no hook.

## Consequences

- Repo-setup routing (`brain:init/index/maintain`) is filtered out of the
  per-edit `next` line: session hooks already deliver it once, and repeating it
  per edit is noise.
- Governing-ADR matching is imported from the Control Room's own doc helpers,
  so the ambient answer and the browser can never disagree.
- Dedupe (per file, 15 min TTL, plus an answer-hash check) keeps repeated edits
  cheap while letting a newly-appearing lease re-surface immediately.
- The budget is a standing obligation: any new section added to the answer must
  fit inside 700 B or displace something, and the CI test decides, not taste.
