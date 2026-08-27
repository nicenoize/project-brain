import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  gitLogArgs,
  parseLog,
  provenanceOf,
  hotspots,
  coChange,
  ownership,
  busFactorOf,
  riskFactors,
  riskScore,
  rankAuc,
  calibrateRisk,
  fileHealth,
  calibrateFileHealth,
  leaseTargetMatches,
  RISK_WEIGHTS,
  RISK_SATURATION,
  FILE_HEALTH_WEIGHTS,
  FILE_HEALTH_SATURATION,
  DEFECT_FIX_REGEX
} from '../scripts/git-intel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INTEL_SCRIPT = path.join(here, '..', 'scripts', 'brain-intel.mjs');

// git --pretty field/record separators mirrored from git-intel.mjs.
const FS = String.fromCharCode(31); // US
const RS = String.fromCharCode(30); // RS

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-08-01T00:00:00Z');

/** Hand-built commit factory (fresh objects each call — determinism test relies on it). */
function commit(hash, author, dateIso, files) {
  return { hash, author, dateIso, files };
}

function daysAgoIso(days) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// parseLog + gitLogArgs
// ---------------------------------------------------------------------------

test('parseLog: parses hash, author, dateIso, subject, files from the delimited stream', () => {
  const raw =
    `${RS}aaa111${FS}Jane Dev${FS}2026-06-21T10:00:00+00:00${FS}feat(intel): add thing--FILES--\n` +
    'scripts/a.mjs\nscripts/b.mjs\n' +
    `${RS}bbb222${FS}Bob Builder${FS}2026-06-20T09:30:00+00:00${FS}--FILES--\n`;
  const commits = parseLog(raw);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    hash: 'aaa111',
    author: 'Jane Dev',
    dateIso: '2026-06-21T10:00:00+00:00',
    subject: 'feat(intel): add thing',
    files: ['scripts/a.mjs', 'scripts/b.mjs']
  });
  // merge-style commit: no files under --name-only, empty subject tolerated
  assert.deepEqual(commits[1].files, []);
  assert.equal(commits[1].subject, '');
});

test('parseLog: empty / whitespace input → []', () => {
  assert.deepEqual(parseLog(''), []);
  assert.deepEqual(parseLog('   \n '), []);
});

test('gitLogArgs: name-only stream, commit cap, rev vs date since', () => {
  const capped = gitLogArgs({ limit: 500 });
  assert.ok(capped.includes('--name-only'));
  assert.ok(capped.includes('-n500'));
  assert.ok(gitLogArgs({ since: 'v1.0.0' }).includes('v1.0.0..HEAD'));
  assert.ok(gitLogArgs({ since: '2026-01-01' }).includes('--since=2026-01-01'));
});

// ---------------------------------------------------------------------------
// hotspots — decay math with a fixed `now`
// ---------------------------------------------------------------------------

test('hotspots: exponential recency decay is exact for fixed now', () => {
  const commits = [
    commit('c1', 'A', daysAgoIso(0), ['hot.mjs']),   // weight 1
    commit('c2', 'A', daysAgoIso(90), ['hot.mjs']),  // weight 0.5 at half-life 90
    commit('c3', 'A', daysAgoIso(180), ['cold.mjs']) // weight 0.25
  ];
  const result = hotspots(commits, { now: NOW, halfLifeDays: 90 });
  assert.equal(result.files[0].file, 'hot.mjs');
  assert.equal(result.files[0].score, 1.5);
  assert.equal(result.files[0].commits, 2);
  assert.equal(result.files[1].file, 'cold.mjs');
  assert.equal(result.files[1].score, 0.25);
  // half-life is a parameter: 45d half-life makes the 90d-old commit worth 0.25
  const faster = hotspots(commits, { now: NOW, halfLifeDays: 45 });
  assert.equal(faster.files[0].score, 1.25);
});

test('hotspots: `now` is required — never Date.now() inside the pure fn', () => {
  assert.throws(() => hotspots([], {}), TypeError);
  assert.throws(() => hotspots([]), TypeError);
});

test('hotspots: carries provenance stamp', () => {
  const commits = [commit('c1', 'A', daysAgoIso(1), ['x.mjs'])];
  const result = hotspots(commits, { now: NOW });
  assert.equal(result.basis, 'measured');
  assert.equal(result.source, 'git-log');
  assert.equal(result.window.commits, 1);
  assert.equal(result.window.since, daysAgoIso(1));
});

// ---------------------------------------------------------------------------
// coChange — confidence, support, and the bulk-commit cap
// ---------------------------------------------------------------------------

/** a+b together 3×, a alone 1×, c alone 1× → P(b|a)=0.75, P(a|b)=1.0 */
function coChangeFixture() {
  return [
    commit('c1', 'A', daysAgoIso(1), ['a.mjs', 'b.mjs']),
    commit('c2', 'A', daysAgoIso(2), ['a.mjs', 'b.mjs']),
    commit('c3', 'A', daysAgoIso(3), ['a.mjs', 'b.mjs']),
    commit('c4', 'A', daysAgoIso(4), ['a.mjs']),
    commit('c5', 'A', daysAgoIso(5), ['c.mjs'])
  ];
}

test('coChange: directed confidence P(b|a) with support threshold', () => {
  const result = coChange(coChangeFixture(), { minSupport: 3, minConfidence: 0.4 });
  assert.deepEqual(result.pairs, [
    { a: 'b.mjs', b: 'a.mjs', together: 3, confidence: 1 },
    { a: 'a.mjs', b: 'b.mjs', together: 3, confidence: 0.75 }
  ]);
  // raise support above the pair count → nothing survives
  assert.deepEqual(coChange(coChangeFixture(), { minSupport: 4 }).pairs, []);
  // raise confidence → only the 1.0 direction survives
  assert.deepEqual(coChange(coChangeFixture(), { minConfidence: 0.8 }).pairs.map((p) => p.a), ['b.mjs']);
});

test('coChange: commits touching > maxFilesPerCommit are excluded entirely', () => {
  const bulkFiles = Array.from({ length: 31 }, (_, i) => `bulk/${i}.mjs`);
  bulkFiles[0] = 'a.mjs';
  bulkFiles[1] = 'b.mjs';
  const commits = [...coChangeFixture(), commit('c6', 'A', daysAgoIso(6), bulkFiles)];

  // default cap 30: the 31-file sweep is skipped — counts identical to the base fixture
  const capped = coChange(commits);
  assert.equal(capped.skippedLargeCommits, 1);
  assert.equal(capped.pairs.find((p) => p.a === 'a.mjs' && p.b === 'b.mjs').together, 3);

  // cap is a parameter: raising it lets the sweep count (together becomes 4)
  const uncapped = coChange(commits, { maxFilesPerCommit: 40 });
  assert.equal(uncapped.skippedLargeCommits, 0);
  assert.equal(uncapped.pairs.find((p) => p.a === 'a.mjs' && p.b === 'b.mjs').together, 4);
});

// ---------------------------------------------------------------------------
// ownership — shares + bus factor
// ---------------------------------------------------------------------------

test('busFactorOf: smallest #authors covering >= 50% of commits', () => {
  assert.equal(busFactorOf(new Map([['A', 3], ['B', 1]])), 1);          // A alone covers 75%
  assert.equal(busFactorOf(new Map([['A', 2], ['B', 2]])), 1);          // A alone hits exactly 50%
  assert.equal(busFactorOf(new Map([['A', 1], ['B', 1], ['C', 1], ['D', 1]])), 2);
  assert.equal(busFactorOf(new Map()), 0);
});

test('ownership: per-file and per-prefix authors, shares, bus factor', () => {
  const commits = [
    commit('c1', 'Ann', daysAgoIso(1), ['scripts/x.mjs', 'scripts/edges/y.mjs']),
    commit('c2', 'Ann', daysAgoIso(2), ['scripts/x.mjs']),
    commit('c3', 'Ann', daysAgoIso(3), ['scripts/x.mjs']),
    commit('c4', 'Bob', daysAgoIso(4), ['scripts/x.mjs']),
    commit('c5', 'Bob', daysAgoIso(5), ['README.md'])
  ];
  const result = ownership(commits);

  const x = result.files.find((f) => f.path === 'scripts/x.mjs');
  assert.equal(x.commits, 4);
  assert.deepEqual(x.topAuthors[0], { author: 'Ann', commits: 3, share: 0.75 });
  assert.equal(x.busFactor, 1);

  // prefix stats: c1 touches two files under scripts/ but counts once
  const scriptsPrefix = result.prefixes.find((p) => p.path === 'scripts');
  assert.equal(scriptsPrefix.commits, 4);
  const nested = result.prefixes.find((p) => p.path === 'scripts/edges');
  assert.equal(nested.commits, 1);
  // root-level files land under '.'
  const root = result.prefixes.find((p) => p.path === '.');
  assert.equal(root.commits, 1);
  assert.equal(root.topAuthors[0].author, 'Bob');
});

// ---------------------------------------------------------------------------
// riskFactors — hotspot hits + missing co-change partners
// ---------------------------------------------------------------------------

test('riskFactors: flags touched hotspots and missing partners', () => {
  const commits = coChangeFixture();
  const hs = hotspots(commits, { now: NOW });
  const cc = coChange(commits);

  const risky = riskFactors(['a.mjs'], { hotspots: hs, coChange: cc });
  assert.equal(risky.basis, 'measured');
  assert.equal(risky.source, 'git-log');
  assert.equal(risky.window.commits, 5);
  assert.equal(risky.hotspotHits[0].file, 'a.mjs');
  assert.equal(risky.hotspotHits[0].rank, 1); // a.mjs has the most recent churn
  assert.equal(risky.missingPartners.length, 1);
  assert.equal(risky.missingPartners[0].missing, 'b.mjs');
  assert.equal(risky.missingPartners[0].changed, 'a.mjs');
  assert.equal(risky.missingPartners[0].confidence, 0.75);

  // partner present in the change-set → nothing missing
  const complete = riskFactors(['a.mjs', 'b.mjs'], { hotspots: hs, coChange: cc });
  assert.deepEqual(complete.missingPartners, []);

  // untouched-by-history file → no factors at all
  const cold = riskFactors(['brand-new.mjs'], { hotspots: hs, coChange: cc });
  assert.deepEqual(cold.hotspotHits, []);
  assert.deepEqual(cold.missingPartners, []);
});

// ---------------------------------------------------------------------------
// riskScore — weighted 0-10 aggregation, factor by factor
// ---------------------------------------------------------------------------

/** hotspots+coChange over coChangeFixture(): a.mjs rank 1/3, b.mjs missing at 0.75. */
function riskSignals() {
  const commits = coChangeFixture();
  return { hotspots: hotspots(commits, { now: NOW }), coChange: coChange(commits) };
}

test('riskScore: hotspot-overlap contributes the touched file\'s churn percentile', () => {
  const scored = riskScore(['a.mjs'], riskSignals());
  const hot = scored.factors.find((f) => f.name === 'hotspot-overlap');
  // a.mjs is churn rank 1 of 3 → percentile 1.0, contribution = full weight
  assert.equal(hot.raw, 1);
  assert.equal(hot.contribution, RISK_WEIGHTS.hotspotOverlap);
  assert.match(hot.evidence, /a\.mjs is churn rank #1 of 3/);

  // rank 3 of 3 → percentile 1/3
  const cold = riskScore(['c.mjs'], riskSignals());
  assert.equal(cold.factors.find((f) => f.name === 'hotspot-overlap').raw, 0.3333);
  assert.equal(cold.score, 1.8); // 10 × (0.35 × 0.3333) / 0.65
});

test('riskScore: missing co-change partners contribute count × confidence, saturating', () => {
  const scored = riskScore(['a.mjs'], riskSignals());
  const missing = scored.factors.find((f) => f.name === 'missing-co-change');
  // b.mjs missing at confidence 0.75 → raw = 0.75 / saturation(2) = 0.375
  assert.equal(missing.raw, 0.75 / RISK_SATURATION.missingConfidenceSum);
  assert.equal(missing.contribution, 0.1125);
  assert.match(missing.evidence, /b\.mjs \(75%\)/);
  // full aggregation: 10 × (0.35 + 0.1125) / 0.65 = 7.1
  assert.equal(scored.score, 7.1);
  // partner included → factor drops to zero
  const complete = riskScore(['a.mjs', 'b.mjs'], riskSignals());
  assert.equal(complete.factors.find((f) => f.name === 'missing-co-change').raw, 0);
});

test('riskScore: blast radius factor only when a graph is provided', () => {
  const withoutGraph = riskScore(['a.mjs'], riskSignals());
  assert.equal(withoutGraph.factors.length, 2); // omitted, not zeroed

  const scored = riskScore(['a.mjs'], {
    ...riskSignals(),
    blastRadius: { dependents: ['x.mjs', 'y.mjs', 'a.mjs'], source: 'ts-graph' }
  });
  const blast = scored.factors.find((f) => f.name === 'blast-radius');
  // a.mjs is in the change-set → filtered; 2 of saturation 10 → raw 0.2
  assert.equal(blast.raw, 2 / RISK_SATURATION.blastDependents);
  assert.deepEqual(blast.data.dependents, ['x.mjs', 'y.mjs']);
  assert.equal(scored.score, 5.9); // 10 × (0.35 + 0.1125 + 0.04) / 0.85
});

test('riskScore: lease conflicts via exact / dir-prefix / glob targets', () => {
  assert.equal(leaseTargetMatches('scripts/a.mjs', 'scripts/a.mjs'), true);
  assert.equal(leaseTargetMatches('scripts/', 'scripts/deep/a.mjs'), true);
  assert.equal(leaseTargetMatches('scripts', 'scripts/a.mjs'), true);
  assert.equal(leaseTargetMatches('scripts/**', 'scripts/deep/a.mjs'), true);
  assert.equal(leaseTargetMatches('*.mjs', 'scripts/a.mjs'), true); // basename glob
  assert.equal(leaseTargetMatches('docs/**', 'scripts/a.mjs'), false);

  const leases = [{ target: 'scripts/**', lockedBy: 'codex-a', until: '2026-08-30', notes: '' }];
  const scored = riskScore(['scripts/z.mjs'], { ...riskSignals(), leases });
  const lease = scored.factors.find((f) => f.name === 'lease-conflicts');
  assert.equal(lease.raw, 1 / RISK_SATURATION.leaseConflicts);
  assert.equal(lease.data.conflicts[0].lockedBy, 'codex-a');
  assert.match(lease.evidence, /codex-a/);
  assert.equal(scored.score, 0.9); // 10 × (0.15 × 0.5) / 0.8

  // leases provided but nothing overlaps → factor present at zero
  const clean = riskScore(['docs/x.md'], { ...riskSignals(), leases });
  assert.equal(clean.factors.find((f) => f.name === 'lease-conflicts').raw, 0);
});

test('riskScore: total function — empty history yields 0 with reason, never NaN', () => {
  const empty = riskScore(['a.mjs'], {});
  assert.equal(empty.score, 0);
  assert.equal(empty.reason, 'insufficient history');
  assert.ok(Number.isFinite(empty.score));
  assert.equal(empty.factors.length, 2); // score always carries its factors
  for (const f of empty.factors) assert.ok(Number.isFinite(f.contribution));
  assert.equal(empty.window.commits, 0);

  const noFiles = riskScore([], riskSignals());
  assert.ok(Number.isFinite(noFiles.score));
  assert.equal(noFiles.score, 0);
});

test('riskScore: weights are overridable (calibration hook), defaults documented', () => {
  const tuned = riskScore(['a.mjs'], {
    ...riskSignals(),
    weights: { hotspotOverlap: 1, missingCoChange: 0, blastRadius: 0, leaseConflicts: 0 }
  });
  assert.equal(tuned.score, 10); // only the saturated hotspot factor counts
  assert.equal(tuned.params.weights.hotspotOverlap, 1);
  // defaults stamped into params for reviewability
  assert.deepEqual(riskScore(['a.mjs'], riskSignals()).params.weights, { ...RISK_WEIGHTS });
});

// ---------------------------------------------------------------------------
// fileHealth — per-file danger score, factor by factor on isolated fixtures
// ---------------------------------------------------------------------------

/** Commit factory with a subject (fileHealth's fix-density reads it). */
function hcommit(hash, day, subject, files, author = 'A') {
  return { hash, author, dateIso: daysAgoIso(day), subject, files };
}

test('fileHealth: churn-percentile isolated — rank in the decay ranking drives the score', () => {
  // Three single-file, single-author, fix-free histories: only churn recency differs.
  const commits = [
    hcommit('t1', 0, 'feat: top', ['top.js']), hcommit('t2', 1, 'feat: top', ['top.js']),
    hcommit('t3', 2, 'feat: top', ['top.js']),
    hcommit('m1', 10, 'feat: mid', ['mid.js']), hcommit('m2', 11, 'feat: mid', ['mid.js']),
    hcommit('m3', 12, 'feat: mid', ['mid.js']),
    hcommit('l1', 20, 'feat: low', ['low.js']), hcommit('l2', 21, 'feat: low', ['low.js']),
    hcommit('l3', 22, 'feat: low', ['low.js'])
  ];
  const result = fileHealth(commits, { now: NOW });
  assert.deepEqual(result.files.map((f) => f.file), ['top.js', 'mid.js', 'low.js']);
  const churnOf = (f) => f.factors.find((x) => x.name === 'churn-percentile');
  assert.equal(churnOf(result.files[0]).raw, 1);
  assert.equal(churnOf(result.files[1]).raw, 0.6667);
  assert.equal(churnOf(result.files[2]).raw, 0.3333);
  assert.match(churnOf(result.files[0]).evidence, /churn rank #1 of 3/);
  // scatter 0 (never co-changes), bus raw 1 (single author), fix 0 for all three →
  // scores differ ONLY through churn: 10×(0.35×pct + 0.2×1)
  assert.deepEqual(result.files.map((f) => f.score), [5.5, 4.3, 3.2]);
  // no file flagged: each has 3 commits (= minCommits)
  assert.ok(result.files.every((f) => !f.lowConfidence));
});

test('fileHealth: co-change-scatter isolated — distinct partners over support 2, saturating', () => {
  const commits = [
    hcommit('c1', 1, 'feat: x', ['hub.js', 'p1.js']), hcommit('c2', 2, 'feat: x', ['hub.js', 'p1.js']),
    hcommit('c3', 3, 'feat: x', ['hub.js', 'p2.js']), hcommit('c4', 4, 'feat: x', ['hub.js', 'p2.js']),
    hcommit('c5', 5, 'feat: x', ['hub.js', 'p3.js']), hcommit('c6', 6, 'feat: x', ['hub.js', 'p3.js']),
    hcommit('c7', 7, 'feat: x', ['hub.js', 'weak.js']) // together only 1× → below support
  ];
  const result = fileHealth(commits, { now: NOW });
  const hub = result.files.find((f) => f.file === 'hub.js');
  const scatter = hub.factors.find((x) => x.name === 'co-change-scatter');
  // 3 recurring partners of saturation 8 → raw 0.375; weak.js does NOT count
  assert.equal(scatter.raw, 3 / FILE_HEALTH_SATURATION.scatterPartners);
  assert.match(scatter.evidence, /3 distinct partner/);
  assert.match(scatter.evidence, /p1\.js/);
  assert.ok(!scatter.evidence.includes('weak.js'));
  // partner side: p1.js co-changes only with hub.js → raw 1/8, and its 2 commits
  // put it below minCommits → lowConfidence, not fake precision
  const p1 = result.files.find((f) => f.file === 'p1.js');
  assert.equal(p1.factors.find((x) => x.name === 'co-change-scatter').raw, 0.125);
  assert.equal(p1.lowConfidence, true);
  assert.equal(p1.reason, 'insufficient history');
});

test('fileHealth: bus-factor isolated — raw = 1/busFactor', () => {
  const commits = [
    hcommit('s1', 1, 'feat: s', ['shared.js'], 'Ann'), hcommit('s2', 2, 'feat: s', ['shared.js'], 'Bob'),
    hcommit('s3', 3, 'feat: s', ['shared.js'], 'Cid'), hcommit('s4', 4, 'feat: s', ['shared.js'], 'Dee'),
    hcommit('o1', 5, 'feat: o', ['solo.js'], 'Ann'), hcommit('o2', 6, 'feat: o', ['solo.js'], 'Ann'),
    hcommit('o3', 7, 'feat: o', ['solo.js'], 'Ann')
  ];
  const result = fileHealth(commits, { now: NOW });
  const busOf = (name) => result.files.find((f) => f.file === name)
    .factors.find((x) => x.name === 'bus-factor');
  // 4 equal authors → busFactor 2 → raw 0.5
  assert.equal(busOf('shared.js').raw, 0.5);
  assert.match(busOf('shared.js').evidence, /bus factor 2/);
  // single author → busFactor 1 → raw 1.0, evidence names the owner
  assert.equal(busOf('solo.js').raw, 1);
  assert.match(busOf('solo.js').evidence, /bus factor 1 — Ann owns 100% of 3 commits/);
});

test('fileHealth: fix-density isolated — share of fix-subject commits, bulk sweeps excluded', () => {
  const bulk = Array.from({ length: 31 }, (_, i) => `bulk/${i}.js`);
  bulk[0] = 'flaky.js';
  const commits = [
    hcommit('f1', 1, 'feat: build the thing', ['flaky.js']),
    hcommit('f2', 2, 'fix: crash on empty input', ['flaky.js']),
    hcommit('f3', 3, 'fixes #12 double free', ['flaky.js']),
    hcommit('f4', 4, 'feat: extend the thing', ['flaky.js']),
    hcommit('b1', 5, 'fix: mass sweep', bulk), // > maxFilesPerCommit → excluded from density
    hcommit('g1', 6, 'feat: stable 1', ['stable.js']),
    hcommit('g2', 7, 'feat: stable 2', ['stable.js']),
    hcommit('g3', 8, 'feat: stable 3', ['stable.js'])
  ];
  const result = fileHealth(commits, { now: NOW });
  const flaky = result.files.find((f) => f.file === 'flaky.js');
  const fix = flaky.factors.find((x) => x.name === 'fix-density');
  // 2 of 4 non-bulk commits are fixes; the 31-file "fix: mass sweep" counts nowhere
  assert.equal(fix.raw, 0.5);
  assert.match(fix.evidence, /2 of 4 commits are fix\/revert commits \(50%\)/);
  // hotspot commit count still sees all 5 commits — only the density excludes bulk
  assert.equal(flaky.commits, 5);
  const stable = result.files.find((f) => f.file === 'stable.js');
  assert.equal(stable.factors.find((x) => x.name === 'fix-density').raw, 0);
  assert.match(stable.factors.find((x) => x.name === 'fix-density').evidence, /no fix-pattern commits in 3 commits/);
});

test('fileHealth: <3 commits → scored but flagged lowConfidence with reason', () => {
  const commits = [
    hcommit('n1', 1, 'feat: new', ['young.js']),
    hcommit('n2', 2, 'fix: new', ['young.js'])
  ];
  const result = fileHealth(commits, { now: NOW });
  const young = result.files[0];
  assert.equal(young.lowConfidence, true);
  assert.equal(young.reason, 'insufficient history');
  assert.ok(Number.isFinite(young.score)); // still a real number, just not trusted
  assert.equal(young.commits, 2);
  assert.equal(result.params.minCommits, 3);
});

test('fileHealth: `now` required, weights overridable, defaults stamped into params', () => {
  assert.throws(() => fileHealth([], {}), TypeError);
  const commits = [
    hcommit('a1', 1, 'feat: a', ['a.js']), hcommit('a2', 2, 'feat: a', ['a.js']),
    hcommit('a3', 3, 'feat: a', ['a.js'])
  ];
  const tuned = fileHealth(commits, {
    now: NOW,
    weights: { churnPercentile: 1, coChangeScatter: 0, busFactor: 0, fixDensity: 0 }
  });
  assert.equal(tuned.files[0].score, 10); // only the saturated churn factor counts
  const defaults = fileHealth(commits, { now: NOW });
  assert.deepEqual(defaults.params.weights, { ...FILE_HEALTH_WEIGHTS });
  assert.equal(defaults.basis, 'measured');
  assert.equal(defaults.source, 'git-log');
});

// ---------------------------------------------------------------------------
// Determinism contract: same fixture + same now ⇒ byte-identical JSON
// ---------------------------------------------------------------------------

test('determinism: same inputs and same now produce byte-identical JSON', () => {
  const run = () => {
    const commits = [...coChangeFixture(),
      commit('c9', 'Zoe', daysAgoIso(10), ['scripts/z.mjs', 'a.mjs'])];
    return JSON.stringify({
      hotspots: hotspots(commits, { now: NOW, halfLifeDays: 90 }),
      coChange: coChange(commits),
      ownership: ownership(commits),
      risk: riskFactors(['a.mjs', 'scripts/z.mjs'], {
        hotspots: hotspots(commits, { now: NOW, halfLifeDays: 90 }),
        coChange: coChange(commits)
      }),
      score: riskScore(['a.mjs', 'scripts/z.mjs'], {
        hotspots: hotspots(commits, { now: NOW, halfLifeDays: 90 }),
        coChange: coChange(commits),
        blastRadius: { dependents: ['x.mjs', 'y.mjs'] },
        leases: [{ target: 'scripts/**', lockedBy: 'codex-a', until: '', notes: '' }]
      }),
      health: fileHealth(commits, { now: NOW, halfLifeDays: 90 })
    });
  };
  // Fixtures are rebuilt from scratch on each call — only the values match.
  assert.equal(run(), run());
});

// ---------------------------------------------------------------------------
// calibration — rank AUC + leakage-free retrospective scoring
// ---------------------------------------------------------------------------

test('rankAuc: rank-based ROC-AUC with average ranks for ties', () => {
  assert.equal(rankAuc([1, 2, 3, 4], [false, false, true, true]), 1);   // perfect
  assert.equal(rankAuc([1, 2, 3, 4], [true, true, false, false]), 0);   // inverted
  assert.equal(rankAuc([5, 5, 5, 5], [true, false, true, false]), 0.5); // all tied
  assert.equal(rankAuc([1, 2], [true, true]), null);                    // one class → undefined
  assert.equal(rankAuc([], []), null);
});

test('DEFECT_FIX_REGEX: matches repair subjects, not fix-as-substring', () => {
  for (const s of ['fix(intel): off-by-one', 'Revert "feat: x"', 'hotfix: prod down',
    'fixes #12', 'fixed flaky test', 'guard against regression']) {
    assert.ok(DEFECT_FIX_REGEX.test(s), s);
  }
  for (const s of ['feat: add prefix matcher', 'test: fixture repo', 'chore: suffix rename']) {
    assert.ok(!DEFECT_FIX_REGEX.test(s), s);
  }
});

const CAL_BASE = Date.parse('2026-01-01T00:00:00Z');

/** Commit at day N with subject — chronological synthetic history. */
function calCommit(hash, day, subject, files) {
  return { hash, author: 'Cal', dateIso: new Date(CAL_BASE + day * DAY_MS).toISOString(), subject, files };
}

/**
 * KNOWN defect structure: hot.js is a hotspot (5 early commits); three risky
 * commits touch it and each is followed by a fix touching it again; three
 * clean commits open brand-new files; a late chore commit extends the log so
 * the eval segment is not censored by the 30d horizon.
 */
function calibrationFixture() {
  return [
    calCommit('h1', 0, 'feat: hot 1', ['hot.js']),
    calCommit('h2', 2, 'feat: hot 2', ['hot.js']),
    calCommit('h3', 4, 'feat: hot 3', ['hot.js']),
    calCommit('h4', 6, 'feat: hot 4', ['hot.js']),
    calCommit('h5', 8, 'feat: hot 5', ['hot.js']),
    calCommit('q1', 9, 'feat: quiet corner', ['quiet.js']),
    calCommit('r1', 40, 'feat: risky 1', ['hot.js']),
    calCommit('f1', 41, 'fix: hot regression 1', ['hot.js']),
    calCommit('n1', 44, 'feat: new area 1', ['new1.js']),
    calCommit('r2', 50, 'feat: risky 2', ['hot.js']),
    calCommit('f2', 51, 'fix: hot regression 2', ['hot.js']),
    calCommit('n2', 54, 'feat: new area 2', ['new2.js']),
    calCommit('r3', 60, 'feat: risky 3', ['hot.js']),
    calCommit('f3', 61, 'fix: hot regression 3', ['hot.js']),
    calCommit('n3', 64, 'feat: new area 3', ['new3.js']),
    calCommit('z1', 120, 'chore: close observation window', ['closer.js'])
  ];
}

test('calibrateRisk: labels from later fixes, AUC beats random on the known structure', () => {
  const result = calibrateRisk(calibrationFixture(), { window: 9 });
  // window 9 = the eval segment r1..n3; z1 is censored (younger than horizon)
  assert.equal(result.evaluated, 9);
  assert.equal(result.censored, 1);
  assert.deepEqual(result.skipped, { merge: 0, bulk: 0 });
  // r1/r2/r3 fixed within days; f1/f2 are themselves re-fixed → 5 defective
  assert.equal(result.defective, 5);
  const byHash = new Map(result.commits.map((r) => [r.hash, r]));
  assert.equal(byHash.get('r1').defective, true);
  assert.equal(byHash.get('r1').fixedBy, 'f1');
  assert.equal(byHash.get('n1').defective, false);
  assert.equal(byHash.get('f3').defective, false); // never re-fixed inside the horizon
  // hotspot-touching commits outscore fresh-file commits ⇒ AUC well above 0.5
  assert.ok(byHash.get('r1').score > byHash.get('n1').score);
  assert.equal(result.auc, 0.875);
  assert.ok(result.auc > 0.5);
  assert.match(result.verdict, /AUC 0\.88 over 9 commits/);
  assert.match(result.verdict, /better than random/);
  assert.match(result.verdict, /gate \(0\.6\) met/);
  // honest methodology: the output itself says what this is and is not
  assert.match(result.method, /self-calibration/);
  assert.match(result.method, /NOT a cross-repo benchmark/);
  assert.equal(result.basis, 'measured');
  assert.equal(result.quantiles.reduce((s, q) => s + q.commits, 0), 9);
});

test('calibrateRisk: no leakage — scores come only from the strict prefix', () => {
  const result = calibrateRisk(calibrationFixture(), { window: 100 });
  const byHash = new Map(result.commits.map((r) => [r.hash, r]));
  // The chronologically first commit is scored from EMPTY history — even
  // though hot.js later becomes the top hotspot, nothing leaks backwards.
  assert.equal(byHash.get('h1').score, 0);
  assert.equal(byHash.get('h1').reason, 'insufficient history');
  // A file's first-ever commit scores 0 even with a rich prefix behind it.
  assert.equal(byHash.get('n1').score, 0);
  // Risky commits score from the prefix hotspot signal alone (no co-change
  // pairs exist in single-file history): 10 × 0.35/0.65 = 5.4.
  assert.equal(byHash.get('r1').score, 5.4);
  assert.ok(result.auc > 0.5);
});

test('calibrateRisk: deterministic — byte-identical JSON on rebuilt fixtures', () => {
  const run = () => JSON.stringify(calibrateRisk(calibrationFixture(), { window: 9 }));
  assert.equal(run(), run());
});

// ---------------------------------------------------------------------------
// calibrateFileHealth — cut-point replay: do today's scores predict fixes?
// ---------------------------------------------------------------------------

function hCal(hash, day, subject, files) {
  return { hash, author: 'Cal', dateIso: new Date(CAL_BASE + day * DAY_MS).toISOString(), subject, files };
}

/**
 * PLANTED structure: hot.js is churned AND repeatedly fixed before the cut,
 * then fixed AGAIN after the cut (the label); calm.js/quiet.js stay clean;
 * born-late.js first appears after the cut (leakage probe); a late chore
 * commit fixes the log end so cut = day 30 at horizonDays 30.
 */
function healthCalFixture() {
  return [
    hCal('h1', 0, 'feat: hot 1', ['hot.js']),
    hCal('h2', 1, 'feat: hot 2', ['hot.js']),
    hCal('hf1', 2, 'fix: hot 1', ['hot.js']),
    hCal('h3', 3, 'feat: hot 3', ['hot.js']),
    hCal('hf2', 4, 'fix: hot 2', ['hot.js']),
    hCal('h4', 5, 'feat: hot 4', ['hot.js']),
    hCal('h5', 6, 'feat: hot 5', ['hot.js']),
    hCal('c1', 7, 'feat: calm 1', ['calm.js']),
    hCal('c2', 8, 'feat: calm 2', ['calm.js']),
    hCal('c3', 9, 'feat: calm 3', ['calm.js']),
    hCal('q1', 10, 'feat: quiet 1', ['quiet.js']),
    hCal('q2', 11, 'feat: quiet 2', ['quiet.js']),
    hCal('q3', 12, 'feat: quiet 3', ['quiet.js']),
    hCal('F1', 40, 'fix: hot exploded again', ['hot.js']),
    hCal('L1', 45, 'feat: born after the cut', ['born-late.js']),
    hCal('Z1', 60, 'chore: close observation window', ['closer.js'])
  ];
}

test('calibrateFileHealth: the repeatedly-fixed file wins the ranking → AUC beats random', () => {
  const result = calibrateFileHealth(healthCalFixture(), { horizonDays: 30 });
  // cut = 30d before the log end (day 60) → day 30
  assert.equal(result.params.cut, new Date(CAL_BASE + 30 * DAY_MS).toISOString());
  // prefix files only: hot/calm/quiet; born-late.js and closer.js are post-cut
  assert.equal(result.evaluated, 3);
  assert.equal(result.futureCommits, 3);
  assert.equal(result.futureFixCommits, 1);
  const byFile = new Map(result.files.map((r) => [r.file, r]));
  // hot.js: churn rank 1 (raw 0.35) + bus 1 (0.2) + fix density 2/7 (0.0714) → 6.2
  assert.equal(byFile.get('hot.js').score, 6.2);
  assert.equal(byFile.get('hot.js').defective, true);
  assert.equal(byFile.get('hot.js').fixedBy, 'F1');
  assert.equal(byFile.get('calm.js').defective, false);
  assert.equal(byFile.get('quiet.js').defective, false);
  assert.equal(result.defective, 1);
  // the planted structure separates perfectly → AUC 1
  assert.equal(result.auc, 1);
  assert.ok(result.auc > 0.5);
  assert.match(result.verdict, /AUC 1\.00 over 3 files/);
  assert.match(result.verdict, /better than random/);
  assert.match(result.verdict, /gate \(0\.6\) met/);
  // honest methodology in the output itself
  assert.match(result.method, /self-calibration/);
  assert.match(result.method, /NOT a cross-repo benchmark/);
  assert.equal(result.basis, 'measured');
  assert.equal(result.quantiles.reduce((s, q) => s + q.files, 0), 3);
});

test('calibrateFileHealth: no leakage — files first committed after the cut are never scored', () => {
  const result = calibrateFileHealth(healthCalFixture(), { horizonDays: 30 });
  const scored = new Set(result.files.map((r) => r.file));
  assert.ok(!scored.has('born-late.js')); // exists only after the cut
  assert.ok(!scored.has('closer.js'));
  // and the prefix score of hot.js uses ONLY pre-cut history: 2 of its 7
  // pre-cut commits are fixes (the post-cut F1 fix must not inflate density)
  const hot = fileHealth(
    healthCalFixture().filter((c) => Date.parse(c.dateIso) <= CAL_BASE + 30 * DAY_MS),
    { now: CAL_BASE + 30 * DAY_MS }
  ).files.find((f) => f.file === 'hot.js');
  assert.match(hot.factors.find((x) => x.name === 'fix-density').evidence, /2 of 7 commits/);
});

test('calibrateFileHealth: window limits the scoring prefix; one-class window → AUC undefined', () => {
  // window 2 keeps only the last two pre-cut commits (q2, q3) → quiet.js alone,
  // 2 commits → lowConfidence; no defective/clean split → AUC undefined.
  const result = calibrateFileHealth(healthCalFixture(), { horizonDays: 30, window: 2 });
  assert.equal(result.evaluated, 1);
  assert.equal(result.files[0].file, 'quiet.js');
  assert.equal(result.files[0].lowConfidence, true);
  assert.equal(result.auc, null);
  assert.match(result.verdict, /AUC undefined/);
  assert.match(result.verdict, /do NOT trust/);
});

test('calibrateFileHealth: deterministic — byte-identical JSON on rebuilt fixtures', () => {
  const run = () => JSON.stringify(calibrateFileHealth(healthCalFixture(), { horizonDays: 30 }));
  assert.equal(run(), run());
});

// ---------------------------------------------------------------------------
// Integration: brain-intel.mjs against a scripted mkdtemp git repo
// ---------------------------------------------------------------------------

function git(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

/** 4 commits with known co-change structure: a.js+b.js together 3×, c.js once. */
function makeFixtureRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-intel-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  const dates = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z'];
  const sets = [['a.js', 'b.js'], ['a.js', 'b.js'], ['a.js', 'b.js'], ['c.js']];
  sets.forEach((files, i) => {
    for (const f of files) fs.appendFileSync(path.join(cwd, f), `change ${i}\n`);
    git(cwd, ['add', ...files]);
    git(cwd, ['commit', '-q', '-m', `feat: change ${i}`],
      { GIT_AUTHOR_DATE: dates[i], GIT_COMMITTER_DATE: dates[i] });
  });
  return cwd;
}

function runIntel(cwd, args) {
  return spawnSync(process.execPath, [INTEL_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_ROOT: cwd }
  });
}

test('brain-intel.mjs --json: stable JSON from a real fixture repo', () => {
  const cwd = makeFixtureRepo();
  const nowFlag = ['--now', '2026-03-01T00:00:00Z'];

  const co = runIntel(cwd, ['co-change', '--json']);
  assert.equal(co.status, 0, co.stderr);
  const coParsed = JSON.parse(co.stdout);
  assert.equal(coParsed.basis, 'measured');
  assert.equal(coParsed.source, 'git-log');
  assert.equal(coParsed.window.commits, 4);
  // a.js and b.js only ever change together → both directions at confidence 1
  assert.deepEqual(coParsed.pairs, [
    { a: 'a.js', b: 'b.js', together: 3, confidence: 1 },
    { a: 'b.js', b: 'a.js', together: 3, confidence: 1 }
  ]);

  const hot = runIntel(cwd, ['hotspots', '--json', ...nowFlag]);
  assert.equal(hot.status, 0, hot.stderr);
  const hotParsed = JSON.parse(hot.stdout);
  assert.equal(hotParsed.files.length, 3);
  // a.js/b.js (3 commits each) outrank c.js; the tie breaks lexicographically
  assert.deepEqual(hotParsed.files.map((f) => f.file), ['a.js', 'b.js', 'c.js']);
  assert.equal(hotParsed.files[0].commits, 3);

  // Determinism as a CLI-level contract: same repo + same --now ⇒ byte-identical stdout
  const again = runIntel(cwd, ['hotspots', '--json', ...nowFlag]);
  assert.equal(hot.stdout, again.stdout);
  const coAgain = runIntel(cwd, ['co-change', '--json']);
  assert.equal(co.stdout, coAgain.stdout);
});

test('brain-intel.mjs risk: reports the missing partner and ends with a next action', () => {
  const cwd = makeFixtureRepo();

  const json = runIntel(cwd, ['risk', '--files', 'a.js', '--json', '--now', '2026-03-01T00:00:00Z']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.files, ['a.js']);
  assert.equal(parsed.missingPartners[0].missing, 'b.js');
  assert.equal(parsed.missingPartners[0].confidence, 1);
  assert.match(parsed.nextAction, /also touch b\.js/);
  assert.match(parsed.nextAction, /project-brain grill/);

  // human output: provenance line + concrete next action as the last line
  const human = runIntel(cwd, ['risk', '--files', 'a.js']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /basis: measured · source: git-log/);
  const lastLine = human.stdout.trim().split('\n').at(-1);
  assert.match(lastLine, /^→ consider: also touch b\.js/);
});

test('brain-intel.mjs ownership --json and --help', () => {
  const cwd = makeFixtureRepo();
  const own = runIntel(cwd, ['ownership', '--json']);
  assert.equal(own.status, 0, own.stderr);
  const parsed = JSON.parse(own.stdout);
  const a = parsed.files.find((f) => f.path === 'a.js');
  assert.equal(a.commits, 3);
  assert.equal(a.busFactor, 1);
  assert.equal(a.topAuthors[0].author, 'Test User');

  const help = runIntel(cwd, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /hotspots/);
  assert.match(help.stdout, /co-change/);
  assert.match(help.stdout, /calibrate/);
});

test('brain-intel.mjs risk --score: full 0-10 score, optional factors omitted cleanly', () => {
  const cwd = makeFixtureRepo();
  const json = runIntel(cwd, ['risk', '--files', 'a.js', '--score', '--json', '--now', '2026-03-01T00:00:00Z']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  // a.js: churn rank 1/3 (raw 1) + missing partner b.js at confidence 1
  // (raw 0.5) → 10 × (0.35 + 0.15) / 0.65 = 7.7
  assert.equal(parsed.score, 7.7);
  assert.equal(parsed.factors.length, 2); // no TS sources, no active_state.md → omitted
  assert.ok(parsed.factors.every((f) => Number.isFinite(f.contribution)));
  assert.match(parsed.nextAction, /also touch b\.js/);
  // read-only discipline: scoring must never create brain state
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain')), false);

  // human output: score line first, action line last
  const human = runIntel(cwd, ['risk', '--files', 'a.js', '--score', '--now', '2026-03-01T00:00:00Z']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Change-risk score 7\.7\/10/);
  assert.match(human.stdout, /uncalibrated defaults/);
  assert.match(human.stdout.trim().split('\n').at(-1), /^→ /);

  // default stays factors-only (score is opt-in until calibration says otherwise)
  const plain = JSON.parse(runIntel(cwd, ['risk', '--files', 'a.js', '--json', '--now', '2026-03-01T00:00:00Z']).stdout);
  assert.equal(plain.score, undefined);
});

/**
 * Scripted repo with KNOWN defect structure (mirrors calibrationFixture, but
 * through real git): hot.js hotspot → risky commit → "fix:" commit; one
 * brand-new-file commit stays clean; a late chore commit closes the horizon.
 */
function makeCalibrationRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-intel-cal-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  const commits = [
    { day: 1, msg: 'feat: core 1', files: ['hot.js'] },
    { day: 2, msg: 'feat: core 2', files: ['hot.js'] },
    { day: 3, msg: 'feat: core 3', files: ['hot.js'] },
    { day: 10, msg: 'feat: risky change', files: ['hot.js'] },
    { day: 11, msg: 'fix: regression in hot path', files: ['hot.js'] },
    { day: 12, msg: 'feat: fresh area', files: ['fresh.js'] },
    { day: 30, msg: 'chore: close observation window', files: ['closer.txt'] }
  ];
  for (const c of commits) {
    const date = new Date(Date.parse('2026-01-01T00:00:00Z') + c.day * DAY_MS).toISOString();
    for (const f of c.files) fs.appendFileSync(path.join(cwd, f), `${c.msg}\n`);
    git(cwd, ['add', ...c.files]);
    git(cwd, ['commit', '-q', '-m', c.msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
  return cwd;
}

test('brain-intel.mjs calibrate: AUC beats random on the scripted defect structure', () => {
  const cwd = makeCalibrationRepo();
  const args = ['calibrate', '--json', '--horizon-days', '5', '--window', '10'];
  const r = runIntel(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.evaluated, 6); // closer.txt commit censored by the horizon
  assert.equal(parsed.censored, 1);
  assert.equal(parsed.defective, 1); // only the risky commit is fixed within 5d
  // risky hot.js commit outranks the clean fresh-file commit → AUC 0.7 here
  assert.equal(parsed.auc, 0.7);
  assert.ok(parsed.auc > 0.5);
  assert.match(parsed.method, /NOT a cross-repo benchmark/);
  assert.match(parsed.verdict, /AUC 0\.70 over 6 commits/);

  // byte-determinism as a CLI-level contract (no clock enters calibrate)
  const again = runIntel(cwd, args);
  assert.equal(r.stdout, again.stdout);

  // human output: methodology disclosure + verdict as the final action line
  const human = runIntel(cwd, ['calibrate', '--horizon-days', '5', '--window', '10']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /NOT a cross-repo benchmark/);
  assert.match(human.stdout.trim().split('\n').at(-1), /^AUC 0\.70/);
});

test('brain-intel.mjs health --json: scored files, lowConfidence flag, mandatory action', () => {
  const cwd = makeFixtureRepo();
  const args = ['health', '--json', '--now', '2026-03-01T00:00:00Z'];
  const r = runIntel(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.basis, 'measured');
  assert.equal(parsed.source, 'git-log');
  // a.js/b.js churn ranks 1/2 (tie broken byString), c.js rank 3 with 1 commit:
  //   a: 10×(0.35×1 + 0.2×(1/8) + 0.2×1) = 5.8
  //   b: 10×(0.35×⅔ + 0.025 + 0.2) = 4.6
  //   c: 10×(0.35×⅓ + 0 + 0.2) = 3.2, flagged (1 commit < 3)
  assert.deepEqual(parsed.files.map((f) => f.file), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(parsed.files.map((f) => f.score), [5.8, 4.6, 3.2]);
  assert.equal(parsed.files[0].lowConfidence, undefined);
  assert.equal(parsed.files[2].lowConfidence, true);
  assert.equal(parsed.files[2].reason, 'insufficient history');
  // every factor carries evidence — no bare numbers
  for (const f of parsed.files) {
    assert.equal(f.factors.length, 4);
    for (const x of f.factors) assert.ok(x.evidence.length > 0, x.name);
  }
  // mandatory action line: top file has bus factor 1 → pair-or-document wording
  assert.match(parsed.nextAction, /^→ highest-risk file a\.js also has bus factor 1/);
  assert.match(parsed.nextAction, /risk --files a\.js/);
  // read-only discipline: health must never create brain state
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain')), false);

  // byte-determinism as a CLI-level contract (same repo + same --now)
  const again = runIntel(cwd, args);
  assert.equal(r.stdout, again.stdout);

  // human output: table, lowConfidence legend, provenance, action line last
  const human = runIntel(cwd, ['health', '--limit', '2', '--now', '2026-03-01T00:00:00Z']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /TOP FACTOR/);
  assert.match(human.stdout, /low confidence/);
  assert.match(human.stdout, /uncalibrated defaults/);
  assert.match(human.stdout, /basis: measured · source: git-log/);
  assert.match(human.stdout.trim().split('\n').at(-1), /^→ highest-risk file a\.js/);
  // --limit 2 → c.js not in the table (but the legend still explains the flag)
  assert.ok(!/c\.js/.test(human.stdout.split('\n').filter((l) => /^\s+\d+\s/.test(l)).join('\n')));
});

/**
 * Scripted repo with planted health structure: hot.js churns 4× and gets a
 * post-cut "fix:", calm.js churns 3× and stays clean, late.js is born after
 * the cut (leakage probe through real git).
 */
function makeHealthCalRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-intel-health-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  const commits = [
    { day: 1, msg: 'feat: hot 1', files: ['hot.js'] },
    { day: 2, msg: 'feat: calm 1', files: ['calm.js'] },
    { day: 3, msg: 'feat: hot 2', files: ['hot.js'] },
    { day: 4, msg: 'feat: calm 2', files: ['calm.js'] },
    { day: 5, msg: 'feat: hot 3', files: ['hot.js'] },
    { day: 6, msg: 'feat: calm 3', files: ['calm.js'] },
    { day: 7, msg: 'feat: hot 4', files: ['hot.js'] },
    { day: 20, msg: 'fix: hot regressed', files: ['hot.js'] },
    { day: 22, msg: 'feat: late arrival', files: ['late.js'] }
  ];
  for (const c of commits) {
    const date = new Date(Date.parse('2026-01-01T00:00:00Z') + c.day * DAY_MS).toISOString();
    for (const f of c.files) fs.appendFileSync(path.join(cwd, f), `${c.msg}\n`);
    git(cwd, ['add', ...c.files]);
    git(cwd, ['commit', '-q', '-m', c.msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
  return cwd;
}

test('brain-intel.mjs health-calibrate: receipt with AUC on the planted structure', () => {
  const cwd = makeHealthCalRepo();
  // horizon 14d before the log end (day 22) → cut day 8: hot 4×, calm 3× scored;
  // the day-20 fix labels hot.js defective; late.js must never be scored.
  const args = ['health-calibrate', '--json', '--horizon-days', '14'];
  const r = runIntel(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.evaluated, 2);
  assert.equal(parsed.defective, 1);
  const byFile = new Map(parsed.files.map((f) => [f.file, f]));
  assert.equal(byFile.get('hot.js').defective, true);
  assert.ok(byFile.get('hot.js').fixedBy); // real git hash of the fix commit
  assert.equal(byFile.get('calm.js').defective, false);
  assert.ok(!byFile.has('late.js')); // born after the cut → never scored
  assert.ok(byFile.get('hot.js').score > byFile.get('calm.js').score);
  assert.equal(parsed.auc, 1);
  assert.match(parsed.verdict, /AUC 1\.00 over 2 files/);
  assert.match(parsed.method, /NOT a cross-repo benchmark/);

  // byte-determinism as a CLI-level contract (no clock enters health-calibrate)
  const again = runIntel(cwd, args);
  assert.equal(r.stdout, again.stdout);

  // human output: methodology disclosure + verdict as the final line
  const human = runIntel(cwd, ['health-calibrate', '--horizon-days', '14']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /NOT a cross-repo benchmark/);
  assert.match(human.stdout.trim().split('\n').at(-1), /^AUC 1\.00/);
});
