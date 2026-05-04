# Project Brain

A Claude Skill and local semantic memory system for web application development.

It keeps a shared Git-tracked Markdown brain plus a local generated vector index for low-token context retrieval.

## One-line setup after adding this folder

Place this folder at:

```txt
skills/project-brain/
```

Then run:

```bash
bash skills/project-brain/bin/setup.sh
```

## What to commit

Commit:

```txt
skills/project-brain/
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

Do not commit:

```txt
.project-brain/vector-db/
.project-brain/index_manifest.json
.project-brain/search_index.json
```

## First Claude command

```text
Use the project-brain skill. Audit this repository, ingest the master plan if present, update context_index, infer modules/features, and mark uncertain facts as Needs Review.
```

## Common commands

```bash
npm run brain:init
npm run brain:index
npm run brain:search -- "auth checkout module"
npm run brain:sync
npm run brain:guard
npm run brain:health
```

## How it works

- `.project-brain/*.md` files are the source of truth.
- `.project-brain/context_index.md` is the compressed low-token map Claude loads first.
- `.project-brain/master_plan.md` stores the full plan.
- The semantic index is rebuilt locally from committed files and selected source files.
- The pre-commit hook runs guard checks and syncs the index.

## Team workflow

Each team member runs:

```bash
git pull
bash skills/project-brain/bin/setup.sh
```

Each developer has their own local semantic index generated from the same shared Markdown brain.
