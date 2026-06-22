---
title: Build-native brain:audit/brain:improve (the act axis)
status: canonical
layer: decision
module: improve
feature: act-axis
date: 2026-06-21
---

# Build-native brain:audit/brain:improve (the act axis)

## Context

shadcn/improve audits a repo across 9 categories, writes self-contained Markdown
plans a cheaper model can execute, dispatches executors in worktrees, and verifies —
"capable model plans, cheap model executes." The brain already owns that execution
back-end: `brain:worktree`, `brain:orchestrate`, `brain:ticket` (`buildPlan`),
`brain:pack --for-agent` (`packPrompt`), `brain:impact` (`buildImpact`),
`brain:eval` / `brain:eval:compare`, and `active_state.md`. Adopting improve wholesale
would duplicate all of it. Its only non-duplicative assets are the **9-category audit
taxonomy** and the **self-contained-plan quality bar**. `brain-speckit.mjs` shows the
adopt+bridge path is nearly as much code as building native *and* creates a second
source of truth (a top-level `plans/` that never indexes or drift-checks).

## Decision

Build brain-native and reuse everything behind it.

- **Front-end.** `brain:audit` is a scaffolder (like `brain:adr`, LLM-driven):
  `run` prints the taxonomy + the brain commands to gather evidence; `add` writes a
  finding. `brain:improve` does `plan` (enrich + decompose), `reconcile` (backlog
  lifecycle), `list`; `execute`/`review` are Phase-2 guidance that route through the
  existing coordinator/verifier rather than a new dispatcher.
- **Two indexed record types** under `.project-brain/`: `finding`
  (`findings/<slug>.md`; `status: open|planned|wontfix|resolved`, `impact`, `category`,
  cited `sources`) and `improve-plan` (`plans/<slug>.md`). Named **`improve-plan`, not
  `plan`** — `inferType` already maps spec-kit `plan.md` → `'plan'`, and
  `retrieval.mjs` gives spec-kit `'plan'` an architectural boost, so a second `'plan'`
  would collide. Indexing is a 2-line `infer.mjs` edit; the store schema is untouched
  (`normalizeRecord` already carries `type/module/references`). `matchesFilter` makes
  `brain:search --type finding|improve-plan` work with no code.
- **Enrichment from the index** (`brain:improve plan --enrich`): blast-radius via
  `buildImpact` (callers/callees/tests/governing decisions/cross-project consumers),
  self-contained context via `packPrompt(mode:'for-agent')` (governing ADRs + module
  summaries + working agreement), decomposition via `buildPlan`. This is what makes a
  brain plan richer than improve's re-derived approximation.
- **Backlog lifecycle.** `reconcile` reuses `evaluateExplainers` + `hashSource`
  verbatim. A finding whose cited sources are **all gone** is auto-resolved; merely
  **changed** sources surface as `stale` for re-review (never auto-closed — avoids
  false-closing on unrelated churn). A `wontfix` finding stays indexed = the
  "what we decided NOT to do" record.
- **Enabling changes.** `brain-impact.mjs` gained an `isMain` guard so `buildImpact`
  is importable without side effects (it had none — a latent bug); `hashSource` is now
  exported from `brain-explain.mjs`; shared record (de)serialization lives in
  `findings.mjs` (precedent: `infer.mjs`). No new npm dependency.
- **Do NOT build:** a new worktree spawner, dispatcher/queue, ticket splitter, context
  packer, impact analyzer, staleness mechanism, or eval harness — all reused. No
  top-level `plans/` dir; no importing improve's Markdown format.

## Consequences

### Positive
- The act axis ships with zero new npm deps; findings/plans are retrievable, and the
  backlog (including `wontfix`) is queryable via `brain:search`.
- Plans carry the real edit surface, the real tests to run, and the governing ADRs —
  strictly more than a re-derived spec.

### Negative / Tradeoffs
- `execute`/`review` wiring is Phase 2 (guidance only now).
- The `--enrich` path loads the embedder and opens the store (heavy); the non-enrich
  path stays offline.
- `reconcile`'s auto-resolve is a conservative heuristic (all-sources-missing), not a
  substitute for human triage.
- Any future retrieval boost for findings/plans must be eval-gated
  (`brain:eval:compare --hard-only`) per the repo rule.

## Alternatives Considered
- **Adopt + bridge shadcn/improve** (like spec-kit): rejected — second source of
  truth, brittle Markdown parsing, inherits a duplicate dispatcher.
- **Single `plan` record type / reuse spec-kit `'plan'`**: rejected — type collision
  plus an unwanted architectural retrieval boost.

## Related
- [[0016-ecosystem-skill-axis-map]]
- [[0012-spec-kit-integration]]
- [[0008-aggregate-vector-records]]
- [[0015-cross-encoder-rerank]]
