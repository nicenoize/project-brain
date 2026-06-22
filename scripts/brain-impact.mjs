/**
 * Symbol impact analyzer: for one identifier, retrieves its definitions,
 * direct callers/callees, tests, related ADRs, and adjacent brain
 * chunks — so an agent can answer "what breaks if I rename X" without
 * grepping. Uses ts-graph workspace references when `typescript` is
 * installed, regex fallback otherwise.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, listIndexableFiles, takeFlag } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';
import { findTsWorkspaceReferences } from './ts-graph.mjs';

const GLOBAL_REFS = new Set(['JSON', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'Math', 'Date', 'Error', 'Promise']);
async function main() {
  const args = process.argv.slice(2);
  const json = takeFlag(args, '--json');
  const crossProject = takeFlag(args, '--cross-project');
  const symbol = args[0];
  if (!symbol) {
    console.error('Usage: npm run brain:impact -- SymbolName [--cross-project] [--json]');
    process.exit(1);
  }

  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const records = await store.getAll();
  const indexable = await listIndexableFiles();
  const impact = await buildImpact(symbol, records, store, embedder, { root: ROOT, indexable, crossProject });
  await store.close();

  if (json) console.log(JSON.stringify(impact, null, 2));
  else printImpact(impact);
}

// Only run the CLI when invoked directly; importing buildImpact (e.g. from
// brain-improve.mjs) must not parse argv, open the store, or call process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export async function buildImpact(symbol, records, store, embedder, options = {}) {
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
  const typescript = await resolveTypeScriptImpact(symbol, options);
  const crossProjectEdges = options.crossProject !== false
    ? findCrossProjectEdges(definitionRecords, records)
    : { fromOwner: [], toOwner: [] };
  return {
    symbol,
    definitions: summarizeRecords(definitionRecords),
    callers: summarizeRecords(callers),
    callees: summarizeRecords(callees),
    tests: summarizeRecords(tests),
    decisions: summarizeRecords(decisions),
    related: summarizeRecords(related),
    typescript,
    crossProjectEdges
  };
}

/**
 * Given the symbol's definition records, find any cross-project-edge records
 * touching the owning project(s). Returns edges grouped by direction so
 * "rename this symbol → who calls me / who do I call across projects" is one
 * lookup.
 */
function findCrossProjectEdges(definitionRecords, records) {
  const ownerProjects = unique(definitionRecords.map(r => r.project).filter(Boolean));
  if (!ownerProjects.length) return { ownerProjects: [], fromOwner: [], toOwner: [] };
  const edges = records.filter(r => r.type === 'cross-project-edge');
  return {
    ownerProjects,
    fromOwner: edges.filter(e => ownerProjects.includes(e.edgeFrom)).map(summarizeEdge),
    toOwner: edges.filter(e => ownerProjects.includes(e.edgeTo)).map(summarizeEdge)
  };
}

function summarizeEdge(record) {
  return {
    from: record.edgeFrom,
    to: record.edgeTo,
    kind: record.edgeKind,
    confidence: record.edgeConfidence
  };
}

async function resolveTypeScriptImpact(symbol, options) {
  if (process.env.BRAIN_TS_GRAPH === '0' || process.env.BRAIN_IMPACT_TS === '0') {
    return { enabled: false, reason: 'disabled_via_env' };
  }
  const root = options.root || ROOT;
  const paths = options.indexable;
  if (!paths?.length) {
    return { enabled: false, reason: 'no_indexable_paths' };
  }
  const refs = await findTsWorkspaceReferences(root, new Set(paths), symbol);
  if (refs === null) {
    return { enabled: false, reason: 'no_ts_program' };
  }
  return {
    enabled: true,
    definitions: refs.definitions,
    usages: refs.usages
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
  printTypeScriptSection(impact.typescript);
  printGroup('Tests', impact.tests);
  printGroup('Decisions', impact.decisions);
  printGroup('Related retrieval', impact.related);
  printCrossProjectSection(impact.crossProjectEdges);
}

function printCrossProjectSection(cpe) {
  if (!cpe || (!cpe.fromOwner?.length && !cpe.toOwner?.length)) return;
  console.log('\n## Cross-project edges');
  if (cpe.ownerProjects?.length) console.log(`- Owning project(s): ${cpe.ownerProjects.join(', ')}`);
  if (cpe.fromOwner?.length) {
    console.log('### Outbound (owner → other)');
    for (const e of cpe.fromOwner) console.log(`- ${e.from} → ${e.to} via ${e.kind} (${e.confidence})`);
  }
  if (cpe.toOwner?.length) {
    console.log('### Inbound (other → owner) — these break if symbol changes shape');
    for (const e of cpe.toOwner) console.log(`- ${e.from} → ${e.to} via ${e.kind} (${e.confidence})`);
  }
}

function printTypeScriptSection(ts) {
  console.log('\n## TypeScript (compiler find-references)');
  if (!ts?.enabled) {
    const reason = ts?.reason || 'unavailable';
    console.log(`- Skipped (${reason}). Install \`typescript\`, widen index globs (\`BRAIN_INDEX_EXTRA_GLOBS\`), or unset BRAIN_TS_GRAPH=0 / BRAIN_IMPACT_TS=0.`);
    return;
  }
  if (!ts.definitions?.length && !ts.usages?.length) {
    console.log('- No workspace declaration matched this exact symbol name (declarations drive find-references).');
    return;
  }
  if (ts.definitions?.length) {
    console.log('### Declarations');
    for (const row of ts.definitions) console.log(`- ${row.file}:${row.line}:${row.column}`);
  }
  if (ts.usages?.length) {
    console.log('### Usages');
    for (const row of ts.usages.slice(0, 200)) console.log(`- ${row.file}:${row.line}:${row.column}`);
    if (ts.usages.length > 200) console.log(`- … and ${ts.usages.length - 200} more`);
  }
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


