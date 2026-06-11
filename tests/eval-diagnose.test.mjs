import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHardCase,
  diagnoseCase,
  suggestClass,
  denseRankInCorpus,
  classifyDistractors,
  evaluateCase,
  summarize
} from '../scripts/eval-lib.mjs';

test('isHardCase keys off the Hard: note prefix, not missing symbols', () => {
  assert.ok(isHardCase({ note: 'Hard: vocabulary mismatch with target' }));
  assert.ok(isHardCase({ note: '  hard: lowercase and padded' }));
  assert.ok(!isHardCase({ note: 'Easy filename lookup' }));
  assert.ok(!isHardCase({})); // no note at all
  assert.ok(!isHardCase({ expectedFiles: ['a.md'] })); // symbol-less ≠ hard
});

test('suggestClass: hit / candidate-generation / ranking', () => {
  assert.equal(suggestClass({ finalRank: 3, inDensePool: true, broad: false, topK: 8 }), 'hit');
  assert.equal(suggestClass({ finalRank: 0, inDensePool: false, broad: false, topK: 8 }), 'candidate-generation');
  assert.equal(suggestClass({ finalRank: 12, inDensePool: true, broad: false, topK: 8 }), 'ranking');
  // Broad pool scored the full corpus, so a miss can only be a ranking failure.
  assert.equal(suggestClass({ finalRank: 0, inDensePool: false, broad: true, topK: 8 }), 'ranking');
});

test('diagnoseCase separates candidate-generation from ranking misses', () => {
  const item = { query: 'q', expectedFiles: ['docs/target.md'] };

  // Target never entered the dense pool.
  const missTrace = {
    queryVector: [1, 0],
    broad: false,
    poolSize: 2,
    denseCandidates: [
      { id: 'a', file: 'scripts/a.mjs', chunk: 0, score: 0.9 },
      { id: 'b', file: 'tests/b.test.mjs', chunk: 0, score: 0.8 }
    ],
    scored: [
      { id: 'a', file: 'scripts/a.mjs', chunk: 0, score: 1.1 },
      { id: 'b', file: 'tests/b.test.mjs', chunk: 0, score: 0.7 }
    ]
  };
  const miss = diagnoseCase(item, missTrace, { topK: 8 });
  assert.equal(miss.inDensePool, false);
  assert.equal(miss.denseRank, 0);
  assert.equal(miss.finalRank, 0);
  assert.equal(miss.suggestedClass, 'candidate-generation');
  assert.equal(miss.corpusDenseRank, null); // no allRecords provided
  assert.equal(miss.distractors.length, 2);

  // Target in the pool but outranked past top-K.
  const scored = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`, file: `scripts/d${i}.mjs`, chunk: 0, score: 1 - i / 100
  }));
  scored.push({ id: 't', file: 'docs/target.md', chunk: 0, score: 0.1 });
  const rankTrace = {
    queryVector: [1, 0],
    broad: false,
    poolSize: 11,
    denseCandidates: [{ id: 't', file: 'docs/target.md', chunk: 0, score: 0.5 }],
    scored
  };
  const ranked = diagnoseCase(item, rankTrace, { topK: 8 });
  assert.equal(ranked.inDensePool, true);
  assert.equal(ranked.finalRank, 11);
  assert.equal(ranked.suggestedClass, 'ranking');
});

test('diagnoseCase computes exact corpus dense rank when records have vectors', () => {
  const item = { query: 'q', expectedFiles: ['docs/target.md'] };
  const trace = { queryVector: [1, 0], broad: false, poolSize: 0, denseCandidates: [], scored: [] };
  const allRecords = [
    { file: 'scripts/near.mjs', vector: [0.99, 0.1] },
    { file: 'docs/target.md', vector: [0.7, 0.7] },
    { file: 'docs/far.md', vector: [0, 1] }
  ];
  const diagnosis = diagnoseCase(item, trace, { topK: 8, allRecords });
  assert.equal(diagnosis.corpusDenseRank, 2);
});

test('denseRankInCorpus returns 0 when expected file is absent', () => {
  const rank = denseRankInCorpus([1, 0], [{ file: 'other.md', vector: [1, 0] }], ['missing.md']);
  assert.equal(rank, 0);
});

test('classifyDistractors buckets paths by kind', () => {
  const kinds = classifyDistractors([
    { file: 'tests/retrieval.test.mjs' },
    { file: '.project-brain/sessions/main__auto-compact__1.md' },
    { file: '.project-brain/decisions/0003-dense.md' },
    { file: 'scripts/retrieval.mjs' },
    { file: 'README.md' }
  ]);
  assert.deepEqual(kinds, { test: 1, session: 1, brainDoc: 1, code: 1, other: 1 });
});

test('summarize reports hard-subset metrics alongside aggregate', () => {
  const found = [{ file: 'a.md', chunk: 0 }];
  const results = [
    evaluateCase({ query: 'easy', expectedFiles: ['a.md'] }, found, 8),
    evaluateCase({ query: 'hard miss', expectedFiles: ['b.md'], note: 'Hard: mismatch' }, found, 8),
    evaluateCase({ query: 'hard hit', expectedFiles: ['a.md'], note: 'Hard: mismatch too' }, found, 8)
  ];
  const report = summarize(results, 8);
  assert.equal(report.cases, 3);
  assert.equal(report.hardCases, 2);
  assert.equal(report.hardHitAtK, 0.5);
  assert.equal(report.hitAtK, Math.round((2 / 3) * 10000) / 10000);
});
