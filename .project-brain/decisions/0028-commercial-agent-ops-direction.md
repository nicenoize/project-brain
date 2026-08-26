---
title: Commercial Agent-Ops direction — cloud for coordination state only, Control Room over editor
status: canonical
layer: decision
module: strategy
feature: commercialization
date: 2026-08-27
---

# 0028 — Commercial Agent-Ops direction

## Context

`docs/roadmap-next.md` explicitly ruled out a cloud service ("kills the
local-first, zero-infra uniqueness"). Meanwhile the competitive analysis
(repowise: AGPL + hosted SaaS, deterministic zero-LLM core, benchmark-as-moat)
and the 2026 runner-tool landscape (Superset, Conductor, Claude Squad — all
free or VC-subsidized) showed:

- The "map of the code" market (retrieval/index, tree-sitter, 18 languages)
  is taken and not winnable for this team.
- The "map of the work" — shared work-state between humans and parallel
  coding agents (leases, briefs, grills, handoffs, audit trail) — is owned
  by nobody, and the pain grows with agent adoption.
- The runner-UI market is being commoditized to $0; governance is not.

Full plan: `docs/strategy-agent-ops.md`.

## Decision

1. **Commercialize as an Agent-Ops product** (AGPL-3.0 + founder-owned
   dual licensing + hosted tiers). Free local tier stays fully functional
   offline, forever.
2. **Deliberate, narrow reversal of the no-cloud stance**: the cloud syncs
   **coordination state only** (leases, workstreams, events) — never code,
   never the index. `active_state.md` becomes a materialized view in remote
   mode; the local mode stays byte-identical.
3. **Product face = Agent Control Room**: a localhost web UI (`serve`)
   that observes *and* starts agents (via the existing orchestrate
   machinery) — explicitly NOT an editor/terminal à la Superset/Cursor.
4. **Own code-intelligence layer** (git-intel: hotspots, co-change,
   ownership; graph/blast-radius; deterministic change-risk score) built
   independently — no third-party AGPL code, ever (copyright purity is a
   precondition for dual licensing).
5. **Honest enforcement model**, communicated everywhere: hard-block only
   where hooks exist (Claude Code/Cursor), advisory elsewhere, post-hoc
   audit always.

## Consequences

- `roadmap-next.md`'s "explicitly NOT worth doing: cloud service" is
  superseded in this narrow scope; every other stance there
  (no LLM in hot path, no auto-merge, default-off) stays canonical.
- New seams to build: `state-backend.mjs` (local/remote driver),
  `lease-overlap.mjs` (shared glob-overlap semantics), `index-provider.mjs`
  (embedding index becomes optional), `git-intel.mjs`, `brain-serve.mjs` + `ui/`.
- Third-party plugin auto-enable in `settings.recommended.json` must be
  removed (supply-chain liability for a commercial installer) — opt-in via
  a separate community file gated by `brain:skill-audit`.
- Session base cost (~24k tok measured) becomes a CI-enforced budget (≤4k).
