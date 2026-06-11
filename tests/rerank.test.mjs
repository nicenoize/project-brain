import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRerankOrder, rerankText, rerank } from '../scripts/rerank.mjs';

test('applyRerankOrder reorders only the head, stable on ties', () => {
  const records = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, score: 1 }));
  // CE prefers c > a > b within the top-3 head; d/e are tail and untouched.
  const out = applyRerankOrder(records, [0.2, 0.1, 0.9], 3);
  assert.deepEqual(out.map(r => r.id), ['c', 'a', 'b', 'd', 'e']);
  assert.equal(out[0].rerankScore, 0.9);
  assert.equal(out[3].rerankScore, undefined, 'tail records carry no rerankScore');

  // Equal CE scores keep the original (hybrid) order.
  const tied = applyRerankOrder(records, [0.5, 0.5, 0.5], 3);
  assert.deepEqual(tied.map(r => r.id), ['a', 'b', 'c', 'd', 'e']);
});

test('applyRerankOrder clamps to available records/scores', () => {
  const records = [{ id: 'a' }, { id: 'b' }];
  const out = applyRerankOrder(records, [0.1, 0.9, 0.7], 10);
  assert.deepEqual(out.map(r => r.id), ['b', 'a']);
  assert.deepEqual(applyRerankOrder([], [], 5), []);
});

test('rerankText joins file/heading/text and bounds length', () => {
  const text = rerankText({ file: 'a.md', heading: 'H', text: 'x'.repeat(5000) });
  assert.ok(text.startsWith('a.md\nH\n'));
  assert.ok(text.length <= 2000);
  assert.equal(rerankText({ file: 'a.md' }), 'a.md');
});

test('rerank is a no-op for tiny inputs or empty query', async () => {
  const records = [{ id: 'a', file: 'a.md', text: 'x' }];
  assert.deepEqual(await rerank('q', records), records);
  assert.deepEqual(await rerank('', [{ id: 'a' }, { id: 'b' }]), [{ id: 'a' }, { id: 'b' }]);
});

// Real-model integration test — downloads ~23 MB on first run; opt in with
// BRAIN_RERANK_IT=1.
test('cross-encoder ranks the on-topic chunk first', { skip: process.env.BRAIN_RERANK_IT !== '1' }, async () => {
  const records = [
    { id: 'off', file: 'docs/cooking.md', text: 'how to cook pasta with garlic and olive oil' },
    { id: 'on', file: 'docs/locks.md', text: 'exclusive file lock prevents two agents writing the same state file' }
  ];
  const out = await rerank('how do we stop two agents clobbering the same shared file', records, { top: 2 });
  assert.equal(out[0].id, 'on');
});
