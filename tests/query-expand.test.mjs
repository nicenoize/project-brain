import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  queryExpandEnabled,
  splitIdentifier,
  stemVariants,
  inflectionVariants,
  lexicalVariants,
  compoundSplits,
  buildVocabulary,
  expandQuery,
  manifestHash,
  getVocabulary,
  readVocabCache
} from '../scripts/query-expand.mjs';
import { retrieve } from '../scripts/retrieval.mjs';

function withFlag(value, fn) {
  const prev = process.env.BRAIN_QUERY_EXPAND;
  if (value === undefined) delete process.env.BRAIN_QUERY_EXPAND;
  else process.env.BRAIN_QUERY_EXPAND = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.BRAIN_QUERY_EXPAND;
    else process.env.BRAIN_QUERY_EXPAND = prev;
  }
}

// ---------------------------------------------------------------------------
// Flag gate
// ---------------------------------------------------------------------------

test('queryExpandEnabled: default-off, on only when BRAIN_QUERY_EXPAND=1', () => {
  withFlag(undefined, () => assert.equal(queryExpandEnabled(), false));
  withFlag('0', () => assert.equal(queryExpandEnabled(), false));
  withFlag('true', () => assert.equal(queryExpandEnabled(), false));
  withFlag('1', () => assert.equal(queryExpandEnabled(), true));
});

// ---------------------------------------------------------------------------
// Pure lexical derivations
// ---------------------------------------------------------------------------

test('splitIdentifier splits camelCase / snake / kebab / digit boundaries', () => {
  assert.deepEqual(splitIdentifier('getUserData'), ['get', 'user', 'data']);
  assert.deepEqual(splitIdentifier('auth_timeout'), ['auth', 'timeout']);
  assert.deepEqual(splitIdentifier('cross-encoder'), ['cross', 'encoder']);
  assert.deepEqual(splitIdentifier('HTTPServer'), ['http', 'server']);
  // Digit boundaries split too; single-char fragments (v, 2) are dropped.
  assert.deepEqual(splitIdentifier('v2model'), ['model']);
  // A plain lowercase word does not split (length-1 result → caller treats as no-split).
  assert.deepEqual(splitIdentifier('timeout'), ['timeout']);
});

test('stemVariants strips common inflectional suffixes', () => {
  assert.ok(stemVariants('worktrees').includes('worktree'));
  assert.ok(stemVariants('policies').includes('policy'));
  assert.ok(stemVariants('locking').includes('lock'));
  assert.ok(stemVariants('locked').includes('lock'));
  // Never returns the token itself, never over-strips a base ending in ss.
  assert.ok(!stemVariants('class').includes('clas'));
});

test('inflectionVariants adds forward forms (constrained later by vocab)', () => {
  const v = inflectionVariants('lock');
  assert.ok(v.includes('locks'));
  assert.ok(v.includes('locking'));
  assert.ok(v.includes('locked'));
  assert.ok(inflectionVariants('policy').includes('policies'));
  assert.ok(inflectionVariants('expire').includes('expiring'));
});

test('lexicalVariants unions splits + stems + inflections, excluding self', () => {
  const v = lexicalVariants('worktrees');
  assert.ok(v.includes('worktree'));
  assert.ok(!v.includes('worktrees'));
});

test('compoundSplits only splits into two in-vocab halves', () => {
  const vocab = new Map([['work', 3], ['tree', 5], ['worktree', 2]]);
  assert.deepEqual(compoundSplits('worktree', vocab), ['work', 'tree']);
  // No valid in-vocab split → [].
  assert.deepEqual(compoundSplits('worktree', new Map([['worktree', 2]])), []);
  // Too short to split.
  assert.deepEqual(compoundSplits('auth', vocab), []);
});

test('buildVocabulary produces token → document-frequency', () => {
  const records = [
    { id: 'a', text: 'worktree lease lock' },
    { id: 'b', text: 'worktree spawn' },
    { id: 'c', text: 'cooking pasta' }
  ];
  const vocab = buildVocabulary(records);
  assert.equal(vocab.get('worktree'), 2); // in a and b
  assert.equal(vocab.get('lease'), 1);
  assert.equal(vocab.get('pasta'), 1);
  assert.equal(vocab.get('nonexistent'), undefined);
});

// ---------------------------------------------------------------------------
// expandQuery: constrained, never invents
// ---------------------------------------------------------------------------

test('expandQuery adds only in-vocab variants and never invents tokens', () => {
  const vocab = new Map([['worktree', 4], ['work', 9], ['tree', 6]]);
  const out = expandQuery('worktrees', vocab);
  // "worktree" is a real corpus token derived by stemming → added.
  assert.ok(out.added.includes('worktree'));
  // Every added token exists in the vocabulary.
  for (const d of out.detail) assert.ok(vocab.has(d.token), `${d.token} must be in vocab`);
  // No token absent from vocab ever appears.
  assert.ok(out.added.every(t => vocab.has(t)));
});

test('expandQuery splits camelCase / snake_case into in-vocab parts', () => {
  const vocab = new Map([['get', 5], ['user', 8], ['data', 7], ['auth', 4], ['timeout', 3]]);
  const camel = expandQuery('getUserData', vocab);
  assert.deepEqual(camel.added.sort(), ['data', 'get', 'user']);
  const snake = expandQuery('auth_timeout', vocab);
  assert.deepEqual(snake.added.sort(), ['auth', 'timeout']);
});

test('expandQuery never re-adds a token already present in the query', () => {
  const vocab = new Map([['lock', 5], ['locks', 2]]);
  const out = expandQuery('lock locks', vocab);
  assert.ok(!out.added.includes('lock'));
  assert.ok(!out.added.includes('locks'));
});

test('expandQuery drops variants absent from the corpus (nothing invented)', () => {
  // Empty vocabulary → no expansion is ever possible.
  const out = expandQuery('getUserData worktrees authentication', new Map());
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.detail, []);
});

test('expandQuery respects the max cap', () => {
  const vocab = new Map([['get', 1], ['user', 1], ['data', 1], ['auth', 1], ['timeout', 1]]);
  const out = expandQuery('getUserData auth_timeout', vocab, { max: 2 });
  assert.equal(out.added.length, 2);
});

test('expandQuery accepts a plain-object vocabulary too', () => {
  const out = expandQuery('worktrees', { worktree: 3 });
  assert.ok(out.added.includes('worktree'));
});

// ---------------------------------------------------------------------------
// Vocabulary cache: built once, invalidated by manifest hash
// ---------------------------------------------------------------------------

test('getVocabulary caches and invalidates on manifest hash change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-vocab-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const cachePath = path.join(dir, 'vocab.json');
  let getAllCalls = 0;
  const store = {
    async getAll() {
      getAllCalls++;
      return [{ id: 'a', text: 'worktree lease lock' }];
    }
  };

  fs.writeFileSync(manifestPath, JSON.stringify({ files: { 'a.md': { hash: 'h1' } } }));
  const v1 = await getVocabulary(store, { manifestPath, cachePath });
  assert.equal(getAllCalls, 1, 'first call builds from the store');
  assert.equal(v1.get('worktree'), 1);
  assert.ok(readVocabCache(cachePath), 'cache sidecar is written');

  // Same manifest → cache hit, store is NOT scanned again.
  const v2 = await getVocabulary(store, { manifestPath, cachePath });
  assert.equal(getAllCalls, 1, 'unchanged manifest reuses the cache');
  assert.equal(v2.get('lease'), 1);

  // Manifest content changes → hash differs → rebuild.
  fs.writeFileSync(manifestPath, JSON.stringify({ files: { 'a.md': { hash: 'h2' } } }));
  await getVocabulary(store, { manifestPath, cachePath });
  assert.equal(getAllCalls, 2, 'changed manifest invalidates the cache');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('manifestHash is a pure function of the manifest content', () => {
  assert.equal(manifestHash('x'), manifestHash('x'));
  assert.notEqual(manifestHash('x'), manifestHash('y'));
});

// ---------------------------------------------------------------------------
// retrieve() integration: byte-identical when off, surfaces target when on
// ---------------------------------------------------------------------------

function fixtureStore() {
  // The target is lexically relevant to the EXPANDED token ("worktree") but not
  // to the raw query token ("worktrees"), and dense search misses it entirely.
  const target = { id: 'target', file: 'scripts/worktree.mjs', chunk: 0, text: 'worktree spawn lease lock coordination', vector: [0.7, 0.7] };
  const noise = Array.from({ length: 3 }, (_, i) => ({
    id: `n${i}`, file: `docs/n${i}.md`, chunk: 0, text: 'unrelated filler content', vector: [1, 0]
  }));
  return {
    target,
    noise,
    store: {
      async search() { return noise.map((r, i) => ({ ...r, score: 0.9 - i / 10 })); },
      async getAll() { return [...noise, target]; }
    },
    embedder: { async embed() { return [1, 0]; } }
  };
}

test('flag OFF: retrieval is byte-identical (target absent, no expansion side-effects)', async () => {
  const { store, embedder } = fixtureStore();
  const trace = {};
  const off = await withFlag(undefined, () =>
    retrieve('worktrees', store, embedder, { topK: 4, lexicalUnion: true, trace }));
  assert.ok(!off.some(r => r.id === 'target'), 'target must be absent without the flag');
  assert.equal(trace.queryExpansion, undefined, 'no expansion recorded when the flag is off');

  // Explicit queryExpand:false is identical to the unset default.
  const forcedOff = await retrieve('worktrees', store, embedder, { topK: 4, lexicalUnion: true, queryExpand: false });
  assert.deepEqual(forcedOff.map(r => r.id), off.map(r => r.id));
});

test('flag ON: in-vocab expansion surfaces a lexically-relevant target', async () => {
  const { store, embedder } = fixtureStore();
  const vocab = new Map([['worktree', 1], ['spawn', 1], ['lease', 1], ['lock', 1], ['coordination', 1]]);
  const trace = {};
  const on = await retrieve('worktrees', store, embedder, {
    topK: 4,
    lexicalUnion: true,
    queryExpand: true,
    queryExpandVocab: vocab,
    trace
  });
  assert.ok(on.some(r => r.id === 'target'), 'expansion must surface the worktree target');
  assert.ok(trace.queryExpansion, 'expansion is recorded on the trace for audit');
  assert.ok(trace.queryExpansion.added.includes('worktree'), 'the audited expansion names the added token');
});

test('flag ON does not alter the dense query (only the lexical path expands)', async () => {
  // With no lexical union and the target already dense-absent, expansion feeds
  // only BM25 over the pool — dense candidates are unchanged.
  const { store, embedder } = fixtureStore();
  const vocab = new Map([['worktree', 1]]);
  const embedCalls = [];
  const spyEmbedder = { async embed(q) { embedCalls.push(q); return [1, 0]; } };
  await retrieve('worktrees', store, spyEmbedder, { topK: 4, queryExpand: true, queryExpandVocab: vocab });
  assert.deepEqual(embedCalls, ['worktrees'], 'the ORIGINAL query is embedded, not the expanded string');
});
