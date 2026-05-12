# Context Index

Purpose: compact map agents load before search. Keep this under ~700 tokens; move detail to product_plan, repo_context, modules, features, or decisions.

## Snapshot
- Status: reusable Project Brain package for app repos.
- Stack: Node ESM scripts, npm, local MiniLM embeddings, JSON/Lance/Qdrant stores.
- Goal: Git-tracked Markdown is canonical; generated semantic index is retrieval cache.

## Current Focus
- Improve token efficiency and automate stale context cleanup.
- Prefer `brain:ask` router before lower-level search/pack commands.

## Modules
- `scripts/brain-index.mjs`: builds records from brain docs and source files.
- `scripts/retrieval.mjs`: hybrid dense, keyword, symbol, metadata ranking.
- `scripts/brain-pack.mjs`: budgeted context packing for agents.
- `scripts/brain-compact.mjs`: writes short resume snapshots.
- `scripts/brain-session.mjs`: session handoffs and expiry cleanup.
- `scripts/brain-maintain.mjs`: sync, health, eval, session cleanup.

## Features
- Semantic search over source, docs, decisions, modules, and sessions.
- Resume/minimal context packs for lower-token agent reloads.
- Git hooks and CI templates keep generated indexes fresh.

## Decisions
- Markdown brain remains source of truth.
- Vector DB and JSON mirror are generated local caches.
- Auto-compact snapshots are short-lived and should not recursively feed future compacts.

## Commands
- Index: `npm run brain:index`
- Search/router: `npm run brain:ask -- "query"`
- Pack: `npm run brain:pack -- "query" --mode resume --max-tokens 1200`
- Maintain: `npm run brain:maintain`

## Retrieval Hints
- Search before opening full specs.
- Load `master_plan.md` only for ambiguity or re-ingestion.
