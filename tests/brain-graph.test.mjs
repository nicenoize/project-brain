import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph, graphStats, renderStats, GRAPH_TTY_WARN_BYTES } from '../scripts/brain-graph.mjs';

const RECORDS = [
  { file: 'a.ts', module: 'mod1', symbols: ['Foo'], references: ['Bar'] },
  { file: 'b.ts', module: 'mod1', symbols: ['Bar'], references: ['Foo'] },
  { file: 'c.ts', feature: 'checkout', imports: ['./a.ts'] }
];

test('graphStats: totals + per-type histograms match the built graph', () => {
  const graph = buildGraph(RECORDS);
  const s = graphStats(graph);
  assert.equal(s.nodes, graph.nodes.length);
  assert.equal(s.edges, graph.edges.length);
  // Node histogram sums back to the node total.
  assert.equal(Object.values(s.nodesByType).reduce((a, b) => a + b, 0), s.nodes);
  assert.equal(Object.values(s.edgesByType).reduce((a, b) => a + b, 0), s.edges);
  assert.equal(s.nodesByType.file, 3);
  assert.equal(s.nodesByType.module, 1);
});

test('graphStats: high-cardinality edge types collapse by prefix before ":"', () => {
  // The Foo/Bar mutual references resolve to `calls:Foo` / `calls:Bar` edges,
  // which must bucket under a single `calls` key, not two.
  const s = graphStats(buildGraph(RECORDS));
  assert.ok(s.edgesByType.calls >= 1);
  assert.ok(!Object.keys(s.edgesByType).some(k => k.includes(':')), 'edge buckets are colon-free prefixes');
});

test('graphStats: empty/malformed graph is safe', () => {
  assert.deepEqual(graphStats({}), { nodes: 0, edges: 0, nodesByType: {}, edgesByType: {} });
  assert.deepEqual(graphStats({ nodes: [], edges: [] }), { nodes: 0, edges: 0, nodesByType: {}, edgesByType: {} });
});

test('renderStats: human-readable block leads with totals and lists buckets', () => {
  const text = renderStats(graphStats(buildGraph(RECORDS)));
  assert.match(text, /^nodes: \d+  edges: \d+/);
  assert.match(text, /nodes by type:/);
  assert.match(text, /file: 3/);
});

test('GRAPH_TTY_WARN_BYTES: ~200 KB threshold is exported for the guard', () => {
  assert.equal(GRAPH_TTY_WARN_BYTES, 200 * 1024);
});
