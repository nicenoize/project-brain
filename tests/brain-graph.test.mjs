import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph, graphStats, renderStats, GRAPH_TTY_WARN_BYTES, findPaths, resolveEndpoint, resolvePaths, renderPaths } from '../scripts/brain-graph.mjs';

// A three-file reference chain: a --calls:Bar--> b --calls:Baz--> c.
const CHAIN = [
  { file: 'a.ts', symbols: ['Foo'], references: ['Bar'] },
  { file: 'b.ts', symbols: ['Bar'], references: ['Baz'] },
  { file: 'c.ts', symbols: ['Baz'] }
];

// A diamond: two distinct 2-hop paths from a to d (via b and via c).
const DIAMOND = [
  { file: 'a.ts', symbols: ['Foo'], references: ['Bar', 'Car'] },
  { file: 'b.ts', symbols: ['Bar'], references: ['Dar'] },
  { file: 'c.ts', symbols: ['Car'], references: ['Dar'] },
  { file: 'd.ts', symbols: ['Dar'] }
];

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

test('findPaths: BFS finds the reference chain a → b → c', () => {
  const graph = buildGraph(CHAIN);
  const paths = findPaths(graph, 'file:a.ts', 'file:c.ts');
  assert.equal(paths.length, 1);
  const hops = paths[0];
  assert.equal(hops.length, 2);
  assert.equal(hops[0].from, 'file:a.ts');
  assert.equal(hops[0].to, 'file:b.ts');
  assert.equal(hops[0].type, 'calls:Bar');
  assert.equal(hops[1].to, 'file:c.ts');
  assert.equal(hops[1].type, 'calls:Baz');
});

test('findPaths: maxDepth bounds path length (2-hop path excluded at maxDepth=1)', () => {
  const graph = buildGraph(CHAIN);
  assert.equal(findPaths(graph, 'file:a.ts', 'file:c.ts', { maxDepth: 1 }).length, 0);
  assert.equal(findPaths(graph, 'file:a.ts', 'file:c.ts', { maxDepth: 2 }).length, 1);
});

test('findPaths: maxPaths caps the number of returned paths', () => {
  const graph = buildGraph(DIAMOND);
  assert.equal(findPaths(graph, 'file:a.ts', 'file:d.ts').length, 2);
  assert.equal(findPaths(graph, 'file:a.ts', 'file:d.ts', { maxPaths: 1 }).length, 1);
});

test('findPaths: no path returns empty; self and bad input are safe', () => {
  const graph = buildGraph(CHAIN);
  assert.deepEqual(findPaths(graph, 'file:c.ts', 'file:a.ts'), []); // edges are directed
  assert.deepEqual(findPaths(graph, 'file:a.ts', 'file:a.ts'), []); // self
  assert.deepEqual(findPaths(null, 'x', 'y'), []);
  assert.deepEqual(findPaths(graph, 'file:missing.ts', 'file:c.ts'), []);
});

test('resolveEndpoint: symbol resolves to its defining file; file path resolves directly', () => {
  assert.deepEqual(resolveEndpoint('Foo', CHAIN), { token: 'Foo', kind: 'symbol', files: ['a.ts'] });
  assert.deepEqual(resolveEndpoint('Baz', CHAIN), { token: 'Baz', kind: 'symbol', files: ['c.ts'] });
  assert.deepEqual(resolveEndpoint('a.ts', CHAIN), { token: 'a.ts', kind: 'file', files: ['a.ts'] });
  assert.deepEqual(resolveEndpoint('nope', CHAIN), { token: 'nope', kind: 'none', files: [] });
});

test('resolvePaths: symbol endpoints resolve to files then BFS the chain', () => {
  const report = resolvePaths(buildGraph(CHAIN), CHAIN, 'Foo', 'Baz');
  assert.equal(report.from.kind, 'symbol');
  assert.equal(report.to.kind, 'symbol');
  assert.equal(report.paths.length, 1);
  assert.equal(report.paths[0].length, 2);
});

test('resolvePaths: no-path report has empty paths (renders "No path found")', () => {
  const report = resolvePaths(buildGraph(CHAIN), CHAIN, 'Baz', 'Foo');
  assert.deepEqual(report.paths, []);
  assert.match(renderPaths(report), /No path found/);
});

test('renderPaths: one line per hop with the edge label + honesty caveat', () => {
  const report = resolvePaths(buildGraph(CHAIN), CHAIN, 'Foo', 'Baz');
  const text = renderPaths(report);
  assert.match(text, /reaches via reference/);
  assert.match(text, /a\.ts --calls:Bar--> b\.ts/);
  assert.match(text, /b\.ts --calls:Baz--> c\.ts/);
});
