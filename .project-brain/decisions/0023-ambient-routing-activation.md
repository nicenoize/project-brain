---
title: Ambient routing activation — the brain routes itself via the harness
status: canonical
layer: decision
module: route
feature: dispatch-axis
date: 2026-06-22
---

# Ambient routing activation — the brain routes itself via the harness

## Context

`brain:route` (decisions/0022) decides correctly which command to run next — but
it is still *pull*: someone has to invoke it. The goal is for the brain to be
"added as a skill and then automatically always used correctly," with no specific
request from the user. That is a HARNESS problem, not another `brain:*` script
(Pocock's "harness > model"): what makes the agent consult the brain at the right
moment without being told?

The mechanism is the agent's own hook / rule surface, which the brain already
wires for other purposes (`setup-claude-settings.mjs` merges `.claude/settings.json`
hooks; `install-cursor-hooks.mjs` installs `.cursor/` hooks + rules; git hooks run
`brain:maintain`). The missing piece is a hook that runs `brain:route` and feeds
its recommendation back into the model's context every turn.

Confirmed Claude Code contract (claude-code-guide): a **UserPromptSubmit** hook
injects context only via a JSON `hookSpecificOutput.additionalContext` envelope
(plain stdout is ignored there) and has a 30s timeout; a **SessionStart** hook
accepts plain stdout; both are non-blocking at exit 0; exit 2 on UserPromptSubmit
would *block the prompt* (never desired here).

## Decision

Add a `brain:route --hook [--event userpromptsubmit|sessionstart]` mode and wire
it into the harness so routing is **ambient**.

- **`--hook` is fast, silent, and safe by construction:** it forces `--no-index`
  (model-free; well under the 30s timeout), surfaces only interrupt-worthy
  recommendations (rank < 11, and `brain:radar`/`brain:pr` suppressed so a clean
  repo injects nothing every prompt), wraps any routing error in a catch, and
  **always exits 0**. It never executes anything — it only surfaces (the autonomy
  ceiling of 0018/0022 is untouched; `--auto` stays an explicit, separate opt-in).
- **Event-correct output:** UserPromptSubmit emits the JSON `additionalContext`
  envelope; SessionStart emits plain stdout.
- **Claude Code wiring** (`templates/claude-code/settings.recommended.json`,
  merged additively by `setup-claude-settings.mjs` on `brain:update-skill`):
  a `UserPromptSubmit` hook injects routing every prompt; a second `SessionStart`
  group orients each new session.
- **Cursor wiring:** `templates/cursor/rules/project-brain-route.mdc`
  (`alwaysApply: true`), installed by `brain:install-cursor-hooks`, is the
  model-driven equivalent — the model is always reminded to consult `brain:route`.
- **Other CLIs:** documented fallback — run `brain:route` yourself.

The agent reads the surfaced block and acts on the `[safe to run]` items, treating
`[your call]` items as decisions. This is the "procedures > abilities" stance made
ambient: the brain is always *consulted*, the human/agent still *decides*.

## Consequences

### Positive
- The brain is used automatically and correctly without specific requests — the
  harness, not the user, triggers it. Adding the skill (`brain:update-skill` /
  `brain:install-cursor-hooks`) is the whole setup.
- Safe by default: surface-only, model-free, silent on a quiet repo, never blocks
  a prompt, never executes a mutating command. No new dependency.

### Negative / Tradeoffs
- "Automatic" means *auto-surfaced*, not *auto-executed*: acting on mutating
  recommendations stays the agent's/human's call (by design — the 0018 ceiling).
  Users who want safe maintenance to run on its own opt into `brain:route --auto`
  in their own hook.
- Persistent state (e.g. "commits ahead, no PR") could repeat across prompts; we
  suppress the chattiest rules (`radar`/`pr`) from the per-prompt stream to limit
  this, accepting that the rest reflects real, current state.
- Per-prompt hook adds a fast node spawn each turn; `--no-index` keeps it cheap,
  `BRAIN_QUIET=1` / opt-out env vars disable it.

## Alternatives Considered
- **Rely only on the SKILL.md description (model-judged invocation):** kept as a
  complement, but alone it is probabilistic — the deterministic hook is what makes
  activation reliable.
- **Auto-execute the safe subset on every prompt (`--auto` in the hook):**
  rejected as the default — too aggressive/surprising every turn; left as an
  explicit opt-in.
- **A long-running daemon watching repo state:** rejected — heavier, statefuller,
  and outside the brain's "thin Node scripts + existing hook surface" house rule.

## Related
- [[0022-route-autonomous-dispatch-axis]]
- [[0021-grill-adversarial-axis]]
- [[0018-autonomous-act-axis-loop]]
