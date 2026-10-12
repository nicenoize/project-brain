# Roadmap — what's next (deferred proposals)

Captured from the "make the brain smarter" sessions. Everything here is **deliberately
not built yet** — recorded so the direction survives. The shipped axes (recall /
structure / trust / act + the sensing/synthesis/learning wave) live in
`decisions/0016`–`0020`. This doc is the honest backlog beyond them.

Discipline that governs all of it (the reason the brain doesn't "just eat tokens"):
**default-off · read-only or eval-gated · no LLM on a hot path · no new npm deps.**
Cheap deterministic features ship freely; speculative ones build the measurement first
and flip default only when `brain:eval:compare` proves a win.

## North star

A **self-verifying, self-improving codebase brain**: it audits itself/the repo, acts in
isolation, and *proves* the improvement with a paired-bootstrap CI — refusing to ship
regressions. Partly realized today (the act-axis loop + the eval gate in
`brain:improve review`). "Fully" = the loop runs end-to-end with the eval gate as the
hard ceiling and a human only at the merge boundary.

## Deferred, ranked by leverage-per-cost

| Idea | What | Cost / confidence | Status |
|---|---|---|---|
| **Constellation federation transport** | Pull/merge knowledge + skills across peer brains over plain Git, gated by `brain:skill-audit` (verify-before-trust). | Large; research (discovery, signing/identity, conflict merge). The trust primitive exists. | see `vision-constellation.md` |
| **Code-aware embedder** | Dual-embedder: code records → a code model, docs → MiniLM, via the existing `BRAIN_LOCAL_EMBED_MODEL` seam. | An **eval experiment**, not new code. General embedders were a measured wash (n=84); a code model on code records is untested. | run via `brain:eval:compare`, don't flip default |
| **Outcome-weighted ranking** | The *ranking* half of `brain:learn`: records that were part of merged/successful work get a small durable boost. | Speculative; a ranking change → must clear `brain:eval:compare --hard-only`. The benchmark-growth half already shipped. | eval-gated follow-up |
| **Retrieval boost for `insight`/`history`** | Surface synthesized insights / git rationale above generic docs on relevant queries. | Small code; a ranking change → eval-gated. | eval-gated follow-up |
| **Semantic contradiction detection** | The judgment half of `brain:gaps`: two ADRs that logically conflict; a doc that semantically contradicts code. | Needs an LLM per check → keep it agent-invoked (scaffold), not automated. | agent-invoked, not a hot-path job |
| **Detached auto-execute runners** | Beyond `brain:improve execute --run` (worktree spawn): actually launch agent runners via `brain:orchestrate`, still stopping at merge. | Real token/compute when run; the eval gate makes it safe. Explicit opt-in only. | next act-axis step |

## Wave: context efficiency & resource hygiene (2026-10-12, active)

**Goal.** Long sessions stay long — that is how the user works — but every request
carries only the context the current step needs. The brain *decides*: it saves where
nothing is lost and brings context back where it is needed. And the brain that
launches agents also collects them, so the machine stays usable.

### What was measured (30 days, all projects, 67.7k API requests)

| Fact | Number | Consequence |
|---|---|---|
| Context per request | **median 370k · p90 794k · max 967k** | 1M models auto-compact at ≈ 967k, so compaction practically never fires; context only grows |
| Input spent in requests > 500k context | **57 %** | session length is the cost, not any single payload |
| Composition of a > 300k context | **54 % tool output older than 100 calls**, 22 % 20–100 calls old, **5.5 % last 20 calls**, 15 % Edit/Write inputs, ≈ 3 % conversation | more than half of every expensive request is ballast re-read on every turn |
| Compressible tool output (json/log/search/html) | **17 %** of 31 M tool-output tokens vs 280 M fresh input | a compression proxy (Headroom) moves a few percent at best |
| Re-reads of an *unchanged* file | 13 % of reads, ≈ 13 % of read volume | small lever; measured, demoted |
| Earlier auto-compact, simulated on the real sessions | **W = 300k → ≈ 66–69 % less input** (≈ 9 compactions/day); W = 500k → 47 %; W = 200k → 75 % | upper bound (compaction loses detail → some re-reading), but the biggest lever by an order of magnitude |
| Machine | 24 GB RAM, swap 19.4 / 20 GB: Docker VM 8.1 GB, 11 agent sessions 4.6 GB (10 idle 2–9 days), 43 MCP processes | nothing told anyone; `brain:ps` now does |

Tools that produced these numbers and will judge the outcome: `brain:tokens`
(exact usage, deduplicated per request; context percentiles; tool output by kind)
and `brain:ps` (sessions, helpers, orphans, real footprint, idleness by last real
message — never by process age or file mtime).

### What Claude Code lets the brain control (docs, 2026-10-12)

- ✅ **When** compaction happens: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (settings `env`),
  `/autocompact`, `autoCompactWindow`.
- ✅ **What the summary keeps**: a *Compact Instructions* section in CLAUDE.md.
- ✅ **See it coming**: `PreCompact` hook (`trigger`, `custom_instructions`,
  `transcript_path`); it can observe or block, nothing else.
- ✅ **Re-inject after**: `SessionStart` with `source: compact` →
  `additionalContext`, **capped at 10,000 characters**.
- ✅ **Keep exploration out**: subagents return only their report.
- ✅ **Show the size**: the status line JSON is the only documented source of
  `context_window.used_percentage`.
- ❌ A hook cannot trigger `/compact` or `/clear`, cannot edit the summary, and no
  hook event carries the live context size. Older tool outputs are cleared by
  Claude Code itself; no setting tunes that.

So the design is: **threshold as the safety net, boundaries as the intelligence,
the warm layer as the memory** — not a hook that "manages" context, which does not
exist.

### The three-layer model

| Layer | Holds | Lives | Owner |
|---|---|---|---|
| **Hot** | the current step: files being edited, last ~20 tool results, the user's ask | the context window | Claude Code |
| **Warm** | the session's state: workstream + goal, decisions so far, files touched (with line ranges), open items, git state, what was tried and failed | ≤ 10k chars, re-injected after every compaction | **the brain** (deterministic extraction, no LLM) |
| **Cold** | everything else: old tool output, earlier sub-tasks, the "side facts" | the transcript on disk, already there — searched on demand, never copied into the index | **the brain** (`brain_recall`) |

The cold layer is *not* re-indexed tool output: transcripts contain company code
from read-only repos and may contain secrets; copying them into `.project-brain`
would be a leak. `brain_recall` searches the pre-compaction transcript in place and
returns bounded excerpts with their position, so a detail that was compacted away
is one call from coming back.

### Workstream K — context (the measured lever)

| Step | Mechanism | Host surface | Status |
|---|---|---|---|
| **K1 Threshold** | `setup` writes `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` into the project `settings.json` `env` (opt-in flag, recommended; user-level override respected). | settings env | **done** |
| **K3 Snapshot** | `brain-session-digest` on `PreCompact` grows from "scrape tagged lines" to a deterministic session record: workstream, decisions, files touched + line ranges, commands run, tests last seen green/red, uncommitted diffstat, open items, dead ends. Written to `.project-brain/sessions/`, indexed. Also runs on `Stop` so a crash loses nothing. | PreCompact / Stop | **done** |
| **K4 Rehydrate** | `SessionStart` matcher `compact` injects the warm layer (K3 record, budgeted in `footprint.mjs`, hard cap 9,500 chars) plus one line: "details: `brain_recall <query>`". Byte-stable ordering so the new cache prefix is reusable. | SessionStart(compact) | **done** |
| **K2 Compact Instructions** | A brain-managed block in CLAUDE.md (between markers, like the settings sync): keep decisions, file paths + line ranges, test status, open items, the user's phrasing of the goal; drop tool output, exploration dead ends already recorded, resolved errors. | CLAUDE.md | second slice |
| **K5 Boundary nudges** | After a commit, a merged PR, `brain:close`, or a workstream switch — and only when context > 150k — the `Stop`/`PostToolUse` hook prints one line: "good moment for `/compact` (context ≈ N)". Compacting at a boundary loses the least; the threshold stays the net. Context size comes from the transcript's last usage record (undocumented format, guarded: silent on parse failure). | Stop / PostToolUse(Bash git commit) | second slice |
| **K6 Recall** | `brain_recall(query, [session])` MCP tool + `brain:recall` CLI: keyword search over the current session's transcript (and the previous one after a resume), returns ≤ 2k chars per hit with tool name and call index. | MCP | second slice |
| **K7 Status line** | A `brain` status-line segment: context used %, time since last compaction, workstream. The only documented live source; `setup --statusline` opt-in. | statusline | third slice |
| **K8 Delegate exploration** | The ambient router (`brain-route`, UserPromptSubmit) tags research-shaped prompts ("where is…", "how does… work", "find all…") with a one-line suggestion to run them in a subagent. Measure acceptance before making it louder. | UserPromptSubmit | third slice |
| K9 Re-read guard | Demoted: 13 % of reads re-read an unchanged file. Revisit only if K1–K6 leave it as the top remaining item in `brain:tokens`. | PreToolUse(Read) | parked |

**First slice ships K1 + K3 + K4 together**, never K1 alone: a lower threshold
without a good warm layer is lossy compaction, which is exactly the fear that makes
people avoid compacting. Default stays off until the gate below passes on this
repo's own sessions.

### Workstream R — resources (the brain collects what it launches)

| Step | What | Status |
|---|---|---|
| **R1 Inventory + orphan reap** | `brain:ps`: classify, real footprint, idleness by last real message; `--reap-orphans --yes` kills only helpers whose agent parent is gone. Foreign sessions are suggest-only. | **done** |
| R2 Process groups | `runner-supervisor` spawns each runner in its own process group; `stop` takes the whole tree (agent + MCP + dev server + browser). No orphans from us, ever. | first slice |
| R3 Idle rules | `.project-brain/config.json`: brain runner idle > 1 h → stop; dev server of a closed workstream → stop; foreign session idle > 4 h → suggest; docker stack of a project without a session for > N h → suggest `stop`. | second slice |
| R4 Admission control | brief-gate sibling: no new agent while swap > 80 %, memory pressure warn, or `maxConcurrentAgents` reached — states the reason, names what to reap; override audited. | second slice |
| R5 Triggers | SessionStart line when pressure is high (time-budgeted in `footprint.mjs`); Control Room resource panel with per-row stop; optional launchd job for `reap --orphans`. | third slice |
| R6 MCP hygiene | `setup` flags `npx …@latest` MCP servers (2 processes + registry check per session) and heavy globals (playwright, chrome-devtools); proposes pinned binaries and per-project enablement. | third slice |

### Workstream H — Headroom and payload compaction (gated)

| Step | What | Status |
|---|---|---|
| H1 Headroom opt-in | Only if a repo's `brain:tokens` shows a material json/log share: list next to caveman in `settings.community-plugins.json`; verify it leaves the brain's injected digest and provenance lines intact. | gated on per-repo P0 |
| H2 Compact-by-default MCP | `brain_blast` / `brain_search` / `brain_risk` return a compact form + handle, `brain_expand(handle)` the rest. Cheap, deterministic, our own version of Headroom's CCR. | after K |

### Gate, metrics, kill criteria

Measured with `brain:tokens --days 14` before and after, on this repo and one
consumer repo:

- **Win:** context p50 < 200k and p90 < 350k; fresh+cached input per session-hour
  down ≥ 40 %; total cost per session-hour down (cache reads are 10 % price but
  the largest block).
- **Loss guards:** re-read volume in the 50 calls after a compaction (K3/K4
  quality); `brain:reflect` `dead_end`/`corrected` outcomes on session records; the
  user's own verdict after one week.
- **Kill:** if post-compaction re-reads eat > ⅓ of the saved input, or the user
  reports lost context twice in a week, the default stays off and K3/K4 get fixed
  before K1 is retried. The threshold is never raised to "fix" lossy summaries.

### Risks

- *Undocumented transcript format* (K3, K5, K6 read it): every reader is guarded —
  parse failure means silence, never a broken hook. The format is already a
  dependency of `brain-session-digest`.
- *10k-char cap on re-injected context*: the warm layer is budgeted and ordered by
  value (goal → decisions → files → open items → git); overflow goes to a file the
  record names, and `brain_recall` covers the rest.
- *Compaction cost*: ≈ 9 × 300k input per day for summaries — under 3 % of what is
  saved.
- *Cold cache after compaction*: one cache write of a small context; irrelevant
  next to the saved reads.
- *Host neutrality*: K1/K4/K7 are Claude Code surfaces; Cursor/Codex get K3 + K6
  (CLI) and the existing `brain:compact`. Stated in the docs tier table, as always.

### Decided against

- **A multi-agent IDE.** ADR 0028: Control Room, no editor. Editors are free and
  commoditized; an IDE trades host-neutrality (MCP + hooks under *any* agent) for
  years of LSP/diff/terminal work. The Control Room grows into a cockpit — start,
  watch, collect, review — not an editor.
- **An LLM-written summary layer of our own.** Claude Code already summarizes; the
  brain's value is the deterministic warm layer and recall around it.
- **Indexing tool output into the brain.** Privacy and size; the transcript is
  already the cold store.
- **A compression model / proxy of our own.** Measured at a few percent here.

Record as ADR 0035 ("context lives in three layers; the brain owns the warm one")
when the first slice ships.

### Also captured (from the r/vibecoding thread, not yet scheduled)

**Frozen paths** (`.project-brain/frozen.md` enforced by `brain:guard` + a
`Brain-Unfreeze:` trailer), **expectation-first** (`expect:` on a work item —
signature + one example I/O; one self-correction, then hand the diff to a human),
**routing-description lint** in `brain:skill-audit` (flag sibling descriptions that
match the same task).

## Explicitly NOT worth doing
- A cloud service / server — kills the local-first, zero-infra uniqueness.
- An LLM in the hot retrieval path — the extractive, no-LLM core is a feature; keep
  judgment at the edges (audit/review/insight scaffolds).
- A bigger general-purpose embedder as the headline — measured wash, against the grain.
- Auto-merge — the human-merge boundary stays.

## Related
- `decisions/0016-ecosystem-skill-axis-map.md` — the four-axis map.
- `decisions/0019-sensing-synthesis-learning-wave.md` — the proactive/synthesis/learning commands.
- `decisions/0020-real-execute-review-loop-closure.md` — the autonomous loop.
- `vision-constellation.md` — the federation direction + trust foundation.
