# External tools — honest trade-offs (RTK, Caveman)

The brain pairs with two optional third-party output/communication tools. Both
are **opt-in**, both are **lossy**, and both save **output tokens only** — not
the thinking/reasoning tokens that dominate a session's cost. Adopt them with
eyes open.

## RTK (output compression via a Bash-rewrite hook)

[RTK](https://github.com/rtk-ai/rtk) compresses noisy CLI output ~60–90% via a
`PreToolUse` hook that rewrites `Bash` tool output before it reaches the model.
The brain ships no output compression of its own, so RTK is the natural fit —
but it is **not** wired in by default.

### Supply-chain verdict (verify-before-trust)

Per the caveman/skillspector precedent, RTK was vetted with the trust axis:

```
npm run brain:skill-audit -- https://github.com/rtk-ai/rtk
```

**Verdict (2026-07): not scored — scanner absent.** `brain:skill-audit` shells
out to skillspector, which is **opt-in and not installed** in this environment,
so the audit was **skipped (a no-op, exit 0)** — exactly like `brain:guard`'s
optional security scanners when their CLIs are absent. This is an honest *"we
ran the gate; it could not produce a score here"* — **not** a clean bill of
health. Before adopting RTK on a real machine, install skillspector
(`BRAIN_SKILLSPECTOR_BIN`, or `BRAIN_SKILLSPECTOR_DOCKER=1`) and re-run the audit
with a `--max-risk` gate. Until then, treat RTK as unverified third-party code.

### Installation is deliberately manual (inert example only)

The brain ships an **inert** example at
`templates/claude-code/settings.rtk-example.json`. It is **never installed**:
`setup-claude-settings.mjs` merges only `settings.recommended.json` into consumer
repos, and RTK's config lives in a separate file the setup script never reads. A
fresh `bin/setup.sh` therefore installs **no** RTK config. To use RTK, copy the
`PreToolUse` group into your own `.claude/settings.json` by hand, per repo.

### Critical: exclude `npm run brain:*` from rewriting

The example config **must** exclude `npm run brain:*` (and bare `brain:*`) from
compression:

```json
"command": "rtk hook --exclude 'npm run brain:*' --exclude 'brain:*' || true"
```

`brain:pack` / `brain:search` / `brain:ask` emit the *packed context the brain
exists to provide*. Letting RTK lossy-compress that output corrupts the exact
payload downstream agents read back. **Never drop the `brain:*` exclusion.**

### Hook coexistence with the brain's own PreToolUse hooks (#17)

Claude Code runs **every** matching hook, so RTK does not replace the brain's
hooks — they **both run**:

- **Brain, `Edit|Write|MultiEdit`** → `brain-lint-conventions.mjs` (unaffected;
  different matcher).
- **Brain, `Bash`** → `brain-route-tool.mjs --surface bash` — the ambient nudge
  toward `brain:search`/`brain:ask` (ADR 0026, #17).
- **Brain, `Read|Glob`** → `brain-route-tool.mjs --surface read` (unaffected).
- **RTK, `Bash`** → output rewrite.

Both `Bash` groups fire on the same tool call. Keep RTK from rewriting the
**command** for `brain:*` invocations (the exclusion above) so the brain's Bash
nudge matchers still see the real command. RTK compresses *output*; the brain's
Bash hook reads the *command* — they don't collide as long as `brain:*` is
excluded.

### When to turn RTK off

RTK is **lossy**. **Disable it during intense debugging** — you need exact,
uncompressed stack traces, diffs, and log lines when hunting a bug. Re-enable it
for routine high-volume output once the fire is out. It is a token optimization,
not a correctness feature.

## Caveman — reality note (saves output tokens, not thinking)

Caveman is shipped as an enabled plugin in `settings.recommended.json` and set to
`ultra` for inter-agent communication (`$caveman ultra`). Be honest about what
it buys: it compresses **final output tokens only** — a small fraction of a
session's total cost. It does **not** reduce **thinking/reasoning tokens**, which
dominate. Community consensus (r/ClaudeAI) matches: limited benefit, real
correctness risk from lossy phrasing.

Practical policy (already in `references/conventions.md` and `README.md`):

- `$caveman ultra` for internal agent progress, handoffs, investigation notes,
  and review notes.
- **Normal wording** for user-facing summaries, destructive-action
  confirmations, and ambiguous multi-step instructions — never compress those.

## Bottom line

Both RTK and Caveman trim the cheap part of the bill (output) while the
expensive part (thinking) is untouched, and both introduce lossy-phrasing risk.
Use them for routine, high-volume, low-stakes output; drop them the moment
correctness or exact detail matters.
