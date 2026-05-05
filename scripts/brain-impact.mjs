import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';

const GLOBAL_REFS = new Set(['JSON', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'Math', 'Date', 'Error', 'Promise']);
const args = process.argv.slice(2);
const json = takeFlag(args, '--json');
const symbol = args[0];
if (!symbol) {
  console.error('Usage: npm run brain:impact -- SymbolName [--json]');
  process.exit(1);
}

const embedder = openEmbedder();
const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
const records = await store.getAll();
const impact = await buildImpact(symbol, records, store, embedder);
await store.close();

if (json) console.log(JSON.stringify(impact, null, 2));
else printImpact(impact);

export async function buildImpact(symbol, records, store, embedder) {
  const codeRecords = records.filter(record => record.type === 'code' && !record.isSummary);
  const definitionRecords = codeRecords.filter(record => has(record.symbols, symbol) || has(record.exportedSymbols, symbol));
  const definitionFiles = unique(definitionRecords.map(record => record.file));
  const definitionIds = new Set(definitionRecords.map(record => record.id));
  const callers = codeRecords.filter(record => !definitionIds.has(record.id) && has(record.references, symbol));
  const callees = findCallees(definitionRecords, codeRecords);
  const tests = findTests(definitionFiles, records);
  const decisions = findDecisions(definitionFiles, records);
  const related = await retrieve(symbol, store, embedder, {
    topK: Number(process.env.BRAIN_IMPACT_TOP_K || 8),
    symbol,
    filter: {}
  });
  return {
    symbol,
    definitions: summarizeRecords(definitionRecords),
    callers: summarizeRecords(callers),
    callees: summarizeRecords(callees),
    tests: summarizeRecords(tests),
    decisions: summarizeRecords(decisions),
    related: summarizeRecords(related)
  };
}

function findCallees(definitionRecords, records) {
  const definitionIds = new Set(definitionRecords.map(record => record.id));
  const definedSymbols = new Set(definitionRecords.flatMap(record => record.symbols || []));
  const refs = unique(definitionRecords.flatMap(record => record.references || []))
    .filter(ref => /^[A-Z]/.test(ref) && !GLOBAL_REFS.has(ref) && !definedSymbols.has(ref));
  return records.filter(record => !definitionIds.has(record.id) && refs.some(ref => hasExact(record.symbols, ref) || hasExact(record.exportedSymbols, ref)));
}

function findTests(files, records) {
  const stems = files.map(file => file.replace(/\.[^.]+$/, '').split('/').pop()).filter(Boolean);
  return records.filter(record => {
    const lower = record.file.toLowerCase();
    return (lower.includes('.test.') || lower.includes('.spec.') || lower.includes('/__tests__/')) &&
      stems.some(stem => lower.includes(stem.toLowerCase()));
  });
}

function findDecisions(files, records) {
  const modules = unique(records.filter(record => files.includes(record.file)).map(record => record.module).filter(Boolean));
  return records.filter(record => record.type === 'decision' && modules.some(module => record.text.includes(module) || record.module === module));
}

function summarizeRecords(records) {
  return records.map(record => ({
    file: record.file,
    chunk: record.chunk,
    type: record.type,
    heading: record.heading,
    symbols: record.symbols || [],
    references: record.references || [],
    lineStart: record.lineStart || 0,
    lineEnd: record.lineEnd || 0,
    score: record.score || 0
  }));
}

function printImpact(impact) {
  console.log(`# Impact: ${impact.symbol}`);
  printGroup('Definitions', impact.definitions);
  printGroup('Direct callers', impact.callers);
  printGroup('Direct callees', impact.callees);
  printGroup('Tests', impact.tests);
  printGroup('Decisions', impact.decisions);
  printGroup('Related retrieval', impact.related);
}

function printGroup(title, records) {
  console.log(`\n## ${title}`);
  if (!records.length) {
    console.log('- None found');
    return;
  }
  for (const record of records) {
    const lines = record.lineStart ? `:${record.lineStart}-${record.lineEnd}` : '';
    const symbols = record.symbols?.length ? ` [${record.symbols.join(', ')}]` : '';
    console.log(`- ${record.file}${lines} ${record.type}${symbols}`);
  }
}

function has(values = [], value) {
  return values.map(normalize).includes(normalize(value));
}

function hasExact(values = [], value) {
  return values.includes(value);
}

function unique(values) {
  return [...new Set(values)];
}

function normalize(value) {
  return String(value).toLowerCase();
}


function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}
