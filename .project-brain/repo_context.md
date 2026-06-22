# Repo Context

## What this repo is

The global Project Brain skill package. App repos consume it via `skills/project-brain/` (symlink, submodule, or vendored checkout). It owns the shared scripts, templates, GitFlow rules, code conventions, and team-memory policy. It does **not** own any single application's product data — that lives under `.project-brain/` in the consuming repo.

## Stack

- **Runtime:** Node 20+ (uses `Atomics.wait`, `node:test`, `--test-glob`).
- **Module system:** ESM throughout (`"type": "module"`).
- **No bundler / no build step** — scripts run directly via `node scripts/*.mjs`.
- **Embeddings:** `@xenova/transformers` (local MiniLM, default) or OpenAI (via `fetch`, no SDK).
- **Vector store (optional):** `@lancedb/lancedb` (preferred when available) or Qdrant (`BRAIN_STORE=qdrant`). JSON mirror is always written for fallback + health checks.
- **TS semantic graph (optional):** `typescript` peer dep — when installed, brain:index uses it for symbol spans, cross-file refs, and resolved imports.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Run the node:test suite |
| `npm run brain:route` | Decide what to run next (deterministic dispatcher; auto-surfaced via hooks) |
| `npm run brain:index` | Full incremental index of source + brain markdown |
| `npm run brain:sync` | Diff manifest, re-embed deltas only |
| `npm run brain:ask -- "query"` | Routed search (recommended retrieval entry point) |
| `npm run brain:search -- "query"` | Hybrid semantic search |
| `npm run brain:pack -- "query" --mode resume` | Token-budgeted context blob |
| `npm run brain:maintain` | brain:sync + brain:health |
| `npm run brain:health` | Read-only index + doc freshness report |
| `npm run brain:guard` | Pre-commit gate (branch base, link-check) |
| `npm run brain:eval` | Retrieval recall@K against `.project-brain/eval.json` |
| `npm run brain:adr "title"` | Scaffold a new ADR |
| `npm run brain:audit -- run` / `brain:improve -- next` | Act axis: find problems → plan/execute/review the backlog |
| `npm run brain:grill -- scaffold <finding>` | Adversarial pre-implementation interview (grounded questions) |
| `npm run brain:install-hooks` | Install Git hooks |
| `npm run brain:install-cursor-hooks` | Install Cursor hooks (incl. auto-routing rule) |

See `package.json` for the full list (one npm script per `brain:*` command).

## Architecture conventions

- **Pure helpers live in dedicated modules.** CLI scripts (`scripts/brain-*.mjs`) are thin wrappers around exported helpers; the heavy logic sits in `common.mjs`, `retrieval.mjs`, `aggregate.mjs`, `chunk.mjs`, `store.mjs`, etc. New scripts must follow this template — see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **No duplicate CLI helpers.** `takeFlag`, `takeOption`, `peekOption`, `splitEnv` are exported from `common.mjs`. A pre-commit rule blocks redefinition (`.project-brain/conventions.json`).
- **`active_state.md` mutations go through `withStateLock`.** Direct `writeFileSync` is blocked by convention rule.
- **Hooks log to stderr but exit 0.** Failure must be visible but never block the host workflow (`brain-session-digest.mjs` is the canonical pattern).
- **Errors propagate from setup scripts.** No `|| true` in `bin/*.sh` (blocked by convention rule).

## Code conventions

- ESM, no CommonJS interop.
- `node:`-prefixed builtins (`node:fs`, `node:path`).
- Top-level `await` is allowed (CLI scripts use it freely).
- Every CLI script has a leading `/** … */` describing what it does (so the file-summary embedding has a real intent sentence; see `extractCodeIntent`).

## Git workflow

- Branch model: GitFlow, with `epic/<issue>-…` integration branches allowed.
- Default work base: `develop` if it exists; `main` otherwise.
- Default PR target: `develop`/`main` (matches base).
- Protected branches: `main` (and `develop` in app repos that use it).
- Branches: `feature/<issue>-slug`, `fix/<issue>-slug`, `refactor/<issue>-slug`, `chore/<issue>-slug`, `docs/<issue>-slug`, `test/<issue>-slug`, `release/<version>`, `hotfix/<issue>-slug`, `epic/<issue>-slug`.
- Commit format: `type(scope): short description` — `scope` is the module (`brain-retrieval`, `brain-index`, `brain-store`, …).

## Team memory

- Markdown under `.project-brain/` is the shared source of truth.
- Cavemem is allowed for personal/session memory; durable facts must be promoted into `.project-brain/`.
- Caveman is communication compression only — not memory.

## Testing

- **Unit:** `tests/*.test.mjs` (node:test runner, no jest/vitest dep).
- **Retrieval quality:** `npm run brain:eval` against `.project-brain/eval.json` (23 cases as of 2026-05-22; recall@K = 1.0 on this repo).
- **CI:** `.github/workflows/ci.yml` — lint (`node --check`), test (`npm test`), setup smoke (stage a fake host repo, run `bin/setup.sh`, assert index artifacts).

## See also

- [[modules/retrieval]] – hybrid search internals
- [[modules/indexing]] – chunk → embed → store pipeline
- [[modules/coordination]] – multi-actor lock + orchestrator
- [[modules/hooks]] – Git / Claude Code / Cursor hook map
- [[CONTRIBUTING]] – per-script template + rules
- [[SKILL]] – agent-facing skill manual
