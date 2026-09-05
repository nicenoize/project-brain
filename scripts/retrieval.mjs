import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { cosine, sha256 } from './common.mjs';

/**
 * Query-time staleness detector (ADR 0025, extends the ADR 0013 lazy-sync
 * story). Given the ≤ topK result `records`, return the distinct source files
 * whose on-disk content has drifted from what the index recorded — the files a
 * consumer should read directly (or re-sync) rather than trust the chunk for.
 *
 * OUTPUT-ONLY: this never touches ranking. It is a two-stage check, bounded at
 * ≤ `opts.max` (default 8) distinct file reads:
 *   1. `fs.stat` mtime vs `record.mtime` — cheap gate; skip files not newer.
 *   2. ONLY for mtime-newer files, confirm sha256(content) vs `record.hash`.
 * Stage 2 kills the git-branch-switch false positive: a checkout rewrites file
 * mtimes to "now" with byte-identical content, so mtime looks newer but the
 * hash matches → NOT reported. A real unsynced edit changes the hash → reported.
 *
 * Records without both `mtime` and `hash` are skipped (nothing to compare),
 * which also naturally excludes synthetic aggregate records whose placeholder
 * `file` paths don't exist on disk. Missing files are skipped (a deleted result
 * can't be "read directly"; deletion staleness is common.mjs's concern — #32).
 * Read/stat errors are swallowed so this can never break a query.
 *
 * Kept deliberately disjoint from common.mjs `staleIndexFromRecords` (whole-
 * corpus, unbounded, hashes every file) — this is the bounded hot-path variant.
 */
export function staleResults(records = [], opts = {}) {
  const root = opts.root || process.cwd();
  const max = Number.isFinite(opts.max) ? opts.max : 8;
  const stale = [];
  const seen = new Set();
  for (const record of records) {
    const file = record && record.file;
    if (!file || seen.has(file)) continue;
    if (!record.mtime || !record.hash) continue;
    if (seen.size >= max) break;
    seen.add(file);
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    let st;
    try { st = fs.statSync(full); } catch { continue; } // missing → skip
    const recMtime = Date.parse(record.mtime);
    if (!Number.isFinite(recMtime)) continue;
    // Stage 1: mtime gate. Not newer on disk → cannot be a fresh edit.
    if (st.mtimeMs <= recMtime) continue;
    // Stage 2: hash confirmation (kills the branch-switch mtime-bump case).
    let current;
    try { current = sha256(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (current !== record.hash) stale.push(file);
  }
  return stale;
}

/** Build the one-line staleness banner, or '' when nothing is stale. */
export function staleBanner(records = [], opts = {}) {
  if (process.env.BRAIN_STALE_BANNER === '0') return '';
  const stale = staleResults(records, opts);
  if (!stale.length) return '';
  return `⚠ index stale for ${stale.length} file(s): ${stale.join(', ')} — read those files directly or run npm run brain:sync`;
}

/**
 * Results a search returns by default.
 *
 * Raised from 8 to 12 on measurement, not taste. Ten questions against a real
 * 14,145-record repo, ground truth authored by that repo's own module records:
 *
 *   top-8    recall 0.50
 *   top-12   recall 0.60     +0.10 for four more results
 *   top-16   recall 0.60     nothing
 *   top-24   recall 0.70     +0.10 for twelve more
 *
 * Twelve is the knee. It costs 261 tokens (474 -> 735 on a real query), which
 * is far less than a missed search costs: the agent falls back to grep, reads
 * wrong files, and pays for all of them.
 *
 * The cases live in docs/eval-clubops-cases.json; `brain:eval --top-k N`
 * re-derives this table on any repo. Six attempts to lift recall by TUNING
 * (metadata boosts, the TS symbol graph on and off, removing 94k junk records,
 * disabling keyword scoring, widening the candidate pool 40->800) moved it by
 * zero. The files that miss rank 39 to 90; no weight lifts a rank-90 result
 * into the top eight. Widening the window was the only thing that worked.
 */
export const DEFAULT_TOP_K = Number(process.env.BRAIN_TOP_K || 12);

export async function retrieve(query, store, embedder, opts = {}) {
  const topK = Number(opts.topK || DEFAULT_TOP_K);
  const candidates = Number(opts.candidates || process.env.BRAIN_CANDIDATES || Math.max(topK * 8, 32));
  const filter = opts.filter || {};
  const queryVector = await embedder.embed(query);
  const dense = (await store.search(queryVector, candidates, filter))
    .filter(record => recordMatches(record, filter));

  // Default: score only over dense candidates (fast, O(candidates) not O(N)).
  // BRAIN_BROAD_CANDIDATES=1 falls back to full corpus scan for cases where
  // keyword/symbol relevance may live outside the top-K dense neighborhood.
  const broad = opts.broadCandidates ?? (process.env.BRAIN_BROAD_CANDIDATES === '1');
  const pool = broad
    ? (await store.getAll()).filter(record => recordMatches(record, filter))
    : dense;

  // BRAIN_GRAPH_EXPAND=1 (default OFF): one-hop graph expansion. Pull in
  // structurally-adjacent records (by references/symbols, imports, cross-project
  // edges) reachable from the top-N dense seeds so neighbors that don't dense-
  // rank on their own can still surface. Heavier than the default path because
  // it needs store.getAll(); only ever calls it when the flag is set.
  const neighborIds = new Set();
  let graphBonus = 0;
  if (process.env.BRAIN_GRAPH_EXPAND === '1') {
    const seedCount = Number(process.env.BRAIN_GRAPH_EXPAND_SEEDS || 5);
    const seeds = dense.slice(0, Math.max(0, seedCount));
    if (seeds.length) {
      graphBonus = clampGraphBonus(Number(process.env.BRAIN_GRAPH_EXPAND_BONUS || 0.08));
      const allRecords = (await store.getAll()).filter(record => recordMatches(record, filter));
      const neighbors = expandByGraph(seeds, allRecords, {
        max: Number(process.env.BRAIN_GRAPH_EXPAND_MAX || 12)
      });
      const inPool = new Set(pool.map(r => r.id));
      for (const neighbor of neighbors) {
        if (inPool.has(neighbor.id)) continue;
        inPool.add(neighbor.id);
        neighborIds.add(neighbor.id);
        pool.push(neighbor);
      }
    }
  }

  const denseScores = new Map(dense.map(record => [record.id, record.score]));

  // Merge the BM25 top-N over the full corpus into the candidate pool, so
  // records that are lexically on-topic but outside the dense top-`candidates`
  // neighborhood can still be scored. Union records get a REAL dense score
  // (cosine against their stored vector) — with denseScore 0 the alpha=0.7
  // weighting buries them, the class-1 failure mode in
  // docs/eval-failure-analysis.md.
  //
  // DEFAULT ON since 2026-09-05. It shipped off because it cost 1.03 s per
  // query; with the corpus cached per process that is now ~20 ms on a warm
  // reader. Measured on 138 own cases, same corpus back to back: recall
  // 0.775 -> 0.841, hard cases 0.706 -> 0.784, and on the hit metric 10 cases
  // gained against 1 lost (sign test p = 0.006). MRR moves +0.033 at t = 1.68,
  // i.e. not significant — rank order inside the top-K reshuffles both ways.
  // The claim is therefore "the file is found more often", not "ranked better".
  // Set BRAIN_LEXICAL_UNION=0 to restore dense-only candidate generation.
  const lexicalUnion = opts.lexicalUnion ?? (process.env.BRAIN_LEXICAL_UNION !== '0');
  if (lexicalUnion && !broad) {
    const unionTop = Number(opts.lexicalUnionTop || process.env.BRAIN_LEXICAL_UNION_TOP || 24);
    const { records: allRecords, index: bm25 } = await corpusFor(store, filter);
    const lexical = tfidfScore(query, allRecords, bm25);
    const inPool = new Set(pool.map(record => record.id));
    const unionRecords = allRecords
      .filter(record => (lexical.get(record.id) || 0) > 0 && !inPool.has(record.id))
      .sort((a, b) => (lexical.get(b.id) || 0) - (lexical.get(a.id) || 0))
      .slice(0, Math.max(0, unionTop));
    for (const record of unionRecords) {
      pool.push(record);
      if (Array.isArray(record.vector) && record.vector.length) {
        denseScores.set(record.id, cosine(queryVector, record.vector));
      }
    }
  }

  const keyword = tfidfScore(query, pool);
  const symbol = symbolScore(query, pool, opts);
  const maxKeyword = Math.max(1, ...keyword.values());
  const context = retrievalContext({ ...opts, query });
  const alpha = Number(opts.alpha || process.env.BRAIN_HYBRID_ALPHA || 0.7);
  const keywordScale = keywordScaleForContext(context);

  const scored = pool
    .map(record => {
      const denseScore = denseScores.get(record.id) || 0;
      const keywordScore = ((keyword.get(record.id) || 0) / maxKeyword) * keywordScale;
      const symbolMatchScore = symbol.get(record.id) || 0;
      // Graph-proximity is a small additive nudge applied through the same
      // metadata channel (clamped in hybridScore) so it can't drown a real
      // dense hit. Only neighbors pulled in by expansion receive it.
      const metadataScore = metadataBoost(record, context) + (neighborIds.has(record.id) ? graphBonus : 0);
      return {
        ...record,
        denseScore,
        keywordScore,
        symbolScore: symbolMatchScore,
        metadataScore,
        score: hybridScore(denseScore, keywordScore, symbolMatchScore, metadataScore, alpha)
      };
    })
    .sort((a, b) => b.score - a.score);

  // BRAIN_RERANK=1 (default OFF): cross-encoder rerank of the scored head
  // (BRAIN_RERANK_TOP, default 20) before per-file capping. Targets that the
  // hybrid layer misorders inside the pool — the class-2 failure mode in
  // docs/eval-failure-analysis.md — get re-judged with the query and chunk
  // read together. Dynamic import so the flag-off path never loads the model.
  let ranked = scored;
  if (opts.rerank ?? (process.env.BRAIN_RERANK === '1')) {
    const { rerank } = await import('./rerank.mjs');
    ranked = await rerank(query, scored, {
      top: opts.rerankTop,
      model: opts.rerankModel
    });
  }

  // Diagnostic out-param (opt-in, zero behavior change): when the caller passes
  // opts.trace = {}, expose the raw dense candidate list, the full sorted scored
  // list (pre per-file capping / pre top-K truncation), and the query vector so
  // eval tooling can distinguish candidate-generation misses from ranking misses.
  if (opts.trace && typeof opts.trace === 'object') {
    opts.trace.queryVector = queryVector;
    opts.trace.broad = broad;
    opts.trace.poolSize = pool.length;
    opts.trace.denseCandidates = dense.map(record => ({
      id: record.id, file: record.file, chunk: record.chunk, score: record.score
    }));
    opts.trace.scored = ranked.map(record => ({
      id: record.id,
      file: record.file,
      chunk: record.chunk,
      type: record.type,
      score: record.score,
      denseScore: record.denseScore,
      keywordScore: record.keywordScore,
      symbolScore: record.symbolScore,
      metadataScore: record.metadataScore
    }));
  }

  return limitChunksPerFile(ranked, opts).slice(0, topK);
}

/**
 * Cap non-summary chunks per file so a single long file can't occupy
 * multiple top-K slots with near-duplicate content. Summaries (chunk: -1)
 * are always kept. Override via opts.maxChunksPerFile or
 * BRAIN_MAX_CHUNKS_PER_FILE; 0 or Infinity disables the cap.
 *
 * Default 1 since 2026-09-05, down from 2. A second chunk of a file already in
 * the list answers a question nobody asked twice: club-ops' notification query
 * spent two of twelve slots on two chunks of the same mark-read.tsx while the
 * file that actually answered it sat at rank 15. Across 138 own cases the
 * change improved 4 and degraded 0 — it only ever frees a slot.
 */
function limitChunksPerFile(records, opts) {
  const limit = Number(
    opts.maxChunksPerFile ??
    process.env.BRAIN_MAX_CHUNKS_PER_FILE ??
    1
  );
  if (!Number.isFinite(limit) || limit <= 0) return records;
  const seen = new Map();
  const out = [];
  for (const record of records) {
    if (record.isSummary) {
      out.push(record);
      continue;
    }
    const key = record.file || record.id;
    const count = seen.get(key) || 0;
    if (count >= limit) continue;
    seen.set(key, count + 1);
    out.push(record);
  }
  return out;
}

/**
 * BM25 keyword score with document-length normalization.
 * k1 controls term-frequency saturation (default 1.2); b controls length
 * normalization (default 0.75, full length normalization). Pluses one to
 * the idf term to keep all scores non-negative even when df > N/2.
 */
/**
 * Corpus + its tokenized BM25 index, reused across queries in one process.
 *
 * The lexical union scores BM25 over every record, and both halves of that —
 * reading the corpus and tokenizing it — are query-independent. Recomputing
 * them per query cost 1.03 s of the 1.26 s a union search took on a 14k-record
 * index, for a result that cannot differ between two queries.
 *
 * Keyed on the store instance AND its corpusVersion(), so a backend that cannot
 * report a version (null) is never cached — an unknown corpus is a changed one.
 * The cache is per-process and holds one corpus per store; a one-shot CLI search
 * still pays full price, which is why the union stays a measured trade rather
 * than a free lunch. Long-lived readers (MCP server, `serve`, eval) pay once.
 */
const corpusCache = new WeakMap();

async function corpusFor(store, filter) {
  const version = await store.corpusVersion?.().catch(() => null) ?? null;
  const filterKey = JSON.stringify(filter ?? null);
  const hit = corpusCache.get(store);
  if (version !== null && hit && hit.version === version && hit.filterKey === filterKey) return hit;
  const records = (await store.getAll()).filter(record => recordMatches(record, filter));
  const entry = { version, filterKey, records, index: buildBm25Index(records) };
  if (version !== null) corpusCache.set(store, entry);
  return entry;
}

/**
 * PURE. The query-independent half of BM25: tokenize every document once and
 * derive df / avg length / per-doc term frequencies.
 *
 * It was inlined in `tfidfScore`, which meant the whole corpus was re-tokenized
 * on every single query. On the lexical-union path (BM25 over all records) that
 * was 523 ms per search on a 14k-record index — for work whose result cannot
 * change between two queries against the same corpus.
 */
export function buildBm25Index(records) {
  const docTokens = records.map(record => tokenize(recordText(record)));
  const df = new Map();
  for (const tokens of docTokens) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) || 0) + 1);
  }
  const tf = docTokens.map(tokens => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  });
  const totalLen = docTokens.reduce((sum, tokens) => sum + tokens.length, 0);
  return {
    ids: records.map(record => record.id),
    tf,
    dl: docTokens.map(tokens => tokens.length || 1),
    df,
    avgdl: totalLen / (docTokens.length || 1) || 1,
    N: records.length,
  };
}

/** PURE. Score a tokenized query against a prebuilt index. */
export function bm25Score(queryTokens, index) {
  const scores = new Map();
  if (!index || !index.N || !queryTokens.length) return scores;
  const k1 = Number(process.env.BRAIN_BM25_K1 || 1.2);
  const b = Number(process.env.BRAIN_BM25_B || 0.75);
  const { N, df, avgdl } = index;
  for (let i = 0; i < index.N; i++) {
    const counts = index.tf[i];
    const dl = index.dl[i];
    let score = 0;
    for (const token of queryTokens) {
      const termFreq = counts.get(token) || 0;
      if (!termFreq) continue;
      const dfT = df.get(token) || 0;
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
      const norm = termFreq + k1 * (1 - b + b * (dl / avgdl));
      score += idf * (termFreq * (k1 + 1)) / norm;
    }
    scores.set(index.ids[i], score);
  }
  return scores;
}

/**
 * BM25 keyword score with document-length normalization.
 * k1 controls term-frequency saturation (default 1.2); b controls length
 * normalization (default 0.75). Pass `index` (from buildBm25Index) to reuse
 * a corpus already tokenized; the result is identical either way.
 */
export function tfidfScore(query, records, index = null) {
  const queryTokens = tokenize(query);
  if (!records.length || !queryTokens.length) return new Map();
  return bm25Score(queryTokens, index || buildBm25Index(records));
}

export function symbolScore(query, records, opts = {}) {
  const expected = new Set(splitList(opts.symbol || opts.expectedSymbol || '').map(normalizeSymbol));
  const queryTokens = new Set(tokenize(query).map(normalizeSymbol));
  // BRAIN_SYMBOL_SUBSTRING_GUARD=1 (default OFF): restrict the fuzzy 0.45
  // substring tier to tokens that show symbol intent — explicit --symbol mode,
  // or identifier-shaped words in the raw query (camelCase hump, underscore,
  // digit, $). Without the guard, plain-English tokens like "tree" substring-
  // match symbols like `worktree` and hand a ×(1+0.6·0.45) multiplier to
  // distractors on conceptual queries (class-2 hybrid demotion, see
  // docs/eval-failure-analysis.md). Exact (1.0) and whole-token (0.85) tiers
  // are unaffected.
  const guard = opts.symbolSubstringGuard ?? (process.env.BRAIN_SYMBOL_SUBSTRING_GUARD === '1');
  const substringTokens = !guard || expected.size
    ? queryTokens
    : new Set(
      String(query || '')
        .split(/[^A-Za-z0-9_$]+/)
        .filter(word => word.length > 1 && /([a-z][A-Z])|[_$\d]/.test(word))
        .map(normalizeSymbol)
    );
  const scores = new Map();
  for (const record of records) {
    const symbols = [...(record.symbols || []), ...(record.exportedSymbols || [])].map(normalizeSymbol);
    let score = 0;
    for (const symbol of symbols) {
      if (expected.has(symbol)) score = Math.max(score, 1);
      else if (queryTokens.has(symbol)) score = Math.max(score, 0.85);
      else if ([...substringTokens].some(token => token && symbol.includes(token))) score = Math.max(score, 0.45);
    }
    if (score) scores.set(record.id, score);
  }
  return scores;
}

// hybridScore = base * (1 + symbol_boost) + clamped_metadata, capped in [0, 2].
// base = α·dense + (1-α)·kw keeps dense/keyword on a normalized 0..1 line.
// Symbol acts as a multiplier so a strong symbol match amplifies an already
// relevant chunk without letting symbol alone outrank a perfect dense hit.
// Metadata is a small additive nudge, clamped so boosts/penalties cannot drown
// the underlying relevance signal.
export function hybridScore(dense, keyword, symbol, metadata, alpha) {
  const symbolWeight = Number(process.env.BRAIN_SYMBOL_WEIGHT || 0.6);
  const base = alpha * dense + (1 - alpha) * keyword;
  const meta = Math.max(-0.5, Math.min(0.5, metadata));
  const raw = base * (1 + symbolWeight * symbol) + meta;
  return Math.max(0, Math.min(2, raw));
}

/**
 * One-hop graph expansion (pure, unit-testable). Given the dense `seeds` and
 * the full record set `allRecords`, return the set of structurally-adjacent
 * neighbor records reachable in a single hop. No store/embedder/env reads —
 * the caller supplies all data and `opts.max` (neighbor cap).
 *
 * Edges walked (both directions where it makes sense):
 *  - references → symbols: a seed's `references` resolve to records that DECLARE
 *    that symbol (in `symbols`/`exportedSymbols`); a seed's declared symbols
 *    resolve to records that REFERENCE them. Mirrors brain-graph's calls: edges.
 *  - imports: records sharing an import specifier with a seed.
 *  - cross-project edges: cross-project-edge records whose edgeFrom/edgeTo touch
 *    a seed's project, plus records in the project on the other end of such an
 *    edge from a seed.
 *
 * Symbol matching is normalized (normalizeSymbol) for consistency with the
 * rest of this module; collisions on a common normalized name are accepted as
 * over-inclusion (capped by opts.max).
 */
export function expandByGraph(seeds, allRecords, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 12;
  if (max <= 0 || !seeds.length || !allRecords.length) return [];

  const seedIds = new Set(seeds.map(r => r.id));

  // Indexes over the full corpus, built once.
  const declaresSymbol = new Map();   // normSymbol -> [records that declare it]
  const referencesSymbol = new Map(); // normSymbol -> [records that reference it]
  const importsSpecifier = new Map(); // specifier  -> [records importing it]
  const recordsByProject = new Map(); // project    -> [records]
  const crossEdges = [];              // cross-project-edge records
  for (const record of allRecords) {
    for (const sym of [...(record.symbols || []), ...(record.exportedSymbols || [])]) {
      pushTo(declaresSymbol, normalizeSymbol(sym), record);
    }
    for (const ref of record.references || []) {
      pushTo(referencesSymbol, normalizeSymbol(ref), record);
    }
    for (const spec of record.imports || []) {
      pushTo(importsSpecifier, spec, record);
    }
    if (record.project) pushTo(recordsByProject, record.project, record);
    if (record.type === 'cross-project-edge' && record.edgeFrom && record.edgeTo) {
      crossEdges.push(record);
    }
  }

  const out = [];
  const added = new Set();
  const add = (record) => {
    if (!record || seedIds.has(record.id) || added.has(record.id)) return;
    added.add(record.id);
    out.push(record);
  };

  for (const seed of seeds) {
    if (out.length >= max) break;
    // seed.references → records declaring that symbol
    for (const ref of seed.references || []) {
      for (const target of declaresSymbol.get(normalizeSymbol(ref)) || []) add(target);
    }
    // seed declared symbols → records referencing them
    for (const sym of [...(seed.symbols || []), ...(seed.exportedSymbols || [])]) {
      for (const target of referencesSymbol.get(normalizeSymbol(sym)) || []) add(target);
    }
    // shared imports
    for (const spec of seed.imports || []) {
      for (const target of importsSpecifier.get(spec) || []) add(target);
    }
    // cross-project edges touching the seed's project
    if (seed.project) {
      for (const edge of crossEdges) {
        let otherProject = '';
        if (edge.edgeFrom === seed.project) otherProject = edge.edgeTo;
        else if (edge.edgeTo === seed.project) otherProject = edge.edgeFrom;
        else continue;
        add(edge);
        for (const target of recordsByProject.get(otherProject) || []) add(target);
      }
    }
  }

  return out.slice(0, max);
}

function pushTo(map, key, value) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function clampGraphBonus(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.5, value));
}

export function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_/-]+/).filter(token => token.length > 1);
}

export function retrievalContext(opts = {}) {
  const changed = new Set(splitList(process.env.BRAIN_CONTEXT_FILES || opts.contextFiles || '').concat(gitChangedFiles()));
  const query = trimStr(opts.query ?? '');
  return {
    branch: opts.branch || process.env.BRAIN_BRANCH || gitBranch(),
    changed,
    symbolMode: Boolean(opts.symbol || opts.expectedSymbol),
    taskId: trimStr(opts.taskId ?? process.env.BRAIN_TASK),
    actor: trimStr(opts.actor ?? process.env.BRAIN_ACTOR),
    query,
    architectural: looksArchitecturalQuery(query),
    mentionsTest: /\b(test|tests|spec|jest|vitest|e2e|cypress|playwright|mock|fixture)\b/i.test(query)
  };
}

/** Heuristic for doc-style / architecture questions; shared with brain:ask routing. */
export function looksArchitecturalQuery(q) {
  const s = String(q || '').trim();
  if (!s) return false;
  return (
    /^(how|why|where|when|which|what|who)\b/i.test(s) ||
    /\b(decision|policy|architecture|architectural|plan|convention|workflow|gitflow|roadmap|vision|adr\b|rfc\b|design doc|blueprint|non-goal|requirements)\b/i.test(s)
  );
}

function metadataBoost(record, context) {
  let boost = 0;
  if (context.changed.has(record.file)) boost += Number(process.env.BRAIN_CHANGED_FILE_BOOST || 0.12);
  if (record.branch && context.branch && record.branch === context.branch) boost += Number(process.env.BRAIN_BRANCH_BOOST || 0.08);
  if (record.isModuleSummary) boost += Number(process.env.BRAIN_MODULE_SUMMARY_BOOST || 0.03);
  if (record.lineStart && record.lineEnd) {
    const defaultBoost = context.symbolMode ? 0.2 : 0.04;
    boost += Number(process.env.BRAIN_CODE_BODY_BOOST || defaultBoost);
  }
  if (context.taskId && record.taskId && record.taskId === context.taskId) {
    boost += Number(process.env.BRAIN_TASK_BOOST || 0.14);
  }
  if (context.actor && record.actor && record.actor === context.actor) {
    boost += Number(process.env.BRAIN_ACTOR_BOOST || 0.06);
  }
  boost += pathHeuristicAdjust(record, context);
  boost += recencyBoost(record);
  boost += canonicalBrainBoost(record, context);
  boost += shallowBrainPathBoost(record, context);
  boost += slopPenalty(record, context);
  return boost;
}

function keywordScaleForContext(context) {
  const base = Number(process.env.BRAIN_KEYWORD_SCALE || 1);
  if (context.architectural) return base * Number(process.env.BRAIN_ARCH_KEYWORD_SCALE || 1.15);
  return base;
}

function recencyBoost(record) {
  const iso = String(record.mtime || '').trim();
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / (86400 * 1000);
  const max = Number(process.env.BRAIN_RECENCY_MAX_BOOST || 0.06);
  const halfLife = Number(process.env.BRAIN_RECENCY_HALF_LIFE_DAYS || 21);
  if (days <= 0) return max;
  const w = Math.exp(-Math.log(2) * (days / halfLife));
  return max * w;
}

const CANONICAL_ROOT_NAMES = new Set(['context_index.md', 'master_plan.md', 'repo_context.md', 'product_plan.md', 'active_state.md', 'constitution.md']);

function canonicalBrainBoost(record, context) {
  const file = String(record.file || '');
  // Canonical-brain content lives under .project-brain/ (brain native) or
  // .specify/memory/ (spec-kit constitution). Both get the same boost path.
  if (!file.startsWith('.project-brain/') && !file.startsWith('.specify/memory/')) return 0;
  const base = Number(process.env.BRAIN_CANONICAL_ROOT_BOOST || 0.05);
  let b = 0;
  const baseName = file.split('/').pop() || '';
  // The root plans (master_plan.md, product_plan.md …) answer "what did we
  // decide", not "where is it implemented". Boosting them on every query put
  // OUR OWN metadata into 36% of the top-5 slots for code questions on a real
  // repo, and pushed the actual implementation out of reach: the correct file
  // for "sending a notification to a user" sat at dense rank 3 and left the
  // top five at final rank 6, beaten by .project-brain/modules/runner-tasks.md.
  // Gated on the same architectural signal the rest of this function uses.
  if (context.architectural && CANONICAL_ROOT_NAMES.has(baseName)) b += base * 1.6;
  if (context.architectural && /\/(decisions|modules|features)\//.test(file)) b += base * 1.1;
  const layer = String(record.layer || '').toLowerCase();
  const status = String(record.docStatus || '').toLowerCase();
  if (context.architectural && (layer === 'architecture' || layer === 'decision')) b += base * 0.9;
  if (status === 'canonical') b += base * 0.8;
  if (status === 'deprecated') b -= base * 1.2;
  // Spec-kit boost: surface specs/plans/tasks above generic docs on architectural queries.
  const speckitType = record.type === 'spec' || record.type === 'plan' || record.type === 'tasks-list' || record.type === 'constitution';
  if (speckitType && context.architectural) {
    b += Number(process.env.BRAIN_SPEC_BOOST || 0.04);
  }
  return b;
}

function shallowBrainPathBoost(record, context = {}) {
  const file = String(record.file || '');
  if (!file.startsWith('.project-brain/')) return 0;
  const depth = file.split('/').length - 1;
  // Same reasoning as canonicalBrainBoost: a shallow brain doc is the answer to
  // an architectural question and a distractor to a code one. The deep-path
  // penalty stays unconditional — it is about depth, not about intent.
  if (depth <= 1) return context.architectural ? Number(process.env.BRAIN_BRAIN_ROOT_BOOST || 0.03) : 0;
  if (depth >= 5) return -Number(process.env.BRAIN_DEEP_PATH_PENALTY || 0.02);
  return 0;
}

function slopPenalty(record, context) {
  let pen = 0;
  const file = String(record.file || '');
  const base = Number(process.env.BRAIN_SLOP_PENALTY || 0.12);
  const prov = String(record.provenance || '').toLowerCase();
  const syn = Boolean(record.synthetic);
  const noix = Boolean(record.noindex);
  const isSessionPath = file.includes('/sessions/');
  const baseFile = path.basename(file);
  const autoName = /__auto-compact__|\.auto/i.test(baseFile) || String(record.type || '').toLowerCase() === 'auto-compact';

  if (noix) pen += base * 2.2;
  if (prov === 'generated' || syn) pen += base * 1.4;
  if (autoName) pen += base * 1.8;
  if (isSessionPath && !autoName) pen += base * 0.55;
  if (isSessionPath && context.architectural && !(context.taskId && record.taskId === context.taskId)) {
    pen += base * 0.85;
  }
  if (context.taskId && record.taskId === context.taskId && isSessionPath) pen -= base * 0.5;
  return -pen;
}

/** Down-rank test-only paths when the query is not test-focused; up-rank canonical brain docs for architectural queries. */
function pathHeuristicAdjust(record, context) {
  let adj = 0;
  const file = String(record.file || '');
  if (context.architectural && file.startsWith('.project-brain/')) {
    const canonical =
      /\/(decisions|modules|features)\//.test(file) ||
      /(product_plan|context_index|repo_context|master_plan)\.md$/.test(file);
    if (canonical || record.type === 'decision' || record.type === 'module' || record.type === 'feature') {
      adj += Number(process.env.BRAIN_ARCH_DOC_BOOST || 0.12);
    } else if (record.isSummary && !file.includes('/sessions/')) {
      adj += Number(process.env.BRAIN_ARCH_SUMMARY_BOOST || 0.04);
    }
  }
  if (!context.symbolMode && isTestLikePath(file) && !context.mentionsTest) {
    adj -= Number(process.env.BRAIN_TEST_PATH_PENALTY || 0.08);
  }
  return adj;
}

export function isTestLikePath(file) {
  if (!file) return false;
  return (
    /(\/__tests__\/|\/tests?\/|\/test\/|\/e2e\/|\/spec\/|\.(test|spec)\.[cm]?[jt]sx?$)/i.test(file) ||
    /\.(test|spec)\.[cm]?js$/i.test(file)
  );
}

function trimStr(v) {
  return String(v ?? '').trim();
}

function recordMatches(record, filter) {
  if (filter.summaryOnly && !record.isSummary) return false;
  if (filter.modulesOnly && !record.isModuleSummary) return false;
  if (filter.type) {
    // String filter is unchanged; array widens to a set (brain:why + rationale).
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(record.type)) return false;
  }
  if (filter.file && record.file !== filter.file) return false;
  if (filter.project) {
    const allowed = Array.isArray(filter.project) ? filter.project : String(filter.project).split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(record.project)) return false;
  }
  if (filter.edgeKind && record.edgeKind !== filter.edgeKind) return false;
  if (filter.edgeFrom && record.edgeFrom !== filter.edgeFrom) return false;
  if (filter.edgeTo && record.edgeTo !== filter.edgeTo) return false;
  return true;
}

function recordText(record) {
  return [
    record.file,
    record.heading,
    record.title,
    record.type,
    record.layer,
    record.docStatus,
    record.provenance,
    record.module,
    record.feature,
    record.decision,
    ...(record.symbols || []),
    ...(record.exportedSymbols || []),
    ...(record.symbolKinds || []),
    ...(record.imports || []),
    ...(record.references || []),
    record.text
  ].filter(Boolean).join(' ');
}

function normalizeSymbol(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_$]/g, '');
}

function splitList(value) {
  return String(value).split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function gitBranch() {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function gitChangedFiles() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean)
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}
