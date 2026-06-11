import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, tfidfScore, hybridScore, symbolScore } from '../scripts/retrieval.mjs';

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

test('retrieve populates opts.trace without changing results', async () => {
  const { retrieve } = await import('../scripts/retrieval.mjs');
  const records = [
    { id: 'a', file: 'scripts/a.mjs', chunk: 0, text: 'lease lock coordination', vector: [1, 0] },
    { id: 'b', file: 'docs/b.md', chunk: 0, text: 'cooking pasta recipe', vector: [0.9, 0.1] },
    { id: 'c', file: 'docs/c.md', chunk: 0, text: 'lease lock', vector: [0.8, 0.2] }
  ];
  const store = {
    async search(_v, _k) { return records.map((r, i) => ({ ...r, score: 1 - i / 10 })); },
    async getAll() { return records; }
  };
  const embedder = { async embed() { return [1, 0]; } };

  const plain = await retrieve('lease lock', store, embedder, { topK: 3 });
  const trace = {};
  const traced = await retrieve('lease lock', store, embedder, { topK: 3, trace });

  assert.deepEqual(traced.map(r => r.id), plain.map(r => r.id), 'trace must not change ranking');
  assert.equal(trace.queryVector.length, 2);
  assert.equal(trace.broad, false);
  assert.equal(trace.poolSize, 3);
  assert.deepEqual(trace.denseCandidates.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(trace.scored.length, 3, 'scored holds the full pre-truncation list');
  for (const entry of trace.scored) {
    for (const key of ['score', 'denseScore', 'keywordScore', 'symbolScore', 'metadataScore']) {
      assert.equal(typeof entry[key], 'number', `scored entry missing ${key}`);
    }
  }
});

test('lexical union pulls a dense-absent but lexically-relevant record into results (flag-gated)', async () => {
  const { retrieve } = await import('../scripts/retrieval.mjs');
  const target = { id: 'target', file: 'scripts/target.mjs', chunk: 0, text: 'lease lock coordination exclusive', vector: [0.7, 0.7] };
  const noise = Array.from({ length: 3 }, (_, i) => ({
    id: `n${i}`, file: `docs/n${i}.md`, chunk: 0, text: 'unrelated filler content', vector: [1, 0]
  }));
  const store = {
    // Dense search "misses" the target: only noise comes back.
    async search() { return noise.map((r, i) => ({ ...r, score: 0.9 - i / 10 })); },
    async getAll() { return [...noise, target]; }
  };
  const embedder = { async embed() { return [1, 0]; } };

  const without = await retrieve('lease lock', store, embedder, { topK: 4 });
  assert.ok(!without.some(r => r.id === 'target'), 'target must be absent without the flag');

  const withUnion = await retrieve('lease lock', store, embedder, { topK: 4, lexicalUnion: true });
  const hit = withUnion.find(r => r.id === 'target');
  assert.ok(hit, 'lexical union must surface the target');
  assert.ok(hit.denseScore > 0, 'union record must get a real cosine dense score, not 0');
  assert.equal(withUnion[0].id, 'target', 'on-topic union record should outrank filler');
});

test('symbol substring guard: plain-English tokens stop fuzzy-matching symbols (flag-gated)', () => {
  const records = [
    { id: 'wt', symbols: ['spawnWorktree'], text: '' },
    { id: 'exact', symbols: ['tree'], text: '' }
  ];
  // Without guard: "tree" substring-matches spawnWorktree → 0.45 noise tier.
  const noisy = symbolScore('catching paths in the tree', records, {});
  assert.equal(noisy.get('wt'), 0.45);

  // With guard: plain word "tree" no longer fuzzy-matches…
  const guarded = symbolScore('catching paths in the tree', records, { symbolSubstringGuard: true });
  assert.equal(guarded.get('wt'), undefined);
  // …but the whole-token tier (0.85) still fires on an exact symbol token,
  const stillExact = symbolScore('catching paths in the tree', records, { symbolSubstringGuard: true });
  assert.equal(stillExact.get('exact'), 0.85);
  // identifier-shaped words (camelCase hump) keep the substring tier,
  const identifier = symbolScore('where is spawnWork handled', records, { symbolSubstringGuard: true });
  assert.equal(identifier.get('wt'), 0.45);
  // and explicit --symbol mode bypasses the guard entirely.
  const explicit = symbolScore('catching paths in the tree', records, { symbolSubstringGuard: true, symbol: 'somethingElse' });
  assert.equal(explicit.get('wt'), 0.45);
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
