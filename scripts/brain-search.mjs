import fs from 'node:fs';
import { JSON_INDEX, MANIFEST, read } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';

const args = process.argv.slice(2);
const summaryOnly = takeFlag(args, '--summary-only');
const modulesOnly = takeFlag(args, '--modules-only');
const json = takeFlag(args, '--json');
const type = takeOption(args, '--type');
const symbol = takeOption(args, '--symbol');
const taskOpt = takeOption(args, '--task');
const actorOpt = takeOption(args, '--actor');
const query = args.join(' ').trim();
if (!query) {
  console.error('Usage: npm run brain:search -- "query" [--summary-only] [--modules-only] [--type doc] [--symbol SymbolName] [--task <id>] [--actor <label>] [--json]');
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
const results = await retrieve(query, store, embedder, {
  topK: Number(process.env.BRAIN_TOP_K || 8),
  symbol,
  filter: { summaryOnly, modulesOnly, type },
  taskId,
  actor
});
await store.close();

if (json) {
  console.log(JSON.stringify({ query, results: results.map(toJsonResult) }, null, 2));
} else {
  for (const r of results) {
    const flags = [r.type, r.isModuleSummary ? 'module-summary' : '', r.isProjectSummary ? 'project-summary' : '', r.isSummary ? 'summary' : ''].filter(Boolean).join(',');
    const scoring = `dense=${r.denseScore.toFixed(3)} keyword=${r.keywordScore.toFixed(3)} symbol=${r.symbolScore.toFixed(3)} metadata=${r.metadataScore.toFixed(3)}`;
    console.log(`\n--- ${r.score.toFixed(4)} ${r.file}#chunk-${r.chunk} [${flags}] ${scoring}`);
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

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const value = args[index + 1] || '';
  args.splice(index, 2);
  return value;
}
