# Control Room — the complete guide

The Control Room is the local surface over the brain. It answers the questions
an agent-manager actually asks, and it lets you act on the answers. Nothing in
it calls an LLM: every number is computed from your git history and your
`.project-brain/` records, or it is refused.

Three ways in, one engine behind them:

| Surface | For | Start it |
|---|---|---|
| **Web board** | you, in a browser | `project-brain serve --open` |
| **MCP tools** | any agent host that pulls | `.mcp.json` (already wired) |
| **Ambient hook** | the agent you are running, at edit time | on by default |

---

## 1. Start it

```bash
project-brain serve            # prints a URL containing a one-time token
project-brain serve --open     # …and opens the browser
project-brain serve --port 4200
```

The daemon binds **127.0.0.1 only**, mints a per-session bearer token, validates
`Origin`/`Host` (DNS-rebinding defense) and sends no CORS headers. The token
rides in the URL fragment, so it never reaches a server log; the UI moves it
into `sessionStorage` and strips it from history. Treat the printed URL like a
password.

There is no endpoint that accepts a command to run. The one thing the daemon can
execute — an agent runner — is configured locally (see §4) and referenced by
task id, never by a string from a request.

### First run in a repo that has no brain yet

The board still works: git-intel fills it from your commit history on day one.
The panels that need authored records say what to write and give you the
command. Nothing is fabricated to fill space.

---

## 2. The board: seven questions

Each panel is one question, its answer, the evidence behind it, and something
you can do next.

### Which repo needs attention?
Only when a fleet exists (≥2 sibling projects under one fleet root — see
`docs/solo-multi-repo-setup.md`). Ranks every project by an **attention score**
whose every point is spent by a named reason carrying its number:

```
100  backend-api    LEASE CONFLICT   1 active lease held by a different actor (codex-b)
                    DIRTY STALE      1 file staged and 1 file unstaged, 9 days since the last commit
                    ABANDONED WS     1 open workstream with no commit for 9 days
  0  frontend-web   quiet — nothing to do here
```

A quiet repo scores 0 and says so. The weights are *reviewable defaults*, not a
calibrated model, and the panel says that out loud — unlike the risk scores
below, which carry a real receipt.

### What should happen next?
The `brain:route` rule engine over sensed signals (dirty tree, index staleness,
open findings, lease conflicts). Up to five ranked commands, each with its
reason and a boundary chip: **safe to run** (read-only/idempotent) or **your
call** (mutating). Every command is copyable.

### Is this change dangerous?
A deterministic 0–10 score over your current working-tree change set, with the
factors that produced it:

- **hotspot-overlap** — churn percentile of the touched files
- **missing-co-change** — files that usually travel with these but aren't in the set
- **blast-radius** — downstream dependents (when an import graph is available)
- **lease-conflicts** — touched files another actor holds

The receipt underneath is the honest part: *"top risk quartile carried 69%
defect rate vs 9% in the lowest — AUC 0.74 over 139 commits of this repo's own
history."* That is **in-repo self-calibration, not a cross-repo benchmark**, and
it is re-measured per repo. Two buttons turn the answer into agent work:
**copy grill prompt** (the risk factors as an adversarial pre-implementation
challenge) and **copy agent context** (a token-budgeted context pack).

### What breaks if I change this?
Likely-affected files, ranked, each tagged by the kind of evidence:

- `measured` — a static import edge. A fact.
- `inferred` — files that historically change together. A pattern.

Repos without TypeScript sources keep the inferred half; that is the normal
case, not a failure, and the panel says so rather than showing an error. The
most valuable answer this panel gives is the green one: **"Nothing forgotten —
all 5 files that usually travel with this change are already in it."**

### What's running right now?
The work board: one rail per workstream, an andon lamp for its state, a T-card
with owner and branch. Running agents carry **log** and **stop**; idle
workstreams carry **start agent** (§4). A lease conflict pulls the row red and
outranks every other state — in an andon board, red beats green.

### Why is it built this way?
The module map: your authored `.project-brain/` records, navigable, each with
its ADR count and one measured signal — **has the code moved on since the doc
was written?** (`CODE MOVED ON` in amber). Click a module to read it in place.
Code areas with no record at all are named as **orphans**, with the command to
fix them.

This is deliberately **not** a documentation generator. Generating docs from
code would contradict the whole point: a decision that was never written down
cannot be mined back out of the code. We map what humans and agents wrote and
say plainly where it is missing or stale.

Click any file in the danger ranking to open the **why drawer**: its module,
governing ADRs (the `## Decision` section — that *is* the why), recent history,
and a copy-for-your-agent button.

### Which files are actually dangerous?
A per-file danger score, our own calibrated answer to code-health scoring:

| factor | what it measures |
|---|---|
| churn-percentile | how hot the file is, with recency decay |
| co-change-scatter | how many distinct partners it drags along |
| bus-factor | how few people know it |
| fix-density | how often its commits are fixes |

Files with fewer than three commits are marked `*` **lowConfidence** instead of
being given false precision. The receipt: *"AUC 0.71 over 247 files of this
repo's own fix history."* Below the ranking sits the hotspot treemap — area is
churn, tone is recency, leased paths carry a red outline, and clicking a leased
cell scrolls to its lease row (the map and the table are the same space).

### Who holds what — until when?
The lease board, and it is a **control**, not a readout:

- **claim** — inline form (path/glob, task, actor). The target is validated
  against the canonical grammar; `src/{a,b}/**` is *rejected with the reason*
  rather than silently mis-matched. A claim overlapping another actor's live
  lease returns a **conflict gate** and writes nothing until you acknowledge —
  and the acknowledgment lands in the audit.
- **release** — per row.

### What happened — and who acknowledged it?
The append-only audit feed from `.project-brain/events.jsonl`: every runner
start/stop, every lease claim/release, and crucially whether a gate was
overridden (`acknowledgedBriefGate: true`, `conflictCount: 1`). Nothing is
deleted here; the trail *is* the product.

---

## 3. Density and themes

The **packet / deployed** switch is one control that transforms every panel at
once — use packet when the board lives on a second monitor. Light and dark are
both first-class and follow your system setting.

---

## 4. Starting agents from the board

Configure the runner command once — it is **never** read from a request:

```bash
# either
export BRAIN_RUNNER_CMD="claude --dangerously-skip-permissions -p 'continue the work package'"
# or .project-brain/config.json
{ "runnerCmd": "claude -p 'continue the work package'" }
```

Then **start agent** on a work card. If any file in that workstream's scope is
leased by a different actor, you get the **brief gate**:

> Read before starting — these leases are held by someone else:
> `src/auth/**` — codex-b until 14:00
> [ start anyway — recorded in audit ] [ cancel ]

Nothing spawns until you acknowledge, and the acknowledgment is written to the
audit with the advisory count. That moment — being stopped *before* the edit,
with the reason, and having your override recorded — is the difference between
a runner and a control room.

Running agents stream a bounded log tail into the card. **stop** sends SIGTERM,
then SIGKILL after a grace period, and writes `runner.stopped`.

---

## 5. MCP: the agent pulls

Already wired in `.mcp.json` (relative path, so it works for anyone who clones
the repo). Approve it once when Claude Code asks. To wire it elsewhere:

```bash
node scripts/brain-mcp.mjs --print-config
```

Eight task-shaped tools:

| tool | answers |
|---|---|
| `brain_status` | repo overview: workstreams, leases, dirty tree, next action |
| `brain_risk` | change risk + factors + calibration receipt |
| `brain_blast` | likely-affected files, per-edge measured/inferred |
| `brain_why` | module, governing decisions, recent history for one file |
| `brain_danger` | per-file danger ranking with receipt |
| `brain_leases` | who holds what, TTL, conflicts against an actor |
| `brain_search` | indexed search (degrades to lexical with a warning) |
| `brain_next` | ranked next actions with auto/human boundary |

Every result carries a **provenance line** and a staleness warning when the
state is old, so the agent knows how far to trust it. Results are capped
(381–1570 bytes measured) because they land in someone's context window.

---

## 6. Ambient: the brain pushes

The pull socket above only works when the agent thinks to ask. The hook works
whether it asks or not: before any `Edit`/`Write`/`MultiEdit`, the agent
receives

```
danger: scripts/store.mjs 8.3/10 — churn rank #9 of 300 (percentile 0.97)
governing: 0007-incremental-summary-rebuild … | 0008-aggregate-vector-records …
co-change: scripts/brain-index.mjs 53%, scripts/common.mjs 53%
LEASE: src/auth/** held by codex-b until 14:00
```

Rules that make this acceptable rather than annoying (ADR 0029):

- **Budgeted and measured**: 700 bytes ≈ 175 tokens, enforced by a CI test and
  reported by `project-brain status`. Worst measured case: 605 B.
- **Cannot block**: it emits context only, never a decision. Blocking stays with
  convention violations.
- **Leases are never truncated.** Under budget pressure the next-action line
  goes first, the lease line never — an unseen lease is the one failure that
  costs real work.
- **Fails open**: no stdin, no git, no brain → exit 0, emit nothing.
- Opt out: `BRAIN_ANSWER_HOOK=0`.

---

## 7. The same answers on the command line

```bash
project-brain x intel health          # per-file danger ranking + receipt
project-brain x intel health-calibrate
project-brain x intel risk --files a,b --score
project-brain x intel hotspots | co-change | ownership
project-brain x intel calibrate       # change-risk receipt
project-brain x answer --files a,b    # exactly what the hook injects
project-brain x graph-scan --cycles --orphans
project-brain brief                   # advisories for your current change set
project-brain grill                   # adversarial pre-implementation interview
```

---

## 8. What it does not do

Stated plainly, because a tool that hides its limits cannot be trusted with the
things it does do:

- **No LLM anywhere in this path.** No summaries, no generated prose, no chat.
  The AI copilot is a separate, opt-in layer (not shipped yet).
- **No cross-repo benchmark.** Every receipt is self-calibration against *your*
  repo's history. It re-measures as history accrues, and it can be thin in a
  young repo — the verdict line says when.
- **No structural code analysis yet** (complexity, clones, dataflow). The danger
  score is history- and graph-based. That is a real gap versus dedicated
  code-health tools.
- **No hosted anything.** Everything here is local; the cloud, when it comes,
  will sync coordination state only — never your code or your index (ADR 0028).
- **The brief gate is advisory where hooks don't reach.** A lease blocks an edit
  only in hosts with a PreToolUse hook; elsewhere it warns, and the audit
  records what happened. We say which tier applies rather than promising
  universal enforcement.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No session token` | Open the URL the daemon printed, not a bare localhost URL |
| `401` on every call | Token expired with the daemon; restart and use the new URL |
| Port busy | The daemon walks to the next free port and says so — check the log line |
| Empty intel panels | Not a git repo, or shallow clone. `git log` must have history |
| `no runner configured` | Set `BRAIN_RUNNER_CMD` or `runnerCmd` in `.project-brain/config.json` |
| Blast shows only inferred edges | Normal outside TypeScript projects — history edges still hold |
| Board looks stale | The freshness line in the header tells you the state age; SSE reconnects on file change |

Related: [`docs/strategy-agent-ops.md`](strategy-agent-ops.md) (why this exists),
[`docs/design-direction.md`](design-direction.md) (how it is designed),
[`DESIGN.md`](../DESIGN.md) (the visual system),
[`.project-brain/decisions/0028`](../.project-brain/decisions/0028-commercial-agent-ops-direction.md)
and [`0029`](../.project-brain/decisions/0029-ambient-answer-hook.md).
