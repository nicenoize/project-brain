import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tfidfScore, buildBm25Index, bm25Score } from '../scripts/retrieval.mjs';

/** Documents with the shape retrieval actually sees: varying length, repeated
    terms, and a term that appears in every document (idf → small). */
const CORPUS = [
  { id: 'a', text: 'the server talks to the database via a supabase client', file: 'lib/supabase/server.ts' },
  { id: 'b', text: 'database database database', file: 'lib/db/bookings.ts' },
  { id: 'c', text: 'a very long document about the server and the client and the browser and the database and much more prose besides', file: 'docs/plan.md' },
  { id: 'd', text: 'unrelated notification content', file: 'lib/actions/notifications.ts' },
];

test('a prebuilt index scores identically to building it inline', () => {
  const index = buildBm25Index(CORPUS);
  for (const query of ['database', 'talk to the database from the server', 'notification', 'client browser']) {
    assert.deepEqual(
      [...tfidfScore(query, CORPUS, index).entries()],
      [...tfidfScore(query, CORPUS).entries()],
      `scores diverged for: ${query}`
    );
  }
});

test('the index is reusable: scoring twice does not mutate it', () => {
  const index = buildBm25Index(CORPUS);
  const first = [...tfidfScore('database server', CORPUS, index).entries()];
  tfidfScore('something else entirely', CORPUS, index);
  assert.deepEqual([...tfidfScore('database server', CORPUS, index).entries()], first);
});

test('length normalization still penalizes the long document', () => {
  const s = tfidfScore('database', CORPUS);
  assert.ok(s.get('b') > s.get('c'), 'the short, term-dense doc must outrank the long one');
});

test('empty query and empty corpus yield no scores', () => {
  assert.equal(tfidfScore('', CORPUS).size, 0);
  assert.equal(tfidfScore('database', []).size, 0);
  assert.equal(bm25Score(['database'], buildBm25Index([])).size, 0);
});
