import fs from 'node:fs';
import { BRAIN_DIR, read } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';

const args = process.argv.slice(2);
const maxTokens = Number(takeOption(args, '--max-tokens') || 3000);
const format = takeOption(args, '--format') || 'text';
const query = args.join(' ').trim();

if (!query && import.meta.url === `file://${process.argv[1]}`) {
  console.error('Usage: npm run brain:pack -- "query" [--max-tokens 3000] [--format json|text]');
  process.exit(1);
}

export async function packPrompt(query, opts = {}) {
  const budget = Number(opts.maxTokens || maxTokens);
  const embedder = openEmbedder(opts);
  const store = await openStore({ model: embedder.modelName });
  const qv = await embedder.embed(query);
  const dense = await store.search(qv, Number(process.env.BRAIN_PACK_CANDIDATES || 32));
  const all = await store.getAll();
  const keyword = tfidfScore(query, all);
  const alpha = Number(process.env.BRAIN_HYBRID_ALPHA || 0.7);
  const maxKeyword = Math.max(1, ...keyword.values());
  const ranked = dense
    .map(record => ({
      ...record,
      score: alpha * record.score + (1 - alpha) * ((keyword.get(record.id) || 0) / maxKeyword)
    }))
    .sort((a, b) => b.score - a.score);

  const sources = [];
  const parts = [];
  let used = 0;
  for (const core of coreFiles()) {
    const text = read(core.path).trim();
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (used + tokens > budget && parts.length) continue;
    parts.push(`## ${core.label}\n\n${text}`);
    sources.push({ file: core.path, tokens, core: true });
    used += tokens;
  }

  const seen = new Set();
  for (const record of ranked) {
    const key = `${record.file}:${record.heading || record.chunk}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = `## ${record.file}#chunk-${record.chunk}\n\n${record.text}`;
    const tokens = estimateTokens(text);
    if (used + tokens > budget) continue;
    parts.push(text);
    sources.push({ file: record.file, chunk: record.chunk, score: record.score, tokens });
    used += tokens;
  }
  await store.close();
  return { prompt: parts.join('\n\n'), sources, estimatedTokens: used };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packed = await packPrompt(query, { maxTokens });
  if (format === 'json') console.log(JSON.stringify(packed, null, 2));
  else console.log(packed.prompt);
}

function coreFiles() {
  return [
    { label: 'context_index.md', path: `${BRAIN_DIR}/context_index.md` },
    { label: 'active_state.md', path: `${BRAIN_DIR}/active_state.md` }
  ];
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const value = args[index + 1] || '';
  args.splice(index, 2);
  return value;
}

function tfidfScore(query, records) {
  const queryTokens = tokenize(query);
  const df = new Map();
  const docs = records.map(record => new Set(tokenize(`${record.file} ${record.heading} ${record.title} ${record.text}`)));
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) || 0) + 1);
  const scores = new Map();
  for (let i = 0; i < records.length; i++) {
    let score = 0;
    const textTokens = tokenize(`${records[i].file} ${records[i].heading} ${records[i].title} ${records[i].text}`);
    for (const token of queryTokens) {
      const tf = textTokens.filter(t => t === token).length;
      if (!tf) continue;
      score += tf * (Math.log((records.length + 1) / ((df.get(token) || 0) + 1)) + 1);
    }
    scores.set(records[i].id, score);
  }
  return scores;
}

function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_/-]+/).filter(token => token.length > 1);
}
