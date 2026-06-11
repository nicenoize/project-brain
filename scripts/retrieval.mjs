import path from 'node:path';
import { execSync } from 'node:child_process';
import { cosine } from './common.mjs';

export async function retrieve(query, store, embedder, opts = {}) {
  const topK = Number(opts.topK || process.env.BRAIN_TOP_K || 8);
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

  // BRAIN_LEXICAL_UNION=1 (default OFF): merge the BM25 top-N over the full
  // corpus into the candidate pool, so records that are lexically on-topic but
  // outside the dense top-`candidates` neighborhood can still be scored.
  // Unlike broad mode, union records get a REAL dense score (cosine against
  // their stored vector) — with denseScore 0 the α=0.7 weighting buries them,
  // which is exactly the class-1 failure mode in docs/eval-failure-analysis.md.
  const lexicalUnion = opts.lexicalUnion ?? (process.env.BRAIN_LEXICAL_UNION === '1');
  if (lexicalUnion && !broad) {
    const unionTop = Number(opts.lexicalUnionTop || process.env.BRAIN_LEXICAL_UNION_TOP || 24);
    const allRecords = (await store.getAll()).filter(record => recordMatches(record, filter));
    const lexical = tfidfScore(query, allRecords);
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
    opts.trace.scored = scored.map(record => ({
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

  return limitChunksPerFile(scored, opts).slice(0, topK);
}

/**
 * Cap non-summary chunks per file so a single long file can't occupy
 * multiple top-K slots with near-duplicate content. Summaries (chunk: -1)
 * are always kept. Default 2; override via opts.maxChunksPerFile or
 * BRAIN_MAX_CHUNKS_PER_FILE. Set to 0 or Infinity to disable.
 */
function limitChunksPerFile(records, opts) {
  const limit = Number(
    opts.maxChunksPerFile ??
    process.env.BRAIN_MAX_CHUNKS_PER_FILE ??
    2
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
export function tfidfScore(query, records) {
  const queryTokens = tokenize(query);
  if (!records.length || !queryTokens.length) return new Map();
  const k1 = Number(process.env.BRAIN_BM25_K1 || 1.2);
  const b = Number(process.env.BRAIN_BM25_B || 0.75);
  const df = new Map();
  const docTokens = records.map(record => tokenize(recordText(record)));
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
  }
  const totalLen = docTokens.reduce((sum, tokens) => sum + tokens.length, 0);
  const avgdl = totalLen / docTokens.length || 1;
  const N = records.length;
  const scores = new Map();
  for (let i = 0; i < records.length; i++) {
    const tokens = docTokens[i];
    const dl = tokens.length || 1;
    let score = 0;
    const tfCache = new Map();
    for (const token of tokens) tfCache.set(token, (tfCache.get(token) || 0) + 1);
    for (const token of queryTokens) {
      const tf = tfCache.get(token) || 0;
      if (!tf) continue;
      const dfT = df.get(token) || 0;
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
      const norm = tf + k1 * (1 - b + b * (dl / avgdl));
      score += idf * (tf * (k1 + 1)) / norm;
    }
    scores.set(records[i].id, score);
  }
  return scores;
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
  boost += shallowBrainPathBoost(record);
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
  if (CANONICAL_ROOT_NAMES.has(baseName)) b += base * 1.6;
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

function shallowBrainPathBoost(record) {
  const file = String(record.file || '');
  if (!file.startsWith('.project-brain/')) return 0;
  const depth = file.split('/').length - 1;
  if (depth <= 1) return Number(process.env.BRAIN_BRAIN_ROOT_BOOST || 0.03);
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
  if (filter.type && record.type !== filter.type) return false;
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
