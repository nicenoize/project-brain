# Project Brain — Recovery & Performance Tuning

> Part of the **project-brain** skill. Loaded on demand from the lean core `SKILL.md` — see its "Reference files" section for the full map.

Index recovery/reset procedures and performance/cap-tuning environment variables.

## Recovery

If the index gets stuck (Lance schema errors, gigantic `search_index.json`, ghost paths in the thousands), reset it:

```bash
npm run brain:repair             # interactive
npm run brain:repair -- --yes    # non-interactive
npm run brain:repair -- --dry-run
npm run brain:index -- --force   # rebuild after repair
```

What gets removed (only generated artifacts):

- `.project-brain/vector-db/` — Lance table
- `.project-brain/search_index.json` (+ any leftover `.tmp.*` siblings)
- `.project-brain/index_manifest.json`
- `.project-brain/.fleet-cache/`

What stays: every Markdown file under `.project-brain/` (source of truth) and everything else in the repo.

Auto-recovery is on by default for Lance schema mismatches (typical after `brain:update-skill` adds new record fields). Opt out with `BRAIN_AUTO_RECOVER=0`. If the JSON mirror overflows Node's string limit (`ERR_STRING_TOO_LONG`), it's read-disabled with a warning — `brain:repair` is then the only recovery path.

Cap-tuning env vars (rarely needed):

```
BRAIN_JSON_MIRROR_MAX_BYTES=209715200    # 200 MB read cap
BRAIN_JSON_MIRROR_MAX_RECORDS=50000      # write cap
BRAIN_JSON_MIRROR=0                      # disable JSON mirror entirely (Lance/Qdrant primary)
```

## Performance

The indexer reuses previously-computed vectors for byte-identical chunks. A one-line edit to a 700-line file embeds **1 chunk**, not all 16 — typical cache hit rate is 80–95% during incremental sync. Background sync runs niced (lowest CPU priority, idle I/O on Linux) and is debounced + globally locked so the editor never sees two bg-syncs racing.

Perf tuning env vars:

```
BRAIN_REUSE_VECTORS=0                    # disable chunk-level vector reuse (force full re-embed)
BRAIN_SYNC_DEBOUNCE_MS=30000             # skip bg sync if manifest was updated within window
BRAIN_SYNC_NICE=0                        # disable nice/ionice wrapping for the bg child
```
