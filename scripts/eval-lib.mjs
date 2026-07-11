/**
 * Pure helpers for the retrieval eval harness (brain-eval) and the paired
 * comparison tool (brain-eval-compare). No store/embedder/env access here —
 * everything takes plain data so it stays unit-testable.
 */
import { isTestLikePath } from './retrieval.mjs';
import { cosine } from './common.mjs';

/**
 * Hard cases are tagged via a `note` starting with "Hard:" (see
 * docs/eval-methodology.md). Absence of expectedSymbols is NOT the
 * discriminator — most easy cases lack symbols too.
 */
export function isHardCase(item) {
  return /^hard:/i.test(String(item?.note || '').trim());
}

/**
 * The hard subset is tagged by *type* so `--hard-only` deltas can be reported
 * per class (issue #33). Three classes, each exercising a different retrieval
 * weakness — see docs/eval-methodology.md:
 *   - vocabulary-mismatch: query synonyms, no filename/symbol overlap
 *   - why-style: rationale answerable only from an ADR ("why does X use Y?")
 *   - cross-file/structural: answer is a projection over the indexed graph
 */
export const HARD_CLASSES = ['vocabulary-mismatch', 'why-style', 'cross-file/structural'];

/** The case's `class` when it is one of HARD_CLASSES, else 'unclassified'. */
export function caseClass(item) {
  const cls = String(item?.class || '').trim();
  return HARD_CLASSES.includes(cls) ? cls : 'unclassified';
}

export function evaluateCase(item, found, topK) {
  const fileRank = firstRank(found, record => matchesAny(record.file, item.expectedFiles));
  const symbolRank = firstRank(found, record => intersects(record.symbols, item.expectedSymbols) || intersects(record.exportedSymbols, item.expectedSymbols));
  const typeRank = firstRank(found, record => matchesAny(record.type, item.expectedTypes));
  const hit = Boolean(
    (!item.expectedFiles?.length || fileRank > 0) &&
    (!item.expectedSymbols?.length || symbolRank > 0) &&
    (!item.expectedTypes?.length || typeRank > 0)
  );
  return {
    query: item.query,
    expectedFiles: item.expectedFiles || [],
    expectedSymbols: item.expectedSymbols || [],
    expectedTypes: item.expectedTypes || [],
    hard: isHardCase(item),
    class: caseClass(item),
    note: item.note || '',
    hit,
    ranks: { file: fileRank, symbol: symbolRank, type: typeRank },
    reciprocalRank: reciprocalRank([fileRank, symbolRank, typeRank]),
    topK,
    top: found.map(record => ({
      file: record.file,
      chunk: record.chunk,
      type: record.type,
      symbols: record.symbols || [],
      lineStart: record.lineStart || 0,
      lineEnd: record.lineEnd || 0,
      score: round(record.score),
      denseScore: round(record.denseScore),
      keywordScore: round(record.keywordScore),
      symbolScore: round(record.symbolScore),
      metadataScore: round(record.metadataScore)
    }))
  };
}

export function summarize(results, topK) {
  const failures = results.filter(result => !result.hit);
  const hard = results.filter(result => result.hard);
  return {
    cases: results.length,
    topK,
    hitAtK: ratio(results.filter(result => result.hit).length, results.length),
    fileHitAtK: ratio(results.filter(result => !result.expectedFiles.length || result.ranks.file > 0).length, results.length),
    symbolHitAtK: ratio(results.filter(result => !result.expectedSymbols.length || result.ranks.symbol > 0).length, results.length),
    typeHitAtK: ratio(results.filter(result => !result.expectedTypes.length || result.ranks.type > 0).length, results.length),
    mrr: round(avg(results.map(result => result.reciprocalRank))),
    hardCases: hard.length,
    hardHitAtK: ratio(hard.filter(result => result.hit).length, hard.length),
    hardMrr: round(avg(hard.map(result => result.reciprocalRank))),
    failures: failures.map(result => ({ query: result.query, expectedFiles: result.expectedFiles, expectedSymbols: result.expectedSymbols, expectedTypes: result.expectedTypes, ranks: result.ranks })),
    results
  };
}

/**
 * Per-case failure diagnosis from a retrieve() trace (opts.trace). Separates
 * candidate-generation failures (expected file never entered the dense pool)
 * from ranking failures (in the pool but outranked). `finalRank` is the rank
 * in the FULL sorted scored list (pre per-file capping), so "rank 9" and
 * "rank 200" are distinguishable; the displayed top-K rank stays in `ranks.file`.
 * `corpusDenseRank` (exact dense rank over the whole corpus) is computed when
 * `allRecords` (with vectors) is provided — it answers "would a wider candidate
 * pool alone have fixed this?".
 */
export function diagnoseCase(item, trace, { topK = 8, allRecords = null } = {}) {
  const expected = item.expectedFiles || [];
  const matches = record => matchesAny(record.file, expected);

  const finalRank = firstRank(trace.scored || [], matches);
  const denseRank = firstRank(trace.denseCandidates || [], matches);
  const inDensePool = denseRank > 0;

  let corpusDenseRank = null;
  if (allRecords?.length && trace.queryVector) {
    corpusDenseRank = denseRankInCorpus(trace.queryVector, allRecords, expected);
  }

  const distractors = (trace.scored || []).filter(record => !matches(record)).slice(0, 3);

  return {
    finalRank,
    denseRank,
    inDensePool,
    poolSize: trace.poolSize || 0,
    broad: Boolean(trace.broad),
    corpusDenseRank,
    distractors,
    distractorKinds: classifyDistractors((trace.scored || []).filter(record => !matches(record)).slice(0, topK)),
    suggestedClass: suggestClass({ finalRank, inDensePool, broad: Boolean(trace.broad), topK })
  };
}

/**
 * Mechanical pre-classification of a case outcome. Classes 3 (weak target
 * text) and 4 (unfair case) require human review and are never suggested here.
 */
export function suggestClass({ finalRank, inDensePool, broad, topK }) {
  if (finalRank > 0 && finalRank <= topK) return 'hit';
  // When the pool was the full corpus (broad mode), every record was scored,
  // so a miss is by definition a ranking failure.
  if (!inDensePool && !broad) return 'candidate-generation';
  return 'ranking';
}

/** Exact dense rank of the best chunk of any expected file over the full corpus. 0 = no expected record found. */
export function denseRankInCorpus(queryVector, allRecords, expectedFiles = []) {
  if (!expectedFiles.length) return 0;
  const ranked = allRecords
    .filter(record => Array.isArray(record.vector) && record.vector.length)
    .map(record => ({ file: record.file, score: cosine(queryVector, record.vector) }))
    .sort((a, b) => b.score - a.score);
  const index = ranked.findIndex(record => expectedFiles.includes(record.file));
  return index === -1 ? 0 : index + 1;
}

/** Bucket distractor records by path kind so ranking failures show what outranked the target. */
export function classifyDistractors(records) {
  const kinds = { test: 0, session: 0, brainDoc: 0, code: 0, other: 0 };
  for (const record of records) {
    const file = String(record.file || '');
    if (isTestLikePath(file)) kinds.test++;
    else if (file.includes('/sessions/')) kinds.session++;
    else if (file.startsWith('.project-brain/')) kinds.brainDoc++;
    else if (/\.[cm]?[jt]sx?$|\.py$|\.go$/.test(file)) kinds.code++;
    else kinds.other++;
  }
  return kinds;
}

/**
 * Pair two brain:eval reports by query (queries are unique — enforced by
 * tests/eval-cases.test.mjs). Throws when the case sets differ: a paired
 * bootstrap is only meaningful over identical cases.
 */
export function pairCases(reportA, reportB, { hardOnly = false } = {}) {
  const select = results => (results || []).filter(result => !hardOnly || result.hard);
  const selectedA = select(reportA.results);
  const selectedB = select(reportB.results);
  const byQueryB = new Map(selectedB.map(result => [result.query, result]));
  const missing = selectedA.filter(result => !byQueryB.has(result.query)).map(result => result.query);
  const extra = selectedB.length - (selectedA.length - missing.length);
  if (missing.length || extra) {
    throw new Error(
      `Case sets differ — paired bootstrap needs identical cases. ` +
      `Missing from variant: ${missing.length ? missing.slice(0, 3).join(' | ') : 'none'}` +
      `${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}; extra in variant: ${extra}.`
    );
  }
  const pairsA = [];
  const pairsB = [];
  for (const result of selectedA) {
    const other = byQueryB.get(result.query);
    pairsA.push({ hit: result.hit ? 1 : 0, reciprocalRank: result.reciprocalRank || 0 });
    pairsB.push({ hit: other.hit ? 1 : 0, reciprocalRank: other.reciprocalRank || 0 });
  }
  return { pairsA, pairsB, cases: pairsA.length };
}

/**
 * PURE: per-class hit@K / MRR deltas over two paired eval reports (issue #33).
 * Pairs cases by query (respecting `hardOnly`), groups the paired set by the
 * case's class (taken from report A; falls back to caseClass, then
 * 'unclassified' for pre-#33 reports), and returns one row per class present.
 * Point estimates only — the paired *bootstrap* CI stays on the whole hard
 * subset (per-class n is too small to bootstrap; these deltas orient which
 * class moved). Deterministic order: HARD_CLASSES first, then any extras
 * alphabetically. Rows carry no side effects.
 *
 * @returns {Array<{class, cases, baseline:{hitAtK,mrr}, variant:{hitAtK,mrr}, delta:{hit,mrr}}>}
 */
export function perClassDeltas(reportA, reportB, { hardOnly = false } = {}) {
  const select = results => (results || []).filter(result => !hardOnly || result.hard);
  const byQueryB = new Map(select(reportB.results).map(result => [result.query, result]));
  const groups = new Map();
  for (const a of select(reportA.results)) {
    const b = byQueryB.get(a.query);
    if (!b) continue; // only cases present in both runs are comparable
    const cls = a.class || caseClass(a);
    if (!groups.has(cls)) groups.set(cls, []);
    groups.get(cls).push([a, b]);
  }
  const order = cls => {
    const i = HARD_CLASSES.indexOf(cls);
    return i === -1 ? HARD_CLASSES.length : i;
  };
  return [...groups.entries()]
    .sort((x, y) => order(x[0]) - order(y[0]) || x[0].localeCompare(y[0]))
    .map(([cls, pairs]) => {
      const baseHit = avg(pairs.map(([a]) => (a.hit ? 1 : 0)));
      const varHit = avg(pairs.map(([, b]) => (b.hit ? 1 : 0)));
      const baseMrr = avg(pairs.map(([a]) => a.reciprocalRank || 0));
      const varMrr = avg(pairs.map(([, b]) => b.reciprocalRank || 0));
      return {
        class: cls,
        cases: pairs.length,
        baseline: { hitAtK: round(baseHit), mrr: round(baseMrr) },
        variant: { hitAtK: round(varHit), mrr: round(varMrr) },
        delta: { hit: round(varHit - baseHit), mrr: round(varMrr - baseMrr) }
      };
    });
}

/**
 * Paired bootstrap over two eval runs (same cases, paired by query).
 * `pairsA` / `pairsB` are arrays of { hit: 0|1, reciprocalRank: number } in
 * identical case order. Returns Δ point estimates (B − A) and 95% percentile
 * CIs for hit rate and MRR. Deterministic for a given seed (mulberry32).
 */
export function pairedBootstrap(pairsA, pairsB, { resamples = 10000, seed = 42 } = {}) {
  if (pairsA.length !== pairsB.length || !pairsA.length) {
    throw new Error(`pairedBootstrap needs two equal-length non-empty runs (got ${pairsA.length} vs ${pairsB.length})`);
  }
  const n = pairsA.length;
  const hitDelta = avg(pairsB.map(p => p.hit)) - avg(pairsA.map(p => p.hit));
  const mrrDelta = avg(pairsB.map(p => p.reciprocalRank)) - avg(pairsA.map(p => p.reciprocalRank));

  const rand = mulberry32(seed);
  const hitDeltas = new Array(resamples);
  const mrrDeltas = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let hitSum = 0, mrrSum = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rand() * n);
      hitSum += pairsB[j].hit - pairsA[j].hit;
      mrrSum += pairsB[j].reciprocalRank - pairsA[j].reciprocalRank;
    }
    hitDeltas[r] = hitSum / n;
    mrrDeltas[r] = mrrSum / n;
  }
  const hitCI = percentileCI(hitDeltas);
  const mrrCI = percentileCI(mrrDeltas);
  return {
    cases: n,
    resamples,
    seed,
    hit: { delta: round(hitDelta), ci95: hitCI, significant: ciExcludesZero(hitCI) },
    mrr: { delta: round(mrrDelta), ci95: mrrCI, significant: ciExcludesZero(mrrCI) }
  };
}

function percentileCI(values, lower = 0.025, upper = 0.975) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  return [round(at(lower)), round(at(upper))];
}

function ciExcludesZero([lo, hi]) {
  return lo > 0 || hi < 0;
}

/** Deterministic PRNG so bootstrap CIs are reproducible run-to-run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function firstRank(records, predicate) {
  if (!predicate) return 0;
  const index = records.findIndex(predicate);
  return index === -1 ? 0 : index + 1;
}

export function matchesAny(value, expected = []) {
  return expected.length ? expected.includes(value) : false;
}

function intersects(values = [], expected = []) {
  if (!expected.length) return false;
  const normalized = new Set(values.map(normalize));
  return expected.some(value => normalized.has(normalize(value)));
}

function reciprocalRank(ranks) {
  const present = ranks.filter(Boolean);
  if (!present.length) return 0;
  return 1 / Math.min(...present);
}

function ratio(value, total) {
  return total ? round(value / total) : 0;
}

export function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function normalize(value) {
  return String(value).toLowerCase();
}
