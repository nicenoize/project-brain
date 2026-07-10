# Project Brain — Fleet Mode & Spec-Kit

> Part of the **project-brain** skill. Loaded on demand from the lean core `SKILL.md` — see its "Reference files" section for the full map.

Multi-repo fleet mode (cross-project edges) and GitHub spec-kit integration.

## Fleet mode

When `scripts/projects.mjs#discoverProjects(ROOT)` finds ≥ 2 sibling projects under one fleet root (or `BRAIN_FLEET_MODE=1` forces it), the brain switches to **fleet mode** automatically — same install path, same `brain:update-skill`, no flag needed for the common case.

A typical fleet:

```
fleet-root/
├── .project-brain/         (the fleet brain)
├── skills/project-brain →  (global skill, symlink)
├── backend/                (Node/TS API, own .git)
├── workers/                (Python / Go pods, own .git)
├── k8s-orchestration/      (Helm + kustomize, own .git)
├── frontend/               (Next.js, own .git)
└── shared-schemas/         (.proto / openapi.yml, own .git)
```

What changes:

- Every indexed record carries `project: <name>` (single-project mode keeps `''`).
- Three new record kinds: `repo-summary` (`chunk:-7`), `fleet-summary` (`chunk:-8`), `cross-project-edge` (`chunk:-9`).
- 12 pluggable edge detectors under `scripts/edges/` populate the cross-project graph: `k8s-image`, `http-client`, `grpc-client`, `proto-schema`, `openapi-schema`, `env-var`, `k8s-env-injection`, `pubsub` (Kafka/RabbitMQ/Redis/SQS/PubSub), `db-shared`, `package-dep`, `go-replace` (+ `image-registry` registrar). `k8s-env-injection` emits **directed** edges from an orchestrator that injects a workload env (Go `corev1.EnvVar{Name:"X"}` or Helm `env:`) → the project that reads it (`os.Getenv`, viper `mapstructure:"x"`, `env:`/`envconfig:` tags) — the operator→pod seam that import/schema detectors can't see.
- `active_state.md` gets a `project` column on both workstreams + leases tables (legacy 6-/4-column files keep parsing).

CLI surface:

```bash
npm run brain:projects                       # list discovered projects + edge counts
npm run brain:edges                          # list materialized cross-project edges
npm run brain:edges -- --detect              # force-rerun every detector
npm run brain:edges -- --detector k8s-image  # run one detector (debug)
npm run brain:edges -- --min-confidence high

# every existing `brain:*` command accepts --project NAME (comma-list for OR):
npm run brain:search -- "X" --project backend
npm run brain:pack   -- "X" --project workers --mode resume
npm run brain:ask    -- "X" --project frontend,backend
npm run brain:work     -- start --project backend --issue 123 --slug auth
npm run brain:lease    -- add lib/auth.ts --project backend --task issue-123
npm run brain:worktree -- spawn --project backend --count 3 --base develop
npm run brain:impact   -- ChargeCard --cross-project
```

Configuration:

```
BRAIN_FLEET_MODE=0|1                      force off / on
BRAIN_FLEET_PROJECTS=backend,workers      discovery whitelist
BRAIN_FLEET_EXCLUDE=tooling,scripts       discovery blacklist
BRAIN_FLEET_NESTED_DIRS=modules           descend one level into marker-less
                                          container dirs (e.g. a modules/ monorepo
                                          of many go.mod) so each child is a project;
                                          default off = depth-1 scan unchanged
BRAIN_FLEET_SERVICE_URLS=backend=https://backend.svc,...
                                          high-confidence http-client resolution
BRAIN_EDGE_TIMEOUT_MS=30000               per-detector budget
BRAIN_AUTO_RECOVER=1                      Lance schema migration on first fleet index
```

See `modules/fleet.md` for the full module overview and `decisions/0009`–`0011` for the rationale.

## Spec-Kit integration

When a repo uses [`github/spec-kit`](https://github.com/github/spec-kit), brain auto-detects its artifacts and indexes them alongside `.project-brain/` content. No flag needed — `.specify/` and `specs/<id>/` paths are picked up by the indexer, and the new record types (`constitution` / `spec` / `plan` / `tasks-list` / `spec-support`) flow into the existing retrieval surface.

New record kinds:

| `type` | Source | Aggregates into |
|---|---|---|
| `constitution` | `.specify/memory/constitution.md` | canonical-root boost (×1.6 baseline) |
| `spec` | `specs/<id>/spec.md` | `feature-summary` (chunk:-3) via `feature: <id>` |
| `plan` | `specs/<id>/plan.md` | same `feature-summary` |
| `tasks-list` | `specs/<id>/tasks.md` | same `feature-summary` |
| `spec-support` | other files in `specs/<id>/` | same `feature-summary` |

CLI (only fires when `specs/<id>/` exists):

```bash
npm run brain:speckit -- import  <id>            # spec.md → .project-brain/features/<id>.md (cross-linked, idempotent)
npm run brain:speckit -- tasks   <id> --write    # tasks.md → .project-brain/work-packages/spec-<id>-wpN.md per US group
npm run brain:speckit -- tasks   <id> --github   # also open GH issues via gh issue create
npm run brain:speckit -- analyze <id>            # ADR scaffolds from specs/<id>/analyze.md headings
```

Three Claude Code slash commands installed automatically by `setup-claude-settings.mjs` (skip via `PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS=1`):

- `/brain-speckit-specify $ARGS` — wraps `/speckit.specify` + `brain:speckit import` + `brain:sync`.
- `/brain-speckit-tasks <id>` — wraps `/speckit.tasks` + `brain:speckit tasks <id> --write`.
- `/brain-speckit-implement <id>` — picks the next pending work-package, opens a brain workstream (`brain:work start --task spec-<id>-wpN`), runs `/speckit.implement` scoped to that package, then `brain:work end`.

Configuration:

```
BRAIN_SPEC_BOOST=0.04                          additive boost on spec/plan/tasks-list/constitution records for architectural queries
PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS=1           skip /brain-speckit-* command install during brain:update-skill
```

See [`modules/spec-kit.md`](.project-brain/modules/spec-kit.md) for the full module overview and [`decisions/0012-spec-kit-integration.md`](.project-brain/decisions/0012-spec-kit-integration.md) for the rationale.
