---
title: Context-footprint discipline — measure and cap what the brain injects
status: canonical
layer: decision
module: route
feature: token-context
date: 2026-07-10
---

# Context-footprint discipline — measure and cap what the brain injects

## Context

Ambient routing (decisions/0023) makes the brain inject text into **every** Claude
session — the SessionStart / UserPromptSubmit hooks, `SKILL.md` on skill
activation, and `brain:pack` output. That is the whole point (the brain is always
consulted), but until now the brain never measured its own token cost. Unbounded
injection is a silent regression: it eats the context window the agent needs for
the actual task, and no one notices until sessions feel "full".

Two concrete measurements forced the issue:

- **SKILL.md** was ~64.5 kB ≈ 16k tokens per skill activation before the #26 lean
  split; the split (references/*.md) brought the core to ~2k tokens, but nothing
  *enforces* it staying lean.
- **active_state.md is cat'd RAW into context on every SessionStart** (a plain
  `cat .project-brain/active_state.md` hook line in
  `settings.recommended.json`, predating ambient routing). In the dev repo that is
  ~110 tokens and looks harmless. **In the only real multi-actor consumer it was
  measured at 30,220 B ≈ 7,555 tokens** (#21 coordination comment, #32 baseline) —
  ~70× the dev-repo assumption and ~12× any sane warn budget. Dev-repo
  self-measurement systematically underestimates the real footprint.

The route hooks themselves are cheap (0 B on a quiet repo; a few hundred bytes of
JSON when state is active), but "cheap today" is not "bounded" — a bug or a verbose
future rule could balloon a per-prompt injection with nothing to stop it.

This ADR **amends 0023**: it keeps ambient routing exactly as designed and adds the
missing discipline — *measure the footprint, warn when it is fat, and hard-cap the
one surface (the hook) that runs on every single turn.*

## Decision

1. **A read-only context-footprint audit in `brain:health`** (no new command — 46
   is enough; this extends the existing reporter). It reports, in both text and
   `--json` (`contextFootprint`):
   - byte size + token estimate (`len/4`) of `SKILL.md` (root **and**
     `skills/project-brain/SKILL.md`, whichever exist) and
     `.project-brain/active_state.md`;
   - the **measured stdout** of `brain-route.mjs --hook --event sessionstart` and
     `--event userpromptsubmit` (spawned and captured — the real injected bytes,
     not a guess);
   - pack defaults (`BRAIN_PACK_MAX_TOKENS`, default 2600);
   - warn thresholds: **SKILL > ~4k tok, active_state > ~600 tok, hook > ~500 tok**.

   Warnings are advisory — the footprint audit never fails the health exit code
   (footprint bloat is a nudge, not a broken repo). The pure logic
   (`estimateTokens`, `footprintWarnings`) lives in `scripts/footprint.mjs`,
   exported and unit-tested (the applyRules/buildGraph house pattern).

2. **A hard byte cap on the hook injection** (`BRAIN_HOOK_MAX_BYTES`, default
   ~4000) in `brain-route.mjs`. The cap truncates the **injected text before**
   `JSON.stringify` — never the JSON envelope — and appends
   `… truncated — run npm run brain:route`. The envelope therefore always stays
   valid JSON, and the hook path still **exits 0 on all errors**. This is a safety
   net, not a behaviour change: measured payloads are ~10× under the cap. The pure
   `capHookText` / `buildHookPayload` are exported and unit-tested.

3. **Per-session hook dedupe** (`brain-route.mjs`, #22). The UserPromptSubmit
   hook fires on **every** prompt and, while the triggering state persists,
   re-injects the byte-identical routing payload each time — a 100-prompt session
   wastes ~8k tokens on repetition. In `--hook` mode the script now reads the hook
   stdin JSON (Claude Code supplies `session_id`), keeps
   `.project-brain/.route-hook-state.json` (`{sessionId, textHash, ts}`) via the
   existing `atomicWrite`, and re-emits **only** when the payload hash changes or a
   ~15 min TTL lapses (the TTL re-surfaces context after a compaction drops it —
   the PreCompact digest hook already exists). Opt-out: `BRAIN_HOOK_DEDUPE=0`. The
   dedupe decision is the PURE, exported, unit-tested `shouldEmitHook(prev,
   current, ttlMs)`; every failure mode (no/corrupt state, corrupt timestamp,
   stdin read error) **fails open** (emits) and the whole path stays try/catch +
   exit 0 — a state-file bug must never block a prompt or swallow real signal. The
   footprint audit spawns the hook with `BRAIN_HOOK_DEDUPE=0` so it still measures
   the raw per-event payload, not the deduped runtime behaviour.

4. **Token-lean retrieval output** (`brain-search.mjs` / `brain-ask.mjs`, #22).
   `brain:search` default output emitted ~5.5 kB (~1,370 tok): 8 hits × 900-char
   bodies **plus** a `dense=/keyword=/symbol=/metadata=` diagnostics line the agent
   rarely needs. Two changes, **output only — ranking is untouched, so no eval
   gate**: (a) a new `--terse` prints **one line per hit** (`score file#chunk
   [type] heading`, bodies omitted) — the token-lean mode for agents that only need
   paths; `brain:ask` forwards `--terse` to its search subprocess. (b) the
   diagnostics line moves **behind `--explain` / `--json`** — the default verbose
   output no longer leaks it. The pure renderers (`terseHitLine`, `scoringLine`,
   `verboseHitHeader`) live in `scripts/search-format.mjs`, exported and
   unit-tested (kept out of the CLI script, which opens the store at import).

5. **`brain:graph` size guard** (`brain-graph.mjs`, #22). `--format json` can emit
   multi-MB (~600k tokens) straight into a session — a context bomb. New: a
   `--stats` flag prints a compact node/edge histogram (totals + per-type, edge
   types bucketed by their `:`-prefix) instead of the full graph; a one-line
   **stderr** nudge fires when an oversized payload (> ~200 KB) is written to a
   **TTY** (pointing at `--stats` / `--write <file>`); and a `--write <file>`
   option streams the graph to a file instead of stdout. The **default format is
   never changed** (pipe back-compat). `graphStats` / `renderStats` are PURE,
   exported, and unit-tested.

## Consequences

### Positive
- The brain now sees its own footprint (`brain:health` / `--json`) and shouts when
  a surface goes fat — the SKILL.md-16k and active_state-7.5k regressions would
  both have tripped a warning.
- The per-turn injection can no longer balloon unbounded: the hook is byte-capped
  with a valid-JSON guarantee and an exit-0 guarantee.
- No new command, no new dependency, no LLM on any path, read-only/advisory.

### Negative / Tradeoffs
- `len/4` is a rough token proxy, not a real tokenizer — good enough for a
  threshold nudge, deliberately not exact (no tokenizer dependency).
- The footprint audit spawns the route hook twice per `brain:health` run; both are
  model-free (`--no-index`) and sub-second, and health is not on a hot path.

## Real-consumer finding & follow-up (SessionStart raw cat)

The footprint audit surfaces, but does **not by itself fix**, the largest real
cost: `settings.recommended.json` cats `active_state.md` **raw** into every
SessionStart. That line predates ambient routing (0023). Now that
`brain:route --hook --event sessionstart` exists as the orientation surface, the
raw-cat line is a candidate for replacement by a **bounded digest** (e.g. the route
hook, or `brain:session-digest`, emitting a size-capped summary instead of the full
table). The `active_state > ~600 tok` warn threshold is calibrated to fire loudly
in exactly the consumer case (~7.5k tok) so the bloat is visible immediately.
Making SessionStart emit a bounded digest instead of the raw cat is left as an
explicit follow-up (tracked with #32 / the token-context wave), not silently
changed here — this ADR documents the finding and adds the measurement that proves
it.

## Related
- [[0023-ambient-routing-activation]] (amended by this ADR)
- [[0022-route-autonomous-dispatch-axis]]
