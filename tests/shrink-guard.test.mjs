import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shrinkGuard } from '../scripts/common.mjs';
import { JsonStore, normalizeRecord } from '../scripts/store.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-shrink-test-'));
}

function record(id, extra = {}) {
  return normalizeRecord({ id, file: `${id}.md`, vector: [1, 0], text: 'x', ...extra });
}

// ---- pure helper ----

test('shrinkGuard: growth and steady-state never block', () => {
  assert.equal(shrinkGuard({ oldCount: 100, newCount: 200 }).blocked, false);
  assert.equal(shrinkGuard({ oldCount: 100, newCount: 100 }).blocked, false);
});

test('shrinkGuard: cold/tiny index below floor never blocks', () => {
  // old below the 50-record floor: even a wipe to 0 is allowed (initial builds).
  assert.equal(shrinkGuard({ oldCount: 10, newCount: 0 }).blocked, false);
  assert.equal(shrinkGuard({ oldCount: 49, newCount: 1 }).blocked, false);
});

test('shrinkGuard: modest shrink (>= ratio kept) allowed', () => {
  // keeps 60% of 100 → above the 50% floor.
  assert.equal(shrinkGuard({ oldCount: 100, newCount: 60 }).blocked, false);
  // exactly at the ratio boundary (50%) is allowed.
  assert.equal(shrinkGuard({ oldCount: 100, newCount: 50 }).blocked, false);
});

test('shrinkGuard: significant shrink blocks and names --force', () => {
  const g = shrinkGuard({ oldCount: 1000, newCount: 10 });
  assert.equal(g.blocked, true);
  assert.match(g.reason, /--force/);
  assert.match(g.reason, /1000 → 10/);
  assert.match(g.reason, /left untouched/);
});

test('shrinkGuard: force bypasses the block', () => {
  assert.equal(shrinkGuard({ oldCount: 1000, newCount: 0, force: true }).blocked, false);
});

test('shrinkGuard: thresholds are tunable', () => {
  // With a stricter ratio, a smaller drop already blocks.
  assert.equal(shrinkGuard({ oldCount: 100, newCount: 80, ratio: 0.9 }).blocked, true);
  // With a higher floor, the same shrink is ignored.
  assert.equal(shrinkGuard({ oldCount: 100, newCount: 1, minFloor: 500 }).blocked, false);
});

// ---- store integration ----

async function seed(file, n) {
  const store = new JsonStore({ path: file });
  await store.upsert(Array.from({ length: n }, (_, i) => record(`r${i}`)));
  return store;
}

test('JsonStore: shrunken write blocked without --force, index preserved', async () => {
  const file = path.join(tmpDir(), 'idx.json');
  await seed(file, 100);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 100);

  // Fresh store re-reads the 100-record snapshot as its baseline.
  const store = new JsonStore({ path: file });
  // Simulate a truncation bug: nearly all records vanish, then persist.
  store.records = [record('r0')];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    store.persist();
  } finally {
    console.warn = origWarn;
  }

  // On-disk snapshot untouched.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 100);
  assert.ok(warnings.some(w => /shrink-guard/.test(w)), 'warns about the block');
  assert.ok(warnings.some(w => /--force/.test(w)), 'names --force');
});

test('JsonStore: shrunken write allowed with force option', async () => {
  const file = path.join(tmpDir(), 'idx.json');
  await seed(file, 100);

  const store = new JsonStore({ path: file, force: true });
  store.records = [record('r0')];
  store.persist();

  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 1);
});

test('JsonStore: shrunken write allowed with BRAIN_FORCE_SHRINK env', async () => {
  const file = path.join(tmpDir(), 'idx.json');
  await seed(file, 100);

  const prev = process.env.BRAIN_FORCE_SHRINK;
  process.env.BRAIN_FORCE_SHRINK = '1';
  try {
    const store = new JsonStore({ path: file });
    store.records = [record('r0')];
    store.persist();
  } finally {
    if (prev === undefined) delete process.env.BRAIN_FORCE_SHRINK;
    else process.env.BRAIN_FORCE_SHRINK = prev;
  }

  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 1);
});

test('JsonStore: incremental delete (modest shrink) still writes', async () => {
  const file = path.join(tmpDir(), 'idx.json');
  const store = await seed(file, 100);
  // Delete 10 records via the normal path — 90/100 kept, above the floor.
  await store.delete(Array.from({ length: 10 }, (_, i) => `r${i}`));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.length, 90);
});
