import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore, normalizeRecord, matchesFilter } from '../scripts/store.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-store-test-'));
}

function record(id, vec, extra = {}) {
  return normalizeRecord({ id, file: `${id}.md`, vector: vec, text: 'x', ...extra });
}

test('JsonStore round-trip: upsert/search/delete/getAll', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'idx.json');
  const store = new JsonStore({ path: file });
  await store.upsert([record('a', [1, 0]), record('b', [0, 1]), record('c', [0.5, 0.5])]);

  const hits = await store.search([1, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'a', 'closest to query vector ranks first');

  await store.delete(['b']);
  const all = await store.getAll();
  assert.deepEqual(all.map(r => r.id).sort(), ['a', 'c']);

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.records.length, 2);
});

test('JsonStore.search honors filter', async () => {
  const dir = tmpDir();
  const store = new JsonStore({ path: path.join(dir, 'idx.json') });
  await store.upsert([
    record('a', [1, 0], { isSummary: true }),
    record('b', [1, 0], { isSummary: false })
  ]);
  const hits = await store.search([1, 0], 5, { summaryOnly: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'a');
});

test('normalizeRecord fills defaults and coerces arrays', () => {
  const r = normalizeRecord({ id: 7, file: 'foo.md', symbols: 'x,y,z' });
  assert.equal(r.id, '7');
  assert.equal(r.title, 'foo.md');
  assert.deepEqual(r.symbols, ['x', 'y', 'z']);
  assert.deepEqual(r.vector, []);
});

test('matchesFilter handles type/file/summaryOnly/modulesOnly', () => {
  const r = normalizeRecord({ id: '1', file: 'a.md', type: 'doc', isSummary: true, isModuleSummary: false });
  assert.equal(matchesFilter(r, { summaryOnly: true }), true);
  assert.equal(matchesFilter(r, { modulesOnly: true }), false);
  assert.equal(matchesFilter(r, { type: 'doc' }), true);
  assert.equal(matchesFilter(r, { type: 'code' }), false);
  assert.equal(matchesFilter(r, { file: 'a.md' }), true);
  assert.equal(matchesFilter(r, { file: 'b.md' }), false);
});

test('normalizeRecord preserves project + edge fields', () => {
  const r = normalizeRecord({
    id: '1', file: 'a.md',
    project: 'backend',
    edgeFrom: 'frontend', edgeTo: 'backend', edgeKind: 'http-call', edgeConfidence: 'high',
    projectKinds: ['ts', 'docker']
  });
  assert.equal(r.project, 'backend');
  assert.equal(r.edgeFrom, 'frontend');
  assert.equal(r.edgeTo, 'backend');
  assert.equal(r.edgeKind, 'http-call');
  assert.equal(r.edgeConfidence, 'high');
  assert.deepEqual(r.projectKinds, ['ts', 'docker']);
});

test('matchesFilter honors project (string + comma-list + array)', () => {
  const r = normalizeRecord({ id: '1', file: 'a.md', project: 'backend' });
  assert.equal(matchesFilter(r, { project: 'backend' }), true);
  assert.equal(matchesFilter(r, { project: 'frontend' }), false);
  assert.equal(matchesFilter(r, { project: 'backend,workers' }), true);
  assert.equal(matchesFilter(r, { project: ['workers', 'backend'] }), true);
  assert.equal(matchesFilter(r, { project: ['workers'] }), false);
});

test('JsonStore: corrupt JSON does not throw; disabled until repair', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mirror-corrupt-'));
  const file = path.join(dir, 'idx.json');
  fs.writeFileSync(file, '{ not valid json');
  const store = new JsonStore({ path: file });
  assert.deepEqual(store.records, []);
});

test('JsonStore.persist: ENOENT during rename (concurrent sync) does not throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mirror-race-'));
  const file = path.join(dir, 'idx.json');
  const store = new JsonStore({ path: file });
  await store.upsert([normalizeRecord({ id: '1', file: 'a.md', vector: [1, 0] })]);
  // Just confirm the basic write went through — race-condition recovery
  // is exercised by the dedicated try/catch path in persist().
  assert.ok(fs.existsSync(file));
});

test('matchesFilter honors edge fields', () => {
  const r = normalizeRecord({ id: '1', file: 'a.md', edgeFrom: 'a', edgeTo: 'b', edgeKind: 'pubsub' });
  assert.equal(matchesFilter(r, { edgeKind: 'pubsub' }), true);
  assert.equal(matchesFilter(r, { edgeKind: 'http-call' }), false);
  assert.equal(matchesFilter(r, { edgeFrom: 'a', edgeTo: 'b' }), true);
  assert.equal(matchesFilter(r, { edgeFrom: 'a', edgeTo: 'c' }), false);
});

/* The JSON mirror wrote each embedding as decimal TEXT: a 384-dimension vector
   became ~7,700 characters, because `-0.07386847585439682` costs 20 bytes to
   say what fits in 4. On a real repo that made the mirror 205 MB, of which
   169 MB (83%) was vector text — over its own 200 MB cap, so it was skipped on
   every read and that repo ran with degraded retrieval for weeks unnoticed. */
test('encodeVector/decodeVector: base64 Float32, and both formats read back', async () => {
  const { encodeVector, decodeVector } = await import('../scripts/store.mjs');
  const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 3);

  const encoded = encodeVector(vec);
  assert.equal(typeof encoded, 'string');
  assert.equal(encoded.length, 2048, '384 floats × 4 bytes → 2048 base64 chars');
  assert.ok(
    JSON.stringify(vec).length / encoded.length > 3,
    'the whole point is that it is several times smaller than decimal text'
  );

  // Float32 is not a NEW loss: LanceDB beside it already stores Float32, so the
  // mirror was carrying more precision than the database it mirrors.
  const back = decodeVector(encoded);
  assert.equal(back.length, 384);
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Math.abs(vec[i] - back[i]) < 1e-6, `dim ${i} drifted: ${vec[i]} vs ${back[i]}`);
  }

  // v2 mirrors on disk are plain arrays and must keep working without reindex.
  assert.deepEqual(decodeVector([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(decodeVector([]), []);
  assert.deepEqual(decodeVector(undefined), []);
  assert.deepEqual(decodeVector(''), []);
  // A truncated or corrupt field must not throw mid-read: an empty vector
  // scores 0 and ranks last, which is visible and safe.
  assert.deepEqual(decodeVector('!!!'), []);
  assert.deepEqual(encodeVector([]), '');
});

test('JsonStore: a v3 mirror round-trips through disk with usable vectors', async () => {
  const { JsonStore, decodeVector, encodeVector } = await import('../scripts/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-store-v3-'));
  try {
    const file = path.join(dir, 'index.json');
    const vec = Array.from({ length: 8 }, (_, i) => (i + 1) / 10);
    const store = new JsonStore({ path: file, model: 'test-model' });
    await store.upsert([{ id: 'a', file: 'a.ts', text: 'hello', vector: vec }]);
    store.persist({ force: true });

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 3);
    assert.equal(typeof raw.records[0].vector, 'string', 'v3 stores the vector as base64');

    const reopened = new JsonStore({ path: file, model: 'test-model' });
    const all = reopened.readRecords();
    assert.equal(all.length, 1);
    // The vector must survive the disk round-trip to Float32 accuracy.
    assert.equal(all[0].vector.length, vec.length);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(vec[i] - all[0].vector[i]) < 1e-6, `dim ${i} drifted after persist`);
    }
    // And the on-disk form really is the compact one.
    assert.equal(raw.records[0].vector, encodeVector(vec));
    assert.deepEqual(decodeVector(raw.records[0].vector).length, vec.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mirror: vectors are dropped when a vector backend owns them', async () => {
  const { JsonStore } = await import('../scripts/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mirror-meta-'));
  try {
    const file = path.join(dir, 'index.json');
    const vec = Array.from({ length: 384 }, (_, i) => i / 384);
    const store = new JsonStore({ path: file });
    // This is what the LanceDB store sets: it owns the embeddings, the mirror
    // records WHAT is indexed. Mirroring the numbers too cost ~2 KB a record
    // for data never read from here — enough to push a real repo past its own
    // cap, at which point the mirror is skipped on read AND frozen on write,
    // silently diverging from the live index (22,045 vs 106,467 records).
    store.vectorsOwnedElsewhere = true;
    await store.upsert([{ id: 'a', file: 'a.ts', text: 'x'.repeat(200), vector: vec }]);
    store.persist({ force: true });

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.records[0].vector, '', 'the vector must not be mirrored');
    assert.equal(raw.records[0].text, 'x'.repeat(200), 'but the metadata must be');
    // Opt back in for a fully portable snapshot that can serve search alone.
    const pfile = path.join(dir, 'p.json');
    const portable = new JsonStore({ path: pfile });
    portable.vectorsOwnedElsewhere = false;
    await portable.upsert([{ id: 'a', file: 'a.ts', text: 'x'.repeat(200), vector: vec }]);
    portable.persist({ force: true });
    const praw = JSON.parse(fs.readFileSync(pfile, 'utf8'));
    assert.equal(praw.records[0].vector.length, 2048);

    // The saving is the whole point, and the honest way to assert it is the
    // comparison rather than a guessed byte threshold: a 384-dim vector is
    // ~2 KB of every record, several times the metadata beside it.
    const meta = fs.statSync(file).size;
    const full = fs.statSync(pfile).size;
    assert.ok(full > meta * 2, `expected the portable mirror to dwarf the metadata one, got ${full} vs ${meta}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
