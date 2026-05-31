# Solo multi-repo setup

A practical guide for a single developer using Project Brain across several
repositories — multiple frontends, backends, services, k8s manifests, shared
libraries — where you are the only brain user and your colleagues commit to the
same repos without brain discipline.

> Sweet spot: 3–20 repos, 1 brain user, AI agents (Claude / Cursor / Codex) as
> first-class collaborators. If your team grows past ~5 brain users you'll want
> to revisit federation; see the vision doc.

## TL;DR

1. Put all your repos as siblings under one parent directory (the "fleet root").
2. Run `bash skills/project-brain/bin/setup.sh` once from the fleet root.
3. Fleet Mode auto-activates with ≥2 projects discovered — all the multi-repo
   tooling (`brain:edges`, `brain:impact --cross-project`, `--project NAME`
   flags, cross-project edges, per-repo summaries) lights up automatically.
4. Use the new commands as your daily driver:
   - `brain:feature start` to begin a feature that spans repos
   - `brain:pack --for-agent claude` to prime a Claude/Cursor/Codex session
   - `brain:pr stage --feature SLUG` to draft linked PR bodies across repos
   - `brain:handoff prepare --write` before you go on vacation / off sick

## Layout

```
work/                           ← fleet root (one parent dir for everything)
├── .project-brain/             ← single brain that sees all repos
├── skills/
│   └── project-brain/          ← symlink to your project-brain checkout
├── frontend-web/               ← repo 1 (real git repo)
├── frontend-mobile/            ← repo 2
├── backend-api/                ← repo 3
├── backend-workers/            ← repo 4
├── platform-k8s/               ← repo 5 (manifests, helm, kustomize)
└── shared-protos/              ← repo 6 (.proto files)
```

Each repo stays a normal git repo your colleagues can clone independently —
they don't need to know about the fleet root. Only YOU set up the parent
directory.

### Option A: clone everything fresh under the parent

```bash
mkdir -p ~/work && cd ~/work
git clone git@github.com:org/frontend-web.git
git clone git@github.com:org/backend-api.git
git clone git@github.com:org/backend-workers.git
git clone git@github.com:org/platform-k8s.git
git clone git@github.com:org/shared-protos.git

# Get the brain itself
git clone git@github.com:nicenoize/project-brain.git
mkdir -p skills
ln -sfn ../project-brain skills/project-brain

# Bootstrap
bash skills/project-brain/bin/setup.sh
```

### Option B: symlink existing checkouts into a fleet root

If your repos already live in random places, link them in:

```bash
mkdir -p ~/work && cd ~/work
ln -sfn /path/to/your/frontend-web frontend-web
ln -sfn /path/to/your/backend-api  backend-api
ln -sfn /path/to/your/backend-workers backend-workers
# ... etc

ln -sfn /path/to/project-brain skills/project-brain
bash skills/project-brain/bin/setup.sh
```

Fleet Mode discovers symlinked subdirs as long as they contain a recognizable
marker (`package.json`, `go.mod`, `pyproject.toml`, `Chart.yaml`,
`kustomization.yaml`, `Dockerfile`, `*.proto`, `*.tf`).

## What activates automatically

Once you have ≥2 projects:

- `npm run brain:projects` lists discovered projects + their kinds + edge counts
- `npm run brain:edges` lists cross-project relationships found by 11 detectors
  (proto-schema, openapi-schema, k8s-image, gRPC client, HTTP client, env-var,
  pubsub, db-shared, package-dep, go-replace, image-registry)
- `npm run brain:impact <symbol> --cross-project` answers "if I change X, what
  breaks elsewhere?" across every repo
- `npm run brain:graph` exports a JSON or Mermaid graph of the whole system
- All `brain:*` commands gain a `--project NAME` flag for scoping

These all work without any new code on your part. They're already in the brain.

## Daily workflow

### Start of session

```bash
cd ~/work
git -C frontend-web pull
git -C backend-api pull
# ... or use a script to pull all
npm run brain:sync    # update the local index after pulls
npm run brain:health  # see if anything is stale
```

Prime your AI agent for the session:

```bash
npm run brain:pack -- --for-agent claude "implement oauth refresh" --project backend-api
# Paste the output into your Claude / Cursor / Codex session.
```

The `--for-agent` mode prepends a working-agreement preamble (use the brain,
check active state, record decisions, mark workstreams) and prioritizes durable
records: decisions, module summaries, cross-project edges, recent sessions.

### Start a multi-repo feature

```bash
npm run brain:feature -- start \
    --slug oauth-refresh \
    --issue 42 \
    --projects frontend-web,backend-api \
    --title "OAuth refresh token rotation"
```

This will:

1. Write `.project-brain/features/oauth-refresh.md` with a multi-repo template
2. Spawn one git worktree per project on branch `feature/42-oauth-refresh`
3. Register a workstream per project in `active_state.md`

Edit the feature spec to fill in goal, constraints, acceptance criteria,
contract changes.

### During the feature

In each worktree, do normal work. The brain's hooks (`brain:guard` pre-commit,
`brain:sync` post-commit/post-merge) keep the index current per repo.

When you need cross-repo context:

```bash
npm run brain:impact ChargeCard --cross-project       # blast radius
npm run brain:edges -- --min-confidence high          # check current edges
npm run brain:pack -- --project backend-api "current"  # context refresh
```

When the AI agent needs to switch repos:

```bash
npm run brain:pack -- --for-agent claude "swap to frontend work" --project frontend-web
```

### When you're ready to push

```bash
# Sync the brain so the PR body picks up the latest state
npm run brain:sync

# Generate linked PR bodies for every project in the feature
npm run brain:pr -- stage --feature oauth-refresh --write
# Writes .project-brain/pr-bodies/oauth-refresh-frontend-web.md
#        .project-brain/pr-bodies/oauth-refresh-backend-api.md
```

Each PR body cross-references the others ("linked branches: ..."), surfaces the
feature spec, lists the verification checklist, and (if the spec has a
`## Contract changes` section) calls that out at the top.

Use the bodies via `gh pr create --body-file <path>` or paste into the GitHub UI.

### Finish the feature

When all PRs are merged:

```bash
npm run brain:feature -- end --slug oauth-refresh
```

Closes the workstreams, releases leases. Worktrees stay — clean them up with
`npm run brain:worktree -- remove <path>` when ready.

## Security gates

Wire SAST / secret-scan / dep-audit into your pre-commit hook so you catch
issues even when nobody else is reviewing:

```bash
# Install the tools you want (none required — guard skips silently if absent)
brew install gitleaks
brew install semgrep
# npm is already there

# Enable per scanner (opt-in)
export BRAIN_GUARD_GITLEAKS=1
export BRAIN_GUARD_SEMGREP=1
export BRAIN_GUARD_NPM_AUDIT=1
# Or enable all at once:
export BRAIN_GUARD_SECURITY=1
```

`brain:guard` runs in pre-commit. Findings at high or critical severity block
the commit; lower severities print as warnings. If a scanner isn't installed,
it's silently skipped — so this works as a soft-enable everywhere.

Tune per-project by putting these in a `.envrc` (direnv) or your shell rc.

## Hand-off (vacation, illness, planned absence)

When you're going away, generate a brief that's readable by colleagues
*without* brain installed:

```bash
npm run brain:handoff -- prepare \
    --until 2026-06-15 \
    --to "the team" \
    --from sebastian \
    --reason vacation \
    --contact "Slack: @me (urgent only)" \
    --write
```

This writes:

- `.project-brain/handoffs/YYYY-MM-DD-handoff.md` (consolidated, for you when
  you come back)
- `HANDOFF.md` at each project root (single source for colleagues — plain
  Markdown, no brain dependency)
- `.project-brain/handoff-state.json` (machine-readable state for `brain:handoff end`)

Each `HANDOFF.md` lists:

- Current branch + last commit per repo
- Uncommitted local changes (so colleagues don't lose your work-in-progress)
- Active workstreams + file leases
- Open PRs
- "OK to do" vs "Wait for me on" guidance
- Pointer to the consolidated brief for full detail

Add `--commit` to auto-stage + commit `HANDOFF.md` in each project so the brief
is visible on GitHub.

When you return:

```bash
npm run brain:handoff -- end
```

Summarizes every commit and merged/open PR across all repos since the hand-off
started, then clears the active flag.

## Recommended habits

The brain rewards a few specific disciplines:

1. **Write an ADR for every non-obvious decision.** Drop a file under
   `.project-brain/decisions/<n>-slug.md` with frontmatter:
   ```yaml
   ---
   title: ...
   status: accepted
   date: YYYY-MM-DD
   feature: <slug>      # if this decision is feature-scoped
   project: <name>      # if it's project-scoped
   ---
   ```
   These auto-surface in `brain:pack --for-agent` priming and are the single
   highest-ROI brain practice for solo work.

2. **Keep `modules.md` files up to date** under `.project-brain/modules/`.
   They become module summaries in retrieval. One paragraph per module is enough.

3. **Mark your work** with `brain:work start` so `active_state.md` shows what's
   in flight. Even solo, the brain uses this for prioritization in
   `brain:pack --resume` and `--for-agent` modes.

4. **Run `brain:edges --detect` periodically** (weekly is plenty). It re-runs
   all 11 detectors against the current state, so your cross-project graph
   stays accurate as you refactor.

5. **Treat the brain like code in PR review.** When you touch a module, update
   its `modules/*.md`. When you make an architectural choice, add an ADR. The
   pre-commit guard warns if you touch features/modules without a matching
   decision change.

## AI agents as your team

You don't have human teammates on the brain, but agents fill the role:

- **Claude Code**: pair-programming, refactors, end-to-end feature work
- **Cursor**: in-editor copilot, faster iteration on specific files
- **Codex CLI**: terminal-driven shell + code agent
- **Custom**: long-running autonomous agents via the brain's session
  primitives

All four share `.project-brain/` as their on-disk world model. When an agent
joins a session, prime it:

```bash
npm run brain:pack -- --for-agent claude "task description" --max-tokens 3000
# Paste output into the agent's system or first user message.
```

When an agent finishes substantial work, capture a session digest:

```bash
npm run brain:session -- end --task <task-id>
```

The session is indexed and surfaces in the next agent's priming, so a Claude
session can pick up where a Cursor session left off.

## What this setup does NOT solve

Be honest with yourself about the ceiling:

- **Cognitive load past ~5 repos.** Brain helps, but there's no magic that
  makes 10-repo solo work feel like 1-repo work. Expect to think hard.
- **Colleagues' changes catching you off guard.** They don't run brain, so
  their commits don't update brain artifacts (modules, decisions). After
  `git pull`, run `brain:sync` and skim `brain:health` for staleness.
- **Real-time alerting.** State is as fresh as your last sync. If you need
  "someone just changed the file you're editing", pair with a chat bot or
  IDE conflict detection — brain won't get you there.
- **Quality of decisions.** Brain captures decisions, doesn't make them
  better. ADR quality in == ADR quality out.

## Troubleshooting

- **Fleet Mode isn't activating.** Run `npm run brain:projects` — if it lists
  fewer than 2 projects, check that each subdirectory contains a recognized
  marker file. Set `BRAIN_FLEET_MODE=1` to force-enable for diagnosis.
- **Cross-project edges are stale.** `npm run brain:edges -- --detect` ignores
  the per-detector cache and re-runs everything.
- **The brain is bloated.** `npm run brain:repair` clears generated artifacts
  (`vector-db/`, `search_index.json`, `index_manifest.json`, `.fleet-cache/`).
  Markdown is never touched. Re-index with `npm run brain:index -- --force`.
- **Hooks not firing.** `npm run brain:install-hooks` (Git) and
  `npm run brain:install-cursor-hooks` (Cursor) are idempotent — re-run after
  pulling brain updates.
- **PR bodies aren't surfacing the right context.** Check
  `npm run brain:health` for stale brain docs. If `context_index.md` is older
  than your last big feature, refresh it (the indexer touches it on every
  `brain:sync`).

## Reference: new solo commands

| Command | What it does |
|---|---|
| `brain:feature start --slug X --projects a,b,c` | Scaffold cross-repo feature: spec, branches, workstreams |
| `brain:feature status [--slug X]` | List features with linked workstreams |
| `brain:feature end --slug X` | Close workstreams and release leases |
| `brain:pack --for-agent <name> "query"` | Token-budgeted prompt with agent priming preamble |
| `brain:pr stage --feature X [--write]` | Linked PR bodies, one per project, cross-referenced |
| `brain:handoff prepare [--write] [--commit]` | Vacation brief, per-repo + consolidated |
| `brain:handoff status` | Current handoff state |
| `brain:handoff end` | What changed across all repos while you were away |

All take `--json` for scripting.
