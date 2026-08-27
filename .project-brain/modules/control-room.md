---
title: Control Room module
status: canonical
layer: architecture
module: control-room
date: 2026-08-27
globs: ui/**, scripts/brain-serve.mjs, scripts/runner-supervisor.mjs
---

# Control Room module

The local web surface over the brain: a read-mostly daemon plus a React UI that
answers the questions an agent-manager actually asks, instead of listing raw
state. Written because the CLI could already compute the answers but nobody
could see them. Lives in `scripts/brain-serve.mjs` (daemon),
`scripts/runner-supervisor.mjs` (process supervision) and `ui/` (React+Vite).

## Shape

`project-brain serve` binds **127.0.0.1 only**, mints a per-session bearer token
printed once in the URL fragment, validates `Origin`/`Host` (DNS-rebinding
defense), sends no CORS headers, and serves `ui/dist` when built. The UI reads
the token from `location.hash` into `sessionStorage` and strips it from history.

## Answer endpoints (the product surface)

Every panel in the UI is one question with a receipt and an action:

| Question | Endpoint | Receipt |
|---|---|---|
| What should happen next? | `/api/next` | sensed signals through the brain:route rule engine |
| Is this change dangerous? | `/api/risk` | self-calibration (AUC over own fix history) |
| What breaks if I change this? | `/api/blast` | per-edge `measured` (imports) vs `inferred` (co-change) |
| Which files are actually dangerous? | `/api/intel/health` | `calibrateFileHealth` receipt |
| Why is it built this way? | `/api/map`, `/api/doc`, `/api/why` | measured doc-vs-code drift |
| Who holds what / what happened? | `/api/state`, `/api/events` | authored state, append-only audit |

Supporting: `/api/changed`, `/api/brief`, `/api/intel/*`, `/api/records`,
`/api/meta`, `/api/stream` (SSE), `/api/runners*`.

## Write surface (the governance moment)

`POST /api/runners/start` is the only meaningful write. The runner command is
resolved **only** from `BRAIN_RUNNER_CMD` or `.project-brain/config.json` —
never from a request body. Starting against files another actor holds returns
`409 {briefGate:true, advisories}` and spawns nothing; `acknowledged:true`
proceeds and appends `runner.started` with `acknowledgedBriefGate` to
`events.jsonl`. The audit trail is the product, not a log.

## Rules that hold here

- No LLM anywhere in this path; every number is computed or refused.
- Every score carries its factors and a concrete next command (decisions/0028).
- Empty states teach and are filled from git-intel on day one.
- Provenance is visible UI: `basis: measured` vs `inferred`, freshness on every
  response.
- Costly computations cache per HEAD (commits, calibration, blast, ts-graph).

## Decisions

See `decisions/0028-commercial-agent-ops-direction.md` for why this exists and
why the cloud will only ever sync coordination state.
