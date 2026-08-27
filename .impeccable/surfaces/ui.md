---
version: 1
slug: "ui"
primary_target: "ui"
related_targets: []
---

# Surface brief: ui (Control Room)

Scope: local Control Room web UI (`ui/`, served by scripts/brain-serve.mjs at 127.0.0.1). Visitor mode: **Operate**.

Audience & job: the solo agent-manager glancing at and operating the shared work-state (workstreams, leases, briefs/grills, audit, git-intel) while running parallel coding agents.

Chosen direction (decision round 2026-08-27, seed e103a5a8, assigned card locked, build path code):
**Andon-Board** — Toyota production-control grammar: work is a T-card in a rail, state is a lamp, stop is a cord-pull. Slotted card rails per repo, andon state colors (green running / amber attention / red blocked), stamped state chips.

Raises carried in from the beaten hand (each must be visible in the build):
1. State-as-light (Cyclorama): a state change washes the whole row, never just a badge.
2. One density control (Miura): global packet↔deployed toggle transforms all panels coherently.
3. Map=list (Doujin catalog): treemap and tables are the same URL-addressable space.
4. Read=edit (HyperCard): ADR/brief records edit in place, no admin mode.

Constraints: both themes first-class (system-follow); Restrained color floor — lamp colors are STATE ONLY, never decoration; provenance/freshness lines are visible UI; no score without action; empty state filled from git-intel; workhorse sans + tabular numerals (Operate permission), no banned display faces; motion 150–250ms state-only via Motion lib.

Memorable moment: a lease conflict pulls the red row lamp — the whole rail row re-lights and lifts the card.

Unresolved: agent start/stop controls await the daemon write API (security model); brief/grill approve flow after that; product name pending (UI uses neutral wordmark slot).
