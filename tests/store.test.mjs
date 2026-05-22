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

test('matchesFilter honors edge fields', () => {
  const r = normalizeRecord({ id: '1', file: 'a.md', edgeFrom: 'a', edgeTo: 'b', edgeKind: 'pubsub' });
  assert.equal(matchesFilter(r, { edgeKind: 'pubsub' }), true);
  assert.equal(matchesFilter(r, { edgeKind: 'http-call' }), false);
  assert.equal(matchesFilter(r, { edgeFrom: 'a', edgeTo: 'b' }), true);
  assert.equal(matchesFilter(r, { edgeFrom: 'a', edgeTo: 'c' }), false);
});
