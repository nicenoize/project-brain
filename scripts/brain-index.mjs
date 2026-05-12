import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BRAIN_DIR, MANIFEST, ensureDir, read, write, sha256, listIndexableFiles, parseDoc, isFastMode } from './common.mjs';
import { dispatchChunker } from './chunk.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';
import { loadTsSemanticContext } from './ts-graph.mjs';

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

const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
const files = await listIndexableFiles();
const indexableSet = new Set(files);
let tsContext = null;
try {
  tsContext = await loadTsSemanticContext(ROOT, indexableSet);
  if (tsContext) console.log('Project Brain: TypeScript semantic graph enabled for indexing.');
} catch (error) {
  console.warn(`Project Brain: TS graph disabled (${error.message || error}).`);
}
const fileSet = new Set(files);
const currentHashes = new Map();
for (const file of files) currentHashes.set(file, sha256(read(path.join(ROOT, file))));

let changedFiles = files.filter(file => forceRebuild || oldManifest.files?.[file]?.hash !== currentHashes.get(file));
let deletedFiles = Object.keys(oldManifest.files || {}).filter(file => !fileSet.has(file));

const existingRecords = await store.getAll();
const existingIdsByFile = new Map();
for (const record of existingRecords) {
  if (!record.file) continue;
  if (!existingIdsByFile.has(record.file)) existingIdsByFile.set(record.file, []);
  existingIdsByFile.get(record.file).push(record.id);
}
const strayFiles = [...new Set(existingRecords.map((r) => r.file).filter(Boolean))].filter((file) => !fileSet.has(file));
deletedFiles = [...new Set([...deletedFiles, ...strayFiles])];

if (!forceRebuild && changedEnv.length) {
  const allowed = new Set(changedEnv);
  changedFiles = changedFiles.filter(file => allowed.has(file));
}
if (!forceRebuild && deletedEnv.length) {
  deletedFiles = [...new Set([...deletedFiles, ...deletedEnv])];
}

const deleteIds = [];
const seenDelete = new Set();
for (const file of new Set([...changedFiles, ...deletedFiles])) {
  const ids = new Set([...(oldManifest.files?.[file]?.ids || []), ...(existingIdsByFile.get(file) || [])]);
  for (const id of ids) {
    if (seenDelete.has(id)) continue;
    seenDelete.add(id);
    deleteIds.push(id);
  }
}
await store.delete(deleteIds);

const records = [];
for (const file of changedFiles) {
  const content = read(path.join(ROOT, file));
  if (!content.trim()) continue;
  const hash = currentHashes.get(file);
  const stat = fs.statSync(path.join(ROOT, file));
  const doc = parseDoc(file, content);
  const chunks = await dispatchChunker(file, doc.body, doc.data, { tsContext });
  const vectors = await embedder.embedBatch(chunks.map(chunk => chunk.embeddingText || `${file}\n${chunk.text}`));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sessionCoord = sessionCoordFields(file, doc.data);
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
      isProjectSummary: false,
      module: inferModule(file, doc.data),
      feature: inferFeature(file, doc.data),
      decision: inferDecision(file, doc.data),
      sourceKind: inferSourceKind(file),
      mtime: stat.mtime.toISOString(),
      hash,
      symbols: chunk.symbols || [],
      symbolKinds: chunk.symbolKinds || [],
      exportedSymbols: chunk.exportedSymbols || [],
      lineStart: chunk.lineStart || 0,
      lineEnd: chunk.lineEnd || 0,
      imports: chunk.imports || [],
      references: chunk.references || [],
      vector: vectors[i],
      ...sessionCoord
    });
  }
}

if (records.length) await store.upsert(records);
if (isFastMode()) {
  console.log('Project Brain: fast mode — skipping module/feature/project summary rebuilds.');
} else {
  await rebuildModuleSummaries(store, embedder);
}

const allRecords = await store.getAll();
const idsByFile = new Map();
for (const record of allRecords) {
  if (record.isModuleSummary || record.isProjectSummary || record.id.startsWith('session:')) continue;
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
  const staleModuleIds = all.filter(record => record.isModuleSummary || record.isProjectSummary || record.type === 'feature-summary').map(record => record.id);
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
      isProjectSummary: false,
      module: dir,
      vector
    });
  }
  if (moduleRecords.length) await store.upsert(moduleRecords);
  await rebuildFeatureAndProjectSummaries(store, embedder, moduleRecords);
}

async function rebuildFeatureAndProjectSummaries(store, embedder, moduleRecords) {
  const all = await store.getAll();
  const summaries = all.filter(record => record.isSummary && !record.isModuleSummary && !record.isProjectSummary && record.type !== 'session');
  const featureGroups = new Map();
  for (const record of summaries) {
    if (!record.feature) continue;
    if (!featureGroups.has(record.feature)) featureGroups.set(record.feature, []);
    featureGroups.get(record.feature).push(record);
  }

  const aggregateRecords = [];
  for (const [feature, records] of featureGroups) {
    if (records.length < 1) continue;
    const text = records.map(record => `## ${record.file}\n${record.text}`).join('\n\n');
    aggregateRecords.push({
      id: sha256(`feature:${feature}:${records.map(record => record.id).sort().join(':')}`),
      file: `.project-brain/features/${feature}.md`,
      chunk: -3,
      title: `${feature} feature summary`,
      type: 'feature-summary',
      heading: feature,
      text,
      embeddingText: `${feature}\n${text}`,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: false,
      feature,
      vector: await embedder.embed(`${feature}\n${text}`)
    });
  }

  const projectInputs = moduleRecords.length ? moduleRecords : summaries;
  if (projectInputs.length >= 2) {
    const text = projectInputs.map(record => `## ${record.heading || record.file}\n${record.text}`).join('\n\n');
    aggregateRecords.push({
      id: sha256(`project:${projectInputs.map(record => record.id).sort().join(':')}`),
      file: '.project-brain/project-summary',
      chunk: -4,
      title: 'Project summary',
      type: 'project-summary',
      heading: 'project',
      text,
      embeddingText: `project\n${text}`,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: true,
      vector: await embedder.embed(`project\n${text}`)
    });
  }
  if (aggregateRecords.length) await store.upsert(aggregateRecords);
}

function splitEnv(name) {
  return (process.env[name] || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

function sessionCoordFields(file, data) {
  if (!file.includes('/sessions/')) return {};
  const taskId = String(data.task_id || data.taskId || '').trim();
  const actor = String(data.actor || '').trim();
  const tool = String(data.tool || '').trim();
  const parentRun = String(data.parent_run || data.parentRun || '').trim();
  const out = {};
  if (taskId) out.taskId = taskId;
  if (actor) out.actor = actor;
  if (tool) out.tool = tool;
  if (parentRun) out.parentRun = parentRun;
  return out;
}

function inferType(file) {
  if (file.includes('/features/')) return 'feature';
  if (file.includes('/modules/')) return 'module';
  if (file.includes('/decisions/')) return 'decision';
  if (file.includes('/sessions/')) return 'session';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'code';
  return 'doc';
}

function inferModule(file, data = {}) {
  if (data.module) return data.module;
  if (file.includes('/modules/')) return path.basename(file, path.extname(file));
  const parts = file.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) return parts.slice(0, 2).join('/');
  return path.dirname(file) === '.' ? '' : path.dirname(file);
}

function inferFeature(file, data = {}) {
  if (data.feature) return data.feature;
  return file.includes('/features/') ? path.basename(file, path.extname(file)) : '';
}

function inferDecision(file, data = {}) {
  if (data.decision) return data.decision;
  return file.includes('/decisions/') ? path.basename(file, path.extname(file)) : '';
}

function inferSourceKind(file) {
  if (file.startsWith('.project-brain/')) return 'brain';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'code';
  if (/\.mdx?$/.test(file)) return 'doc';
  return 'other';
}
