import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from '@xenova/transformers';
import { ROOT, BRAIN_DIR, JSON_INDEX, MANIFEST, ensureDir, read, write, sha256, listIndexableFiles, chunkText, parseDoc } from './common.mjs';

ensureDir(BRAIN_DIR);
ensureDir(path.join(BRAIN_DIR, 'vector-db'));

console.log('Loading local embedding model: Xenova/all-MiniLM-L6-v2');
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

async function embed(text) {
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

const files = await listIndexableFiles();
const records = [];
const manifest = { version: 1, model: 'Xenova/all-MiniLM-L6-v2', generated_at: new Date().toISOString(), files: {} };

for (const file of files) {
  const abs = path.join(ROOT, file);
  const content = read(abs);
  if (!content.trim()) continue;
  const hash = sha256(content);
  manifest.files[file] = { hash };
  const doc = parseDoc(file, content);
  const chunks = chunkText(doc.body);
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    const vector = await embed(`${file}\n${text}`);
    records.push({ id: sha256(`${file}:${i}:${hash}`), file, chunk: i, title: doc.data.title || path.basename(file), type: doc.data.type || inferType(file), text, vector });
  }
}

write(JSON_INDEX, JSON.stringify({ version: 1, model: manifest.model, records }, null, 2));
write(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`Indexed ${records.length} chunks from ${files.length} files into ${JSON_INDEX}`);

function inferType(file) {
  if (file.includes('/features/')) return 'feature';
  if (file.includes('/modules/')) return 'module';
  if (file.includes('/decisions/')) return 'decision';
  if (file.includes('/sessions/')) return 'session';
  if (file.endsWith('.tsx') || file.endsWith('.ts')) return 'code';
  return 'doc';
}
