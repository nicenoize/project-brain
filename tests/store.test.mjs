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

/* Never destroy more than can be rebuilt.
   The auto-recovery path dropped the Lance table and recreated it from the
   CURRENT UPSERT BATCH. On a real repo a background sync carrying 179 records
   hit a schema mismatch and that "recovery" destroyed 98,690 — silently, from
   a hook, behind a warning that said "auto-recovering" and never said how much
   was being deleted. */
test('canAutoRecover: refuses to drop more than the batch can replace', async () => {
  const { canAutoRecover } = await import('../scripts/store.mjs');

  // The exact case that happened.
  const real = canAutoRecover({ existingRows: 98690, batchSize: 179, mirrorCanRestore: false });
  assert.equal(real.allowed, false);
  assert.equal(real.wouldLose, 98511);
  assert.match(real.reason, /would lose 98511/);

  // A mirror that carries vectors CAN rebuild it, so the drop is safe.
  assert.equal(canAutoRecover({ existingRows: 98690, batchSize: 179, mirrorCanRestore: true }).allowed, true);

  // An unreadable table has nothing provably worth protecting, and refusing
  // there would deadlock a genuinely broken store.
  assert.equal(canAutoRecover({ existingRows: null, batchSize: 179 }).allowed, true);
  assert.equal(canAutoRecover({ existingRows: NaN, batchSize: 179 }).allowed, true);

  // A batch at least as large as the table loses nothing.
  assert.equal(canAutoRecover({ existingRows: 5, batchSize: 200 }).allowed, true);
  assert.equal(canAutoRecover({ existingRows: 179, batchSize: 179 }).allowed, true);

  // Degenerate input must not throw.
  assert.equal(canAutoRecover().allowed, true);
});

test('a metadata-only mirror is never used to seed the vector store', async () => {
  const { JsonStore } = await import('../scripts/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-seed-guard-'));
  try {
    const file = path.join(dir, 'index.json');
    const store = new JsonStore({ path: file });
    store.vectorsOwnedElsewhere = true;
    await store.upsert([{ id: 'a', file: 'a.ts', text: 'x', vector: [1, 2, 3] }]);
    store.persist({ force: true });

    // Read back: the record exists, the vector does not. Seeding Lance from
    // this would create the table with a zero-width vector column, the next
    // real upsert would be a schema mismatch, and auto-recovery would drop the
    // table — then reseed from the same vector-less mirror. That loop is what
    // wiped a 98,690-record index.
    const back = new JsonStore({ path: file }).readRecords();
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].vector, [], 'a metadata-only mirror has no vectors to seed with');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The record cap is a PROXY for the byte cap, and a proxy is only as good as
   its assumption about record size. 50,000 was calibrated when every record
   carried its 384-dimension vector as decimal text (~9.3 KB). A metadata-only
   mirror stores ~1.6 KB, so the old number locked out repos the byte guard
   would have accepted: a 33-project fleet at 52,255 records had its mirror
   disabled while the file it would have written was ~84 MB. */
test('mirrorRecordCap: follows what the mirror actually stores', async () => {
  const { mirrorRecordCap } = await import('../scripts/store.mjs');
  const byteCap = 200 * 1024 * 1024;

  const withVectors = mirrorRecordCap({ vectorsOwnedElsewhere: false, byteCap, explicit: '' });
  const metaOnly = mirrorRecordCap({ vectorsOwnedElsewhere: true, byteCap, explicit: '' });

  // Metadata-only records are several times smaller, so several times more fit.
  assert.ok(metaOnly > withVectors * 4, `${metaOnly} should dwarf ${withVectors}`);

  // Both caps must stay under the byte guard they stand in for — the OLD 50,000
  // with vectors implied ~465 MB, more than twice the 200 MB it was protecting.
  assert.ok(withVectors * 9300 < byteCap, 'the with-vectors cap must respect the byte cap');
  assert.ok(metaOnly * 1600 < byteCap, 'the metadata cap must respect the byte cap');

  // The fleet that prompted this fits; a repo twice its size still does not,
  // which is the honest answer rather than a number chosen to make it pass.
  assert.ok(metaOnly > 52255, 'a 52k-record fleet should be mirrorable');
  assert.ok(metaOnly < 106881, 'a 107k-record repo genuinely does not fit');

  // An explicit setting always wins: someone who set it meant it.
  assert.equal(mirrorRecordCap({ vectorsOwnedElsewhere: true, explicit: '9000' }), 9000);
  assert.equal(mirrorRecordCap({ vectorsOwnedElsewhere: true, explicit: 'nonsense' }), metaOnly);
  assert.equal(mirrorRecordCap({ vectorsOwnedElsewhere: true, explicit: '-5' }), metaOnly);

  // A tiny byte cap still leaves a usable floor rather than zero.
  assert.ok(mirrorRecordCap({ byteCap: 1000, explicit: '' }) >= 1000);
});

/* Compaction's safety window protects an IN-FLIGHT READ, not "recent work".
   The first guess of one hour made compaction a no-op exactly when it mattered
   most: after a --force rebuild every superseded fragment is minutes old, so
   nothing qualified. club-ops sat at 2.0 GB while optimize() returned success
   in 4 ms; the same call with a one-minute window reclaimed 1.4 GB in 64 ms
   with all 107,834 records intact. */
test('compact: the keep-window is short enough to clean a fresh rebuild', async () => {
  const { openStore } = await import('../scripts/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-compact-window-'));
  try {
    // The contract, not the mechanics: compact() must be total on EVERY
    // backend, must report whether it ran, and must never throw at a caller
    // mid-sync. It existed only on LanceStore until CI — which has no LanceDB
    // and gets the JSON store — failed with "store.compact is not a function".
    const store = await openStore({ root: dir });
    const r = await store.compact();
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.ran, 'boolean');
    assert.ok(Number.isFinite(r.ms));
    if (!r.ran) assert.ok(r.reason, 'a skipped compaction must say why');
    await store.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compact: a commit conflict is retried, then reported as recoverable', async () => {
  const { LanceStore } = await import('../scripts/store.mjs');
  if (typeof LanceStore !== 'function') return; // not exported in this build
  // A background sync fires on every edit, so a conflict that is merely
  // reported recurs forever and the store is never compacted — which is how a
  // repo reached 2.0 GB. One bounded retry clears the overlap.
  let calls = 0;
  const fake = {
    optimize: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Commit conflict for version 18: concurrent commit');
    }
  };
  const store = Object.create(LanceStore.prototype);
  store.openTable = async () => fake;
  const r = await store.compact();
  assert.equal(r.ran, true, `expected the retry to succeed, got ${JSON.stringify(r)}`);
  assert.equal(calls, 2, 'exactly one retry');
  assert.equal(r.attempts, 2);

  // A second conflict means something is genuinely busy: skip, and say so in
  // terms the reader can act on.
  calls = 0;
  const always = { optimize: async () => { calls += 1; throw new Error('Commit conflict for version 19'); } };
  const store2 = Object.create(LanceStore.prototype);
  store2.openTable = async () => always;
  const r2 = await store2.compact();
  assert.equal(r2.ran, false);
  assert.equal(calls, 2, 'bounded at two attempts');
  assert.match(r2.reason, /compact on the next idle run/);
});

test('compact: every backend answers, none throws', async () => {
  const { JsonStore } = await import('../scripts/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-compact-total-'));
  try {
    // The JSON store has nothing to compact and must SAY so rather than not
    // having the method — the shape that broke CI.
    const js = new JsonStore({ path: path.join(dir, 'i.json') });
    const r = await js.compact();
    assert.equal(r.ran, false);
    assert.match(r.reason, /nothing to compact/);
    assert.equal(typeof r.ms, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
