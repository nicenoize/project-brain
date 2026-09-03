/**
 * Index-provider seam (strategy doc §M2): makes the embedding index optional.
 *
 * `getIndexProvider()` returns one of two providers:
 *   - `builtin` — thin delegation to today's embed + store + retrieval stack
 *     (nothing re-implemented here); selected when an embedder is usable
 *     (local @xenova/transformers resolvable, or the OpenAI provider active).
 *   - `none`    — selected when the embedder is unavailable, or forced via
 *     BRAIN_INDEX_PROVIDER=none. `search()` degrades to a pure BM25 lexical
 *     pass over the JSON index mirror (tfidfScore from retrieval.mjs over
 *     JsonStore records); with no mirror it returns an empty, clearly-marked
 *     result. `ensureIndex()` skips with a warning.
 *
 * Every degraded result carries a one-line `warning` string that callers are
 * expected to print (stderr). Pure-ish cores (`lexicalSearch`) are exported
 * for unit testing.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openEmbedder, EmbedderUnavailableError } from './embed.mjs';
import { openStore, JsonStore, matchesFilter } from './store.mjs';
import { retrieve, tfidfScore } from './retrieval.mjs';

export const LEXICAL_FALLBACK_WARNING =
  'semantic index unavailable — install @xenova/transformers (or set BRAIN_EMBED_PROVIDER=openai + OPENAI_API_KEY); falling back to lexical search';
export const NO_RESULTS_WARNING =
  'semantic index unavailable — install @xenova/transformers (or set BRAIN_EMBED_PROVIDER=openai + OPENAI_API_KEY); no results possible (no JSON index mirror found)';

/**
 * Select the index provider. Honors `options.provider`, then
 * BRAIN_INDEX_PROVIDER (`builtin` | `none` | `auto`, default `auto`).
 * `auto` picks `builtin` when the embedder is usable, else `none`.
 */
export async function getIndexProvider(options = {}) {
  const requested = options.provider || process.env.BRAIN_INDEX_PROVIDER || 'auto';
  if (requested === 'none') {
    return noneProvider('BRAIN_INDEX_PROVIDER=none');
  }
  // OpenAIProvider inherits available() → true; LocalProvider probes module
  // resolution without importing the heavy runtime.
  const embedder = openEmbedder(options);
  if (!(await embedder.available())) {
    if (requested === 'builtin') {
      throw new EmbedderUnavailableError(
        'BRAIN_INDEX_PROVIDER=builtin requested but no embedder is available ' +
        '(@xenova/transformers is not installed; for the OpenAI path set ' +
        'BRAIN_EMBED_PROVIDER=openai AND OPENAI_API_KEY).'
      );
    }
    return noneProvider(
    '@xenova/transformers is not installed (npm i @xenova/transformers), and the ' +
    'OpenAI embedder is not active (requires BRAIN_EMBED_PROVIDER=openai plus OPENAI_API_KEY)'
  );
  }
  return builtinProvider(embedder);
}

/** Today's semantic stack: embed the query, hit the store, hybrid-rescore. */
function builtinProvider(embedder) {
  return {
    name: 'builtin',
    modelName: embedder.modelName,
    dims: embedder.dims,
    available: () => true,
    async ensureIndex(opts = {}) {
      return runIndexScript(opts);
    },
    async search(query, opts = {}) {
      const store = await openStore({
        model: opts.model || embedder.modelName,
        dims: opts.dims || embedder.dims
      });
      try {
        const results = await retrieve(query, store, embedder, opts);
        return { results, warning: '' };
      } catch (error) {
        // Module resolvable but broken at import/load time (e.g. a partially
        // failed optional install): degrade to lexical instead of crashing.
        if (error instanceof EmbedderUnavailableError || error?.code === 'EMBEDDER_UNAVAILABLE') {
          return lexicalSearch(query, opts);
        }
        throw error;
      } finally {
        try { await store.close(); } catch { /* mirror flush is best-effort */ }
      }
    }
  };
}

/** Degraded provider: no embeddings; BM25 over the JSON mirror only. */
function noneProvider(reason) {
  return {
    name: 'none',
    reason,
    warning: LEXICAL_FALLBACK_WARNING,
    available: () => false,
    async ensureIndex() {
      return { ok: false, skipped: true, reason, warning: LEXICAL_FALLBACK_WARNING };
    },
    async search(query, opts = {}) {
      return lexicalSearch(query, opts);
    }
  };
}

/**
 * Pure-BM25 fallback over the JSON index mirror. Composes existing exported
 * pieces (JsonStore + matchesFilter from store.mjs, tfidfScore from
 * retrieval.mjs) — no new search engine. Result records mirror retrieve()'s
 * shape (denseScore/keywordScore/symbolScore/metadataScore + score) so
 * downstream formatters and staleness banners keep working unchanged.
 */
export async function lexicalSearch(query, opts = {}) {
  const store = new JsonStore(opts.jsonPath ? { path: opts.jsonPath } : {});
  const all = await store.getAll();
  if (!all.length) return { results: [], warning: NO_RESULTS_WARNING };
  const filter = opts.filter || {};
  const pool = all.filter(record => matchesFilter(record, filter));
  const scores = tfidfScore(query, pool);
  const maxScore = Math.max(1, ...scores.values());
  const topK = Number(opts.topK || process.env.BRAIN_TOP_K || 12);
  const results = pool
    .filter(record => (scores.get(record.id) || 0) > 0)
    .map(record => {
      const keywordScore = (scores.get(record.id) || 0) / maxScore;
      return {
        ...record,
        denseScore: 0,
        keywordScore,
        symbolScore: 0,
        metadataScore: 0,
        score: keywordScore
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return { results, warning: LEXICAL_FALLBACK_WARNING };
}

/** Spawn brain-index.mjs as a subprocess (same pattern as brain-sync.mjs). */
function runIndexScript(opts = {}) {
  const script = fileURLToPath(new URL('./brain-index.mjs', import.meta.url));
  const args = [script, ...(opts.force ? ['--force'] : [])];
  const result = spawnSync(process.execPath, args, {
    stdio: opts.stdio || 'inherit',
    env: { ...process.env, ...(opts.env || {}) }
  });
  return { ok: (result.status || 0) === 0, skipped: false, status: result.status || 0 };
}
