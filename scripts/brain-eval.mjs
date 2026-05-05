import fs from 'node:fs';
import { BRAIN_DIR, read } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';

const file = takeOption(process.argv, '--file') || `${BRAIN_DIR}/eval.json`;
const topK = Number(takeOption(process.argv, '--top-k') || process.env.BRAIN_EVAL_TOP_K || 5);
const cases = loadCases(file);
if (!cases.length) {
  console.error(`No eval cases found. Create ${file} with [{"query":"...","expectedFiles":["..."]}].`);
  process.exit(1);
}

const embedder = openEmbedder();
const store = await openStore({ model: embedder.modelName });
let hits = 0;
const results = [];
for (const item of cases) {
  const found = await retrieve(item.query, store, embedder, { topK });
  const expected = new Set(item.expectedFiles || []);
  const hit = found.some(record => expected.has(record.file));
  if (hit) hits++;
  results.push({
    query: item.query,
    expectedFiles: [...expected],
    hit,
    topFiles: found.map(record => ({ file: record.file, score: record.score, type: record.type }))
  });
}
await store.close();

const report = {
  cases: cases.length,
  hits,
  hitRate: cases.length ? hits / cases.length : 0,
  topK,
  results
};
console.log(JSON.stringify(report, null, 2));
if (process.env.BRAIN_EVAL_STRICT === '1' && hits !== cases.length) process.exit(1);

function loadCases(file) {
  if (fs.existsSync(file)) return JSON.parse(read(file));
  return [
    { query: 'vector store retrieval adapter', expectedFiles: ['docs/vector-db-upgrade-plan.md', 'scripts/store.mjs'] },
    { query: 'prompt pack token budget', expectedFiles: ['scripts/brain-pack.mjs'] },
    { query: 'session branch changed files', expectedFiles: ['scripts/brain-session.mjs'] }
  ];
}

function takeOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return '';
  return argv[index + 1] || '';
}
