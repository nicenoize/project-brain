import fs from 'node:fs';
import { JSON_INDEX, MANIFEST, read } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';

const args = process.argv.slice(2);
const summaryOnly = takeFlag(args, '--summary-only');
const modulesOnly = takeFlag(args, '--modules-only');
const query = args.join(' ').trim();
if (!query) {
  console.error('Usage: npm run brain:search -- "query" [--summary-only] [--modules-only]');
  process.exit(1);
}
if (!fs.existsSync(JSON_INDEX) && !fs.existsSync(MANIFEST)) {
  console.error('No semantic index found. Run: npm run brain:index');
  process.exit(1);
}

const manifest = fs.existsSync(MANIFEST) ? JSON.parse(read(MANIFEST)) : {};
const embedder = openEmbedder();
if (manifest.model && manifest.model !== embedder.modelName) {
  console.warn(`Index model is ${manifest.model}, but current embedder is ${embedder.modelName}. Run: npm run brain:index -- --force`);
}

const qv = await embedder.embed(query);
const topK = Number(process.env.BRAIN_TOP_K || 8);
const store = await openStore({ model: manifest.model || embedder.modelName });
const filter = { summaryOnly, modulesOnly };
const dense = await store.search(qv, Math.max(topK * 4, topK), filter);
const all = await store.getAll();
const keyword = tfidfScore(query, all.filter(record => recordMatches(record, filter)));
const alpha = Number(process.env.BRAIN_HYBRID_ALPHA || 0.7);
const maxKeyword = Math.max(1, ...keyword.values());

const scored = dense
  .map(record => ({
    ...record,
    denseScore: record.score,
    keywordScore: (keyword.get(record.id) || 0) / maxKeyword,
    score: hybridScore(record.score, (keyword.get(record.id) || 0) / maxKeyword, alpha)
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, topK);

for (const r of scored) {
  const flags = [r.type, r.isModuleSummary ? 'module-summary' : '', r.isSummary ? 'summary' : ''].filter(Boolean).join(',');
  console.log(`\n--- ${r.score.toFixed(4)} ${r.file}#chunk-${r.chunk} [${flags}]`);
  console.log(r.text.slice(0, 900).trim());
}
await store.close();

export function tfidfScore(query, records) {
  const queryTokens = tokenize(query);
  const df = new Map();
  const docs = records.map(record => new Set(tokenize(`${record.file} ${record.heading} ${record.title} ${record.text}`)));
  for (const doc of docs) {
    for (const token of doc) df.set(token, (df.get(token) || 0) + 1);
  }
  const scores = new Map();
  for (let i = 0; i < records.length; i++) {
    let score = 0;
    const textTokens = tokenize(`${records[i].file} ${records[i].heading} ${records[i].title} ${records[i].text}`);
    for (const token of queryTokens) {
      const tf = textTokens.filter(t => t === token).length;
      if (!tf) continue;
      const idf = Math.log((records.length + 1) / ((df.get(token) || 0) + 1)) + 1;
      score += tf * idf;
    }
    scores.set(records[i].id, score);
  }
  return scores;
}

export function hybridScore(dense, keyword, alpha) {
  return alpha * dense + (1 - alpha) * keyword;
}

export function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_/-]+/).filter(token => token.length > 1);
}

function recordMatches(record, filter) {
  if (filter.summaryOnly && !record.isSummary) return false;
  if (filter.modulesOnly && !record.isModuleSummary) return false;
  return true;
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}
