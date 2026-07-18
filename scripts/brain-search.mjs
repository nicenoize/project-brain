/**
 * Hybrid semantic search over the local Project Brain index.
 *
 * Embeds the query, hits the configured vector store (lance/qdrant/json),
 * then re-scores candidates with BM25 + symbol matching + metadata boosts
 * (see retrieval.mjs). Filters: --summary-only, --modules-only,
 * --type code|doc|module-summary|…, --file path, --symbol name.
 */
import fs from 'node:fs';
import { JSON_INDEX, MANIFEST, read, takeFlag, takeOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve, staleResults, staleBanner } from './retrieval.mjs';
import { openStore } from './store.mjs';
import { terseHitLine, verboseHitHeader } from './search-format.mjs';

const args = process.argv.slice(2);
const summaryOnly = takeFlag(args, '--summary-only');
const modulesOnly = takeFlag(args, '--modules-only');
const json = takeFlag(args, '--json');
const terse = takeFlag(args, '--terse');
const explain = takeFlag(args, '--explain');
const type = takeOption(args, '--type');
const symbol = takeOption(args, '--symbol');
const taskOpt = takeOption(args, '--task');
const actorOpt = takeOption(args, '--actor');
const projectOpt = takeOption(args, '--project');
const edgeKindOpt = takeOption(args, '--edge-kind');
const query = args.join(' ').trim();
if (!query) {
  console.error('Usage: npm run brain:search -- "query" [--terse] [--explain] [--summary-only] [--modules-only] [--type doc] [--symbol SymbolName] [--task <id>] [--actor <label>] [--project name[,name2]] [--edge-kind k8s-image|http-call|...] [--json]');
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

const store = await openStore({ model: manifest.model || embedder.modelName, dims: manifest.dims || embedder.dims });
const taskId = String(taskOpt || process.env.BRAIN_TASK || '').trim();
const actor = String(actorOpt || process.env.BRAIN_ACTOR || '').trim();
// Capture the query-expansion audit only when BRAIN_QUERY_EXPAND=1 (issue #19).
// With the flag off, no trace is passed and the output is byte-identical.
const expandTrace = process.env.BRAIN_QUERY_EXPAND === '1' ? {} : null;
const results = await retrieve(query, store, embedder, {
  topK: Number(process.env.BRAIN_TOP_K || 8),
  symbol,
  filter: {
    summaryOnly, modulesOnly, type,
    ...(projectOpt ? { project: projectOpt } : {}),
    ...(edgeKindOpt ? { edgeKind: edgeKindOpt } : {})
  },
  taskId,
  actor,
  ...(expandTrace ? { trace: expandTrace } : {})
});
await store.close();

// Query-time staleness banner (ADR 0025): warn when a result file drifted from
// the index. Default-on; opt-out BRAIN_STALE_BANNER=0. Output-only, no ranking.
const banner = staleBanner(results);

if (json) {
  console.log(JSON.stringify({
    query,
    ...(expandTrace ? { expansion: expandTrace.queryExpansion || null } : {}),
    stale: process.env.BRAIN_STALE_BANNER === '0' ? [] : staleResults(results),
    results: results.map(toJsonResult)
  }, null, 2));
} else if (terse) {
  // One line per hit, bodies omitted, no diagnostics — the token-lean default
  // for agents that only need paths (decisions/0024).
  if (banner) console.log(banner);
  for (const r of results) console.log(terseHitLine(r));
} else {
  // Verbose: header (+ diagnostics only under --explain) then the chunk body.
  if (banner) console.log(banner);
  for (const r of results) {
    console.log(`\n${verboseHitHeader(r, { explain })}`);
    console.log(r.text.slice(0, 900).trim());
  }
}

function toJsonResult(record) {
  return {
    id: record.id,
    file: record.file,
    chunk: record.chunk,
    title: record.title,
    type: record.type,
    taskId: record.taskId,
    actor: record.actor,
    tool: record.tool,
    parentRun: record.parentRun,
    heading: record.heading,
    score: record.score,
    denseScore: record.denseScore,
    keywordScore: record.keywordScore,
    symbolScore: record.symbolScore,
    metadataScore: record.metadataScore,
    module: record.module,
    feature: record.feature,
    decision: record.decision,
    provenance: record.provenance,
    layer: record.layer,
    docStatus: record.docStatus,
    synthetic: record.synthetic,
    noindex: record.noindex,
    mtime: record.mtime,
    symbols: record.symbols,
    symbolKinds: record.symbolKinds,
    exportedSymbols: record.exportedSymbols,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    imports: record.imports,
    references: record.references,
    text: record.text
  };
}

