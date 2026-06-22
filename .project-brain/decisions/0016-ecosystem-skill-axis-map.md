---
title: Ecosystem-skill adoption map (recall / structure / trust / act)
status: canonical
layer: architecture
module: brain
feature: smarter
date: 2026-06-21
---

# Ecosystem-skill adoption map (recall / structure / trust / act)

## Context

Four community skills were evaluated for improving the brain and its conventions:
`Agents365-ai/drawio-skill`, `DietrichGebert/ponytail`, `nvidia/skillspector`,
`shadcn/improve`. The "brain smarter" framing already runs on three axes — **recall**
(retrieval quality), **structure** (how knowledge and code are organized), and
**trust** (verification / guardrails). A recurring question conflated ponytail with
caveman; they are orthogonal — caveman compresses *communication* (terse prose),
ponytail minimizes *generated code*. Installing all four wholesale would duplicate
capabilities the brain already has and add heavy dependencies.

## Decision

Map each skill to an axis and adopt only where the tool is uniquely strong:

- **recall — drawio-skill: do NOT adopt.** The brain already computes the graph
  (`buildGraph` in brain-graph.mjs, ts-graph, the edges/ detectors). A future
  `brain:diagram` emits Mermaid (default, zero deps) / optional `.drawio` from the
  index; drawio's desktop CLI is at most an optional rasterizer, never imported.
- **structure — ponytail: adopt as a convention, not a dependency.** It's a Claude
  Code plugin the developer installs, orthogonal to caveman. Two of its six
  decision-ladder rungs ("already-installed dep?", "duplicate helper?") are
  mechanically checkable via the existing `.project-brain/conventions.json` +
  `brain:guard`; the rest stay agent policy.
- **trust — skillspector: integrate as an OPTIONAL external scanner.** Shell out to
  its CLI/Docker, never vendor Python (precedent: `brain-prune.mjs` shelling to
  caveman; the security gates in brain-guard.mjs). It gates third-party-skill
  adoption and is the first concrete primitive of the Constellation
  verify-before-trust direction.
- **act (NEW axis) — shadcn/improve: build brain-native.** The brain is *extractive*
  (recall); improve is *executive* (audit → plan → execute → verify). Build a native
  front-end (see [[0017-build-native-improve-act-axis]]) that reuses the brain's
  context + coordination + statistical-eval back-end.

Build order by leverage: **act first** (this change), then diagram, trust, conventions.

## Consequences

### Positive
- A coherent four-axis roadmap; no wholesale adoption of overlapping tooling.
- The act axis turns the brain from "knows things" into "does things" while reusing
  existing primitives (zero new npm deps).
- Each external tool is used where it is genuinely additive, not where it duplicates
  the brain.

### Negative / Tradeoffs
- skillspector's value depends on the user installing an external Python/Docker tool.
- The Constellation federation transport itself is still future work (`docs/vision-constellation.md`); only its first trust primitive (`brain:skill-audit`) is built.

## Status (2026-06-22)

All four axes shipped on `feature/eval-failure-diagnosis`: **act** ([[0017-build-native-improve-act-axis]], `brain:audit`/`brain:improve`), **recall** (`brain:diagram`), **trust** (`brain:skill-audit`), **structure** (ponytail/caveman conventions in `references/conventions.md` + `conventions.json`). Plus an autonomous loop ([[0018-autonomous-act-axis-loop]]). All additive, default-off where they change behavior, zero new npm deps.

## Alternatives Considered
- Adopt all four skills directly: rejected — duplicates the graph, the coordinator,
  and adds a Python toolchain against the Node-only / 2-dependency ethos.

## Related
- [[0017-build-native-improve-act-axis]]
- [[0012-spec-kit-integration]]
- [[0008-aggregate-vector-records]]
