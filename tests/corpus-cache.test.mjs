import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrainStore } from '../scripts/store.mjs';

/** A store that counts how often the corpus is actually read, and can pretend
    to be a backend that cannot report a version. */
class CountingStore extends BrainStore {
  constructor(records, { version = 'v1', reportVersion = true } = {}) {
    super();
    this.records = records;
    this.version = version;
    this.reportVersion = reportVersion;
    this.reads = 0;
  }
  async getAll() { this.reads++; return this.records; }
  async corpusVersion() { return this.reportVersion ? this.version : null; }
  async search(vector, k) { return this.records.slice(0, k).map(r => ({ ...r, score: 0.5 })); }
}

const RECORDS = [
  { id: 'a', file: 'lib/supabase/server.ts', text: 'the server talks to the database', vector: [1, 0], type: 'code' },
  { id: 'b', file: 'lib/db/bookings.ts', text: 'bookings table access', vector: [0, 1], type: 'code' },
];
const embedder = { embed: async () => [1, 0] };

async function search(store) {
  const { retrieve } = await import('../scripts/retrieval.mjs');
  return retrieve('talk to the database from the server', store, embedder, { topK: 2, lexicalUnion: true });
}

test('a versioned corpus is read once across repeated queries', async () => {
  const store = new CountingStore(RECORDS);
  await search(store);
  await search(store);
  await search(store);
  assert.equal(store.reads, 1, 'the corpus should be read once, not per query');
});

test('a changed version invalidates the cache', async () => {
  const store = new CountingStore(RECORDS);
  await search(store);
  store.version = 'v2';
  await search(store);
  assert.equal(store.reads, 2);
});

test('a backend that cannot report a version is never cached', async () => {
  const store = new CountingStore(RECORDS, { reportVersion: false });
  await search(store);
  await search(store);
  assert.equal(store.reads, 2, 'an unknown corpus must be treated as a changed one');
});

test('caching does not change what is returned', async () => {
  const cached = new CountingStore(RECORDS);
  const uncached = new CountingStore(RECORDS, { reportVersion: false });
  await search(cached);
  const a = await search(cached);
  const b = await search(uncached);
  assert.deepEqual(a.map(r => [r.id, r.score]), b.map(r => [r.id, r.score]));
});

test('corpusVersion is total: the base class answers instead of not existing', async () => {
  assert.equal(await new BrainStore().corpusVersion(), null);
});
