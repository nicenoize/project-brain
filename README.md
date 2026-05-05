# Project Brain

A reusable agent skill and local semantic memory system for web application development.

This repository is the **global Project Brain package**. It owns shared scripts, templates, guardrails, GitFlow rules, code conventions, and team-memory policy. Application repositories should keep project-specific state in `.project-brain/`.

## Source Of Truth Layers

- Global repo (`project-brain`): reusable conventions, templates, scripts, and guardrails.
- Application repo (`.project-brain/`): project-specific product plan, architecture context, features, modules, decisions, active state, and handoffs.
- Cavemem: optional local personal/session memory. It is not authoritative until promoted into `.project-brain/*.md`.

## One-line setup after adding this folder

Place or link this repository at:

```txt
skills/project-brain/
```

Then run:

```bash
bash skills/project-brain/bin/setup.sh
```

For a sibling checkout layout:

```bash
git clone git@github.com:nicenoize/project-brain.git ../project-brain
mkdir -p skills
ln -sfn ../project-brain skills/project-brain
bash skills/project-brain/bin/setup.sh
```

## What to commit in an application repo

Commit:

```txt
.project-brain/context_index.md
.project-brain/master_plan.md
.project-brain/product_plan.md
.project-brain/repo_context.md
.project-brain/active_state.md
.project-brain/features/
.project-brain/modules/
.project-brain/decisions/
.project-brain/sessions/
.github/PULL_REQUEST_TEMPLATE.md
.github/workflows/project-brain.yml
```

Do not commit a full fork of this global skill into every app repo unless the project intentionally vendors a pinned copy. Prefer a symlink, package install, submodule, or documented setup path to this canonical repo.

Do not commit:

```txt
.project-brain/vector-db/
.project-brain/index_manifest.json
.project-brain/search_index.json
~/.cavemem/
```

## GitFlow Defaults

- `main` is protected production/release.
- `develop` is protected integration.
- Feature/fix/refactor/chore/docs/test branches start from `develop` and target `develop`.
- Work branches should be issue-linked: `feature/123-short-description`.
- Release branches target `main`.
- Hotfix branches start from `main` and must merge back into `develop`.
- PRs close issues with `Closes #123` or `Fixes #123`.

## First Agent Command

```text
Use the project-brain skill. Audit this repository, ingest the master plan if present, update context_index, infer modules/features, and mark uncertain facts as Needs Review.
```

## Common commands

```bash
npm run brain:init
npm run brain:update-skill
npm run brain:index
npm run brain:search -- "auth checkout module"
npm run brain:search -- "auth checkout module" --summary-only
npm run brain:pack -- "auth checkout module" --max-tokens 3000
npm run brain:session -- start
npm run brain:sync
npm run brain:guard
npm run brain:health
```

Useful retrieval env vars:

```bash
BRAIN_STORE=auto|json|lance
BRAIN_EMBED_PROVIDER=local|openai
BRAIN_HYBRID_ALPHA=0.7
BRAIN_SESSION_TTL_HOURS=72
```

## How it works

- `.project-brain/*.md` files are the source of truth.
- `.project-brain/context_index.md` is the compressed low-token map agents load first.
- `.project-brain/master_plan.md` stores the full plan.
- The semantic index is rebuilt locally from committed files and selected source files.
- Retrieval uses LanceDB when `@lancedb/lancedb` is available, with the atomic JSON cache as the default-compatible fallback.
- The pre-commit hook runs guard checks and syncs the index.
- The post-merge and post-checkout hooks run `brain:update-skill` to fast-forward the canonical skill checkout.

## Visualization

See [docs/brain-architecture.md](docs/brain-architecture.md) for the source-of-truth layers, update flow, and CI layout.

```mermaid
flowchart LR
  PB["project-brain repo<br/>global rules + scripts"] --> Link["skills/project-brain<br/>symlink/submodule/checkout"]
  Link --> App["application repo"]
  App --> Brain[".project-brain/*.md<br/>project facts"]
  Brain --> Index["local semantic index<br/>generated, not committed"]
  PB --> Hooks["Git hooks + CI<br/>auto update + guard"]
  Hooks --> App
```

### Skill Runtime

```mermaid
flowchart TD
  Agent["Agent using project-brain skill"] --> Load["Load context_index.md<br/>then active_state.md"]
  Load --> Need{"Need more context?"}
  Need -- "yes" --> Query["brain:search or brain:pack"]
  Need -- "no" --> Work["Implement / review / plan"]

  Query --> Embed["Embed query<br/>local MiniLM or OpenAI"]
  Embed --> Store["Vector store adapter<br/>BRAIN_STORE=auto|json|lance"]
  Store --> Json["JSON cache<br/>.project-brain/search_index.json"]
  Store --> Lance["LanceDB table<br/>.project-brain/vector-db/"]
  Json --> Rank["Hybrid ranking<br/>dense + keyword"]
  Lance --> Rank
  Rank --> Pack["Relevant chunks<br/>summaries, modules, code, docs"]
  Pack --> Work

  Source["Markdown brain + selected source files"] --> Chunk["Code-aware chunking<br/>file summaries + module summaries"]
  Chunk --> Index["brain:index / brain:sync<br/>incremental upsert/delete"]
  Index --> Store

  Session["brain:session<br/>start/end/list/clean"] --> Store
  Work --> Update["Update Markdown brain<br/>when durable facts change"]
  Update --> Source
```

## Team workflow

Each team member runs:

```bash
git pull
bash skills/project-brain/bin/setup.sh
npm run brain:update-skill
```

Each developer has their own local semantic index generated from the same shared Markdown brain.

Team members may also install Cavemem for local cross-session recall:

```bash
npm install -g cavemem
cavemem install --ide codex
cavemem install --ide claude-code
cavemem status
cavemem doctor
```

Project Brain remains the shared source of truth.
