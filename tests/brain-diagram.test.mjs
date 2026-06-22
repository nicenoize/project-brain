import { test } from 'node:test';
import assert from 'node:assert/strict';

import { overviewGraph, fleetGraph, scopedGraph, toMermaid, toDrawioXml } from '../scripts/brain-diagram.mjs';

const RECORDS = [
  { file: 'lib/auth/login.ts', module: 'lib/auth', feature: 'auth', project: 'web', type: 'code', symbols: ['login'], references: ['verifyToken'], imports: ['./token'] },
  { file: 'lib/auth/token.ts', module: 'lib/auth', project: 'web', type: 'code', symbols: ['verifyToken'], references: [] },
  { file: 'lib/pay/charge.ts', module: 'lib/pay', feature: 'checkout', project: 'web', type: 'code', symbols: ['charge'], references: [] },
  { type: 'cross-project-edge', edgeFrom: 'web', edgeTo: 'api', edgeKind: 'http-client', edgeConfidence: 'high', file: '.project-brain/fleet/edges/x.md' },
  // a summary record must be ignored
  { file: '.project-brain/modules/auth.md', module: 'lib/auth', isSummary: true, type: 'module-summary' }
];

test('overviewGraph collapses to module/feature/project with file counts', () => {
  const g = overviewGraph(RECORDS);
  const ids = g.nodes.map(n => n.id);
  assert.ok(ids.includes('module:lib/auth'));
  assert.ok(ids.includes('feature:auth'));
  assert.ok(ids.includes('project:web'));
  // no file/symbol nodes in the collapsed overview
  assert.ok(!ids.some(id => id.startsWith('file:') || id.startsWith('symbol:')));
  // module label carries its (unique) file count: login.ts + token.ts = 2
  assert.equal(g.nodes.find(n => n.id === 'module:lib/auth').label, 'lib/auth (2)');
  // implements + contains + cross-project edges present
  assert.ok(g.edges.some(e => e.from === 'module:lib/auth' && e.to === 'feature:auth' && e.type === 'implements'));
  assert.ok(g.edges.some(e => e.from === 'project:web' && e.to === 'module:lib/auth' && e.type === 'contains'));
  assert.ok(g.edges.some(e => e.from === 'project:web' && e.to === 'project:api'));
});

test('fleetGraph keeps only cross-project edges', () => {
  const g = fleetGraph(RECORDS);
  assert.deepEqual(g.nodes.map(n => n.id).sort(), ['project:api', 'project:web']);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].type, 'http-client:high');
});

test('scopedGraph keeps file/symbol fidelity and drops import/reference noise', () => {
  const g = scopedGraph(RECORDS, 'module', 'lib/auth');
  const ids = g.nodes.map(n => n.id);
  assert.ok(ids.includes('file:lib/auth/login.ts'));
  assert.ok(ids.includes('file:lib/auth/token.ts'));
  // import/reference nodes are dropped
  assert.ok(!g.nodes.some(n => n.type === 'import' || n.type === 'reference'));
  // the resolved cross-file call survives (login → token via verifyToken)
  assert.ok(g.edges.some(e => e.from === 'file:lib/auth/login.ts' && e.to === 'file:lib/auth/token.ts' && e.type.startsWith('calls:')));
});

test('scopedGraph returns empty for an unknown module', () => {
  const g = scopedGraph(RECORDS, 'module', 'nope');
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
});

test('toMermaid renders a flowchart with classDef styling and escaping', () => {
  const g = overviewGraph(RECORDS);
  const m = toMermaid(g, 'LR');
  assert.match(m, /^flowchart LR/);
  assert.match(m, /classDef module/);
  assert.match(m, /-->\|implements\|/);
  // labels are sanitized (no raw pipes that would break mermaid edge syntax)
  assert.ok(!/\["[^"]*\|[^"]*"\]/.test(m));
});

test('toDrawioXml emits a well-formed model with one vertex per node', () => {
  const g = fleetGraph(RECORDS);
  const xml = toDrawioXml(g);
  assert.match(xml, /<mxGraphModel><root>/);
  assert.equal((xml.match(/vertex="1"/g) || []).length, g.nodes.length);
  assert.equal((xml.match(/edge="1"/g) || []).length, g.edges.length);
});
