/**
 * Exports a JSON or Mermaid graph of the indexed brain:
 * file → module → feature → decision → symbol → import edges.
 * `--format mermaid` is human-inspectable; `--format json` is machine-
 * consumable for follow-up tooling.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peekOption, atomicWrite } from './common.mjs';
import { openStore } from './store.mjs';

// A full `--format json` graph can be multi-MB. Emitting that straight to a
// terminal (i.e. into an agent's context) is a token bomb (decisions/0024); we
// warn — but never suppress — when stdout is a TTY and the payload is fat.
export const GRAPH_TTY_WARN_BYTES = 200 * 1024; // ~200 KB

async function main() {
  const argv = process.argv;
  const format = peekOption(argv, '--format') || 'json';
  const stats = argv.includes('--stats');
  const writePath = peekOption(argv, '--write');
  const store = await openStore();
  const records = await store.getAll();
  await store.close();

  const graph = buildGraph(records);

  // --stats: compact node/edge histogram instead of the full graph — the cheap
  // way to inspect the index shape inside a session.
  if (stats) {
    const s = graphStats(graph);
    const out = format === 'json' ? JSON.stringify(s, null, 2) : renderStats(s);
    emit(out, writePath);
    return;
  }

  const out = format === 'mermaid' ? toMermaid(graph) : JSON.stringify(graph, null, 2);
  emit(out, writePath);
}

/**
 * Write `out` to `writePath` (context-safe) or stdout. On a TTY, an oversized
 * stdout payload gets a one-line stderr nudge toward `--write`/`--stats` — the
 * default format is never changed, so pipes stay byte-for-byte compatible.
 */
function emit(out, writePath) {
  if (writePath) {
    atomicWrite(writePath, out.endsWith('\n') ? out : out + '\n');
    process.stderr.write(`[brain:graph] wrote ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(0)} KB → ${writePath}\n`);
    return;
  }
  const bytes = Buffer.byteLength(out, 'utf8');
  if (process.stdout.isTTY && bytes > GRAPH_TTY_WARN_BYTES) {
    process.stderr.write(`[brain:graph] emitting ${(bytes / 1024).toFixed(0)} KB to a terminal — in a session use \`--stats\` or \`--write <file>\` to avoid flooding context\n`);
  }
  console.log(out);
}

// Only run the CLI when invoked directly; importing buildGraph (e.g. from
// brain-diagram.mjs) must not open the store or print a graph.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`[brain:graph] ${err.message || err}\n`); process.exit(1); });
}

export function buildGraph(records) {
  const nodes = new Map();
  const edges = new Map();
  for (const record of records) {
    // Cross-project edges (chunk:-9) materialize as project→project graph edges
    // and don't get the per-file/symbol breakdown applied.
    if (record.type === 'cross-project-edge' && record.edgeFrom && record.edgeTo) {
      addNode(nodes, `project:${record.edgeFrom}`, 'project', record.edgeFrom);
      addNode(nodes, `project:${record.edgeTo}`, 'project', record.edgeTo);
      addEdge(edges, `project:${record.edgeFrom}`, `project:${record.edgeTo}`, `${record.edgeKind}:${record.edgeConfidence}`);
      continue;
    }
    addNode(nodes, `file:${record.file}`, 'file', record.file);
    if (record.project) {
      addNode(nodes, `project:${record.project}`, 'project', record.project);
      addEdge(edges, `file:${record.file}`, `project:${record.project}`, 'belongs_to_project');
    }
    if (record.module) {
      addNode(nodes, `module:${record.module}`, 'module', record.module);
      addEdge(edges, `file:${record.file}`, `module:${record.module}`, 'belongs_to');
    }
    if (record.feature) {
      addNode(nodes, `feature:${record.feature}`, 'feature', record.feature);
      addEdge(edges, `file:${record.file}`, `feature:${record.feature}`, 'implements');
    }
    if (record.decision) {
      addNode(nodes, `decision:${record.decision}`, 'decision', record.decision);
      addEdge(edges, `file:${record.file}`, `decision:${record.decision}`, 'records');
    }
    for (const symbol of record.symbols || []) {
      addNode(nodes, `symbol:${record.file}:${symbol}`, 'symbol', symbol);
      addEdge(edges, `file:${record.file}`, `symbol:${record.file}:${symbol}`, 'defines');
    }
    for (const symbol of record.exportedSymbols || []) {
      addNode(nodes, `symbol:${record.file}:${symbol}`, 'symbol', symbol);
      addEdge(edges, `symbol:${record.file}:${symbol}`, `file:${record.file}`, 'exported_by');
    }
    for (const specifier of record.imports || []) {
      addNode(nodes, `import:${specifier}`, 'import', specifier);
      addEdge(edges, `file:${record.file}`, `import:${specifier}`, 'imports');
    }
    for (const reference of record.references || []) {
      addNode(nodes, `reference:${reference}`, 'reference', reference);
      addEdge(edges, `file:${record.file}`, `reference:${reference}`, 'references');
    }
  }
  addResolvedReferenceEdges(nodes, edges, records);
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Node/edge totals and per-type histograms for a built graph. Edge types are
 * grouped by their prefix before the first ':' so high-cardinality edges
 * (`calls:foo`, `k8s-image:0.9`) collapse into one bucket each. PURE.
 */
export function graphStats(graph) {
  const nodesByType = {};
  const edgesByType = {};
  for (const n of graph.nodes || []) nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  for (const e of graph.edges || []) {
    const key = edgeTypeKey(e.type);
    edgesByType[key] = (edgesByType[key] || 0) + 1;
  }
  return {
    nodes: (graph.nodes || []).length,
    edges: (graph.edges || []).length,
    nodesByType,
    edgesByType
  };
}

function edgeTypeKey(type) {
  const t = String(type || '');
  const i = t.indexOf(':');
  return i === -1 ? t : t.slice(0, i);
}

/** Human-readable one-block summary of graphStats(). PURE. */
export function renderStats(s) {
  const lines = [`nodes: ${s.nodes}  edges: ${s.edges}`];
  const hist = (label, obj) => {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return;
    lines.push(label);
    for (const [k, v] of entries) lines.push(`  ${k}: ${v}`);
  };
  hist('nodes by type:', s.nodesByType);
  hist('edges by type:', s.edgesByType);
  return lines.join('\n');
}

function addResolvedReferenceEdges(nodes, edges, records) {
  const definitions = new Map();
  for (const record of records) {
    for (const symbol of record.symbols || []) {
      if (!definitions.has(symbol)) definitions.set(symbol, new Set());
      definitions.get(symbol).add(record.file);
    }
  }
  for (const record of records) {
    for (const reference of record.references || []) {
      for (const targetFile of definitions.get(reference) || []) {
        if (targetFile === record.file) continue;
        addNode(nodes, `file:${targetFile}`, 'file', targetFile);
        addEdge(edges, `file:${record.file}`, `file:${targetFile}`, `calls:${reference}`);
      }
    }
  }
}

function addNode(nodes, id, type, label) {
  if (!nodes.has(id)) nodes.set(id, { id, type, label });
}

function addEdge(edges, from, to, type) {
  const id = `${from}->${to}:${type}`;
  if (!edges.has(id)) edges.set(id, { from, to, type });
}

function toMermaid(graph) {
  const lines = ['flowchart LR'];
  for (const edge of graph.edges) {
    lines.push(`  ${nodeId(edge.from)}["${label(edge.from)}"] -->|${edge.type}| ${nodeId(edge.to)}["${label(edge.to)}"]`);
  }
  return lines.join('\n');
}

function nodeId(id) {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function label(id) {
  return id.replace(/^(file|module|feature|decision|symbol|import|reference|project):/, '').replace(/"/g, "'");
}

