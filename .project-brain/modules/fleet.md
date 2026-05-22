---
title: Fleet mode
status: canonical
layer: architecture
module: indexing
feature: fleet
date: 2026-05-22
---

# Fleet mode

One project-brain spanning N sibling project directories under a fleet root. Auto-activates when ≥ 2 projects are discovered; single-project repos are byte-identical to pre-fleet behavior.

## Activation

`scripts/projects.mjs#discoverProjects(root)` walks one level deep and classifies subdirs by markers:

| Marker file | Kind |
|---|---|
| `package.json` | `node` |
| `go.mod` | `go` |
| `pyproject.toml` / `requirements.txt` / `setup.py` / `setup.cfg` | `python` |
| `Chart.yaml` | `helm` |
| `kustomization.yaml` | `kustomize` |
| `Dockerfile*` / `Containerfile` | `docker` |
| `*.proto` (any in dir) | `proto` |
| `main.tf` / `terraform.tf` | `terraform` |

`isFleetMode(projects)` → fleet on iff `projects.length >= 2`, unless `BRAIN_FLEET_MODE` overrides (`0`=off, `1`=on). `BRAIN_FLEET_PROJECTS=backend,workers` whitelists; `BRAIN_FLEET_EXCLUDE=tooling` blacklists.

## New record kinds

| chunk | type | builder |
|---|---|---|
| `-7` | `repo-summary` | `aggregate.buildRepoSummary` per project (Node/Go/Python/K8s/Docker extractors) |
| `-8` | `fleet-summary` | `aggregate.buildFleetSummary` — one per fleet brain |
| `-9` | `cross-project-edge` | `edges/materialize.candidateToRecord` from detector output |

All carry the project / edge schema fields (`project`, `edgeFrom`, `edgeTo`, `edgeKind`, `edgeConfidence`, `projectKinds`) added in F1.1.

## Edge detectors (scripts/edges/)

| Detector | Kind | Notes |
|---|---|---|
| `image-registry` | (registrar) | publishes `facts.imageRegistry` |
| `proto-schema` | `proto-schema` | also publishes `facts.grpcServices` |
| `openapi-schema` | `openapi-schema` | also publishes `facts.openapiServices` |
| `k8s-image` | `k8s-image` | consumes `imageRegistry` |
| `grpc-client` | `grpc-call` | consumes `grpcServices` |
| `http-client` | `http-call` | consumes `openapiServices` + `BRAIN_FLEET_SERVICE_URLS` |
| `env-var` | `env-shared` | publishes `facts.envKeysByProject` |
| `pubsub` | `pubsub` | Kafka / RabbitMQ / Redis Streams / SQS / Cloud Pub/Sub |
| `db-shared` | `db-shared` | consumes envKeysByProject + migration dir detection |
| `package-dep` | `package-dep` | parses package.json deps for sibling names |
| `go-replace` | `go-replace` | parses go.mod replace + require |

Each emits `{from, to, kind, evidence[], confidence}` with `high|medium|low`. `index.mjs` wraps each in `AbortSignal.timeout(BRAIN_EDGE_TIMEOUT_MS || 30_000)` and continues on individual failure. Per-detector cache at `.project-brain/.fleet-cache/<detector>.json` replays clean pairs when `dirtyProjects` is non-empty.

## CLI surface (fleet-mode-only)

```bash
npm run brain:edges                         # list materialized edges, grouped by (from→to)
npm run brain:edges -- --detect             # force re-run all detectors, ignore cache
npm run brain:edges -- --detector k8s-image # run one detector (debug)
npm run brain:edges -- --min-confidence high
npm run brain:edges -- --json

npm run brain:projects                      # list projects + kinds + edge counts (in/out)
npm run brain:projects -- --json
```

All other `brain:*` commands gain `--project NAME` (comma-list for OR semantics on retrieval):

```bash
npm run brain:search -- "X" --project backend
npm run brain:ask    -- "X" --project frontend,backend
npm run brain:pack   -- "X" --project workers --mode resume

npm run brain:work     -- start --project backend --issue 123 --slug auth …
npm run brain:lease    -- add lib/auth.ts --project backend --task issue-123
npm run brain:worktree -- spawn --project backend --count 3 --base develop
npm run brain:impact   -- ChargeCard --cross-project
```

## Configuration

```
BRAIN_FLEET_MODE=0|1                       force off / on
BRAIN_FLEET_PROJECTS=backend,workers       discovery whitelist
BRAIN_FLEET_EXCLUDE=tooling,scripts        discovery blacklist
BRAIN_FLEET_SERVICE_URLS=backend=https://backend.svc.local,workers=https://workers.svc.local
                                           hints for http-client confidence-high resolution
BRAIN_EDGE_TIMEOUT_MS=30000                per-detector budget
BRAIN_AUTO_RECOVER=1                       Lance schema auto-migration on first fleet index
```

## Files

- `scripts/projects.mjs` — discovery + `isFleetMode` + `findProjectForFile`.
- `scripts/brain-index.mjs` — fleet loop, `rebuildRepoSummaries`, `rebuildCrossProjectEdges`, `rebuildFleetSummary`.
- `scripts/aggregate.mjs` — `buildRepoSummary` + per-kind extractors, `buildFleetSummary`.
- `scripts/edges/*.mjs` — detector contract + 11 detectors + runner + cache + materialize.
- `scripts/brain-edges.mjs`, `scripts/brain-projects.mjs` — CLIs.
- `scripts/brain-work.mjs`, `scripts/brain-lease.mjs`, `scripts/brain-worktree.mjs` — `--project` flag, per-project git scope.
- `scripts/active-state.mjs` — `project` column on workstreams + leases tables.

## Decisions

- [[0009-fleet-mode-discovery]] — discovery + per-record tagging.
- [[0010-cross-project-edge-detection]] — detector subsystem.
- [[0011-fleet-active-state-coordination]] — active_state column + per-project git scope.
