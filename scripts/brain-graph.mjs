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
  const pathIdx = argv.indexOf('--path');
  const store = await openStore();
  const records = await store.getAll();
  await store.close();

  const graph = buildGraph(records);

  // --path <from> <to>: BFS call-path query ("how does X reach Y?"). Endpoints
  // are files or symbols (symbols resolve to their defining file first). One
  // line per hop with the edge label — inherently terse, so no --write guard.
  if (pathIdx !== -1) {
    const fromTok = argv[pathIdx + 1];
    const toTok = argv[pathIdx + 2];
    if (!fromTok || !toTok || fromTok.startsWith('--') || toTok.startsWith('--')) {
      process.stderr.write('Usage: npm run brain:graph -- --path <from> <to>   # from/to are files or symbols\n');
      process.exit(1);
    }
    const maxDepth = Number(peekOption(argv, '--max-depth')) || 8;
    const maxPaths = Number(peekOption(argv, '--max-paths')) || 5;
    const report = resolvePaths(graph, records, fromTok, toTok, { maxDepth, maxPaths });
    if (format === 'json') emit(JSON.stringify(report, null, 2), writePath);
    else emit(renderPaths(report), writePath);
    return;
  }

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

// --- Call-path queries (issue #24) ------------------------------------------
// "How does X reach Y?" — BFS over the same reference edges brain:graph already
// materializes. HONESTY CAVEAT: `calls:<sym>` edges are chunk-level references
// (file A mentions a symbol defined in file B), NOT a precise call graph. A
// path therefore means "reaches via reference", the same honesty bar CodeGraph
// uses — treat it as a lead, not proof of a runtime call.

// Only these edge kinds carry "reaches"-semantics for path-finding:
//   calls:<symbol>  file → file  (A references a symbol B defines)
//   exported_by     symbol → file
//   defines         file → symbol
function isPathEdge(type) {
  const t = String(type || '');
  return t.startsWith('calls:') || t === 'exported_by' || t === 'defines';
}

/**
 * BFS over the graph's reference edges from node id `from` to node id `to`.
 * Returns up to `maxPaths` paths (shortest first), each an array of hop edges
 * `{ from, to, type }`, none longer than `maxDepth` hops. No path (or bad
 * input) → `[]`. PURE — no I/O, no process exit.
 */
export function findPaths(graph, from, to, { maxDepth = 8, maxPaths = 5 } = {}) {
  const results = [];
  if (!graph || !Array.isArray(graph.edges) || !from || !to || from === to) return results;
  const adj = new Map();
  for (const e of graph.edges) {
    if (!isPathEdge(e.type)) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }
  // BFS: shortest paths surface first. `nodes` guards against cycles within a
  // single path; distinct paths may still revisit a node.
  const queue = [{ node: from, nodes: new Set([from]), edges: [] }];
  while (queue.length && results.length < maxPaths) {
    const cur = queue.shift();
    if (cur.edges.length >= maxDepth) continue;
    for (const e of adj.get(cur.node) || []) {
      if (cur.nodes.has(e.to)) continue;
      const edges = [...cur.edges, { from: e.from, to: e.to, type: e.type }];
      if (e.to === to) {
        results.push(edges);
        if (results.length >= maxPaths) break;
      } else {
        const nodes = new Set(cur.nodes);
        nodes.add(e.to);
        queue.push({ node: e.to, nodes, edges });
      }
    }
  }
  return results;
}

/**
 * Resolve a CLI endpoint token (a file path or a symbol name) to the graph
 * `file:<file>` node id(s) it stands for. File matches (exact path, then
 * path-suffix/basename) win over symbol matches; a symbol resolves to its
 * defining file(s) via `symbols`/`exportedSymbols`. PURE.
 */
export function resolveEndpoint(token, records) {
  if (!token) return { token, kind: 'none', files: [] };
  const recs = records || [];
  const exact = uniq(recs.filter(r => r.file === token).map(r => r.file));
  if (exact.length) return { token, kind: 'file', files: exact };
  const base = token.split('/').pop();
  const suffix = uniq(recs.filter(r => r.file && (r.file.endsWith('/' + token) || r.file.split('/').pop() === base && (token.includes('.') || token.includes('/')))).map(r => r.file));
  if (suffix.length) return { token, kind: 'file', files: suffix };
  const sym = uniq(recs.filter(r => (r.symbols || []).includes(token) || (r.exportedSymbols || []).includes(token)).map(r => r.file));
  if (sym.length) return { token, kind: 'symbol', files: sym };
  return { token, kind: 'none', files: [] };
}

/**
 * End-to-end call-path report: resolve both endpoints, then run findPaths over
 * every resolved from×to file pair. Returns a serializable structure the CLI
 * renders (and brain:impact can reuse). PURE.
 */
export function resolvePaths(graph, records, fromTok, toTok, opts = {}) {
  const from = resolveEndpoint(fromTok, records);
  const to = resolveEndpoint(toTok, records);
  const paths = [];
  const maxPaths = opts.maxPaths ?? 5;
  for (const f of from.files) {
    for (const t of to.files) {
      if (f === t) continue;
      for (const hops of findPaths(graph, `file:${f}`, `file:${t}`, opts)) {
        paths.push(hops);
        if (paths.length >= maxPaths) break;
      }
      if (paths.length >= maxPaths) break;
    }
    if (paths.length >= maxPaths) break;
  }
  return { from, to, paths: paths.slice(0, maxPaths) };
}

/** Human-readable render of a resolvePaths() report — one line per hop. PURE. */
export function renderPaths(report) {
  const lines = [];
  const { from, to, paths } = report;
  lines.push(`# Paths: ${from.token} → ${to.token}`);
  const endpoint = (e, side) => {
    if (e.kind === 'none') lines.push(`- ${side}: "${e.token}" matched no file or symbol`);
    else if (e.kind === 'symbol') lines.push(`- ${side}: symbol "${e.token}" → ${e.files.join(', ')}`);
    else lines.push(`- ${side}: file ${e.files.join(', ')}`);
  };
  endpoint(from, 'from');
  endpoint(to, 'to');
  lines.push('_edges are chunk-level references, not a precise call graph — "reaches via reference"._');
  if (!paths.length) {
    lines.push('\nNo path found.');
    return lines.join('\n');
  }
  paths.forEach((hops, i) => {
    lines.push(`\n## Path ${i + 1} (${hops.length} hop${hops.length === 1 ? '' : 's'})`);
    for (const h of hops) lines.push(`  ${label(h.from)} --${h.type}--> ${label(h.to)}`);
  });
  return lines.join('\n');
}

function uniq(values) {
  return [...new Set(values)];
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

