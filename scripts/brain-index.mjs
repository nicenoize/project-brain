import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BRAIN_DIR, MANIFEST, ensureDir, read, write, sha256, listIndexableFiles, parseDoc, isFastMode, truthyFrontmatter, filterGitignoredRelativePaths, splitEnv } from './common.mjs';
import { dispatchChunker } from './chunk.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';
import { loadTsSemanticContext } from './ts-graph.mjs';
import { discoverProjects, isFleetMode } from './projects.mjs';
import { inferType, inferModule, inferFeature, inferDecision, inferSourceKind } from './infer.mjs';
import { contextualChunksEnabled, situateEmbeddingText, repoLabel } from './contextual.mjs';
import { runDetectors } from './edges/index.mjs';
import { candidateToRecord } from './edges/materialize.mjs';
import {
  buildAggregateSummaryTexts,
  buildFleetSummary,
  buildPackageSummary,
  buildRepoSummary,
  decisionGroupKeys,
  discoverPackages,
  groupSummariesByPackage,
  readDirReadmeLead
} from './aggregate.mjs';

const force = process.argv.includes('--force');
const changedEnv = splitEnv('BRAIN_CHANGED_FILES');
const deletedEnv = splitEnv('BRAIN_DELETED_FILES');

ensureDir(BRAIN_DIR);
ensureDir(path.join(BRAIN_DIR, 'vector-db'));

// Bg-sync hands us BRAIN_SYNC_LOCK so we can release the cross-process bg-sync
// lock on exit. Released on any termination (clean or via signal).
if (process.env.BRAIN_SYNC_LOCK) {
  const lockPath = process.env.BRAIN_SYNC_LOCK;
  const release = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

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

// Pass `force` so the shrink-guard (#20) lets a deliberate `--force` rebuild
// overwrite the index even when it produces a much smaller snapshot.
const store = await openStore({ model: embedder.modelName, dims: embedder.dims, force: forceRebuild });

// Fleet discovery: if ≥ 2 sibling projects (and BRAIN_FLEET_MODE doesn't
// override), build the file list as the union of per-project listings and
// remember which project each file belongs to so records get tagged.
const projects = discoverProjects(ROOT);
const fleetMode = isFleetMode(projects);
const projectByFile = new Map();
let files;
if (fleetMode) {
  const all = [];
  for (const project of projects) {
    const projAbs = path.join(ROOT, project.dir);
    const projFiles = filterGitignoredRelativePaths(
      await listIndexableFiles({ root: projAbs }),
      { root: projAbs }
    );
    for (const f of projFiles) {
      const fleetRel = path.posix.join(project.dir, f);
      all.push(fleetRel);
      projectByFile.set(fleetRel, project.name);
    }
  }
  files = all;
  if (!process.env.BRAIN_QUIET) {
    console.log(`Project Brain: fleet mode — ${projects.length} projects (${projects.map(p => p.name).join(', ')})`);
  }
} else {
  files = filterGitignoredRelativePaths(await listIndexableFiles());
}

const indexableSet = new Set(files);
let tsContext = null;
try {
  // In fleet mode, ts-graph is invoked per-project lazily by brain:impact
  // when --cross-project is requested. The single-program initial load only
  // makes sense for a single tsconfig root.
  if (!fleetMode) {
    tsContext = await loadTsSemanticContext(ROOT, indexableSet);
    if (tsContext) console.log('Project Brain: TypeScript semantic graph enabled for indexing.');
  }
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
// Chunk-level vector reuse: when a file's top-level hash changes but most of
// its chunks are byte-identical, we copy the previously-embedded vector instead
// of re-running the model. Keyed by sha256(embeddingText). Disabled with
// BRAIN_REUSE_VECTORS=0 (default on).
const reuseVectors = process.env.BRAIN_REUSE_VECTORS !== '0';
const existingVectorByChunkSha = new Map();
for (const record of existingRecords) {
  if (!record.file) continue;
  if (!existingIdsByFile.has(record.file)) existingIdsByFile.set(record.file, []);
  existingIdsByFile.get(record.file).push(record.id);
  if (reuseVectors && record.embeddingText && Array.isArray(record.vector) && record.vector.length) {
    const key = `${record.file}:${sha256(record.embeddingText)}`;
    if (!existingVectorByChunkSha.has(key)) existingVectorByChunkSha.set(key, record.vector);
  }
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
const reuseStats = { reused: 0, embedded: 0 };
for (const file of changedFiles) {
  const content = read(path.join(ROOT, file));
  if (!content.trim()) continue;
  const hash = currentHashes.get(file);
  const stat = fs.statSync(path.join(ROOT, file));
  const doc = parseDoc(file, content);
  if (truthyFrontmatter(doc.data.noindex)) continue;
  const chunks = await dispatchChunker(file, doc.body, doc.data, { tsContext });
  // Per-file inferred metadata is identical across this file's chunks; compute
  // once and reuse for both the record build and the contextual situating.
  const fileModule = inferModule(file, doc.data);
  const fileFeature = inferFeature(file, doc.data);
  const fileType = doc.data.type || inferType(file);
  const fileProject = doc.data.project || projectByFile.get(file) || '';
  // Contextual Retrieval (BRAIN_CONTEXTUAL_CHUNKS=1, default OFF): prepend a
  // deterministic situating prefix to the DENSE embedding input only. The
  // stored/displayed `record.text` stays the original chunk body (see below).
  const contextual = contextualChunksEnabled();
  const ctxRepo = repoLabel({ project: fileProject }, ROOT);
  const embeddingTexts = chunks.map(chunk => {
    const base = chunk.embeddingText || `${file}\n${chunk.text}`;
    if (!contextual) return base;
    return situateEmbeddingText(base, {
      file,
      module: fileModule,
      feature: fileFeature,
      type: fileType,
      heading: chunk.heading || '',
      symbols: chunk.symbols || [],
      exportedSymbols: chunk.exportedSymbols || []
    }, { enabled: true, repo: ctxRepo });
  });
  // Try to reuse vectors for byte-identical chunks first.
  const vectors = new Array(chunks.length);
  const pendingIdx = [];
  const pendingTexts = [];
  for (let i = 0; i < chunks.length; i++) {
    const key = reuseVectors ? `${file}:${sha256(embeddingTexts[i])}` : null;
    const cached = key && existingVectorByChunkSha.get(key);
    if (cached) {
      vectors[i] = cached;
      reuseStats.reused++;
    } else {
      pendingIdx.push(i);
      pendingTexts.push(embeddingTexts[i]);
    }
  }
  if (pendingTexts.length) {
    const fresh = await embedder.embedBatch(pendingTexts);
    for (let k = 0; k < pendingIdx.length; k++) vectors[pendingIdx[k]] = fresh[k];
    reuseStats.embedded += pendingTexts.length;
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sessionCoord = sessionCoordFields(file, doc.data);
    const meta = brainDocMeta(file, doc.data);
    records.push({
      id: sha256(`${file}:${chunk.chunk}:${hash}`),
      file,
      chunk: chunk.chunk,
      title: doc.data.title || path.basename(file),
      type: fileType,
      heading: chunk.heading || '',
      // Stored/displayed text stays the ORIGINAL chunk body. Contextual
      // situating (when enabled) only augments embeddingText below.
      text: chunk.text,
      embeddingText: embeddingTexts[i],
      isSummary: Boolean(chunk.isSummary),
      isModuleSummary: false,
      isProjectSummary: false,
      module: fileModule,
      feature: fileFeature,
      decision: inferDecision(file, doc.data),
      project: fileProject,
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
if (reuseVectors && (reuseStats.reused || reuseStats.embedded)) {
  const total = reuseStats.reused + reuseStats.embedded;
  const pct = total ? Math.round((reuseStats.reused / total) * 100) : 0;
  console.log(`Project Brain: embedded ${reuseStats.embedded} new chunks, reused ${reuseStats.reused} (${pct}% cache hit).`);
}

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

const dirtyDecisions = new Set();
for (const file of dirtyFiles) {
  if (file.startsWith('.project-brain/decisions/')) dirtyDecisions.add(path.basename(file, path.extname(file)));
}

const dirtyProjects = new Set();
if (fleetMode) {
  for (const file of dirtyFiles) {
    const p = projectByFile.get(file);
    if (p) dirtyProjects.add(p);
  }
  // First index in fleet mode → all projects dirty.
  if (forceRebuild || existingRecords.length === 0) {
    for (const p of projects) dirtyProjects.add(p.name);
  }
}

if (isFastMode()) {
  console.log('Project Brain: fast mode — skipping module/feature/project summary rebuilds.');
} else if (forceRebuild) {
  await rebuildModuleSummaries(store, embedder, { all: true });
  await rebuildPackageSummaries(store, embedder, { all: true });
  await rebuildDecisionClusters(store, embedder, { all: true });
  if (fleetMode) await rebuildRepoSummaries(store, embedder, { all: true });
} else if (dirtyDirs.size === 0 && dirtyFeatures.size === 0 && dirtyDecisions.size === 0 && dirtyProjects.size === 0) {
  console.log('Project Brain: no changes — module/feature/project/decision summaries left intact.');
} else {
  await rebuildModuleSummaries(store, embedder, { dirtyDirs, dirtyFeatures });
  await rebuildPackageSummaries(store, embedder, { dirtyDirs });
  await rebuildDecisionClusters(store, embedder, { dirtyDecisions, dirtyFeatures, dirtyDirs });
  if (fleetMode) await rebuildRepoSummaries(store, embedder, { dirtyProjects });
}

if (fleetMode && !isFastMode()) {
  await rebuildCrossProjectEdges(store, embedder, { forceRebuild, dirtyProjects });
  await rebuildFleetSummary(store, embedder);
}

/**
 * Emit one chunk:-7 repo-summary record per fleet project. Aggregates
 * the project's package.json/go.mod/Chart.yaml metadata, README first
 * paragraph, top-level exports, k8s services, Dockerfile images, and
 * child file-summary intent lines into a single intent-dense vector.
 */
async function rebuildRepoSummaries(store, embedder, opts = {}) {
  const { all: rebuildAll = false, dirtyProjects = new Set() } = opts;
  const allRecords = await store.getAll();

  // Stale: drop repo-summary records for dirty projects (or all on --force).
  const staleIds = allRecords
    .filter(r => r.type === 'repo-summary' && (rebuildAll || dirtyProjects.has(r.project)))
    .map(r => r.id);
  if (staleIds.length) await store.delete(staleIds);

  const refreshed = await store.getAll();
  const childByProject = new Map();
  for (const r of refreshed) {
    if (!r.isSummary || r.type === 'repo-summary' || r.type === 'session' || r.type === 'auto-compact') continue;
    if (r.isModuleSummary || r.isProjectSummary) continue;
    if (r.type === 'feature-summary' || r.type === 'package-summary' || r.type === 'decision-cluster') continue;
    if (!r.project) continue;
    if (!childByProject.has(r.project)) childByProject.set(r.project, []);
    childByProject.get(r.project).push(r);
  }

  const newRecords = [];
  for (const project of projects) {
    if (!rebuildAll && !dirtyProjects.has(project.name)) continue;
    const summary = buildRepoSummary({
      root: ROOT,
      project,
      childSummaries: childByProject.get(project.name) || []
    });
    if (!summary) continue;
    newRecords.push({
      id: sha256(`repo:${project.name}:${summary.signature}`),
      file: project.dir,
      chunk: -7,
      title: `${summary.name} project summary`,
      type: 'repo-summary',
      heading: summary.name,
      text: summary.text,
      embeddingText: summary.embeddingText,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: false,
      project: project.name,
      projectKinds: project.kinds,
      module: project.dir,
      vector: await embedder.embed(summary.embeddingText)
    });
  }
  if (newRecords.length) await store.upsert(newRecords);
}

/**
 * Run all edge detectors, materialize candidates as chunk:-9 records, and
 * incrementally upsert. Detectors emit per-project; we delete existing
 * cross-project-edge records where either endpoint is dirty before
 * writing the fresh set so removed edges don't linger.
 */
async function rebuildCrossProjectEdges(store, embedder, opts = {}) {
  const { forceRebuild = false, dirtyProjects = new Set() } = opts;
  const allRecords = await store.getAll();
  const dirty = forceRebuild ? new Set(projects.map(p => p.name)) : dirtyProjects;
  const staleIds = allRecords
    .filter(r => r.type === 'cross-project-edge' && (forceRebuild || dirty.has(r.edgeFrom) || dirty.has(r.edgeTo)))
    .map(r => r.id);
  if (staleIds.length) await store.delete(staleIds);

  const candidates = await runDetectors({
    ROOT,
    projects,
    dirtyProjects: dirty,
    useCache: !forceRebuild
  });
  if (!candidates.length) return;

  const newRecords = [];
  for (const c of candidates) {
    const record = candidateToRecord(c, []);
    record.vector = await embedder.embed(record.embeddingText);
    newRecords.push(record);
  }
  await store.upsert(newRecords);
  console.log(`Project Brain: cross-project edges — ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} materialized.`);
}

/**
 * One chunk:-8 fleet-summary record. Aggregates every repo-summary's
 * intent line + the cross-project edge graph into a single vector so
 * "describe this fleet" queries hit one record.
 */
async function rebuildFleetSummary(store, embedder) {
  const all = await store.getAll();
  const repoSummaries = all.filter(r => r.type === 'repo-summary');
  const edgeRecords = all.filter(r => r.type === 'cross-project-edge');
  // Drop any prior fleet-summary record before writing the fresh one.
  const stale = all.filter(r => r.type === 'fleet-summary').map(r => r.id);
  if (stale.length) await store.delete(stale);

  if (!repoSummaries.length) return; // nothing to aggregate yet
  const summary = buildFleetSummary({ projects, repoSummaries, edgeRecords });
  await store.upsert([{
    id: sha256(`fleet:${summary.signature}`),
    file: '.project-brain/fleet/fleet-summary.md',
    chunk: -8,
    title: 'Fleet summary',
    type: 'fleet-summary',
    heading: 'fleet',
    text: summary.text,
    embeddingText: summary.embeddingText,
    isSummary: true,
    isModuleSummary: false,
    isProjectSummary: false,
    project: '',
    vector: await embedder.embed(summary.embeddingText)
  }]);
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
      readmeLeadParagraph: readDirReadmeLead(ROOT, dir),
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
 * For monorepos: emit one `chunk:-5 type:package-summary` per detected
 * package under `packages/*` and `apps/*` (configurable via
 * BRAIN_PACKAGE_GLOBS). Each summary aggregates the package.json metadata,
 * README lead paragraph, top exports from src/index.ts, and the list of
 * child file summary titles — embedded as one intent-dense record so
 * "what does @scope/x do" queries hit a single, accurate vector instead
 * of scattered file summaries.
 */
async function rebuildPackageSummaries(store, embedder, opts = {}) {
  const { all: rebuildAll = false, dirtyDirs = new Set() } = opts;
  const globs = splitEnv('BRAIN_PACKAGE_GLOBS');
  const packageDirs = discoverPackages(ROOT, globs.length ? globs : undefined);
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
      root: ROOT,
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

/**
 * Group ADRs (`.project-brain/decisions/*.md`) by `module:` or `feature:` in
 * their frontmatter and emit one `chunk:-6 type:decision-cluster` per group
 * with ≥2 decisions. Cross-decision queries ("all auth decisions") hit one
 * synthesized vector instead of grepping individual ADRs.
 */
async function rebuildDecisionClusters(store, embedder, opts = {}) {
  const { all: rebuildAll = false, dirtyDecisions = new Set(), dirtyFeatures = new Set(), dirtyDirs = new Set() } = opts;
  const allRecords = await store.getAll();
  const decisionFileSummaries = allRecords.filter(record =>
    record.isSummary && record.type === 'decision'
  );

  const groups = new Map(); // key -> { kind, key, records }
  for (const record of decisionFileSummaries) {
    const keys = decisionGroupKeys(record);
    for (const { kind, key } of keys) {
      const fullKey = `${kind}:${key}`;
      if (!groups.has(fullKey)) groups.set(fullKey, { kind, key, records: [] });
      groups.get(fullKey).records.push(record);
    }
  }

  // Stale identification: only the clusters whose key touches the dirty set.
  const dirtyKeys = new Set();
  if (!rebuildAll) {
    for (const decision of dirtyDecisions) dirtyKeys.add(decision);
    for (const feature of dirtyFeatures) dirtyKeys.add(feature);
    for (const dir of dirtyDirs) dirtyKeys.add(dir);
  }

  const staleIds = allRecords
    .filter(record => {
      if (record.type !== 'decision-cluster') return false;
      if (rebuildAll) return true;
      const k = record.heading || '';
      return [...dirtyKeys].some(dirty => k === dirty || k.endsWith(`:${dirty}`));
    })
    .map(record => record.id);
  if (staleIds.length) await store.delete(staleIds);

  const newRecords = [];
  for (const [, group] of groups) {
    if (group.records.length < 2) continue;
    if (!rebuildAll) {
      const touched = group.records.some(record => dirtyDecisions.has(record.decision || ''));
      const groupKeyTouched = dirtyKeys.has(group.key);
      if (!touched && !groupKeyTouched) continue;
    }
    const { text, embeddingText } = buildAggregateSummaryTexts({
      title: `${group.kind}:${group.key} decisions`,
      key: `${group.kind}:${group.key}`,
      children: group.records
    });
    const sigSource = group.records.map(record => record.id).sort().join(':');
    newRecords.push({
      id: sha256(`decision-cluster:${group.kind}:${group.key}:${sigSource}`),
      file: `.project-brain/decisions/__cluster__/${group.kind}-${group.key}.md`,
      chunk: -6,
      title: `${group.kind}:${group.key} decision cluster`,
      type: 'decision-cluster',
      heading: `${group.kind}:${group.key}`,
      text,
      embeddingText,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: false,
      module: group.kind === 'module' ? group.key : '',
      feature: group.kind === 'feature' ? group.key : '',
      vector: await embedder.embed(embeddingText)
    });
  }
  if (newRecords.length) await store.upsert(newRecords);
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
