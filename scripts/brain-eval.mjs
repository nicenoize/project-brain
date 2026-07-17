/**
 * Retrieval-quality eval: runs a list of {query, expectedFiles/Symbols}
 * cases from .project-brain/eval.json (or built-in smoke set) and
 * reports recall@K + a per-case pass/fail line. Used to baseline
 * retrieval tuning before/after changes.
 *
 * Flags:
 *   --file <path>    eval cases (default .project-brain/eval.json)
 *   --top-k <n>      K for recall@K (default 8 / BRAIN_EVAL_TOP_K)
 *   --hard-only      only cases whose note starts with "Hard:" (the
 *                    vocabulary-mismatch subset; see docs/eval-methodology.md)
 *   --diagnose       per-case failure diagnosis: expected file's rank in the
 *                    dense candidate pool, in the full scored list, and over
 *                    the whole corpus — distinguishes candidate-generation
 *                    misses from ranking misses (see docs/eval-failure-analysis.md)
 *   --out <path>     write the full JSON report to a file; stdout then gets
 *                    the summary only
 *
 * The store/model preamble ("Project Brain store: ...", "Loading local
 * embedding model: ...") goes to STDERR, so stdout is pure JSON and
 * `node scripts/brain-eval.mjs --hard-only > r.json` is directly valid and
 * pipeable into brain:eval:compare. (BRAIN_QUIET=1 still silences the banner
 * entirely.)
 */
import fs from 'node:fs';
import { BRAIN_DIR, read, write, peekOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';
import { evaluateCase, summarize, isHardCase, diagnoseCase } from './eval-lib.mjs';

const file = peekOption(process.argv, '--file') || `${BRAIN_DIR}/eval.json`;
const topK = Number(peekOption(process.argv, '--top-k') || process.env.BRAIN_EVAL_TOP_K || 8);
const hardOnly = process.argv.includes('--hard-only');
const diagnose = process.argv.includes('--diagnose');
const outPath = peekOption(process.argv, '--out');

const allCases = loadCases(file);
const cases = hardOnly ? allCases.filter(isHardCase) : allCases;
if (!cases.length) {
  console.error(hardOnly
    ? `No hard cases found in ${file} (hard cases carry a note starting with "Hard:").`
    : `No eval cases found. Create ${file} with [{"query":"...","expectedFiles":["..."]}].`);
  process.exit(1);
}

const embedder = openEmbedder();
const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
// Diagnosis needs the full corpus once (for exact corpus-wide dense ranks).
const allRecords = diagnose ? await store.getAll() : null;
const results = [];
for (const item of cases) {
  const trace = diagnose ? {} : null;
  const found = await retrieve(item.query, store, embedder, {
    topK,
    symbol: item.expectedSymbols?.join(',') || item.symbol || '',
    // Symbol-heavy cases need the full-corpus scan because dense-only candidate
    // pruning can miss out-of-vocab symbols (e.g. "QdrantStore" is OOV for MiniLM
    // and won't appear in topK*8 dense candidates). See decision 0003.
    broadCandidates: Boolean(item.expectedSymbols?.length),
    filter: item.expectedTypes?.length === 1 ? { type: item.expectedTypes[0] } : {},
    ...(trace ? { trace } : {})
  });
  const result = evaluateCase(item, found, topK);
  if (trace) result.diagnosis = diagnoseCase(item, trace, { topK, allRecords });
  results.push(result);
}
await store.close();

const report = summarize(results, topK);
if (outPath) {
  write(outPath, JSON.stringify(report, null, 2));
  const { results: _results, ...summaryOnly } = report;
  console.log(JSON.stringify({ ...summaryOnly, out: outPath }, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (process.env.BRAIN_EVAL_STRICT === '1' && report.failures.length) process.exit(1);

function loadCases(file) {
  if (fs.existsSync(file)) return JSON.parse(read(file));
  return [
    { query: 'Qdrant adapter', expectedFiles: ['scripts/store.mjs'], expectedSymbols: ['QdrantStore'], expectedTypes: ['code'] },
    { query: 'prompt token budget', expectedFiles: ['scripts/brain-pack.mjs'], expectedSymbols: ['packPrompt'], expectedTypes: ['code'] },
    { query: 'changed file boost', expectedFiles: ['scripts/retrieval.mjs'], expectedSymbols: ['metadataBoost'], expectedTypes: ['code'] },
    { query: 'AST chunking', expectedFiles: ['scripts/chunk.mjs'], expectedSymbols: ['findSymbolsAst'], expectedTypes: ['code'] }
  ];
}
