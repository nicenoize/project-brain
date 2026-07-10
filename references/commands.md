# Project Brain — Command Reference

> Part of the **project-brain** skill. Loaded on demand from the lean core `SKILL.md` — see its "Reference files" section for the full map.

Full detail for every `brain:*` command: what it does, flags, and examples.

## Token-saving communication

Use the external Caveman skill for compressed agent communication when available.

- Internal progress, handoffs, investigations, and reviews: prefer `$caveman ultra`.
- User-facing summaries: keep concise and understandable; do not hide risk or ordering for token savings.
- Temporarily drop compression for security warnings, destructive actions, or ambiguous multi-step instructions.
- Caveman affects wording only. Durable facts still belong in `.project-brain/*.md`.
- **`npm run brain:maintain`** optional logs: `BRAIN_MAINTAIN_CAVEMAN=1` and/or `BRAIN_MAINTAIN_WENYAN=1` (or `--caveman` / `--wenyan`) print terse hook/CI status lines only; they do not rewrite skill text or Markdown.

## Standard commands

When asked to initialize:

```bash
npm run brain:init
npm run brain:index
npm run brain:health
npm run brain:adr -- "short decision title"
```

When asked to search context, default to the smart router which picks the cheapest correct retrieval automatically:

```bash
npm run brain:ask -- "query text"
npm run brain:ask -- "query text" --pack --max-tokens 3000
npm run brain:ask -- "query text" --task issue-99-slug --actor cursor-worker-a --pack --max-tokens 3000
npm run brain:ask -- "query text" --explain          # show route decision without running
```

### Reasoning cache (`brain:explain`)

`brain:ask` answers are throwaway — the brain re-derives the same explanation every session. `brain:explain` is the reasoning cache: it captures a synthesized answer as a durable, cited `explainer` record under `.project-brain/explainers/<slug>.md` and tracks whether it has gone stale.

```bash
# Save an answer (text from stdin or --answer-file), citing the sources it came from.
npm run brain:ask -- "how does sync flush work" | npm run brain:explain -- save --query "how does sync flush work" --sources scripts/brain-sync.mjs,scripts/common.mjs --actor cursor-worker-a
npm run brain:explain -- save --query "..." --answer-file answer.md --sources a.mjs,b/c.md

# Re-check freshness: an explainer is STALE if any cited source's content changed or the file is gone.
npm run brain:explain -- check            # human report
npm run brain:explain -- check --json     # machine-readable
npm run brain:explain -- check --strict   # non-zero exit if any stale (CI / pre-commit gate)
npm run brain:explain -- list             # explainers with fresh/stale status
```

Each record stores `query`, `created`/`updated`, `actor`, and `sources:` as `{ path, sha256 }` where the hash is the cited file's content at save time. `check`/`list` re-hash each source's current content; a mismatch (or missing file) marks the cached answer STALE — the staleness invalidation that pairs with the brain's drift philosophy. `save` is idempotent by slug (re-save updates the body + `updated` + re-hashes sources, preserves `created`). v1 deliberately does NOT touch retrieval ranking; a search boost for explainers is a planned follow-up.

### Act axis: audit → enriched plan (`brain:audit` / `brain:improve`)

The brain is extractive (it retrieves); the act axis makes it executive. `brain:audit` is a 9-category audit scaffold (like `brain:adr`, the model does the judging); each confirmed problem becomes an indexed `finding`. `brain:improve` turns a finding into an `improve-plan` enriched from the brain's own index — real blast-radius, governing ADRs, the actual tests to run — then keeps the backlog honest. See `decisions/0017-build-native-improve-act-axis.md`.

```bash
# 1. Scaffold the audit, then record each confirmed problem as a finding.
npm run brain:audit -- run --quick                     # taxonomy + evidence commands (or --categories a,b)
npm run brain:audit -- add --title "..." --category performance --impact 4 \
    --symbols hybridScore,tfidfScore --module scripts/retrieval --sources scripts/retrieval.mjs --body "evidence + fix"
npm run brain:audit -- list                            # backlog by status/impact

# 2. Turn a finding into an enriched, self-contained plan a cheaper model can execute.
npm run brain:improve -- plan <finding-slug> --enrich  # injects buildImpact blast-radius + packPrompt context + buildPlan packages
npm run brain:improve -- list

# 3. Keep the backlog honest: cited sources gone → auto-resolved; changed → flagged stale for re-review.
npm run brain:improve -- reconcile                     # add --dry-run to preview, --json for machines

# 4. Execute / verify — REAL wiring over the existing coordinator + gate (decisions/0020):
npm run brain:improve -- execute <plan-slug>           # DRY preview: materializes work-packages, prints what it WOULD spawn
npm run brain:improve -- execute <plan-slug> --run     # spawns worktrees (brain:worktree); stops at the worktree boundary — no push/merge
npm run brain:improve -- review  <plan-slug>           # brain:guard + brain:verify (+ brain:eval:compare for retrieval-affecting plans)
```

Both record types are indexed and retrievable via `brain:search --type finding|improve-plan`:

| Type | Path | Holds |
|------|------|-------|
| `finding` | `.project-brain/findings/<slug>.md` | A problem: `category`, `impact`, `status` (open/planned/wontfix/resolved), cited `sources` (staleness anchors), `symbols`/`module` (drive enrichment). |
| `improve-plan` | `.project-brain/plans/<slug>.md` | A remediation: the enriched, self-contained plan body. Named `improve-plan`, not `plan`, to avoid colliding with the spec-kit `plan` type. |

`reconcile` reuses the explainer staleness machinery (`evaluateExplainers` + `hashSource`): a finding whose cited sources are all gone is auto-resolved; merely changed sources surface as stale (never auto-closed — avoids false-closing on churn). A `wontfix` finding stays indexed — the "what we decided NOT to do" record. Everything heavy (worktrees, orchestration, eval) is an existing `brain:*` primitive; the act axis adds no new dependency. A retrieval boost for these types is a planned, eval-gated follow-up.

#### Running the act axis as an autonomous loop

The act axis is a cycle — audit → plan → execute → verify → reconcile. Drive it with the `/loop` skill so the agent drains the backlog with minimal input:

```
/loop work the improvement backlog: run `brain:improve status`; if open findings exist run
`brain:improve next` (it plans the top one); if findings are planned, `brain:improve execute <plan> --run`
to spawn worktrees, do the work, then `brain:improve review <plan>`; if the backlog is clear,
`brain:audit run` to find more. Stop when status shows nothing open or planned.
```

- `npm run brain:improve -- status` — backlog dashboard (open/planned/wontfix/resolved + the next action). The loop's situational awareness and stop condition.
- `npm run brain:improve -- next` — advances the backlog ONE safe tick: plans the highest-impact open finding (the only auto-step). Never mutates code.
- `npm run brain:improve -- execute <plan> [--run]` — REAL wiring (decisions/0020): materializes work-packages and routes them to `brain:worktree spawn` as a subprocess. **DRY preview by default** (prints what it would spawn); `--run` spawns; either way **stops at the worktree boundary — no push/merge.**
- `npm run brain:improve -- review <plan> [--baseline f --variant f]` — the REAL gate: `brain:guard` + `brain:verify`, plus `brain:eval:compare --hard-only` for retrieval-affecting plans. It refuses regressions (a required-but-unproven eval gate FAILS) — that is what makes the loop effective rather than a token-burner.

The LLM stays in the loop by design: **auditing** (judging what's worth fixing) and **reviewing** a diff need judgment a CLI can't supply — `next`/`execute`/`review` do the mechanical planning/spawning/gating, the agent does the judgment. Autonomy ceiling: execution is worktree-isolated, and the loop **stops at the merge boundary** — you merge (house rule). See `decisions/0018-autonomous-act-axis-loop.md` and `decisions/0020-real-execute-review-loop-closure.md`.

### Diagrams (`brain:diagram`)

The brain already computes the graph, so a diagram is a projection of the index — no re-parsing. Default output is Mermaid (renders in `docs/*.md` and on GitHub, zero deps); `--format drawio` emits `.drawio` XML (the draw.io desktop CLI is only needed to rasterize to PNG, and the brain never calls it). See `decisions/0016-ecosystem-skill-axis-map.md` (recall axis).

```bash
npm run brain:diagram                                   # module/feature/project overview
npm run brain:diagram -- --module scripts/retrieval     # files + symbols inside one module
npm run brain:diagram -- --feature checkout             # files/modules/decisions for a feature
npm run brain:diagram -- --symbol hybridScore           # blast-radius ego-graph (reuses brain:impact)
npm run brain:diagram -- --fleet                        # cross-project edges (fleet mode)
npm run brain:diagram -- --module x --format drawio --out docs/diagrams/x.drawio
```

Pick at most one scope (default = overview). `--format mermaid|drawio|json`, `--direction TD|LR`, `--max-nodes N` (caps huge graphs). Writing a Mermaid block into a `.project-brain/**.md` round-trips it back into retrieval.

### Skill trust / supply-chain audit (`brain:skill-audit`)

Installing a third-party skill is a supply-chain risk. `brain:skill-audit <path|url>` shells out to [skillspector](https://github.com/NVIDIA/skillspector) (if installed) for a 0-100 risk score and gates adoption. OPT-IN and never vendored: install the scanner CLI, set `BRAIN_SKILLSPECTOR_BIN`, or run via Docker (`BRAIN_SKILLSPECTOR_DOCKER=1`, no local Python). Absent → the audit is skipped (a no-op, not an error), exactly like the `brain:guard` security scanners.

```bash
npm run brain:skill-audit -- ./path/to/skill                 # scan a local skill dir/file
npm run brain:skill-audit -- https://github.com/owner/skill  # scan a remote skill
npm run brain:skill-audit -- ./skill --max-risk 40 --json    # gate: exit 1 if risk > 40
```

First primitive of the trust axis / Constellation federation (`docs/vision-constellation.md`): verify-before-trust for any skill or brain fragment entering your brain. Dogfood it before adopting ecosystem skills (caveman, drawio-skill, ponytail, improve).

### Adversarial pre-implementation grill (`brain:grill`)

The brain *finds* problems (`brain:audit`/`brain:gaps`) and *synthesizes* (`brain:insight`), but `brain:grill` *challenges an idea before you build it* — an adversarial interviewer that flushes out issues while they're cheap. Its edge over a generic "grill me": the questions are generated **deterministically from the index** — real callers/tests of a symbol (`buildImpact`), the ADRs that govern the module, conflicting open findings — so the interview is specific, not boilerplate. Scaffold + recorder like `brain:audit`/`brain:adr`/`brain:insight`: the command poses grounded questions, **the agent answers** (the judgment a CLI can't supply), `save` records the Q&A + verdict. See `decisions/0021-grill-adversarial-axis.md`.

```bash
npm run brain:grill -- scaffold <finding-slug>          # grounded interview from the index
npm run brain:grill -- scaffold improve-<plan> --context # also inject a retrieved context primer
npm run brain:grill -- scaffold --title "free proposal" --category performance
npm run brain:grill -- save --target <id> --verdict proceed|revise|block \
    --sources scripts/retrieval.mjs --body-file answers.md
npm run brain:grill -- check --strict                    # STALE when cited evidence drifts (CI gate)
npm run brain:grill -- list
```

The `grill` record (`.project-brain/grills/<slug>.md`, indexed → `brain:search --type grill`) carries a `verdict` (`open`/`proceed`/`revise`/`block`) and cited `sources` ({path, sha256}); a grill goes STALE when its evidence changes (same machinery as explainers/findings). Evidence gathering is mostly model-free (ADRs + related findings from disk); only blast-radius needs the index and degrades gracefully without it. A grill on a `finding`/`improve-plan` flushes issues **before** `brain:improve execute`.

### Autonomous dispatch — the brain decides what to run next (`brain:route`)

Every other command answers "do X"; `brain:route` answers "what should I do NOW?". It is the **Default automation policy table above, made executable** — a deterministic sensor + rule engine (no LLM on the hot path) that senses git/index/backlog state and prints the ranked next `brain:*` action(s) with a reason for each, generalizing `brain:improve status/next` from one backlog to the whole command surface. See `decisions/0022-route-autonomous-dispatch-axis.md`.

```bash
npm run brain:route                          # ranked next actions + reasons (recommend only)
npm run brain:route -- --explain             # every sensed signal + which rules fired
npm run brain:route -- --json                # machine-readable envelope for the agent
npm run brain:route -- --auto                # run ONLY the safe subset; STOP at the first mutating boundary
npm run brain:route -- --auto --dry-run      # show what --auto would run vs. where it stops
npm run brain:route -- --intent "start a PR" # bias ranking toward a stated goal (keyword match)
npm run brain:route -- --no-index            # skip the optional index open (model-free, faster)
```

**Autonomy ceiling (inherits `decisions/0018`):** plain `brain:route` recommends only. `--auto` executes the read-only/advisory/idempotent subset (`ask`, `radar`, `brief`, `gaps`, `maintain`, `improve next`, …) and **stops at every mutating/irreversible boundary** — record writes, branch/worktree/PR creation, `improve execute` — printing what it stopped before and why. It re-checks the boundary before every execution and **never runs git commit/push/merge**. It delegates (never reimplements): retrieval → `brain:ask`, backlog → `brain:improve`, pre-touch → `buildBrief`.

#### Auto-activation — the brain routes itself (no command needed)

So you don't have to *ask* the brain which command to run, `brain:route --hook` is wired into the agent harness to surface routing **automatically**. It is fast (model-free `--no-index`), **silent on a quiet repo** (no per-prompt noise), and **always exits 0** (never blocks a prompt). It only nags on genuinely interrupt-worthy state (stale index, lease conflict, risky uncommitted change, open/planned backlog) — `brain:radar`/`brain:pr` are kept out of the per-prompt stream. See `decisions/0023-ambient-routing-activation.md`.

- **Claude Code:** `brain:update-skill` merges two hooks into `.claude/settings.json` (via `setup-claude-settings.mjs`): a **`UserPromptSubmit`** hook (emits the JSON `additionalContext` envelope Claude Code requires) injects the current routing into context on every prompt, and a **`SessionStart`** hook (plain stdout) orients each new session. Additive + idempotent (deduped by command string).
- **Cursor:** `brain:install-cursor-hooks` installs `.cursor/rules/project-brain-route.mdc` (`alwaysApply: true`) — the model is always reminded to consult `brain:route`.
- **Other CLIs (Codex/Gemini/plain terminal):** no per-prompt hook; run `npm run brain:route` yourself (the Cursor rule's guidance applies), or add `brain:route --hook` to your own shell prompt wiring.

**When you see a `Project Brain routing` block in context:** act on the **[safe to run]** items yourself; treat **[your call]** items as decisions (do them only when the task calls for it). Opt out with `PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1` (Claude) or by deleting the rule/hook; `BRAIN_QUIET=1` and `--no-index` keep it fast.

### Pre-touch / PR radar (`brain:radar`)

File-centric, deterministic, index-only (no LLM, no new embeddings) — surfaces what the brain already knows about files **before** you edit them. Turns the brain proactive.

```bash
npm run brain:radar -- --for scripts/retrieval.mjs   # one file (repeatable)
npm run brain:radar -- --staged                       # git-staged files (PR briefing)
npm run brain:radar                                    # working-tree changes; --json, --no-impact
```
Per file: active leases, governing ADRs (by module), downstream cross-project consumers, open findings citing it, and a one-line blast radius. Always exits 0 (advisory). Opt-in hook at `templates/hooks/brain-radar.sh` (`BRAIN_RADAR_ON_CHECKOUT=1` / `_ON_COMMIT=1`). See `decisions/0019`.

### Git archaeology (`brain:why`)

Make git history queryable so an agent can answer "why is this code like this?" instead of guessing. New indexed `history` record type.

```bash
npm run brain:why -- ingest [--limit N] [--since <ref>]   # git log → .project-brain/history/<sha>.md (then brain:index)
npm run brain:why -- "why was rerank added" [--json]      # retrieve the commits/PRs that explain it
```
Ingest is **explicit** (not on every sync). Enriches with PR bodies if `gh` is available; degrades silently otherwise. `.project-brain/history/` is regenerable → gitignored. See `decisions/0019`.

### Deterministic self-audit (`brain:gaps`)

What the brain does NOT know / where it's stale or self-contradictory — all from the index, no LLM. READ-ONLY by default.

```bash
npm run brain:gaps                       # grouped-by-severity report; --json; --strict (CI gate)
npm run brain:gaps -- --as-findings      # emit each gap as an indexed `finding` (feeds the act axis)
```
Three checks: coverage gaps (modules w/o ADR+doc, features w/o tests, empty rationales), decision-decay (old ADRs whose module churned), structural contradictions (doc names a missing symbol / cites a vanished file). Precision-biased (won't cry wolf). See `decisions/0019`.

### Synthesis: cross-source insights (`brain:insight`)

Where an `explainer` caches one answer, an `insight` is a SYNTHESIZED claim across multiple sources. A scaffold+recorder like `brain:adr` — **it never calls an LLM** (the agent synthesizes; the command records with guardrails). New indexed `insight` type.

```bash
npm run brain:insight -- scaffold "<topic>"            # guidance on what to synthesize + evidence cmds
npm run brain:insight -- add --title "..." --claim "..." --sources a.mjs,b.md --confidence 0.7 --body "..."
npm run brain:insight -- check [--strict] | list       # staleness via cited-source hashes
```
**Guardrail:** requires ≥2 cited sources (else refuses) + staleness tracking — a synthesized claim must be grounded, to protect the trust axis from hallucination. `.project-brain/insights/` is durable (committed). See `decisions/0019`.

### Learning axis: usage grows the benchmark (`brain:learn`)

Make the eval set learn from real usage **without ever changing ranking** (ranking stays human-approved + eval-gated — the house discipline). It grows only the *measurement*.

```bash
npm run brain:learn -- capture --query "..." --used a.mjs,b.mjs   # stage a usage-proven case
npm run brain:learn -- promote [--min-uses N] [--dry-run]         # append de-duped cases to eval.json
npm run brain:learn -- suggest                                     # propose an A/B knob to run via brain:eval:compare (applies nothing)
```
`capture` stages (gitignored); `promote` is the explicit, reviewable step that grows `eval.json` (file-level cases, not tagged `Hard:`). Nothing here changes ranking or runs automatically. See `decisions/0019`.

The router decides between direct file read, symbol search, doc summary, module summary, vector search, or budgeted pack. Only fall back to the lower-level commands when the router result is insufficient:

```bash
npm run brain:search -- "query text"
npm run brain:search -- "query text" --terse          # one line per hit (score file#chunk [type] heading); bodies omitted — token-lean
npm run brain:search -- "query text" --explain        # add the dense=/keyword=/symbol=/metadata= diagnostics (default omits them)
npm run brain:search -- "query text" --summary-only
npm run brain:search -- "query text" --modules-only
npm run brain:symbol -- SymbolName SymbolName
npm run brain:impact -- SymbolName
npm run brain:pack -- "query text" --max-tokens 3000
npm run brain:pack -- "query text" --print-budget
npm run brain:pack -- "resume current work" --mode resume --max-tokens 1200
npm run brain:pack -- "architecture map" --mode minimal --max-tokens 800
npm run brain:pack -- "query text" --task issue-99-slug --actor cursor-worker-a
npm run brain:ticket -- "large task title" --packages 4 --write
npm run brain:ticket -- create "large task title" --packages 4 --github
npm run brain:orchestrate -- --limit 6 --concurrency 3 --write
npm run brain:orchestrate -- --limit 6 --concurrency 3 --write --write-packages
npm run brain:orchestrate -- --refill --limit 6 --concurrency 3 --write
npm run brain:orchestrate -- --watch --interval 120 --concurrency 3 --write
npm run brain:orchestrate -- --refill --concurrency 3 --spawn-worktrees --launch-runners --runner-cmd 'codex exec {prompt}'
npm run brain:work -- start --issue 99 --slug checkout-hardening --actor codex --tool codex --files lib/auth.ts
npm run brain:lease -- add "lib/auth.ts" --task issue-99-checkout-hardening --actor codex
npm run brain:pr -- prepare --write .project-brain/pr-body.md
npm run brain:graph -- --stats                        # node/edge counts by type — inspect the index shape without dumping the whole graph
npm run brain:graph -- --format json --write graph.json  # ALWAYS write to a file in a session: the full JSON can be multi-MB (a context bomb)
npm run brain:graph -- --format json                  # to stdout; warns on stderr if >~200 KB is emitted to a terminal
npm run brain:route
npm run brain:grill -- scaffold <finding-slug>
npm run brain:eval
npm run brain:maintain
npm run brain:maintain -- --strict
npm run brain:maintain -- --ci
npm run brain:compact
npm run brain:install-cursor-hooks
```

Retrieval ranks with dense vector similarity, keyword relevance, exact symbol matches, metadata, and current branch/diff boosts. Set `BRAIN_CONTEXT_FILES` to comma-separated files when the current task should favor a specific diff or changed-file set. Set `BRAIN_TASK` and/or `BRAIN_ACTOR` (or use `--task` / `--actor` on `brain:search`, `brain:pack`, `brain:ask`) to boost session handoffs and chunks whose frontmatter matches that workstream.

### Automated maintenance (outcome quality)

The skill and Markdown layers improve **answer** quality; **`npm run brain:maintain`** automates **index freshness + gates** so agents cite fewer ghosts. It does **not** change MiniLM, LanceDB chunking, or hybrid ranking weights—those still need deliberate `scripts/retrieval.mjs` (or config) work when `brain:eval` proves a blind spot.

| Command / mode | Behavior |
|----------------|----------|
| `npm run brain:maintain` | If `search_index.json` reports deleted paths or stale hashes (and not `BRAIN_FAST=1`), runs `brain:sync`, then `brain:health`, then removes expired session records. |
| `--strict` | After sync, runs `brain:health --strict-stale`, then **`brain:eval` with `BRAIN_EVAL_STRICT=1`** when `.project-brain/eval.json` exists. |
| `--ci` | Same as `--strict` for CI. If there is **no** `.project-brain/eval.json`, eval is skipped with a log line (add one from `skills/project-brain/templates/brain/eval.json` via `brain:init` or hand-author cases). |
| `--hook` | For Git hooks after pulls: sync when needed; **non-zero exits become 0** so merges are not blocked (inspect logs if retrieval feels wrong). |
| `--no-sync` | Health (and strict/eval when combined with `--strict`) only. |
| `--force-sync` | Passes `--force` into the first `brain:sync`. |
| `--clean-session-files` | Also deletes expired `.project-brain/sessions/*.md` files, not just expired index records. |
| Stale after sync | One automatic `brain:sync --force` retry when `--strict` / `--ci` before failing. |

`post-merge` and `post-checkout` (branch switch) hooks run **`npm run brain:update-skill`** then **`npm run brain:maintain -- --hook`**. The GitHub Actions template runs **`npm run brain:maintain -- --ci`** before `brain:guard`.

`npm run brain:health -- --json` emits machine-readable layout/stale/expiry fields for scripts.

### Auto-compact (token reload slice)

**`npm run brain:compact`** builds a **bounded resume-mode `brain:pack` slice** (default ~1200 token budget), writes `.project-brain/sessions/<branch>__auto-compact__<timestamp>.md`, and indexes it so the next agent turn can reload context without re-reading the whole repo. It excludes prior auto-compact snapshots by default to avoid recursive context bloat. Set `BRAIN_TASK`, `BRAIN_ACTOR`, and **`BRAIN_TOOL`** (`cursor`, `claude`, `gemini`, `codex`, …) in the environment so retrieval boosts match the active workstream.

- **Cursor (automatic):** run **`npm run brain:install-cursor-hooks`** once per repo. Hooks run on **`preCompact`** and **`stop`** (`npm run brain:compact -- --cursor-hook …`). Optional rule: `skills/project-brain/templates/cursor/rules/project-brain-compact.mdc` is copied beside `hooks.json` when the rule file is missing.
- **Claude Code / Codex CLI / Gemini CLI:** no IDE hook—run **`npm run brain:compact`** (same env vars) before `/compact`, thread reset, or ending a long terminal session. Copy-paste policy from **`skills/project-brain/templates/agents/COMPACT_INSTRUCTIONS.md`** into team docs or `CLAUDE.md` if desired.
- **CLI follow-up:** compact triggers **`npm run brain:sync`** by default so the index sees the new session file; Cursor hook mode skips sync for latency (set `BRAIN_COMPACT_SYNC=1` to force sync from hooks). Set **`BRAIN_QUIET=1`** is applied automatically for hook runs so stdout stays JSON-clean for Cursor.

### Performance modes

- `BRAIN_FAST=1` — fast iteration mode. Sync hooks become no-ops, retrieval uses the JSON store with summary-only results, and module/feature/project summaries are not rebuilt during indexing. Recommended local default during heavy edit loops; CI keeps it off so retrieval quality stays high.
- `BRAIN_BACKGROUND=1` — pre-commit hook sets this so `brain:sync` self-decides foreground vs detached background indexing instead of blocking the commit. Manual `npm run brain:sync` runs foreground by default.

### Polyglot symbols (Python + Go)

- `BRAIN_POLYGLOT_SYMBOLS=1` — **default OFF.** When set, `.py` and `.go` files are indexed as `type:code` records with regex/heuristic-extracted `symbols`, `exportedSymbols`, and `references`, so `brain:impact` and `brain:graph` work in Python/Go repos (today they are effectively TS/JS-only, since precise extraction runs through the TypeScript compiler). Python exports = top-level `def`/`class`/module assignments not prefixed with `_`; Go exports = capitalized identifiers. With the flag unset, the indexed file set and every record are byte-for-byte unchanged. The intent is to flip this default-on after validation. This first increment is regex-based (lightweight, no native deps); **tree-sitter precision is the planned follow-up** and will replace the heuristics behind the same record interface.

When asked to sync:

```bash
npm run brain:sync
```

When asked to update the reusable skill:

```bash
npm run brain:update-skill
```

Without a configured upstream branch (`git branch -u …`), this fast-forwards from **https://github.com/nicenoize/project-brain** via a Git remote named `project-brain-upstream` (set `PROJECT_BRAIN_UPSTREAM_URL` or `PROJECT_BRAIN_UPSTREAM_REMOTE` to override, or set `PROJECT_BRAIN_REMOTE` to use an existing remote such as `origin`).

When asked to guard/check:

```bash
npm run brain:guard
```

When asked to track short-lived work context (branch-scoped; use flags when several agents or humans share one branch):

```bash
npm run brain:session -- start [--task <workstream-id>] [--actor <label>] [--tool cursor|claude|gemini|codex|human|other] [--parent <orchestrator-id>]
npm run brain:session -- end [--task <workstream-id>]
npm run brain:session -- list [--json]
npm run brain:session -- clean [--files]
```

For retrieval that prefers the current workstream’s session chunks, set `BRAIN_TASK` / `BRAIN_ACTOR` or pass `--task` / `--actor` to `brain:search`, `brain:pack`, or `brain:ask`.

When asked for **parallel Claude Code / Cursor workers** on **separate branches** (Git worktrees: isolated directories, no stash dance):

```bash
npm run brain:worktree -- spawn --count 3 --base develop --type feature --issue 456 --slug checkout-hardening [--tool cursor|claude|gemini|codex|human|other] [--parent <orchestrator-id>]
npm run brain:worktree -- list
npm run brain:worktree -- remove <path-from-list>
npm run brain:worktree -- prune
```

Each worktree is a normal checkout: use one terminal or IDE window per tree, `cd` into its path, run `npm run brain:session -- start …` there with the printed `--task` / `--actor` / `--tool`, and keep `BRAIN_TASK` / `BRAIN_ACTOR` aligned when calling `brain:pack` / `brain:ask`. Default worktree parent is `<repo>/.worktrees/` (gitignored via setup); override with `--dir` or `BRAIN_WORKTREE_DIR`. Prefer `develop` as `--base` for GitFlow work branches. **`--tool`** (or env **`BRAIN_WORKTREE_TOOL`**) sets the session tool label and the `<tool>-worker-N` actor prefix for Cursor, Claude Code, Codex CLI, Gemini, etc. (defaults to `claude`). Aliases: `claude-code` → `claude`; `openai`, `gpt`, `codex-cli` → `codex`.
