import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandByGraph, retrieve } from '../scripts/retrieval.mjs';

// --- Pure helper: expandByGraph ----------------------------------------

test('expandByGraph: seed referencing Foo pulls in the record that declares Foo', () => {
  const seed = { id: 'caller', references: ['Foo'], symbols: [], imports: [] };
  const declarer = { id: 'declarer', symbols: ['Foo'], references: [] };
  const unrelated = { id: 'unrelated', symbols: ['Bar'], references: ['Baz'] };
  const out = expandByGraph([seed], [seed, declarer, unrelated], { max: 12 });
  const ids = out.map(r => r.id);
  assert.ok(ids.includes('declarer'), `expected declarer pulled in, got: ${ids.join(',')}`);
  assert.ok(!ids.includes('unrelated'), `unrelated must not be pulled in, got: ${ids.join(',')}`);
  assert.ok(!ids.includes('caller'), 'seeds are never returned as neighbors');
});

test('expandByGraph: seed declaring a symbol pulls in records that reference it', () => {
  const seed = { id: 'def', symbols: ['Widget'], references: [] };
  const user = { id: 'user', references: ['Widget'], symbols: [] };
  const out = expandByGraph([seed], [seed, user], { max: 12 });
  assert.deepEqual(out.map(r => r.id), ['user']);
});

test('expandByGraph: symbol matching is normalized', () => {
  const seed = { id: 's', references: ['Foo.bar'] };
  const declarer = { id: 'd', symbols: ['foobar'] };
  const out = expandByGraph([seed], [seed, declarer], { max: 12 });
  assert.deepEqual(out.map(r => r.id), ['d']);
});

test('expandByGraph: shared imports link records', () => {
  const seed = { id: 's', imports: ['./db.mjs'] };
  const sibling = { id: 'sib', imports: ['./db.mjs'] };
  const other = { id: 'o', imports: ['./other.mjs'] };
  const out = expandByGraph([seed], [seed, sibling, other], { max: 12 });
  assert.deepEqual(out.map(r => r.id), ['sib']);
});

test('expandByGraph: cross-project edges pull in edge + far-side records', () => {
  const seed = { id: 's', project: 'api', references: [] };
  const edge = { id: 'e', type: 'cross-project-edge', edgeFrom: 'api', edgeTo: 'web' };
  const far = { id: 'f', project: 'web' };
  const elsewhere = { id: 'x', project: 'mobile' };
  const out = expandByGraph([seed], [seed, edge, far, elsewhere], { max: 12 });
  const ids = out.map(r => r.id);
  assert.ok(ids.includes('e'), 'edge record pulled in');
  assert.ok(ids.includes('f'), 'far-side project record pulled in');
  assert.ok(!ids.includes('x'), 'unrelated project not pulled in');
});

test('expandByGraph: respects max cap and dedups', () => {
  const seed = { id: 's', references: ['Foo'] };
  const decls = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, symbols: ['Foo'] }));
  const out = expandByGraph([seed], [seed, ...decls], { max: 5 });
  assert.equal(out.length, 5);
  assert.equal(new Set(out.map(r => r.id)).size, 5);
});

test('expandByGraph: max <= 0 or empty inputs returns []', () => {
  assert.deepEqual(expandByGraph([], [], { max: 12 }), []);
  assert.deepEqual(expandByGraph([{ id: 's', references: ['Foo'] }], [{ id: 'd', symbols: ['Foo'] }], { max: 0 }), []);
});

// --- retrieve() integration with the env flag --------------------------

function makeFixture() {
  // seed dense-ranks (vector [1,0]); declarer does NOT dense-rank ([0,1]) but
  // is structurally adjacent (declares Foo, which seed references).
  const seed = { id: 'seed', file: 'a.mjs', type: 'code', text: 'uses foo', references: ['Foo'], symbols: ['A'], lineStart: 1, lineEnd: 5, vector: [1, 0] };
  const declarer = { id: 'declarer', file: 'b.mjs', type: 'code', text: 'declares', symbols: ['Foo'], references: [], lineStart: 1, lineEnd: 9, vector: [0, 1] };
  const noise = { id: 'noise', file: 'c.mjs', type: 'code', text: 'irrelevant', symbols: ['Zzz'], references: ['Qqq'], lineStart: 1, lineEnd: 3, vector: [0.1, 0.1] };
  const records = [seed, declarer, noise];
  const store = {
    async search(qv, k) {
      // cosine-ish: rank by dot product with query, return topK with score.
      return records
        .map(r => ({ ...r, score: r.vector[0] * qv[0] + r.vector[1] * qv[1] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async getAll() { return records; }
  };
  const embedder = { async embed() { return [1, 0]; } };
  return { records, store, embedder };
}

test('retrieve: with BRAIN_GRAPH_EXPAND=1 a structurally-adjacent record surfaces', async () => {
  const { store, embedder } = makeFixture();
  delete process.env.BRAIN_GRAPH_EXPAND;
  // OFF: only dense candidates are scored. declarer (vector [0,1]) still comes
  // back from search() since the fake store returns all, so to prove the
  // additive bonus matters we compare ranks. First assert OFF baseline.
  // lexicalUnion:false isolates graph expansion — the union is on by default
  // and would pull `declarer` in lexically, hiding what this test measures.
  const off = await retrieve('Foo', store, embedder, { topK: 3, candidates: 2, lexicalUnion: false });
  const offIds = off.map(r => r.id);
  assert.ok(!offIds.includes('declarer'), `OFF: declarer should be outside the candidate window, got: ${offIds.join(',')}`);

  process.env.BRAIN_GRAPH_EXPAND = '1';
  try {
    const on = await retrieve('Foo', store, embedder, { topK: 3, candidates: 2, lexicalUnion: false });
    const onIds = on.map(r => r.id);
    assert.ok(onIds.includes('declarer'), `ON: declarer should surface via graph expansion, got: ${onIds.join(',')}`);
  } finally {
    delete process.env.BRAIN_GRAPH_EXPAND;
  }
});

test('retrieve: neither graph expansion nor the lexical union off means no corpus read', async () => {
  const { records, embedder } = makeFixture();
  let getAllCalls = 0;
  const store = {
    async search(qv, k) {
      return records
        .map(r => ({ ...r, score: r.vector[0] * qv[0] + r.vector[1] * qv[1] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async getAll() { getAllCalls++; return records; }
  };
  delete process.env.BRAIN_GRAPH_EXPAND;
  const result = await retrieve('Foo', store, embedder, { topK: 3, candidates: 2, lexicalUnion: false });
  assert.equal(getAllCalls, 0, 'the dense-only path must never read the whole corpus');
  // Candidate window of 2 excludes declarer entirely.
  assert.ok(!result.map(r => r.id).includes('declarer'));
});
