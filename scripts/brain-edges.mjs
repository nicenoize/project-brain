/**
 * brain:edges — list/inspect cross-project edges in the local fleet brain.
 *
 * Default: prints the materialized edge graph from the store grouped by
 * (from → to). With --detect, force-reruns every edge detector and upserts
 * the result (ignoring the per-detector cache).
 */
import { ROOT, takeFlag, takeOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';
import { discoverProjects } from './projects.mjs';
import { runDetectors } from './edges/index.mjs';
import { candidateToRecord, dedupeCandidates } from './edges/materialize.mjs';

const args = process.argv.slice(2);
const json = takeFlag(args, '--json');
const detect = takeFlag(args, '--detect');
const onlyDetector = takeOption(args, '--detector');
const minConfidence = takeOption(args, '--min-confidence') || 'low';
const helpFlag = takeFlag(args, '--help') || takeFlag(args, '-h');

if (helpFlag) {
  console.log(`Usage: npm run brain:edges -- [--detect] [--detector NAME] [--min-confidence high|medium|low] [--json]

  (no args)        print materialized edges from the index
  --detect         force-run every detector + upsert results (skips cache)
  --detector NAME  run only the named detector (debug)
  --min-confidence cut off below high|medium|low (default low = show all)
  --json           machine-readable output`);
  process.exit(0);
}

const projects = discoverProjects(ROOT);
if (projects.length < 2) {
  console.error('brain:edges requires fleet mode (≥ 2 sibling projects). Discovered: ' + (projects.map(p => p.name).join(', ') || 'none'));
  process.exit(1);
}

const embedder = openEmbedder();
const store = await openStore({ model: embedder.modelName, dims: embedder.dims });

if (detect) {
  const candidates = await runDetectors({
    ROOT, projects,
    dirtyProjects: new Set(projects.map(p => p.name)),
    useCache: false,
    onlyDetector: onlyDetector || null
  });
  const deduped = dedupeCandidates(candidates);
  const newRecords = [];
  for (const c of deduped) {
    const r = candidateToRecord(c, []);
    r.vector = await embedder.embed(r.embeddingText);
    newRecords.push(r);
  }
  // Drop existing edges before upsert when --detect (full rebuild).
  const existing = (await store.getAll()).filter(r => r.type === 'cross-project-edge').map(r => r.id);
  if (existing.length) await store.delete(existing);
  if (newRecords.length) await store.upsert(newRecords);
  console.log(`brain:edges --detect: ${deduped.length} edge${deduped.length === 1 ? '' : 's'} materialized.`);
}

const records = (await store.getAll())
  .filter(r => r.type === 'cross-project-edge')
  .filter(r => confidenceRank(r.edgeConfidence) >= confidenceRank(minConfidence))
  .sort((a, b) => `${a.edgeFrom}|${a.edgeTo}|${a.edgeKind}`.localeCompare(`${b.edgeFrom}|${b.edgeTo}|${b.edgeKind}`));

await store.close();

if (json) {
  console.log(JSON.stringify({
    fleet: projects.map(p => p.name),
    count: records.length,
    edges: records.map(r => ({
      from: r.edgeFrom, to: r.edgeTo, kind: r.edgeKind,
      confidence: r.edgeConfidence,
      title: r.title,
      text: r.text
    }))
  }, null, 2));
  process.exit(0);
}

if (!records.length) {
  console.log('No cross-project edges materialized. Run `brain:edges -- --detect` to refresh.');
  process.exit(0);
}

const groups = new Map();
for (const r of records) {
  const key = `${r.edgeFrom} → ${r.edgeTo}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

console.log(`# Cross-project edges (${records.length})\n`);
for (const [key, list] of groups) {
  console.log(`## ${key}`);
  for (const r of list) {
    console.log(`  - **${r.edgeKind}** (${r.edgeConfidence})`);
  }
  console.log('');
}

function confidenceRank(level) {
  return { high: 3, medium: 2, low: 1 }[level] || 0;
}
