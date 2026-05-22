import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateToRecord, dedupeCandidates } from '../../scripts/edges/materialize.mjs';

test('candidateToRecord builds a chunk:-9 cross-project-edge record', () => {
  const r = candidateToRecord({
    from: 'backend', to: 'workers', kind: 'pubsub',
    evidence: ['backend/queue.ts:42', 'workers/handler.py:18'],
    confidence: 'high', detector: 'pubsub'
  }, []);
  assert.equal(r.chunk, -9);
  assert.equal(r.type, 'cross-project-edge');
  assert.equal(r.edgeFrom, 'backend');
  assert.equal(r.edgeTo, 'workers');
  assert.equal(r.edgeKind, 'pubsub');
  assert.equal(r.edgeConfidence, 'high');
  assert.equal(r.project, 'backend');
  assert.ok(r.embeddingText.includes('backend to workers via pubsub'));
  assert.ok(r.embeddingText.includes('backend/queue.ts:42'));
});

test('candidateToRecord produces deterministic ids on same inputs', () => {
  const a = candidateToRecord({ from: 'a', to: 'b', kind: 'http-call', evidence: ['x:1', 'y:2'], confidence: 'high', detector: 'd' }, []);
  const b = candidateToRecord({ from: 'a', to: 'b', kind: 'http-call', evidence: ['y:2', 'x:1'], confidence: 'high', detector: 'd' }, []);
  assert.equal(a.id, b.id);
});

test('dedupeCandidates keeps highest confidence and merges evidence', () => {
  const out = dedupeCandidates([
    { from: 'a', to: 'b', kind: 'http-call', evidence: ['x:1'], confidence: 'low', detector: 'd' },
    { from: 'a', to: 'b', kind: 'http-call', evidence: ['x:1', 'y:2'], confidence: 'high', detector: 'd' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 'high');
  assert.deepEqual([...out[0].evidence].sort(), ['x:1', 'y:2']);
});

test('dedupeCandidates does NOT collapse different kinds or directions', () => {
  const out = dedupeCandidates([
    { from: 'a', to: 'b', kind: 'http-call', evidence: ['x:1'], confidence: 'high', detector: 'd' },
    { from: 'a', to: 'b', kind: 'pubsub', evidence: ['x:1'], confidence: 'high', detector: 'd' },
    { from: 'b', to: 'a', kind: 'http-call', evidence: ['x:1'], confidence: 'high', detector: 'd' }
  ]);
  assert.equal(out.length, 3);
});
