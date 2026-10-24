# Command map

Moved out of `SKILL.md` on 2026-10-24 so the skill core stays near 3 KB; loaded only when needed. Full flags and behaviour per command: [`commands.md`](commands.md).

## When to use what (quick table)

| Situation | Default action |
|-----------|----------------|
| Unsure which command fits the repo state | `npm run brain:route` (`--auto` for the safe subset) |
| Ask a repo/context question | Load `context_index.md` + `active_state.md`, then `npm run brain:ask -- "query"` |
| Need exact implementation context | `brain:ask --pack --max-tokens 1200-3000`; fall back to file reads for returned paths |
| About to implement a finding/plan/risky idea | `npm run brain:grill -- scaffold <finding\|plan\|decision>` first |
| Start non-trivial implementation | `npm run brain:work -- start ...` (branch, session, workstream, leases, pack) |
| Task large/vague/cross-module | `npm run brain:ticket -- "title" --packages N --write` before coding |
| Pull issues + distribute across agents | `npm run brain:orchestrate -- --limit N --concurrency M --write` |
| Overlapping edits by several actors | `brain:lease -- add ...` before editing; `brain:lease -- list` before assigning |
| Parallel work on separate branches | `brain:ticket`, then `brain:worktree -- spawn --count N ...` |
| Long session / compaction / handoff | `npm run brain:compact` (set `BRAIN_TASK`/`BRAIN_ACTOR`/`BRAIN_TOOL`) |
| Preparing a PR | `brain:maintain`, `brain:guard`, project checks, then `brain:pr -- prepare --write ...` |
| Updating durable architecture/product facts | Edit the specific feature/module/decision file; keep `context_index.md` compact |

Full policy, splitting heuristics, and step-by-step operating-mode runbooks: [`workflows.md`](workflows.md).

## Command map (one line each)

**Retrieval**
- `brain:ask` — smart router: picks the cheapest correct retrieval (`--pack --max-tokens`, `--explain`).
- `brain:search` — low-level semantic search (`--terse` one-line hits, `--summary-only`, `--modules-only`).
- `brain:symbol` / `brain:impact` — exact symbol lookup / blast-radius for a symbol.
- `brain:pack` — budgeted context pack (`--mode resume|minimal`, `--max-tokens`).
- `brain:graph` / `brain:diagram` — dependency graph / Mermaid·drawio projection of the index (`--stats` for counts; `--path <from> <to>` answers "how does X reach Y?"; always `--write <file>` in a session — the full JSON can be multi-MB).

**Reason & act axes**
- `brain:explain` — reasoning cache: `save`/`check` durable cited explainers.
- `brain:audit` → `brain:improve` — 9-category audit → findings → enriched plan → execute/review loop.
- `brain:grill` — adversarial pre-implementation interview generated from the index.
- `brain:insight` — synthesized cross-source claim (requires ≥2 cited sources).
- `brain:gaps` — deterministic self-audit: what the brain does NOT know / is stale on.
- `brain:why` — git archaeology: `ingest` history, then query "why is this like this?".
- `brain:learn` — grow the eval set from real usage (never changes ranking).
- `brain:reflect` — outcome-tagged learning loop: `record <id> --outcome useful|dead_end|corrected` (append-only sidecar), then aggregate into deterministic lessons (decay + ≥2-corroboration gate + contested flag + prune). No LLM, no ranking change — details in `references/commands.md`.

**Proactive / pre-touch**
- `brain:route` — rank the next action(s); `--auto` runs the safe subset. `--hook` = ambient.
- `brain:radar` / `brain:brief` — file advisories (leases, ADRs, impact) before you edit.

**Planning & parallelism**
- `brain:ticket` — size + split a large task into agent-ready work packages.
- `brain:orchestrate` — pull GitHub issues, split, assign across worker slots.
- `brain:work` — full workflow envelope: branch, session, workstream, leases, resume pack.
- `brain:worktree` — spawn/list/remove parallel git-worktree workers.
- `brain:lease` / `brain:session` — file leases / branch-scoped short-lived work context.
- `brain:compact` — bounded resume slice for handoff / token reload.
- `brain:close` — end-of-session retrospective: collects digest, open leases, ADR/learn candidates + a commit SUGGESTION (never commits). Run it when wrapping up a session.

**PR & quality gates**
- `brain:pr` — prepare a PR body from diff + workstream state.
- `brain:guard` — pre-PR security/hygiene gate.
- `brain:verify` — read-only drift check (curated docs vs. code).
- `brain:skill-audit` — supply-chain risk score for a third-party skill (opt-in scanner).
- `brain:lint-conventions` / `brain:link-check` — conventions linter / markdown path check.
- `brain:lint` — consume ESLint/tsc/SARIF output, rank findings by where a change actually hurts.
- `brain:security` — advisories ordered by REACHABILITY (does our code import it), not severity alone.
- `brain:tokens` / `brain:ps` — where agent tokens go (context size, compressible tool output) / which sessions, runners, stacks and orphans hold RAM, and whether another agent fits.
- `brain_recall` (MCP) / `brain:recall` — fetch a detail from earlier in this session, including what a compaction dropped, instead of re-running or re-reading.

**Code intelligence (measured from git + imports, no index needed)**
- `brain:outline <file>` — the file's functions with line ranges; `--symbol <name>` prints just that one. Read 90 lines instead of 1,300.
- `brain:overview` — the WHOLE repo in <2k tokens: what it leans on, where it is dangerous, who owns what. Start here on an unfamiliar repo instead of grepping.
- `brain:intel health` — per-file danger score from churn, co-change scatter and fix density. `--structure` adds size/nesting/coupling; `--plans` names the refactoring move.
- `brain:intel health-calibrate` — does that ranking predict THIS repo's own next fixes? Prints an AUC and refuses to endorse it below 10 files in the smaller class.
- `brain:intel hotspots|co-change|ownership|risk` — churn ranking / "who changes A changes B" / bus factor / risk of the staged change.
- `brain:graph-scan` — multi-language import graph: blast radius, cycles, dead-code CANDIDATES. Reports unresolved specifiers rather than dropping them.
- `brain:draft` — module-record draft for a code area no `.project-brain/modules/*.md` claims.
- `brain:serve` — local Control Room (127.0.0.1, session token) over that same data.
- `brain:release snapshot|tag|compare` — pin the measurements to a version so two versions can be compared, and `git checkout <tag>` is the way back.

**Index & maintenance**
- `brain:init` / `brain:index` — scaffold `.project-brain/` / build the index (`--force`).
- `brain:sync` / `brain:maintain` — incremental re-index / automated freshness + gates.
- `brain:health` — index plumbing & layout check (`--json`).
- `brain:eval` / `brain:eval:compare` — retrieval quality eval / CI-verdict paired compare.
- `brain:repair` — reset a stuck index (generated artifacts only).
- `brain:adr` — new ADR file. `brain:maintain -- --ci` for CI.

**Fleet & spec-kit**
- `brain:projects` / `brain:edges` — discovered projects / materialized cross-project edges.
- `brain:speckit` — import/tasks/analyze for GitHub spec-kit repos.

**Setup & sync**
- `brain:update-skill` — fast-forward this skill from upstream.
- `brain:install-hooks` / `brain:install-cursor-hooks` — hook installers.
- `brain:handoff` / `brain:feature` — solo multi-repo helpers.

Every command accepts `--project NAME` in fleet mode. Full flags, examples, and behavior for each command: [`commands.md`](commands.md).
