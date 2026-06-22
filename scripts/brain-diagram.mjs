/**
 * brain:diagram — emit a diagram of the indexed brain straight from the index.
 *
 * The brain already computes the graph (buildGraph in brain-graph.mjs, the
 * symbol/import edges from ts-graph, the cross-project edges from edges/). So a
 * diagram is a pure projection of data the brain already has — no re-parsing, no
 * external parser. Default output is Mermaid (plain text, renders in docs/*.md and
 * on GitHub, ZERO new deps). `--format drawio` emits .drawio XML (also pure text;
 * the draw.io desktop CLI is only needed to rasterize it to PNG, and we never call
 * it). See decisions/0016-ecosystem-skill-axis-map.md (recall axis).
 *
 * Scopes (pick one; default is a module-level overview):
 *   (none)            module/feature/project overview of the whole repo
 *   --module <name>   files + symbols inside one module
 *   --feature <id>    files + modules + decisions implementing one feature
 *   --symbol <Name>   blast-radius ego-graph around a symbol (reuses buildImpact)
 *   --fleet           cross-project edge graph (fleet mode only)
 *
 * Output: --format mermaid|drawio|json (default mermaid), --out <path> (else stdout),
 *         --direction TD|LR (mermaid only), --max-nodes N (BRAIN_DIAGRAM_MAX_NODES).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, write, takeFlag, takeOption, listIndexableFiles } from './common.mjs';
import { openStore } from './store.mjs';
import { openEmbedder } from './embed.mjs';
import { buildGraph } from './brain-graph.mjs';
import { buildImpact } from './brain-impact.mjs';

const MAX_NODES = Number(process.env.BRAIN_DIAGRAM_MAX_NODES || 200);

function usage() {
  return [
    'Usage:',
    '  npm run brain:diagram                       # repo overview (modules/features/projects)',
    '  npm run brain:diagram -- --module lib/auth  # files + symbols in one module',
    '  npm run brain:diagram -- --feature checkout # files/modules/decisions for a feature',
    '  npm run brain:diagram -- --symbol ChargeCard# blast-radius ego-graph around a symbol',
    '  npm run brain:diagram -- --fleet            # cross-project edges (fleet mode)',
    '',
    'Options: --format mermaid|drawio|json (default mermaid) · --out <path> · --direction TD|LR · --max-nodes N'
  ].join('\n');
}

// ---------- graph builders (pure; record-based scopes are unit-testable) ----------

function addNode(map, id, type, label) { if (!map.has(id)) map.set(id, { id, type, label }); }
function edgeKey(e) { return `${e.from}->${e.to}:${e.type}`; }
function dedupeEdges(edges) {
  const seen = new Set(); const out = [];
  for (const e of edges) { const k = edgeKey(e); if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out;
}

/** Module/feature/project overview: collapse files away, keep the structural skeleton. */
export function overviewGraph(records) {
  const nodes = new Map();
  const edges = [];
  const filesByModule = new Map();
  for (const r of records) {
    if (!r || r.isSummary) continue;
    if (r.type === 'cross-project-edge' && r.edgeFrom && r.edgeTo) {
      addNode(nodes, `project:${r.edgeFrom}`, 'project', r.edgeFrom);
      addNode(nodes, `project:${r.edgeTo}`, 'project', r.edgeTo);
      edges.push({ from: `project:${r.edgeFrom}`, to: `project:${r.edgeTo}`, type: String(r.edgeKind || 'edge') });
      continue;
    }
    if (r.project) addNode(nodes, `project:${r.project}`, 'project', r.project);
    if (r.module) {
      addNode(nodes, `module:${r.module}`, 'module', r.module);
      if (!filesByModule.has(r.module)) filesByModule.set(r.module, new Set());
      if (r.file) filesByModule.get(r.module).add(r.file);
    }
    if (r.feature) addNode(nodes, `feature:${r.feature}`, 'feature', r.feature);
    if (r.project && r.module) edges.push({ from: `project:${r.project}`, to: `module:${r.module}`, type: 'contains' });
    if (r.module && r.feature) edges.push({ from: `module:${r.module}`, to: `feature:${r.feature}`, type: 'implements' });
  }
  for (const [m, files] of filesByModule) {
    const n = nodes.get(`module:${m}`);
    if (n) n.label = `${m} (${files.size})`;
  }
  return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
}

/** Fleet view: just the cross-project edges. */
export function fleetGraph(records) {
  const nodes = new Map();
  const edges = [];
  for (const r of records) {
    if (r?.type !== 'cross-project-edge' || !r.edgeFrom || !r.edgeTo) continue;
    addNode(nodes, `project:${r.edgeFrom}`, 'project', r.edgeFrom);
    addNode(nodes, `project:${r.edgeTo}`, 'project', r.edgeTo);
    edges.push({ from: `project:${r.edgeFrom}`, to: `project:${r.edgeTo}`, type: `${r.edgeKind}:${r.edgeConfidence}` });
  }
  return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
}

/** Module/feature internals: reuse buildGraph, then drop noisy import/reference nodes. */
export function scopedGraph(records, key, name) {
  const subset = records.filter(r => r && r.file && !r.isSummary && r[key] === name);
  if (!subset.length) return { nodes: [], edges: [] };
  const g = buildGraph(subset);
  const drop = new Set(g.nodes.filter(n => n.type === 'import' || n.type === 'reference').map(n => n.id));
  return {
    nodes: g.nodes.filter(n => !drop.has(n.id)),
    edges: g.edges.filter(e => !drop.has(e.from) && !drop.has(e.to))
  };
}

/** Symbol ego-graph from buildImpact (async — needs embedder/store). */
async function symbolGraph(symbol, records, store, embedder) {
  const indexable = await listIndexableFiles();
  const impact = await buildImpact(symbol, records, store, embedder, { root: ROOT, indexable, crossProject: true });
  const nodes = new Map();
  const edges = [];
  addNode(nodes, `symbol:${symbol}`, 'symbol', symbol);
  const link = (recs, type, edgeType, dir) => {
    for (const r of recs || []) {
      if (!r.file) continue;
      const id = `file:${r.file}`;
      addNode(nodes, id, type, r.file.split('/').pop());
      edges.push(dir === 'in'
        ? { from: id, to: `symbol:${symbol}`, type: edgeType }
        : { from: `symbol:${symbol}`, to: id, type: edgeType });
    }
  };
  link(impact.definitions, 'file', 'defines', 'in');
  link(impact.callers, 'file', 'calls', 'in');
  link(impact.callees, 'file', 'calls', 'out');
  link(impact.tests, 'test', 'covers', 'in');
  link(impact.decisions, 'decision', 'governs', 'in');
  for (const e of impact.crossProjectEdges?.toOwner || []) {
    addNode(nodes, `project:${e.from}`, 'project', e.from);
    edges.push({ from: `project:${e.from}`, to: `symbol:${symbol}`, type: String(e.kind || 'edge') });
  }
  return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
}

/** Cap node count so a huge monorepo doesn't emit an unrenderable blob. */
function capGraph(graph, max) {
  if (graph.nodes.length <= max) return { graph, dropped: 0 };
  const keep = new Set(graph.nodes.slice(0, max).map(n => n.id));
  return {
    graph: {
      nodes: graph.nodes.slice(0, max),
      edges: graph.edges.filter(e => keep.has(e.from) && keep.has(e.to))
    },
    dropped: graph.nodes.length - max
  };
}

// ---------- renderers ----------

function nid(id) { return id.replace(/[^A-Za-z0-9_]/g, '_'); }
function mEsc(s) { return String(s).replace(/"/g, "'").replace(/[|]/g, '/'); }

const PALETTE = {
  module: 'fill:#e1f5fe,stroke:#0277bd',
  feature: 'fill:#f3e5f5,stroke:#7b1fa2',
  project: 'fill:#fff3e0,stroke:#ef6c00',
  decision: 'fill:#e8f5e9,stroke:#2e7d32',
  symbol: 'fill:#fce4ec,stroke:#c2185b',
  test: 'fill:#fffde7,stroke:#f9a825',
  file: 'fill:#f5f5f5,stroke:#616161'
};

export function toMermaid(graph, direction = 'LR') {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const label = (id) => mEsc((byId.get(id) || { label: id }).label);
  const lines = [`flowchart ${direction}`];
  const declared = new Set();
  for (const e of graph.edges) {
    lines.push(`  ${nid(e.from)}["${label(e.from)}"] -->|${mEsc(e.type)}| ${nid(e.to)}["${label(e.to)}"]`);
    declared.add(e.from); declared.add(e.to);
  }
  for (const n of graph.nodes) if (!declared.has(n.id)) lines.push(`  ${nid(n.id)}["${mEsc(n.label)}"]`);
  const types = [...new Set(graph.nodes.map(n => n.type))].filter(t => PALETTE[t]);
  for (const t of types) lines.push(`  classDef ${t} ${PALETTE[t]};`);
  for (const n of graph.nodes) if (PALETTE[n.type]) lines.push(`  class ${nid(n.id)} ${n.type};`);
  return lines.join('\n');
}

function xEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toDrawioXml(graph) {
  const idx = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length || 1)));
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  graph.nodes.forEach((n, i) => {
    const x = 40 + (i % cols) * 200;
    const y = 40 + Math.floor(i / cols) * 110;
    cells.push(`<mxCell id="n${i}" value="${xEsc(n.label)}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="160" height="60" as="geometry"/></mxCell>`);
  });
  graph.edges.forEach((e, j) => {
    const s = idx.get(e.from); const t = idx.get(e.to);
    if (s === undefined || t === undefined) return;
    cells.push(`<mxCell id="e${j}" value="${xEsc(e.type)}" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="n${s}" target="n${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  return `<mxGraphModel><root>\n${cells.join('\n')}\n</root></mxGraphModel>\n`;
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) { console.log(usage()); process.exit(0); }
  let format = (takeOption(args, '--format') || 'mermaid').toLowerCase();
  if (takeFlag(args, '--json')) format = 'json';
  const direction = (takeOption(args, '--direction') || 'LR').toUpperCase();
  const out = takeOption(args, '--out');
  const maxNodes = Number(takeOption(args, '--max-nodes')) || MAX_NODES;
  const moduleName = takeOption(args, '--module');
  const featureName = takeOption(args, '--feature');
  const symbolName = takeOption(args, '--symbol');
  const fleet = takeFlag(args, '--fleet');

  const scopes = [moduleName && 'module', featureName && 'feature', symbolName && 'symbol', fleet && 'fleet'].filter(Boolean);
  if (scopes.length > 1) {
    process.stderr.write(`[brain:diagram] pick at most one scope (got: ${scopes.join(', ')})\n`);
    process.exit(1);
  }

  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const records = await store.getAll();

  let graph;
  let title;
  if (symbolName) { graph = await symbolGraph(symbolName, records, store, embedder); title = `Symbol: ${symbolName}`; }
  else if (moduleName) { graph = scopedGraph(records, 'module', moduleName); title = `Module: ${moduleName}`; }
  else if (featureName) { graph = scopedGraph(records, 'feature', featureName); title = `Feature: ${featureName}`; }
  else if (fleet) { graph = fleetGraph(records); title = 'Fleet: cross-project edges'; }
  else { graph = overviewGraph(records); title = 'Architecture overview'; }
  await store.close();

  if (!graph.nodes.length) {
    process.stderr.write(`[brain:diagram] no records for this scope — nothing to draw.\n`);
    // emit a valid-but-empty diagram so the command stays hook-safe (exit 0)
    graph = { nodes: [{ id: 'empty', type: 'file', label: title + ' (empty)' }], edges: [] };
  }

  const { graph: capped, dropped } = capGraph(graph, maxNodes);
  if (dropped) process.stderr.write(`[brain:diagram] capped at ${maxNodes} nodes (+${dropped} more; raise --max-nodes).\n`);

  let output;
  if (format === 'json') output = JSON.stringify({ title, ...capped }, null, 2);
  else if (format === 'drawio') output = toDrawioXml(capped);
  else output = `%% ${title}\n${toMermaid(capped, direction === 'TD' ? 'TD' : 'LR')}`;

  if (out) {
    const dest = path.isAbsolute(out) ? out : path.join(ROOT, out);
    write(dest, output.replace(/\n*$/, '\n'));
    process.stdout.write(`${path.relative(ROOT, dest)}\n`);
  } else {
    process.stdout.write(output.replace(/\n*$/, '\n'));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`[brain:diagram] ${err.message || err}\n`); process.exit(1); });
}
