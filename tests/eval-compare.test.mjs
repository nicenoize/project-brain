import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairCases, pairedBootstrap, mulberry32 } from '../scripts/eval-lib.mjs';

function makeReport(cases) {
  return { results: cases.map(([query, hit, rr, hard]) => ({ query, hit, reciprocalRank: rr, hard: Boolean(hard) })) };
}

test('pairCases pairs by query and respects --hard-only', () => {
  const a = makeReport([['q1', true, 1, true], ['q2', false, 0, false], ['q3', true, 0.5, true]]);
  const b = makeReport([['q3', true, 1, true], ['q1', false, 0, true], ['q2', true, 1, false]]);
  const all = pairCases(a, b);
  assert.equal(all.cases, 3);
  const hard = pairCases(a, b, { hardOnly: true });
  assert.equal(hard.cases, 2);
  // Order follows report A; q1 pairs with q1 regardless of position in B.
  assert.deepEqual(hard.pairsA[0], { hit: 1, reciprocalRank: 1 });
  assert.deepEqual(hard.pairsB[0], { hit: 0, reciprocalRank: 0 });
});

test('pairCases throws on mismatched case sets', () => {
  const a = makeReport([['q1', true, 1, false], ['q2', false, 0, false]]);
  const b = makeReport([['q1', true, 1, false], ['qX', false, 0, false]]);
  assert.throws(() => pairCases(a, b), /Case sets differ/);
});

test('pairedBootstrap: identical runs → delta 0, CI [0,0], not significant', () => {
  const pairs = Array.from({ length: 50 }, (_, i) => ({ hit: i % 2, reciprocalRank: (i % 5) / 5 }));
  const stats = pairedBootstrap(pairs, pairs, { resamples: 500, seed: 1 });
  assert.equal(stats.hit.delta, 0);
  assert.deepEqual(stats.hit.ci95, [0, 0]);
  assert.equal(stats.hit.significant, false);
  assert.deepEqual(stats.mrr.ci95, [0, 0]);
});

test('pairedBootstrap: variant winning every case → CI excludes 0', () => {
  const pairsA = Array.from({ length: 60 }, () => ({ hit: 0, reciprocalRank: 0 }));
  const pairsB = Array.from({ length: 60 }, () => ({ hit: 1, reciprocalRank: 1 }));
  const stats = pairedBootstrap(pairsA, pairsB, { resamples: 500, seed: 1 });
  assert.equal(stats.hit.delta, 1);
  assert.ok(stats.hit.ci95[0] > 0);
  assert.equal(stats.hit.significant, true);
  assert.equal(stats.mrr.significant, true);
});

test('pairedBootstrap is deterministic for a given seed', () => {
  const pairsA = Array.from({ length: 40 }, (_, i) => ({ hit: i % 3 === 0 ? 1 : 0, reciprocalRank: (i % 4) / 4 }));
  const pairsB = Array.from({ length: 40 }, (_, i) => ({ hit: i % 2, reciprocalRank: (i % 5) / 5 }));
  const run1 = pairedBootstrap(pairsA, pairsB, { resamples: 1000, seed: 7 });
  const run2 = pairedBootstrap(pairsA, pairsB, { resamples: 1000, seed: 7 });
  assert.deepEqual(run1, run2);
  const run3 = pairedBootstrap(pairsA, pairsB, { resamples: 1000, seed: 8 });
  assert.notDeepEqual(run1.hit.ci95, run3.hit.ci95);
});

test('pairedBootstrap rejects mismatched or empty runs', () => {
  assert.throws(() => pairedBootstrap([], []), /equal-length non-empty/);
  assert.throws(() => pairedBootstrap([{ hit: 1, reciprocalRank: 1 }], []), /equal-length non-empty/);
});

test('mulberry32 yields stable values in [0,1)', () => {
  const rand = mulberry32(123);
  const values = [rand(), rand(), rand()];
  for (const v of values) assert.ok(v >= 0 && v < 1);
  const rand2 = mulberry32(123);
  assert.deepEqual([rand2(), rand2(), rand2()], values);
});
