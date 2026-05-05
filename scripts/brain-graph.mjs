import { openStore } from './store.mjs';

const format = takeOption(process.argv, '--format') || 'json';
const store = await openStore();
const records = await store.getAll();
await store.close();

const graph = buildGraph(records);
if (format === 'mermaid') console.log(toMermaid(graph));
else console.log(JSON.stringify(graph, null, 2));

export function buildGraph(records) {
  const nodes = new Map();
  const edges = new Map();
  for (const record of records) {
    addNode(nodes, `file:${record.file}`, 'file', record.file);
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
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
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
  return id.replace(/^(file|module|feature|decision|symbol|import):/, '').replace(/"/g, "'");
}

function takeOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return '';
  return argv[index + 1] || '';
}
