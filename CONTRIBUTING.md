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

## Conventions enforced by hooks

- `brain:lint-conventions` reads `.project-brain/conventions.json` and blocks edits that match `forbid` regexes (per file glob).
- `brain:link-check` verifies `lib/db/events.ts`-style code-path references inside `.project-brain/**.md` resolve in the working tree.
- `brain:guard` (pre-commit) enforces branch base, runs link-check on staged brain docs, and warns when `context_index.md` exceeds `BRAIN_CONTEXT_INDEX_WARN_TOKENS`.

## Retrieval-tuning changes

Changes to `retrieval.mjs` (BM25 params, hybrid score, metadata boosts, dedup behavior) must:

1. Update `tests/retrieval.test.mjs` to assert the new invariant.
2. Run `npm run brain:eval` against a known repo and record the before/after recall@8 in the PR body.
3. Default-off any new behavior that changes ranking globally; gate behind an env var (`BRAIN_*`) until the new defaults are validated.

## Release flow

This package is consumed via `brain:update-skill` from application repos, so `main` is always-shippable.

- Merge to `main` → consumers fast-forward on their next `brain:update-skill`.
- Breaking schema changes (record fields, env var renames) must include a recovery path: e.g. `BRAIN_AUTO_RECOVER=1` for the Lance schema, or a one-shot migration script.
- Tag releases when shipping a breaking schema change so consumers can pin (`PROJECT_BRAIN_UPSTREAM_REF=v1.2.0`).

## Reporting issues

Open an issue at <https://github.com/nicenoize/project-brain/issues> with:

- The consuming repo's setup style (symlink / submodule / vendored).
- `node --version`, OS, and store backend (`BRAIN_STORE`).
- Full output with `BRAIN_QUIET=` unset.
- The `package.json` snippet showing `brain:*` script entries.
