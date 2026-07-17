# Contributing to Project Brain

This is the global Project Brain package: shared scripts, templates, conventions, GitFlow guardrails. Application repos consume it via symlink/submodule/checkout at `skills/project-brain/`.

## Getting set up

```bash
git clone git@github.com:nicenoize/project-brain.git
cd project-brain
npm install
npm test
```

`npm test` runs the node built-in test suite (no jest/vitest dependency). Expect ~250ms total.

## Branches and PRs

- Branch from `main` (this repo has no `develop` — application repos do).
- One feature/fix per PR. Title: `feat(brain): …` / `fix(brain): …` / `perf(brain): …` / `docs(brain): …` / `test(brain): …` / `refactor(brain): …` / `chore(brain): …`.
- Bundle related commits into a single epic only when they would otherwise churn each other (`epic/<issue>-…` is allowed by `brain:guard`).
- PRs close issues with `Closes #N` or `Fixes #N`. Every behavior change needs at least one test.

## Adding a new `brain:*` script

Template:

```js
import path from 'node:path';
import { BRAIN_DIR, read, write, ensureDir, takeFlag, takeOption, peekOption, splitEnv } from './common.mjs';

const args = process.argv.slice(2);
const help = takeFlag(args, '--help') || takeFlag(args, '-h');
const verbose = takeFlag(args, '--verbose');
const target = takeOption(args, '--target') || process.env.BRAIN_TARGET || '';

if (help) {
  console.log('Usage: npm run brain:foo -- [--target x] [--verbose]');
  process.exit(0);
}

try {
  // …work…
} catch (error) {
  process.stderr.write(`[brain:foo] ${error.message || error}\n`);
  process.exit(1);
}
```

Rules:

1. **No duplicate helpers.** `takeFlag` / `takeOption` / `peekOption` / `splitEnv` / `ensureDir` / `read` / `write` / `sha256` / `parseDoc` / `gitChangedFiles` already exist in `common.mjs`. Import them — do not re-declare.
2. **Absolute paths only.** Build paths from `ROOT` / `BRAIN_DIR` in `common.mjs`. No bare relative `./…` paths.
3. **Hooks must not block on failure.** If your script runs as a Claude Code / Cursor / Git hook, write errors to **stderr** but still exit 0 unless the failure is genuinely fatal. See `brain-session-digest.mjs` for the canonical pattern.
4. **Errors on stderr, results on stdout.** `--json` flag should produce parseable JSON on stdout with nothing else.
5. **`active_state.md` mutations** go through `withStateLock` (`active-state.mjs`). Never read-then-write that file outside the lock.
6. **Add the npm script.** Register the entry in `scripts/common.mjs:mergePackageScripts` so application repos get it on `brain:update-skill`.
7. **Add a test.** At minimum a smoke test under `tests/<name>.test.mjs` that imports the module and exercises one happy path. If the script reads/writes state, use `fs.mkdtempSync` for isolation.

## Sidecar discipline (records vs sidecars)

Structural truth lives in **records** (`.project-brain/decisions/`, `findings/`, …); derived or experiential annotations (reflect outcomes, learning scores, verdict/staleness overlays) live in **sidecar files beside the record**, merged only at read time.

- A folder's **own recorder** is the only writer of files in that folder (`brain:adr` → `decisions/`, `brain:audit`/`findings.mjs` → `findings/`). No other script may create or rewrite a record.
- Anything else that wants to attach information writes a sibling sidecar (`0007-foo.md` → `0007-foo.reflect.json`, or a folder-level `.brain_learning.json`) and leaves the record byte-for-byte untouched. Sidecars are regenerable and never authoritative.
- Never read-then-write a record to bolt on a derived field — do the merge in the consumer instead.

This is the record-level form of "generated indexes are never authoritative": it keeps structural truth diff-clean and safe for parallel agents. `brain:lint-conventions --sidecars` scans for scripts that violate it. Full rationale: [`references/conventions.md`](references/conventions.md#sidecar-discipline-records-vs-sidecars).

## Conventions enforced by hooks

- `brain:lint-conventions` reads `.project-brain/conventions.json` and blocks edits that match `forbid` regexes (per file glob).
- `brain:lint-conventions --sidecars` scans tracked `scripts/*` for writes under `decisions/`/`findings/` from outside the allowlisted recorders (sidecar discipline, above). Advisory today; wire into CI with the reflect epic.
- `brain:link-check` verifies `lib/db/events.ts`-style code-path references inside `.project-brain/**.md` resolve in the working tree.
- `brain:guard` (pre-commit) enforces branch base, runs link-check on staged brain docs, and warns when `context_index.md` exceeds `BRAIN_CONTEXT_INDEX_WARN_TOKENS`.

## Retrieval-tuning changes

Changes to `retrieval.mjs` (BM25 params, hybrid score, metadata boosts, dedup behavior) must:

1. Update `tests/retrieval.test.mjs` to assert the new invariant.
2. Run `npm run brain:eval` against a known repo and record the before/after recall@8 in the PR body. Report movement on the **hard (vocabulary-mismatch) subset** specifically, not just the aggregate — see [`docs/eval-methodology.md`](docs/eval-methodology.md) for why the easy cases are saturated and what makes a fair hard case.
3. Default-off any new behavior that changes ranking globally; gate behind an env var (`BRAIN_*`) until the new defaults are validated.

**Contextual Retrieval** (`scripts/contextual.mjs`, gated by `BRAIN_CONTEXTUAL_CHUNKS=1`) follows this stance: when enabled, the indexer prepends a deterministic situating prefix to each chunk's **embedding input only** (`record.embeddingText`); the stored/displayed `record.text` stays the original chunk. It is **default OFF** — with the var unset, indexing is byte-for-byte unchanged. The prefix generator is a pure, exported function (`buildContextualPrefix` / `situateEmbeddingText`) unit-tested in `tests/contextual.test.mjs`. Before flipping the default, run `npm run brain:eval` and record before/after recall@8. `BRAIN_CONTEXTUAL_PROVIDER` is a reserved extension seam for a future LLM-generated blurb; no network/LLM client is implemented.

## Release flow

This package is consumed via `brain:update-skill` from application repos, so `main` is always-shippable.

- Merge to `main` → consumers fast-forward on their next `brain:update-skill`.
- Breaking schema changes (record fields, env var renames) must include a recovery path: e.g. `BRAIN_AUTO_RECOVER=1` for the Lance schema, or a one-shot migration script.
- Tag releases when shipping a breaking schema change so consumers can pin (`PROJECT_BRAIN_UPSTREAM_REF=v1.2.0`).

## The update contract: `bin/setup.sh` vs `bin/update.sh`

Two entry points, one rule of thumb: **`update.sh` must refresh everything a consumer needs to keep the brain working, not just the scripts.** A consumer that only got new `scripts/` but a stale `.claude/settings.json` runs with the flagship wiring installed as dead code — e.g. ADR 0023's ambient-routing hooks present on disk but never registered (issue #34).

| Concern | `setup.sh` (one-time) | `update.sh` (every refresh) |
| --- | --- | --- |
| Package tree (`SKILL.md`, `references/*.md`, scripts) | copies/links in place | git ff-merge from upstream |
| `package.json` scripts/deps, `.gitignore`, PR template, CI workflow | `setup-package.mjs` | `setup-package.mjs` |
| `.claude/settings.json` (hooks, permissions, plugins) | `setup-claude-settings.mjs` (via `setup-package.mjs`) | **`setup-claude-settings.mjs` (via `setup-package.mjs`, with a direct fallback)** |
| Git hooks, `brain:init`, first index | yes | no (state, not wiring) |

`.claude/settings.json` is merged **additively** by `setup-claude-settings.mjs`:

- recommended hooks are appended per event only when their `command` is not already present — **user-added hooks and permissions are never dropped**;
- existing scalar values are never overwritten;
- bypass with `PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1` for repos that hand-manage their settings.

`brain:health` audits this: it compares the installed `.claude/settings.json` against `templates/claude-code/settings.recommended.json` and warns (non-fatal) when recommended hooks/permissions are missing — the same section as the context-footprint audit (`decisions/0024`). If you add a hook or permission to `settings.recommended.json`, that warning is how consumers who haven't re-run `update.sh` discover the drift; the additive merge is how they fix it.

## Reporting issues

Open an issue at <https://github.com/nicenoize/project-brain/issues> with:

- The consuming repo's setup style (symlink / submodule / vendored).
- `node --version`, OS, and store backend (`BRAIN_STORE`).
- Full output with `BRAIN_QUIET=` unset.
- The `package.json` snippet showing `brain:*` script entries.

## Writing a new cross-project edge detector

Fleet mode (see `modules/fleet.md`) hosts a pluggable detector subsystem under `scripts/edges/`. Adding a new detector is one file plus one line in the runner registry.

Detector contract (`scripts/edges/types.mjs` — JSDoc only):

```js
// detector(context) -> AsyncIterable<EdgeCandidate>
// context = {
//   ROOT, projects, projectDirs, dirtyProjects,
//   facts: Map,          // shared with earlier detectors (e.g. imageRegistry, grpcServices)
//   cache, logger, signal
// }
// EdgeCandidate = { from, to, kind, evidence[], confidence, detector, meta? }
```

Template (`scripts/edges/<kind>.mjs`):

```js
import fs from 'node:fs';
import path from 'node:path';

const NAME = '<kind>';

async function* detect(ctx) {
  for (const project of ctx.projects) {
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    // …scan, resolve, yield EdgeCandidate…
  }
}

export default { name: NAME, detect };
```

Rules:

1. **Async generator, no batch return.** The runner streams + dedupes; large fleets won't hold all candidates in memory.
2. **`from` and `to` must be project names** discovered by `discoverProjects`. Self-edges (`from === to`) are filtered out by `dedupeCandidates`.
3. **Evidence is `'fleet-relative-path:line'` lines.** Cap at the 5 most useful per candidate; `dedupeCandidates` will merge across detectors.
4. **Confidence tagging is required.**
   - `high`: parser-level certainty (parsed YAML / JSON / proto / go.mod).
   - `medium`: regex-level certainty with a plausible heuristic.
   - `low`: best-effort match (e.g. localhost), filterable via `brain:edges --min-confidence`.
5. **Honor `ctx.dirtyProjects`.** Skip clean projects; the runner replays cached candidates for them.
6. **No I/O outside `ctx.projectDirs`** unless you have a strong reason; the per-detector timeout is 30s.
7. **Add a registry entry** in `scripts/edges/index.mjs#DETECTORS` in the right phase (registrars before consumers).
8. **Tests**: `tests/edges/<kind>.test.mjs` with a tmpdir fixture. Use the `consume(asyncIter)` helper pattern already in `tests/edges/k8s-image.test.mjs`.
9. **Document** the detector in `modules/fleet.md`'s detector table.

If your detector publishes shared state (a name registry, a service map), set it on `ctx.facts` under a documented key (e.g. `imageRegistry`, `grpcServices`, `openapiServices`, `envKeysByProject`). Downstream detectors should treat missing facts as "no relevant data" rather than throwing.
