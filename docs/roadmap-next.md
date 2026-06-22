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
