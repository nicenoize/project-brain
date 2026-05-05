import path from 'node:path';
import { ROOT, BRAIN_DIR, MANIFEST, ensureDir, read, write, sha256, listIndexableFiles, parseDoc } from './common.mjs';
import { dispatchChunker } from './chunk.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';

const force = process.argv.includes('--force');
const changedEnv = splitEnv('BRAIN_CHANGED_FILES');
const deletedEnv = splitEnv('BRAIN_DELETED_FILES');

ensureDir(BRAIN_DIR);
ensureDir(path.join(BRAIN_DIR, 'vector-db'));

let oldManifest = { files: {} };
try {
  oldManifest = JSON.parse(read(MANIFEST, '{"files":{}}'));
} catch {
  oldManifest = { files: {} };
}

const embedder = openEmbedder();
let forceRebuild = force;
if (oldManifest.model && oldManifest.model !== embedder.modelName) {
  console.warn(`Embedding model changed from ${oldManifest.model} to ${embedder.modelName}. Forcing full re-index.`);
  forceRebuild = true;
}

const store = await openStore({ model: embedder.modelName });
const files = await listIndexableFiles();
const fileSet = new Set(files);
const currentHashes = new Map();
for (const file of files) currentHashes.set(file, sha256(read(path.join(ROOT, file))));

let changedFiles = files.filter(file => forceRebuild || oldManifest.files?.[file]?.hash !== currentHashes.get(file));
let deletedFiles = Object.keys(oldManifest.files || {}).filter(file => !fileSet.has(file));

if (!forceRebuild && changedEnv.length) {
  const allowed = new Set(changedEnv);
  changedFiles = changedFiles.filter(file => allowed.has(file));
}
if (!forceRebuild && deletedEnv.length) {
  deletedFiles = [...new Set([...deletedFiles, ...deletedEnv])];
}

const deleteIds = [];
for (const file of [...changedFiles, ...deletedFiles]) {
  deleteIds.push(...(oldManifest.files?.[file]?.ids || []));
}
await store.delete(deleteIds);

const records = [];
for (const file of changedFiles) {
  const content = read(path.join(ROOT, file));
  if (!content.trim()) continue;
  const hash = currentHashes.get(file);
  const doc = parseDoc(file, content);
  const chunks = dispatchChunker(file, doc.body, doc.data);
  const vectors = await embedder.embedBatch(chunks.map(chunk => chunk.embeddingText || `${file}\n${chunk.text}`));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    records.push({
      id: sha256(`${file}:${chunk.chunk}:${hash}`),
      file,
      chunk: chunk.chunk,
      title: doc.data.title || path.basename(file),
      type: doc.data.type || inferType(file),
      heading: chunk.heading || '',
      text: chunk.text,
      embeddingText: chunk.embeddingText || `${file}\n${chunk.text}`,
      isSummary: Boolean(chunk.isSummary),
      isModuleSummary: false,
      vector: vectors[i]
    });
  }
}

if (records.length) await store.upsert(records);
await rebuildModuleSummaries(store, embedder);

const allRecords = await store.getAll();
const idsByFile = new Map();
for (const record of allRecords) {
  if (record.isModuleSummary || record.id.startsWith('session:')) continue;
  if (!idsByFile.has(record.file)) idsByFile.set(record.file, []);
  idsByFile.get(record.file).push(record.id);
}

const manifest = {
  version: 2,
  backend: process.env.BRAIN_STORE || 'auto',
  model: embedder.modelName,
  dims: embedder.dims,
  generated_at: new Date().toISOString(),
  records: allRecords.length,
  files: {}
};
for (const file of files) {
  manifest.files[file] = { hash: currentHashes.get(file), ids: idsByFile.get(file) || [] };
}
write(MANIFEST, JSON.stringify(manifest, null, 2));

console.log(`Indexed ${records.length} new records, deleted ${deleteIds.length}, total ${allRecords.length}.`);
await store.close();

async function rebuildModuleSummaries(store, embedder) {
  const all = await store.getAll();
  const staleModuleIds = all.filter(record => record.isModuleSummary).map(record => record.id);
  if (staleModuleIds.length) await store.delete(staleModuleIds);

  const groups = new Map();
  for (const record of all) {
    if (!record.isSummary || record.type === 'session' || record.isModuleSummary) continue;
    const dir = path.dirname(record.file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(record);
  }

  const moduleRecords = [];
  for (const [dir, summaries] of groups) {
    if (summaries.length < 2) continue;
    const text = summaries.map(record => `## ${record.file}\n${record.text}`).join('\n\n');
    const vector = await embedder.embed(`${dir}\n${text}`);
    moduleRecords.push({
      id: sha256(`module:${dir}:${summaries.map(record => record.id).sort().join(':')}`),
      file: dir,
      chunk: -2,
      title: `${dir} module summary`,
      type: 'module-summary',
      heading: dir,
      text,
      embeddingText: `${dir}\n${text}`,
      isSummary: true,
      isModuleSummary: true,
      vector
    });
  }
  if (moduleRecords.length) await store.upsert(moduleRecords);
}

function splitEnv(name) {
  return (process.env[name] || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

function inferType(file) {
  if (file.includes('/features/')) return 'feature';
  if (file.includes('/modules/')) return 'module';
  if (file.includes('/decisions/')) return 'decision';
  if (file.includes('/sessions/')) return 'session';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'code';
  return 'doc';
}
