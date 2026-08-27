# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite (confirmed 2026-08-27): static bundle in `ui/`, served locally by
`scripts/brain-serve.mjs` (127.0.0.1 daemon) and later re-used unchanged against
the cloud API. Motion (motion.dev) as the animation library; shadcn/ui
primitives allowed as behavior/a11y skeleton only, fully re-skinned in the
product's own tokens (see docs/design-direction.md).

## Users

Primary: the solo "agent manager" — a professional developer running 3+
parallel coding-agent sessions (Claude Code, worktrees) on one or more repos.
Uses the Control Room on a second monitor AND as an active window on a laptop
in equal measure (confirmed): the design must fully work in both light and
dark, following the system theme.

Secondary (later, paid): 2–10-person AI-native teams where each developer runs
1–3 agents; team leads who need the audit trail.

## Product Purpose

Project Brain (product name pending — provisional CLI name `project-brain`) is
the shared work-state layer for humans and parallel coding agents: who — human
or agent — holds which files (leases with TTL), under which decision (ADRs),
with which brief/grill, and what happened afterwards (append-only audit).
The Control Room is its local web surface: fleet view, in-flight work packages,
live lease board, brief/grill approvals, audit feed, agent start/stop.
Success = fewer agent collisions and duplicate work, faster session context,
every change traceable to a decision.

## Positioning

"CI knows whether your code builds. We know who is working on what, and why."
Deterministic, zero-LLM core; the map of the WORK, not the map of the code
(repowise et al.). Enforcement is honestly three-tiered: hard-block where hooks
exist, advisory elsewhere, post-hoc audit always.

## Operating Context

Terminal-centric developers; the Control Room sits beside terminals/editors,
is glanced at continuously during long sessions and actively operated in
bursts (approve a brief, start a work package, resolve a lease conflict).
Data shown is real and locally computed: git-intel (hotspots, co-change,
ownership), lease table from `active_state.md`, events from `events.jsonl`.
The product is a meta-tool used across arbitrary customer projects — its own
identity must sit calmly above any kind of codebase rather than imposing a
theme tied to one kind of software (user: what feels "wrong" depends on the
project being worked on — recorded as a neutrality constraint, not a fixed
anti-aesthetic).

## Capabilities and Constraints

- Read-only JSON API + SSE already shipped (`brain-serve.mjs`); agent
  start/stop lands via `runner-supervisor.mjs` (v1: Claude Code runners,
  macOS/Linux).
- Every number in the UI carries provenance ("basis: measured · source:
  git-log · window: N commits") or a concrete next action — no bare scores.
- Empty state must be filled from git-intel on day one (no "nothing here").
- Session token in URL hash; API is localhost-only — no cloud data in v1.
- Undecided: final product name and brand; landing page comes later as its own
  Persuade surface.

## Evidence on Hand

Real, demonstrable data in any git repo: hotspot/co-change/ownership tables,
risk factors with evidence strings, lease board, audit events. Self-calibration
result (AUC 0.74 on own history) exists but is repo-specific — never present it
as a cross-repo benchmark. No customers, testimonials, or pricing claims may be
invented.

## Product Principles

1. Earned familiarity: the tool disappears into the task; brand lives in
   precise details, never decoration (Operate surface).
2. Prove, don't claim: real repo data is the design material.
3. Honest numbers: provenance stamps and freshness metadata are visible UI
   elements, part of the trust identity.
4. No score without an action.
5. Deterministic core; nothing in the UI depends on an LLM.

## Accessibility & Inclusion

Both themes (light/dark via system preference) are first-class. Contrast
checked with APCA, not only WCAG ratios (docs/design-direction.md). Full
keyboard operability for the approval/start flows.
