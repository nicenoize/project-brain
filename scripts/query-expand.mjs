/**
 * Constrained query vocabulary expansion (issue #19) — DORMANT, default-off
 * behind BRAIN_QUERY_EXPAND=1. Variant 1 (deterministic / pure).
 *
 * The remaining measured failure class in docs/eval-failure-analysis.md is
 * vocabulary mismatch: the query says "getUserData" / "worktrees" / "auth_timeout"
 * while the corpus stores "user", "worktree", "auth". Candidate-side levers
 * (ADR 0014) can't help when the query TOKENS never occur. This adds a query-side
 * lever, with the graphify constraint that fits the house rules: expand the query
 * ONLY with tokens that actually exist in the corpus vocabulary. No invented
 * synonyms — every added token is intersected against the corpus token set, so a
 * variant that isn't already in the index is silently dropped.
 *
 * The derivations are lexical and judgment-free — camelCase / snake_case /
 * kebab / digit-boundary splitting, stemming-adjacent normalization (plural /
 * -ing / -ed stripping), inflectional forms, and vocabulary-constrained compound
 * splitting. No LLM, no thesaurus. The expanded tokens feed the existing
 * BM25 / lexical-union candidate path as query-side additions; the dense
 * embedding of the original query is unchanged (retrieve() embeds `query`, not
 * the expanded string).
 *
 * DORMANCY CONTRACT: retrieval.mjs only imports/invokes any of this when the
 * flag is set (dynamic import). With BRAIN_QUERY_EXPAND unset the lexical query
 * equals the original query byte-for-byte, no cache is read/written, and
 * retrieval is byte-identical to before — proven in tests/query-expand.test.mjs
 * and tests/retrieval.test.mjs.
 *
 * AUDITABILITY: retrieve() always prints the expansion to stderr when the flag
 * is on, and brain:search --json includes it. Nothing is hidden or invented.
 *
 * Pure cores (splitIdentifier, stemVariants, inflectionVariants, lexicalVariants,
 * compoundSplits, buildVocabulary, expandQuery) take plain data and are
 * unit-tested without a store/embedder/fs. The cache glue (getVocabulary) is the
 * only fs-touching part and is parameterised so it can be tested with temp paths.
 */
import path from 'node:path';
import { BRAIN_DIR, MANIFEST, read, exists, atomicWrite, sha256 } from './common.mjs';
import { tokenize, recordText } from './retrieval.mjs';

/** Default-OFF flag gate. */
export function queryExpandEnabled() {
  return process.env.BRAIN_QUERY_EXPAND === '1';
}

/** Cache sidecar (gitignored): { hash, df }. `hash` = manifest content hash. */
export const VOCAB_CACHE = path.join(BRAIN_DIR, '.query-vocab.json');

/** Hard ceiling on tokens added to a single query, so BM25 query length stays bounded. */
export const DEFAULT_MAX_EXPANSIONS = Number(process.env.BRAIN_QUERY_EXPAND_MAX || 16);

/** Minimum length of each half of a vocabulary-constrained compound split. */
const COMPOUND_MIN_PART = 4;

/**
 * PURE: split an identifier into its lowercased sub-parts on camelCase humps,
 * snake_case, kebab-case, and digit boundaries. Returns [self] (lowercased) when
 * nothing splits, so callers can test `parts.length > 1` to know a split
 * happened. Judgment-free — pure orthography.
 */
export function splitIdentifier(token) {
  const raw = String(token || '');
  if (!raw) return [];
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // fooBar -> foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTTPServer -> HTTP Server
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')       // v2 -> v 2
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .map(part => part.toLowerCase())
    .filter(part => part.length > 1);
}

/**
 * PURE: stemming-adjacent normalization — strip common inflectional suffixes to
 * recover a likely base form. Conservative and deterministic (no Porter table).
 * e.g. worktrees->worktree, policies->policy, locking->lock/locke, locked->lock.
 */
export function stemVariants(token) {
  const t = String(token || '').toLowerCase();
  const out = [];
  const push = v => { if (v && v.length > 1 && v !== t) out.push(v); };
  if (t.length > 4 && t.endsWith('ies')) push(t.slice(0, -3) + 'y');
  if (t.length > 4 && /(ses|xes|zes|ches|shes)$/.test(t)) push(t.slice(0, -2));
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) push(t.slice(0, -1));
  if (t.length > 5 && t.endsWith('ing')) { push(t.slice(0, -3)); push(t.slice(0, -3) + 'e'); }
  if (t.length > 4 && t.endsWith('ed')) { push(t.slice(0, -2)); push(t.slice(0, -2) + 'e'); }
  return dedupe(out);
}

/**
 * PURE: inflectional forms in the FORWARD direction (base -> plural / -ing /
 * -ed). Constrained to the corpus by the intersection in expandQuery, so
 * appending letters can never introduce a token the index doesn't contain.
 * e.g. lock->locks/locking/locked, expire->expires/expiring/expired.
 */
export function inflectionVariants(token) {
  const t = String(token || '').toLowerCase();
  if (t.length < 2) return [];
  const out = [t + 's', t + 'ing', t + 'ed'];
  if (/(s|x|z|ch|sh)$/.test(t)) out.push(t + 'es');
  if (t.endsWith('y') && t.length > 2) out.push(t.slice(0, -1) + 'ies');
  if (t.endsWith('e')) { out.push(t.slice(0, -1) + 'ing'); out.push(t + 'd'); out.push(t + 's'); }
  return dedupe(out.filter(v => v !== t));
}

/**
 * PURE: all vocabulary-free morphological candidates for one token — identifier
 * splits (when the token itself splits, e.g. a snake_case query token), stems,
 * and inflections. The result is INTERSECTED with the corpus vocabulary by the
 * caller; nothing here is ever emitted on its own.
 */
export function lexicalVariants(token) {
  const t = String(token || '').toLowerCase();
  const parts = splitIdentifier(t);
  const splits = parts.length > 1 ? parts : [];
  return dedupe([...splits, ...stemVariants(t), ...inflectionVariants(t)].filter(v => v !== t));
}

/**
 * PURE: vocabulary-constrained compound split. Find a single split point where
 * BOTH halves (each ≥ COMPOUND_MIN_PART chars) exist in the corpus vocabulary.
 * e.g. "worktree" -> ["work","tree"] iff both are in-vocab. Because both halves
 * must be real corpus tokens, this can never invent anything. Returns the first
 * valid split scanning left→right, or [] when none.
 */
export function compoundSplits(token, vocab) {
  const t = String(token || '').toLowerCase();
  const has = vocabHas(vocab);
  if (t.length < COMPOUND_MIN_PART * 2) return [];
  for (let i = COMPOUND_MIN_PART; i <= t.length - COMPOUND_MIN_PART; i++) {
    const left = t.slice(0, i);
    const right = t.slice(i);
    if (has(left) && has(right)) return [left, right];
  }
  return [];
}

/**
 * PURE: build the corpus vocabulary (token → document-frequency) from a record
 * set, tokenizing exactly the text BM25 sees (recordText) so the vocabulary and
 * the scorer agree on what a "corpus token" is. Document frequency (records
 * containing the token, not raw count) is what's cached + shown for audit.
 */
export function buildVocabulary(records = []) {
  const df = new Map();
  for (const record of records) {
    const seen = new Set(tokenize(recordText(record)));
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
  }
  return df;
}

/**
 * PURE: expand a query with in-vocabulary lexical variants only. Never adds a
 * token absent from `vocab`, never re-adds a token already in the query.
 * Deterministic order (identifier splits of raw words first, in query order,
 * then per-token stems/inflections/compound splits), capped at opts.max.
 *
 * @param {string} query
 * @param {Map<string,number>|Object} vocab  token → document frequency
 * @returns {{ query, queryTokens: string[], added: string[],
 *             detail: Array<{token, df, from}> }}
 */
export function expandQuery(query, vocab, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : DEFAULT_MAX_EXPANSIONS;
  const queryTokens = tokenize(query);
  const get = vocabGet(vocab);
  const seen = new Set(queryTokens);
  const added = [];
  const detail = [];
  const consider = (cand, from) => {
    if (added.length >= max) return;
    const token = String(cand || '');
    if (token.length < 2 || seen.has(token)) return;
    const df = get(token);
    if (!df) return; // not in corpus → never invented, always dropped
    seen.add(token);
    added.push(token);
    detail.push({ token, df, from });
  };

  // Identifier splitting works on the RAW query words (case + separators intact),
  // because tokenize() has already lowercased away camelCase humps.
  const rawWords = String(query || '').match(/[A-Za-z0-9_]+/g) || [];
  for (const word of rawWords) {
    const parts = splitIdentifier(word);
    if (parts.length > 1) for (const part of parts) consider(part, word);
  }

  // Morphological + compound variants of each lowercased query token.
  for (const token of queryTokens) {
    for (const variant of lexicalVariants(token)) consider(variant, token);
    for (const variant of compoundSplits(token, vocab)) consider(variant, token);
  }

  return { query: String(query || ''), queryTokens, added, detail };
}

// --- Cache glue (the only fs-touching part) --------------------------------

/** PURE: the manifest-content hash the vocabulary cache is keyed on. */
export function manifestHash(manifestText) {
  return sha256(String(manifestText || ''));
}

/** Read the vocab cache sidecar; missing/corrupt → null. Fail-silent. */
export function readVocabCache(cachePath = VOCAB_CACHE) {
  try {
    if (!exists(cachePath)) return null;
    const data = JSON.parse(read(cachePath));
    if (!data || typeof data.hash !== 'string' || !data.df) return null;
    return data;
  } catch {
    return null;
  }
}

/** Write the vocab cache sidecar atomically. Fail-silent (cache is an accelerator). */
export function writeVocabCache(hash, df, cachePath = VOCAB_CACHE) {
  try {
    const obj = df instanceof Map ? Object.fromEntries(df) : df;
    atomicWrite(cachePath, JSON.stringify({ hash, df: obj }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the corpus vocabulary, cached on disk and invalidated by the index
 * manifest hash. On a cache hit (hash matches) the store is never scanned; on a
 * miss it builds from store.getAll() once and persists. Parameterised paths keep
 * it unit-testable. Returns a Map<token, df>.
 */
export async function getVocabulary(store, opts = {}) {
  const manifestPath = opts.manifestPath || MANIFEST;
  const cachePath = opts.cachePath || VOCAB_CACHE;
  const hash = manifestHash(read(manifestPath, ''));
  const cached = readVocabCache(cachePath);
  if (cached && cached.hash === hash) {
    return new Map(Object.entries(cached.df));
  }
  const records = await store.getAll();
  const vocab = buildVocabulary(records);
  writeVocabCache(hash, vocab, cachePath);
  return vocab;
}

// --- internals --------------------------------------------------------------

function vocabGet(vocab) {
  if (vocab instanceof Map) return token => vocab.get(token) || 0;
  const obj = vocab || {};
  return token => obj[token] || 0;
}

function vocabHas(vocab) {
  const get = vocabGet(vocab);
  return token => get(token) > 0;
}

function dedupe(list) {
  return [...new Set(list)];
}
