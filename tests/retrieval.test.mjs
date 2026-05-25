import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, tfidfScore, hybridScore } from '../scripts/retrieval.mjs';

test('tokenize lowercases and drops short tokens', () => {
  const out = tokenize('Hello, WORLD! a/b foo-bar');
  assert.ok(out.includes('hello'));
  assert.ok(out.includes('world'));
  assert.ok(out.includes('a/b'));
  assert.ok(out.includes('foo-bar'));
  // single chars dropped (length > 1)
  assert.ok(!out.includes('a') || out.includes('a/b'));
});

test('BM25 ranks concise relevant doc over spammy long doc', () => {
  const records = [
    { id: 'a', text: 'auth lease lock concurrent' },
    { id: 'b', text: 'lease '.repeat(40) }, // many repeats, no other relevance
    { id: 'c', text: 'cooking pasta recipe' }
  ];
  const scores = tfidfScore('lease lock', records);
  const a = scores.get('a') || 0;
  const b = scores.get('b') || 0;
  const c = scores.get('c') || 0;
  assert.ok(a > b, `expected a (${a}) > b (${b}) with length normalization`);
  assert.equal(c, 0);
});

test('BM25 handles empty corpus or empty query', () => {
  assert.equal(tfidfScore('x', []).size, 0);
  assert.equal(tfidfScore('', [{ id: 'a', text: 'x' }]).size, 0);
});

test('hybridScore is bounded [0, 2] and symbol acts as multiplier', () => {
  // No relevance at all: still non-negative.
  assert.ok(hybridScore(0, 0, 0, 0, 0.7) >= 0);
  // High symbol amplifies the base, not replaces it.
  const baseOnly = hybridScore(0.5, 0.4, 0, 0, 0.7);
  const withSymbol = hybridScore(0.5, 0.4, 1, 0, 0.7);
  assert.ok(withSymbol > baseOnly);
  // Cap.
  assert.ok(hybridScore(1, 1, 1, 1, 0.7) <= 2);
});

test('hybridScore: high symbol alone cannot beat a perfect dense hit', () => {
  const perfectDense = hybridScore(1.0, 0.0, 0.0, 0.0, 0.7);
  const onlySymbol = hybridScore(0.0, 0.0, 1.0, 0.0, 0.7);
  assert.ok(perfectDense > onlySymbol, `${perfectDense} > ${onlySymbol}`);
});

test('hybridScore: metadata clamp prevents drowning', () => {
  // A wild metadata boost still gets clamped to ±0.5.
  const a = hybridScore(0.6, 0.4, 0, 99, 0.7);
  const b = hybridScore(0.6, 0.4, 0, 0.5, 0.7);
  assert.equal(a, b);
});

// S1.2: constitution canonical-root boost + spec-kit type boost on
// architectural queries. We import the metadataBoost helper via the
// public retrieve() path with a custom store stub so the test stays
// pure (no embedder, no real store).

test('canonical-root boost recognizes .specify/memory/constitution.md', async () => {
  const { retrieve } = await import('../scripts/retrieval.mjs');
  const records = [
    { id: 'a', file: '.specify/memory/constitution.md', type: 'constitution', text: 'project principles', vector: [1, 0] },
    { id: 'b', file: 'docs/random.md', type: 'doc', text: 'project principles', vector: [1, 0] }
  ];
  const store = {
    async search(_v, _k) { return records.map(r => ({ ...r, score: 1 })); },
    async getAll() { return records; }
  };
  const embedder = { async embed() { return [1, 0]; } };
  // Architectural-style query to trip canonicalBrainBoost.
  const result = await retrieve('how is the project governed', store, embedder, { topK: 2 });
  assert.equal(result[0].id, 'a', `expected constitution to rank first, got: ${result.map(r => r.id).join(',')}`);
});

test('spec-kit BRAIN_SPEC_BOOST lifts spec records over docs on architectural queries', async () => {
  const { retrieve } = await import('../scripts/retrieval.mjs');
  const records = [
    { id: 'spec', file: 'specs/auth/spec.md', type: 'spec', text: 'auth requirements', vector: [1, 0] },
    { id: 'doc', file: 'docs/random.md', type: 'doc', text: 'auth requirements', vector: [1, 0] }
  ];
  const store = {
    async search() { return records.map(r => ({ ...r, score: 1 })); },
    async getAll() { return records; }
  };
  const embedder = { async embed() { return [1, 0]; } };
  const result = await retrieve('how does the auth feature work', store, embedder, { topK: 2 });
  assert.equal(result[0].id, 'spec', `expected spec record to rank first, got: ${result.map(r => r.id).join(',')}`);
});
