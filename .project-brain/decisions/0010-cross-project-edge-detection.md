---
title: Cross-project edge detection via pluggable detectors
status: canonical
layer: decision
module: indexing
feature: fleet
date: 2026-05-22
---

# Cross-project edge detection via pluggable detectors

## Context

Tagging records with `project: <name>` ([[0009-fleet-mode-discovery]]) makes retrieval project-aware but doesn't answer cross-project questions. Without explicit edges, a query like *"what consumes the `order.created` event?"* falls back on dense recall across loose text — fragile, brittle, low precision.

We needed a way to materialize the runtime relationships between projects (HTTP/gRPC clients hitting services, k8s manifests referencing Dockerfile-built images, shared env vars, pub/sub topics, schema imports, internal package deps) so retrieval can return them as first-class records.

## Decision

A pluggable detector subsystem under `scripts/edges/`. Each detector is an async generator that streams `EdgeCandidate` objects:

```js
{
  from: 'backend', to: 'workers',
  kind: 'pubsub' | 'k8s-image' | 'http-call' | 'grpc-call'
      | 'proto-schema' | 'openapi-schema' | 'env-shared'
      | 'db-shared' | 'package-dep' | 'go-replace',
  evidence: ['fleet-relative-path:line', ...],
  confidence: 'high' | 'medium' | 'low',
  meta: { /* per-detector free-form */ }
}
```

`scripts/edges/index.mjs` iterates `DETECTORS` in dependency order, passing a shared `context.facts` map (so `image-registry.mjs` can publish an `imageRegistry`, and later detectors consume it). Each detector wrapped in `AbortSignal.timeout(BRAIN_EDGE_TIMEOUT_MS || 30_000)` — one hanging detector cannot block the rest.

`materialize.mjs` turns candidates into `chunk:-9` `cross-project-edge` records:

```js
id: sha256(`cross-project-edge:${from}|${to}|${kind}|${sortedEvidence.join(',')}`)
embeddingText: `Cross-project edge from ${from} to ${to} via ${kind}. Evidence: ${ev.slice(0,5).join('; ')}. Confidence ${conf}.`
```

Deterministic ids → incremental delete-then-upsert is idempotent. `cache.mjs` provides per-detector JSON caches under `.project-brain/.fleet-cache/`, replaying clean-pair candidates when `dirtyProjects` is non-empty.

Detectors that shipped in F3.1–F3.5:

| Detector | Kind(s) | Confidence drivers |
|---|---|---|
| image-registry | (registrar — no emit) | publishes imageRegistry facts |
| proto-schema | proto-schema | high (parsed import resolution) |
| openapi-schema | openapi-schema | high (servers[].url published) |
| k8s-image | k8s-image | high (resolved image ref) / medium (Helm template via values.yaml) |
| grpc-client | grpc-call | high (service name in grpcServices) |
| http-client | http-call | high (openapi or env hint) / medium (sibling name in host) |
| env-var | env-shared | high (*_URL/*_DSN/KAFKA_*/_TOPIC) / medium (default) / low (NODE_ENV/PORT/etc.) |
| pubsub | pubsub | medium (regex-level certainty across Kafka/Rabbit/Redis/SQS/PubSub SDKs) |
| db-shared | db-shared | high (shared DB env + same migration shape) / medium (shared env only) |
| package-dep | package-dep | high (exact name match) |
| go-replace | go-replace | high (replace =>) / medium (require) |

## Consequences

- **Queries unlocked**: "what publishes `X` event?", "what services does the backend call?", "what breaks if I rename this gRPC service?", "which projects share the DB?". Each answer is one retrieval hit on a single `cross-project-edge` record.
- **Pluggable**: adding a new detector is one file under `scripts/edges/` + an entry in `DETECTORS[]`. The detector contract is JSDoc-only (`types.mjs`).
- **Single-project mode**: zero edges emitted (the runner returns immediately when projects.length < 2 via no edges with `from !== to`).
- **Confidence tagging** lets `brain:edges --min-confidence high` filter out heuristic noise; default shows all.
- **Per-detector timeouts** prevent one slow language detector from blocking the index pipeline.
- **Cache** keeps incremental indexing fast on large fleets — clean (from, to) pairs replay from disk.

## Related

- [[0009-fleet-mode-discovery]] — the `project` tag this builds on.
- `scripts/edges/types.mjs` — detector contract.
- `scripts/brain-edges.mjs` — CLI for inspecting + force-running detectors.
- `scripts/brain-impact.mjs` — follows `cross-project-edge` records on `--cross-project`.
