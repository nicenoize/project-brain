# Project Brain — Vector DB Upgrade Plan

## Context

The repo uses a JSON full-scan cache (`search_index.json`) rather than the declared LanceDB dependency. The embedding model (MiniLM-L6-v2, 384-dim) truncates at ~256 word pieces. No adapter pattern, no incremental upsert, no code-aware chunking, no hybrid retrieval. Goal: make retrieval faster, smarter, and more token-efficient while keeping Markdown as the authoritative source of truth.

---

## Phase 1 — Storage Abstraction + Incremental Indexing

**Creates:** `scripts/store.mjs`
**Modifies:** `scripts/common.mjs`, `scripts/brain-index.mjs`, `scripts/brain-sync.mjs`

### `store.mjs` exports

- `BrainStore` — base duck-type contract: `upsert(records[])`, `delete(ids[])`, `search(queryVec, topK, filter)`, `getAll()`, `close()`
- `JsonStore` — behavioral port of current flat-JSON (atomic write via `.tmp` + `renameSync`); used when `@lancedb/lancedb` is absent
- `LanceStore` — dynamic import of `@lancedb/lancedb`; uses `table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll()` API; on first upsert creates `brain_records` table; falls back to cold re-import from existing JSON if table is empty
- `openStore(options)` — auto-selects based on `BRAIN_STORE` env var (`json|lance|auto`); logs which backend is active

### `common.mjs` additions

- `atomicWrite(p, data)` — write to `p + '.tmp'` then `fs.renameSync`
- Export `LANCE_DIR` alias for existing `VECTOR_DIR` constant

### `brain-index.mjs` changes

- Open store via `openStore()` at startup
- Incremental: compare current hash against manifest per file; `store.delete(oldIds)` + `store.upsert(newRecords)` for changed files; `store.delete` for deleted files
- Record `id` = `sha256(\`${file}:${chunkIndex}:${fileHash}\`)` — stable per file version
- Add `--force` flag for full rebuild

### `brain-sync.mjs` changes

- Pass `BRAIN_CHANGED_FILES` + `BRAIN_DELETED_FILES` env vars to indexer so only the delta is processed

**Env:** `BRAIN_STORE=json|lance|auto` (default: `auto`)

**Verify:**
1. Existing search returns same results via `JsonStore`
2. Modify one file, sync → log shows "1 new"
3. `BRAIN_STORE=lance` creates LanceDB table in `.project-brain/vector-db/`
4. Both stores return identical top-5 for same query

---

## Phase 2 — Pluggable Embedding Providers

**Creates:** `scripts/embed.mjs`
**Modifies:** `scripts/brain-index.mjs`, `scripts/brain-search.mjs`

### `embed.mjs` exports

- `EmbedProvider` base: `embed(text)`, `embedBatch(texts[])`, `modelName`, `dims`
- `LocalProvider` — wraps existing `@xenova/transformers` pipeline; lazy-loads on first call; 384-dim
- `OpenAIProvider` — POSTs to `https://api.openai.com/v1/embeddings` via Node's built-in `fetch`; model default `text-embedding-3-small`; batch size 96; 1536-dim
- `openEmbedder(options)` — selects provider via `BRAIN_EMBED_PROVIDER` env; falls back to `LocalProvider` with warning if `OPENAI_API_KEY` is missing

**Key guard:** if `embedder.modelName !== manifest.model`, warn and force full re-index (prevents mixing 384-dim + 1536-dim vectors).

### `brain-index.mjs`

Replace inline `pipeline` + `embed()` with `openEmbedder()` + `embedBatch()` per file.

**Env:** `BRAIN_EMBED_PROVIDER=local|openai`, `OPENAI_API_KEY`

**Verify:**
1. Default = `LocalProvider`, behavior unchanged
2. `BRAIN_EMBED_PROVIDER=openai` stores 1536-dim vectors
3. Switching provider without `--force` triggers warning + auto full rebuild
4. Missing API key falls back gracefully

---

## Phase 3 — Code-Aware Chunking + File Summaries

**Creates:** `scripts/chunk.mjs`
**Modifies:** `scripts/brain-index.mjs`, `scripts/brain-search.mjs`

### `chunk.mjs` exports

- `chunkMarkdown(text, opts)` — splits on `##`/`###` headers first; falls back to char sliding window; returns `Chunk[]` with optional `heading`
- `chunkCode(text, filePath, opts)` — regex-based symbol detection (`/^(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+\w+/m`); groups symbols up to `maxChars`; each chunk prefixed with `filePath + symbolName` for embedding context; no external AST dep
- `chunkSummary(text, filePath, docData)` — one summary chunk per file: frontmatter + headings (docs) or exported symbol names + first block comment (code); returns single `Chunk` with `isSummary: true`
- `dispatchChunker(filePath, text, docData, opts)` — routes by extension (`.ts/.tsx/.js/.jsx/.mjs` → `chunkCode`; else → `chunkMarkdown`); always prepends summary chunk as `chunk: -1`

### `brain-index.mjs`

Replace `chunkText()` with `dispatchChunker()`. `common.mjs`'s `chunkText()` stays exported for backward compat.

### `brain-search.mjs`

Add `--summary-only` flag (filter `isSummary: true`).

**Verify:**
1. TypeScript file → separate chunks per function
2. Large Markdown → splits at `##` boundaries
3. `--summary-only` returns file-level records
4. Code symbol search scores improve

---

## Phase 4 — Change-Aware Session Memory

**Creates:** `scripts/brain-session.mjs`
**Modifies:** `scripts/common.mjs`, `scripts/brain-health.mjs`, `scripts/setup-package.mjs`

### `brain-session.mjs` commands

- `start` — detect branch (`git rev-parse --abbrev-ref HEAD`), list changed files (`git status --porcelain`), create session record with `expiresAt = now + TTL`, upsert into store, scaffold `.project-brain/sessions/${branch}-${date}.md` if absent
- `end` — find latest session for current branch, append git log summary, re-embed, upsert
- `list` — print all session records (branch, date, file count, expiry)
- `clean` — delete records where `expiresAt < now`

### `brain-health.mjs`

Warn if expired session records exist → suggest `npm run brain:session -- clean`.

### `setup-package.mjs`

Add `brain:session` to merged scripts.

**Env:** `BRAIN_SESSION_TTL_HOURS=72` (default)

**Verify:**
1. Session record created + appears in search
2. TTL expiry + clean removes it
3. Health warning fires for expired records

---

## Phase 5 — Hybrid Retrieval + Prompt Packing

**Creates:** `scripts/brain-pack.mjs`
**Modifies:** `scripts/brain-search.mjs`, `scripts/setup-package.mjs`

### `brain-search.mjs` — hybrid scoring

- `tfidfScore(query, records)` — inline tokenize + IDF precomputed once per search call; returns `Map<id, score>`
- `hybridScore(dense, keyword, alpha)` — `alpha * dense + (1-alpha) * normalizedKeyword`; alpha via `BRAIN_HYBRID_ALPHA` env (default `0.7`)

### `brain-pack.mjs`

- CLI: `brain:pack "query" [--max-tokens 3000] [--format json|text]`
- Always includes `context_index.md` + `active_state.md` first (counted against budget)
- Greedily adds hybrid-ranked chunks until token budget hit (estimate: `text.length / 4`)
- De-duplicates by file + heading
- Exports `packPrompt(query, opts)` for programmatic use by agents

### `setup-package.mjs`

Add `brain:pack` to merged scripts.

**Env:** `BRAIN_HYBRID_ALPHA=0.7`

**Verify:**
1. Keyword-exact query ranks higher with hybrid than pure cosine
2. `brain:pack` output stays within token budget
3. `context_index.md` always appears first in output
4. `--format json` returns `{ prompt, sources, estimatedTokens }`

---

## Phase 6 — Module-Level Summary Aggregation

**Modifies:** `scripts/brain-index.mjs`, `scripts/brain-search.mjs`

Post-processing pass in `brain-index.mjs` after all files are indexed:
- Group `isSummary: true` records (excluding sessions) by parent directory
- For dirs with ≥ 2 file summaries: concatenate summaries, embed, store as `chunk: -2` / `isModuleSummary: true`
- Upsert module records; delete stale module records for dirs with no remaining summaries

### `brain-search.mjs`

Add `--modules-only` flag.

**Requires Phase 3** (needs file summary records as input).

**Verify:**
1. Module records created for multi-file dirs
2. `--modules-only` returns dir-level records
3. `brain:pack` surfaces module summaries for high-level queries
4. Delete all files in a dir → module record is removed

---

## New Files Summary

| File | Phase | Purpose |
|---|---|---|
| `scripts/store.mjs` | 1 | BrainStore interface + JsonStore + LanceStore + `openStore()` |
| `scripts/embed.mjs` | 2 | EmbedProvider interface + LocalProvider + OpenAIProvider + `openEmbedder()` |
| `scripts/chunk.mjs` | 3 | `chunkMarkdown`, `chunkCode`, `chunkSummary`, `dispatchChunker` |
| `scripts/brain-session.mjs` | 4 | Session records with TTL (start/end/list/clean) |
| `scripts/brain-pack.mjs` | 5 | Prompt packer with token budget enforcement |

## Env Vars Introduced

| Variable | Phase | Default | Effect |
|---|---|---|---|
| `BRAIN_STORE` | 1 | `auto` | `json` forces JsonStore, `lance` forces LanceStore |
| `BRAIN_EMBED_PROVIDER` | 2 | `local` | `openai` activates OpenAIProvider |
| `OPENAI_API_KEY` | 2 | unset | Required for OpenAI provider |
| `BRAIN_HYBRID_ALPHA` | 5 | `0.7` | Dense weight in hybrid scoring |
| `BRAIN_SESSION_TTL_HOURS` | 4 | `72` | Session record TTL |

## Invariants Preserved Throughout

- `.project-brain/*.md` remain the source of truth; vector store is always a generated cache
- `@xenova/transformers` stays the default (no forced cloud dependency)
- `common.mjs`'s `chunkText()` kept for backward compat
- All scripts stay plain `.mjs` ES modules (no TypeScript migration)
- No new mandatory npm packages — only the optional `@lancedb/lancedb` is activated
- All existing `npm run brain:*` commands preserve their current behavior

## Dependency Order

```
Phase 1 → Phase 2 → Phase 3 ─┐
                   → Phase 4  ├─ all complete → Phase 6
                   → Phase 5 ─┘
```

Phases 3, 4, and 5 can proceed in parallel after Phase 2 completes. Phase 6 requires Phase 3.
