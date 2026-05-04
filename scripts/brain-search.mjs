import fs from 'node:fs';
import { pipeline } from '@xenova/transformers';
import { JSON_INDEX, cosine } from './common.mjs';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npm run brain:search -- "query"');
  process.exit(1);
}
if (!fs.existsSync(JSON_INDEX)) {
  console.error('No semantic index found. Run: npm run brain:index');
  process.exit(1);
}
const index = JSON.parse(fs.readFileSync(JSON_INDEX, 'utf8'));
const extractor = await pipeline('feature-extraction', index.model || 'Xenova/all-MiniLM-L6-v2');
const out = await extractor(query, { pooling: 'mean', normalize: true });
const qv = Array.from(out.data);
const scored = index.records.map(r => ({ ...r, score: cosine(qv, r.vector) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, Number(process.env.BRAIN_TOP_K || 8));

for (const r of scored) {
  console.log(`\n--- ${r.score.toFixed(4)} ${r.file}#chunk-${r.chunk} [${r.type}]`);
  console.log(r.text.slice(0, 900).trim());
}
