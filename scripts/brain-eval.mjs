/**
 * Retrieval-quality eval: runs a list of {query, expectedFiles/Symbols}
 * cases from .project-brain/eval.json (or built-in smoke set) and
 * reports recall@K + a per-case pass/fail line. Used to baseline
 * retrieval tuning before/after changes.
 */
import fs from 'node:fs';
import { BRAIN_DIR, read, peekOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';

const file = peekOption(process.argv, '--file') || `${BRAIN_DIR}/eval.json`;
const topK = Number(peekOption(process.argv, '--top-k') || process.env.BRAIN_EVAL_TOP_K || 8);
const cases = loadCases(file);
if (!cases.length) {
  console.error(`No eval cases found. Create ${file} with [{"query":"...","expectedFiles":["..."]}].`);
  process.exit(1);
}

const embedder = openEmbedder();
const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
const results = [];
for (const item of cases) {
  const found = await retrieve(item.query, store, embedder, {
    topK,
    symbol: item.expectedSymbols?.join(',') || item.symbol || '',
    filter: item.expectedTypes?.length === 1 ? { type: item.expectedTypes[0] } : {}
  });
  results.push(evaluateCase(item, found, topK));
}
await store.close();

const report = summarize(results, topK);
console.log(JSON.stringify(report, null, 2));
if (process.env.BRAIN_EVAL_STRICT === '1' && report.failures.length) process.exit(1);

function evaluateCase(item, found, topK) {
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

function summarize(results, topK) {
  const failures = results.filter(result => !result.hit);
  return {
    cases: results.length,
    topK,
    hitAtK: ratio(results.filter(result => result.hit).length, results.length),
    fileHitAtK: ratio(results.filter(result => !result.expectedFiles.length || result.ranks.file > 0).length, results.length),
    symbolHitAtK: ratio(results.filter(result => !result.expectedSymbols.length || result.ranks.symbol > 0).length, results.length),
    typeHitAtK: ratio(results.filter(result => !result.expectedTypes.length || result.ranks.type > 0).length, results.length),
    mrr: round(avg(results.map(result => result.reciprocalRank))),
    failures: failures.map(result => ({ query: result.query, expectedFiles: result.expectedFiles, expectedSymbols: result.expectedSymbols, expectedTypes: result.expectedTypes, ranks: result.ranks })),
    results
  };
}

function loadCases(file) {
  if (fs.existsSync(file)) return JSON.parse(read(file));
  return [
    { query: 'Qdrant adapter', expectedFiles: ['scripts/store.mjs'], expectedSymbols: ['QdrantStore'], expectedTypes: ['code'] },
    { query: 'prompt token budget', expectedFiles: ['scripts/brain-pack.mjs'], expectedSymbols: ['packPrompt'], expectedTypes: ['code'] },
    { query: 'changed file boost', expectedFiles: ['scripts/retrieval.mjs'], expectedSymbols: ['metadataBoost'], expectedTypes: ['code'] },
    { query: 'AST chunking', expectedFiles: ['scripts/chunk.mjs'], expectedSymbols: ['findSymbolsAst'], expectedTypes: ['code'] }
  ];
}

function firstRank(records, predicate) {
  if (!predicate) return 0;
  const index = records.findIndex(predicate);
  return index === -1 ? 0 : index + 1;
}

function matchesAny(value, expected = []) {
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

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function normalize(value) {
  return String(value).toLowerCase();
}

