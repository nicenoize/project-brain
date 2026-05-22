import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BRAIN_DIR, MANIFEST, ensureDir, read, write, sha256, listIndexableFiles, parseDoc, isFastMode, truthyFrontmatter, filterGitignoredRelativePaths, splitEnv } from './common.mjs';
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
const files = filterGitignoredRelativePaths(await listIndexableFiles());
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
  if (truthyFrontmatter(doc.data.noindex)) continue;
  const chunks = await dispatchChunker(file, doc.body, doc.data, { tsContext });
  const vectors = await embedder.embedBatch(chunks.map(chunk => chunk.embeddingText || `${file}\n${chunk.text}`));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sessionCoord = sessionCoordFields(file, doc.data);
    const meta = brainDocMeta(file, doc.data);
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
      ...meta,
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

const dirtyFiles = new Set([...changedFiles, ...deletedFiles]);
const dirtyDirs = new Set();
const dirtyFeatures = new Set();
for (const file of dirtyFiles) {
  dirtyDirs.add(path.dirname(file));
  const feat = inferFeatureFromPath(file);
  if (feat) dirtyFeatures.add(feat);
}
// Include feature/module from frontmatter of touched records too (already loaded above).
for (const record of records) {
  if (record.feature) dirtyFeatures.add(record.feature);
}

if (isFastMode()) {
  console.log('Project Brain: fast mode — skipping module/feature/project summary rebuilds.');
} else if (forceRebuild) {
  await rebuildModuleSummaries(store, embedder, { all: true });
  await rebuildPackageSummaries(store, embedder, { all: true });
} else if (dirtyDirs.size === 0 && dirtyFeatures.size === 0) {
  console.log('Project Brain: no changes — module/feature/project summaries left intact.');
} else {
  await rebuildModuleSummaries(store, embedder, { dirtyDirs, dirtyFeatures });
  await rebuildPackageSummaries(store, embedder, { dirtyDirs });
}

function inferFeatureFromPath(file) {
  return file.includes('/features/') ? path.basename(file, path.extname(file)) : '';
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

async function rebuildModuleSummaries(store, embedder, opts = {}) {
  const { all: rebuildAll = false, dirtyDirs = new Set(), dirtyFeatures = new Set() } = opts;
  const all = await store.getAll();

  // Identify which existing module summaries are stale — for a partial run,
  // only those that cover a dirty directory.
  const staleModuleIds = all
    .filter(record => {
      if (!(record.isModuleSummary || record.isProjectSummary || record.type === 'feature-summary')) return false;
      if (rebuildAll) return true;
      if (record.isProjectSummary) return true; // project summary always refreshed when anything changed
      if (record.type === 'feature-summary') return dirtyFeatures.has(record.feature);
      return dirtyDirs.has(record.file);
    })
    .map(record => record.id);
  if (staleModuleIds.length) await store.delete(staleModuleIds);

  const groups = new Map();
  for (const record of all) {
    if (!record.isSummary || record.type === 'session' || record.type === 'auto-compact' || record.isModuleSummary) continue;
    const dir = path.dirname(record.file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(record);
  }

  const moduleRecords = [];
  for (const [dir, summaries] of groups) {
    if (summaries.length < 2) continue;
    if (!rebuildAll && !dirtyDirs.has(dir)) continue;
    const { text, embeddingText } = buildAggregateSummaryTexts({
      title: `${dir} module`,
      key: dir,
      readmeLeadParagraph: readDirReadmeLead(dir),
      children: summaries
    });
    const vector = await embedder.embed(embeddingText);
    moduleRecords.push({
      id: sha256(`module:${dir}:${summaries.map(record => record.id).sort().join(':')}`),
      file: dir,
      chunk: -2,
      title: `${dir} module summary`,
      type: 'module-summary',
      heading: dir,
      text,
      embeddingText,
      isSummary: true,
      isModuleSummary: true,
      isProjectSummary: false,
      module: dir,
      vector
    });
  }
  if (moduleRecords.length) await store.upsert(moduleRecords);
  await rebuildFeatureAndProjectSummaries(store, embedder, moduleRecords, { rebuildAll, dirtyFeatures });
}

/**
 * Build human-readable and embed-ready text for an aggregate summary record.
 * - `text` is verbose (full child concat) — shown to humans via brain:pack.
 * - `embeddingText` is intent-dense (~800-1000 chars) — what the vector encodes.
 *
 * For embedding we keep: the title, optional README lead paragraph, a one-line
 * per-child digest (title + first sentence of intent), and a flat union of
 * exported symbol names. List-y concatenation of full child summaries used to
 * overflow MiniLM's 256-token context and waste recall on long modules.
 */
function buildAggregateSummaryTexts({ title, key, readmeLeadParagraph = '', children }) {
  const verbose = children.map(record => `## ${record.heading || record.file}\n${record.text}`).join('\n\n');
  const childLines = [];
  const symbolUnion = new Set();
  const headings = new Set();
  const sliceCap = 20;
  const sorted = [...children].sort((a, b) => String(a.file).localeCompare(String(b.file)));
  for (const record of sorted.slice(0, sliceCap)) {
    const intent = firstSentenceOfChild(record);
    const childTitle = record.heading || path.basename(record.file || '');
    if (intent) childLines.push(`- ${childTitle}: ${intent}`);
    else if (childTitle) childLines.push(`- ${childTitle}`);
    for (const sym of (record.symbols || []).slice(0, 8)) symbolUnion.add(sym);
    if (record.heading) headings.add(record.heading);
  }
  const remainder = children.length - sliceCap;
  if (remainder > 0) childLines.push(`- … +${remainder} more`);

  const embedSections = [
    `# ${title}`,
    `Key: ${key}`,
    readmeLeadParagraph ? `Readme: ${readmeLeadParagraph}` : '',
    childLines.length ? `Children:\n${childLines.join('\n')}` : '',
    symbolUnion.size ? `Exports: ${[...symbolUnion].slice(0, 60).join(', ')}` : ''
  ].filter(Boolean);

  let embeddingText = embedSections.join('\n');
  // MiniLM context is ~256 tokens (~1000 chars after path noise). Hard cap so
  // the tail of a huge module doesn't silently drop out of the vector.
  if (embeddingText.length > 1100) embeddingText = embeddingText.slice(0, 1080) + ' …';
  return { text: verbose, embeddingText };
}

/** Pull the first sentence/line of a child summary's text (drops the `# Title` / `File:` boilerplate). */
function firstSentenceOfChild(record) {
  const lines = String(record.text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    if (line.startsWith('File: ')) continue;
    if (line.startsWith('Exports') || line.startsWith('Imports') || line.startsWith('Resolved ') || line.startsWith('Cross-file')) continue;
    if (line.startsWith('Headings:')) continue;
    if (line.startsWith('No exported') || line.startsWith('No headings')) continue;
    // First non-boilerplate line: cut at a sentence break.
    const match = line.match(/^[^.?!]+[.?!]?/);
    return (match ? match[0] : line).slice(0, 180);
  }
  return '';
}

/**
 * For monorepos: emit one `chunk:-5 type:package-summary` per detected
 * package under `packages/*` and `apps/*` (configurable via
 * BRAIN_PACKAGE_GLOBS, comma/newline separated, default
 * "packages/*,apps/*"). Each summary aggregates the package.json
 * metadata, README lead paragraph, top exports from src/index.ts, and
 * the list of child file summary titles — embedded as one intent-dense
 * record so "what does @scope/x do" queries hit a single, accurate
 * vector instead of scattered file summaries.
 */
async function rebuildPackageSummaries(store, embedder, opts = {}) {
  const { all: rebuildAll = false, dirtyDirs = new Set() } = opts;
  const packageDirs = discoverPackages();
  if (!packageDirs.length) return;

  // Identify and drop stale package-summary records for dirty packages only.
  const allRecords = await store.getAll();
  const staleIds = allRecords
    .filter(record => {
      if (record.type !== 'package-summary') return false;
      if (rebuildAll) return true;
      return [...dirtyDirs].some(dir => dir === record.file || dir.startsWith(`${record.file}/`));
    })
    .map(record => record.id);
  if (staleIds.length) await store.delete(staleIds);

  const refreshedRecords = await store.getAll();
  const childSummariesByDir = groupSummariesByPackage(refreshedRecords, packageDirs);

  const newRecords = [];
  for (const pkgDir of packageDirs) {
    const dirty = rebuildAll || [...dirtyDirs].some(dir => dir === pkgDir || dir.startsWith(`${pkgDir}/`));
    if (!dirty) continue;
    const summary = buildPackageSummary({
      pkgDir,
      childSummaries: childSummariesByDir.get(pkgDir) || []
    });
    if (!summary) continue;
    newRecords.push({
      id: sha256(`package:${pkgDir}:${summary.signature}`),
      file: pkgDir,
      chunk: -5,
      title: `${summary.name || pkgDir} package summary`,
      type: 'package-summary',
      heading: summary.name || pkgDir,
      text: summary.text,
      embeddingText: summary.embeddingText,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: false,
      module: pkgDir,
      vector: await embedder.embed(summary.embeddingText)
    });
  }
  if (newRecords.length) await store.upsert(newRecords);
}

function discoverPackages() {
  const globs = splitEnv('BRAIN_PACKAGE_GLOBS');
  const patterns = globs.length ? globs : ['packages/*', 'apps/*'];
  const found = new Set();
  for (const pattern of patterns) {
    const base = pattern.replace(/\/\*$/, '');
    const baseDir = path.join(ROOT, base);
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pkgDir = `${base}/${entry.name}`;
      if (fs.existsSync(path.join(ROOT, pkgDir, 'package.json'))) found.add(pkgDir);
    }
  }
  return [...found].sort();
}

function groupSummariesByPackage(records, packageDirs) {
  const sorted = [...packageDirs].sort((a, b) => b.length - a.length); // longest-prefix match
  const byPkg = new Map();
  for (const record of records) {
    if (!record.isSummary) continue;
    if (record.isModuleSummary || record.isProjectSummary || record.type === 'package-summary') continue;
    if (record.type === 'session' || record.type === 'auto-compact' || record.type === 'feature-summary') continue;
    const pkg = sorted.find(p => record.file === p || record.file.startsWith(`${p}/`));
    if (!pkg) continue;
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(record);
  }
  return byPkg;
}

function buildPackageSummary({ pkgDir, childSummaries }) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const name = pkgJson.name || pkgDir;
  const description = pkgJson.description || '';
  const keywords = Array.isArray(pkgJson.keywords) ? pkgJson.keywords.filter(Boolean).slice(0, 12) : [];
  const deps = [...Object.keys(pkgJson.dependencies || {}), ...Object.keys(pkgJson.peerDependencies || {})].slice(0, 24);
  const readmeLead = readDirReadmeLead(pkgDir);
  const topExports = readTopLevelExports(pkgDir);

  const childTitles = childSummaries
    .map(record => record.heading || path.basename(record.file || ''))
    .filter(Boolean)
    .slice(0, 24);
  const childIntents = childSummaries
    .slice(0, 12)
    .map(record => {
      const intent = firstSentenceOfChild(record);
      const t = record.heading || path.basename(record.file || '');
      return intent ? `- ${t}: ${intent}` : (t ? `- ${t}` : '');
    })
    .filter(Boolean);

  const embedSections = [
    `# ${name} package`,
    `Path: ${pkgDir}`,
    description ? `Description: ${description}` : '',
    keywords.length ? `Keywords: ${keywords.join(', ')}` : '',
    readmeLead ? `Readme: ${readmeLead}` : '',
    topExports.length ? `Exports: ${topExports.join(', ')}` : '',
    childIntents.length ? `Files:\n${childIntents.join('\n')}` : '',
    deps.length ? `Deps: ${deps.join(', ')}` : ''
  ].filter(Boolean);
  let embeddingText = embedSections.join('\n');
  if (embeddingText.length > 1100) embeddingText = embeddingText.slice(0, 1080) + ' …';

  const text = [
    `# ${name}`,
    `Path: ${pkgDir}`,
    description && `> ${description}`,
    keywords.length && `**Keywords:** ${keywords.join(', ')}`,
    readmeLead && `**Readme:** ${readmeLead}`,
    topExports.length && `**Top-level exports:** ${topExports.join(', ')}`,
    childTitles.length && `**Files (${childSummaries.length}):** ${childTitles.join(', ')}`,
    deps.length && `**Dependencies:** ${deps.join(', ')}`
  ].filter(Boolean).join('\n\n');

  const signature = sha256([name, description, keywords.join(','), readmeLead, topExports.join(','), deps.join(','), childTitles.join(',')].join('|'));
  return { name, text, embeddingText, signature };
}

function readTopLevelExports(pkgDir) {
  const candidates = ['src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'src/index.mjs'];
  for (const rel of candidates) {
    const full = path.join(ROOT, pkgDir, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const text = fs.readFileSync(full, 'utf8');
      const names = new Set();
      // export { a, b } from '…' / export { a, b }
      for (const m of text.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
          const local = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (local && /^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
        }
      }
      // export function/class/const/let/var/type/interface/enum NAME
      for (const m of text.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.add(m[1]);
      }
      // export * from '…/foo'  → list "* from foo"
      for (const m of text.matchAll(/^\s*export\s*\*\s*from\s+['"]([^'"]+)['"]/gm)) {
        names.add(`*from:${path.basename(m[1])}`);
      }
      if (names.size) return [...names].slice(0, 32);
    } catch {}
  }
  return [];
}

/** Read the first paragraph of `<dir>/README.md` (case-insensitive), or ''. */
function readDirReadmeLead(dir) {
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
  for (const name of candidates) {
    const full = path.join(ROOT, dir, name);
    if (!fs.existsSync(full)) continue;
    try {
      const text = fs.readFileSync(full, 'utf8');
      // Drop frontmatter, then take first non-heading paragraph.
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
      const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      for (const p of paragraphs) {
        if (p.startsWith('#')) continue;
        return p.slice(0, 280).replace(/\s+/g, ' ');
      }
    } catch {}
  }
  return '';
}

async function rebuildFeatureAndProjectSummaries(store, embedder, moduleRecords, opts = {}) {
  const { rebuildAll = false, dirtyFeatures = new Set() } = opts;
  const all = await store.getAll();
  const summaries = all.filter(record => record.isSummary && !record.isModuleSummary && !record.isProjectSummary && record.type !== 'session' && record.type !== 'auto-compact');
  const featureGroups = new Map();
  for (const record of summaries) {
    if (!record.feature) continue;
    if (!featureGroups.has(record.feature)) featureGroups.set(record.feature, []);
    featureGroups.get(record.feature).push(record);
  }

  const aggregateRecords = [];
  for (const [feature, records] of featureGroups) {
    if (records.length < 1) continue;
    if (!rebuildAll && !dirtyFeatures.has(feature)) continue;
    const { text, embeddingText } = buildAggregateSummaryTexts({
      title: `${feature} feature`,
      key: feature,
      children: records
    });
    aggregateRecords.push({
      id: sha256(`feature:${feature}:${records.map(record => record.id).sort().join(':')}`),
      file: `.project-brain/features/${feature}.md`,
      chunk: -3,
      title: `${feature} feature summary`,
      type: 'feature-summary',
      heading: feature,
      text,
      embeddingText,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: false,
      feature,
      vector: await embedder.embed(embeddingText)
    });
  }

  const projectInputs = moduleRecords.length ? moduleRecords : summaries;
  if (projectInputs.length >= 2) {
    const { text, embeddingText } = buildAggregateSummaryTexts({
      title: 'Project',
      key: 'project',
      children: projectInputs
    });
    aggregateRecords.push({
      id: sha256(`project:${projectInputs.map(record => record.id).sort().join(':')}`),
      file: '.project-brain/project-summary',
      chunk: -4,
      title: 'Project summary',
      type: 'project-summary',
      heading: 'project',
      text,
      embeddingText,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: true,
      vector: await embedder.embed(embeddingText)
    });
  }
  if (aggregateRecords.length) await store.upsert(aggregateRecords);
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

function brainDocMeta(file, data = {}) {
  const provenance = String(data.provenance || '').trim() || inferProvenance(file, data);
  const docStatus = String(data.status || '').trim();
  const layer = String(data.layer || '').trim();
  const synthetic = truthyFrontmatter(data.synthetic);
  const noindex = truthyFrontmatter(data.noindex);
  return { provenance, docStatus, layer, synthetic, noindex };
}

function inferProvenance(file, data = {}) {
  const t = String(data.type || '').toLowerCase();
  if (t === 'auto-compact') return 'generated';
  if (file.includes('/sessions/') && file.includes('__auto-compact__')) return 'generated';
  if (file.includes('/sessions/')) return 'human';
  return 'human';
}
