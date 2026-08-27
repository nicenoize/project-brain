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
  FILE_HEALTH_STRUCTURE_WEIGHTS,
  FILE_HEALTH_STRUCTURE_SATURATION,
  HISTORY_FACTORS,
  STRUCTURE_FACTORS,
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
  // Scores differ ONLY through churn: 10×(0.4×pct). bus-factor is still
  // measured and still in the factor list, but at weight 0 since it scored
  // AUC 0.50 on two independent repos — so it no longer moves the number.
  assert.deepEqual(result.files.map((f) => f.score), [4, 2.7, 1.3]);
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
// fileHealth — the three OPTIONAL code-structure factors
// ---------------------------------------------------------------------------

/**
 * Fixture with a KNOWN history shape, reused by the structure tests and by the
 * backwards-compatibility snapshot below: core.mjs churns 3× (one fix, two
 * authors), util.mjs rides along twice, leaf.mjs is touched once.
 */
function structureFixture() {
  return [
    hcommit('s1', 1, 'feat: core', ['scripts/core.mjs', 'scripts/util.mjs']),
    hcommit('s2', 2, 'fix: core crash', ['scripts/core.mjs', 'scripts/util.mjs']),
    hcommit('s3', 3, 'feat: core again', ['scripts/core.mjs'], 'B'),
    hcommit('s4', 5, 'feat: leaf', ['scripts/leaf.mjs'])
  ];
}

/**
 * BYTE-IDENTITY GUARD. The three structural factors are optional by contract:
 * a caller that passes no structure data must get exactly what it got before
 * they existed. This is the stored expectation of the history-only output —
 * if any of it changes, that contract broke and this test says where.
 *
 * Updated once, deliberately: bus-factor dropped to weight 0 after measuring
 * AUC 0.50 on two independent repos, and the remaining three weights were
 * renormalised. The factor is still emitted (same name, same raw, same
 * evidence) so the SHAPE of the contract is unchanged — only the numbers it
 * no longer influences.
 */
const FILE_HEALTH_HISTORY_ONLY_SNAPSHOT = "{\"basis\":\"measured\",\"source\":\"git-log\",\"window\":{\"commits\":4,\"since\":\"2026-07-27T00:00:00.000Z\",\"until\":\"2026-07-31T00:00:00.000Z\"},\"params\":{\"weights\":{\"churnPercentile\":0.4,\"coChangeScatter\":0.25,\"fixDensity\":0.35},\"saturation\":{\"scatterPartners\":8},\"scatterSupport\":2,\"minCommits\":3,\"halfLifeDays\":90,\"maxFilesPerCommit\":30,\"fixPattern\":\"/\\\\b(fix(es|ed)?|hotfix|revert(s|ed)?|regression)\\\\b/i\",\"now\":\"2026-08-01T00:00:00.000Z\"},\"files\":[{\"file\":\"scripts/core.mjs\",\"score\":5.5,\"commits\":3,\"lastCommit\":\"2026-07-31T00:00:00.000Z\",\"factors\":[{\"name\":\"churn-percentile\",\"weight\":0.4,\"raw\":1,\"contribution\":0.4,\"evidence\":\"churn rank #1 of 3 (percentile 1)\"},{\"name\":\"co-change-scatter\",\"weight\":0.25,\"raw\":0.125,\"contribution\":0.0313,\"evidence\":\"co-changes with 1 distinct partner(s) (\u22652\u00d7): scripts/util.mjs\"},{\"name\":\"bus-factor\",\"weight\":0,\"raw\":1,\"contribution\":0,\"evidence\":\"bus factor 1 \u2014 A owns 67% of 3 commits\"},{\"name\":\"fix-density\",\"weight\":0.35,\"raw\":0.3333,\"contribution\":0.1167,\"evidence\":\"1 of 3 commits are fix/revert commits (33%)\"}]},{\"file\":\"scripts/util.mjs\",\"score\":4.7,\"commits\":2,\"lastCommit\":\"2026-07-31T00:00:00.000Z\",\"factors\":[{\"name\":\"churn-percentile\",\"weight\":0.4,\"raw\":0.6667,\"contribution\":0.2667,\"evidence\":\"churn rank #2 of 3 (percentile 0.67)\"},{\"name\":\"co-change-scatter\",\"weight\":0.25,\"raw\":0.125,\"contribution\":0.0313,\"evidence\":\"co-changes with 1 distinct partner(s) (\u22652\u00d7): scripts/core.mjs\"},{\"name\":\"bus-factor\",\"weight\":0,\"raw\":1,\"contribution\":0,\"evidence\":\"bus factor 1 \u2014 A owns 100% of 2 commits\"},{\"name\":\"fix-density\",\"weight\":0.35,\"raw\":0.5,\"contribution\":0.175,\"evidence\":\"1 of 2 commits are fix/revert commits (50%)\"}],\"lowConfidence\":true,\"reason\":\"insufficient history\"},{\"file\":\"scripts/leaf.mjs\",\"score\":1.3,\"commits\":1,\"lastCommit\":\"2026-07-27T00:00:00.000Z\",\"factors\":[{\"name\":\"churn-percentile\",\"weight\":0.4,\"raw\":0.3333,\"contribution\":0.1333,\"evidence\":\"churn rank #3 of 3 (percentile 0.33)\"},{\"name\":\"co-change-scatter\",\"weight\":0.25,\"raw\":0,\"contribution\":0,\"evidence\":\"no recurring co-change partners\"},{\"name\":\"bus-factor\",\"weight\":0,\"raw\":1,\"contribution\":0,\"evidence\":\"bus factor 1 \u2014 A owns 100% of 1 commits\"},{\"name\":\"fix-density\",\"weight\":0.35,\"raw\":0,\"contribution\":0,\"evidence\":\"no fix-pattern commits in 1 commits\"}],\"lowConfidence\":true,\"reason\":\"insufficient history\"}]}";

test('fileHealth: WITHOUT structure data the output is byte-identical to the stored expectation', () => {
  const result = fileHealth(structureFixture(), { now: NOW });
  assert.equal(JSON.stringify(result), FILE_HEALTH_HISTORY_ONLY_SNAPSHOT);
  // params must not grow a structure block when nothing structural was passed
  assert.equal(result.params.structure, undefined);
  assert.ok(result.files.every((f) => f.factors.length === 4));
  // passing EMPTY structural inputs must also change nothing (no half-states)
  assert.equal(
    JSON.stringify(fileHealth(structureFixture(), { now: NOW, structure: {}, graph: { nodes: [] } })),
    FILE_HEALTH_HISTORY_ONLY_SNAPSHOT);
});

test('fileHealth: size factor isolated — codeLines against the saturating threshold', () => {
  const structure = [
    { file: 'scripts/core.mjs', lines: 260, codeLines: 200, maxNestingDepth: 0, avgNestingDepth: 0, functionCount: 9, longestFunctionLines: 0 },
    { file: 'scripts/util.mjs', lines: 900, codeLines: 800, maxNestingDepth: 0, avgNestingDepth: 0, functionCount: 40, longestFunctionLines: 0 }
  ];
  const result = fileHealth(structureFixture(), { now: NOW, structure });
  const sizeOf = (name) => result.files.find((f) => f.file === name).factors.find((x) => x.name === 'size');
  // 200 of a 400 saturation → 0.5; 800 saturates at 1.0 (never above)
  assert.equal(sizeOf('scripts/core.mjs').raw, 0.5);
  assert.equal(sizeOf('scripts/util.mjs').raw, 1);
  assert.equal(sizeOf('scripts/core.mjs').weight, FILE_HEALTH_STRUCTURE_WEIGHTS.size);
  assert.match(sizeOf('scripts/core.mjs').evidence, /200 code line\(s\) of 260 across 9 function\(s\)/);
  assert.match(sizeOf('scripts/core.mjs').evidence, /saturates at 400/);
  // leaf.mjs has NO structure entry → no structural factors at all for that row
  const leaf = result.files.find((f) => f.file === 'scripts/leaf.mjs');
  assert.equal(leaf.factors.length, 4);
  assert.deepEqual(leaf.factors.map((f) => f.name), [...HISTORY_FACTORS]);
  // params record what was supplied
  assert.equal(result.params.structure.measuredFiles, 2);
  assert.equal(result.params.structure.graphNodes, 0);
  assert.deepEqual(result.params.structure.weights, { ...FILE_HEALTH_STRUCTURE_WEIGHTS });
});

test('fileHealth: nesting factor isolated — maxNestingDepth against the saturating threshold', () => {
  const structure = new Map([
    ['scripts/core.mjs', { file: 'scripts/core.mjs', lines: 10, codeLines: 0, maxNestingDepth: 3, avgNestingDepth: 1.5, longestFunctionLines: 40 }],
    ['scripts/util.mjs', { file: 'scripts/util.mjs', lines: 10, codeLines: 0, maxNestingDepth: 12, avgNestingDepth: 6, longestFunctionLines: 0 }]
  ]);
  const result = fileHealth(structureFixture(), { now: NOW, structure });
  const nestOf = (name) => result.files.find((f) => f.file === name).factors.find((x) => x.name === 'nesting');
  assert.equal(nestOf('scripts/core.mjs').raw, 0.5); // 3 of a 6 saturation
  assert.equal(nestOf('scripts/util.mjs').raw, 1); // clamped, never 2.0
  assert.match(nestOf('scripts/core.mjs').evidence, /max nesting depth 3 \(avg 1\.5, longest function 40 lines/);
  assert.equal(FILE_HEALTH_STRUCTURE_SATURATION.nestingDepth, 6);
});

test('fileHealth: coupling factor isolated — fanIn + fanOut from the import graph', () => {
  const graph = {
    nodes: [
      { file: 'scripts/core.mjs', imports: 4, importedBy: 6 }, // degree 10 of 20 → 0.5
      { file: 'scripts/util.mjs', imports: 0, importedBy: 40 }, // degree 40 → saturated
      { file: 'scripts/leaf.mjs', imports: 0, importedBy: 0 } // degree 0 → 0, still reported
    ]
  };
  const result = fileHealth(structureFixture(), { now: NOW, graph });
  const coupOf = (name) => result.files.find((f) => f.file === name).factors.find((x) => x.name === 'coupling');
  assert.equal(coupOf('scripts/core.mjs').raw, 0.5);
  assert.equal(coupOf('scripts/util.mjs').raw, 1);
  assert.equal(coupOf('scripts/leaf.mjs').raw, 0);
  assert.match(coupOf('scripts/core.mjs').evidence, /6 file\(s\) import this, it imports 4 — degree 10/);
  // the SUM is the hazard: a pure sink and a pure hub of the same degree score alike
  assert.equal(result.params.structure.graphNodes, 3);
  assert.equal(result.params.structure.measuredFiles, 0);
});

test('fileHealth: structural factors renormalize the score, they do not inflate it', () => {
  const base = fileHealth(structureFixture(), { now: NOW });
  const core = base.files.find((f) => f.file === 'scripts/core.mjs');
  // all three structural factors at raw 0 must LOWER the score (more weight, no
  // extra danger) — proof that the score normalizes over the factors present
  const withZeros = fileHealth(structureFixture(), {
    now: NOW,
    structure: [{ file: 'scripts/core.mjs', lines: 1, codeLines: 0, maxNestingDepth: 0, avgNestingDepth: 0 }],
    graph: { nodes: [{ file: 'scripts/core.mjs', imports: 0, importedBy: 0 }] }
  });
  const zeroed = withZeros.files.find((f) => f.file === 'scripts/core.mjs');
  assert.equal(zeroed.factors.length, 7);
  assert.ok(zeroed.score < core.score, `${zeroed.score} should be below ${core.score}`);
  // and all three saturated must raise it
  const withMax = fileHealth(structureFixture(), {
    now: NOW,
    structure: [{ file: 'scripts/core.mjs', lines: 9999, codeLines: 9999, maxNestingDepth: 99, avgNestingDepth: 9 }],
    graph: { nodes: [{ file: 'scripts/core.mjs', imports: 99, importedBy: 99 }] }
  });
  assert.ok(withMax.files.find((f) => f.file === 'scripts/core.mjs').score > core.score);
  // structure weights are overridable like every other weight
  const tuned = fileHealth(structureFixture(), {
    now: NOW,
    weights: { churnPercentile: 0, coChangeScatter: 0, busFactor: 0, fixDensity: 0 },
    structureWeights: { size: 1, nesting: 0, coupling: 0 },
    structure: [{ file: 'scripts/core.mjs', lines: 999, codeLines: 999, maxNestingDepth: 0, avgNestingDepth: 0 }]
  });
  assert.equal(tuned.files.find((f) => f.file === 'scripts/core.mjs').score, 10);
});

test('fileHealth: structure input accepts a measureFiles() result, a map, and an array alike', () => {
  const measures = [{ file: 'scripts/core.mjs', lines: 500, codeLines: 400, maxNestingDepth: 6, avgNestingDepth: 2 }];
  const asArray = fileHealth(structureFixture(), { now: NOW, structure: measures });
  const asWrapped = fileHealth(structureFixture(), { now: NOW, structure: { files: measures, skipped: [] } });
  const asMap = fileHealth(structureFixture(), { now: NOW, structure: new Map([['scripts/core.mjs', measures[0]]]) });
  const asObject = fileHealth(structureFixture(), { now: NOW, structure: { 'scripts/core.mjs': measures[0] } });
  assert.equal(JSON.stringify(asArray), JSON.stringify(asWrapped));
  assert.equal(JSON.stringify(asArray), JSON.stringify(asMap));
  assert.equal(JSON.stringify(asArray), JSON.stringify(asObject));
  // determinism with structure in play
  assert.equal(JSON.stringify(asArray), JSON.stringify(fileHealth(structureFixture(), { now: NOW, structure: measures })));
});

// ---------------------------------------------------------------------------
// calibrateFileHealth — per-factor discrimination
// ---------------------------------------------------------------------------

test('calibrateFileHealth: reports AUC per factor next to the combined AUC', () => {
  // horizon 30 puts the cut at day 30: hot.js (fixed on day 40) is the only
  // defective file, calm.js and quiet.js are the clean controls.
  const result = calibrateFileHealth(healthCalFixture(), { horizonDays: 30 });
  assert.deepEqual(result.perFactor.map((f) => f.name), [...HISTORY_FACTORS]);
  assert.ok(result.perFactor.every((f) => f.kind === 'history'));
  assert.ok(result.perFactor.every((f) => f.evaluated === result.evaluated));
  // a factor with the same raw for every file cannot discriminate → AUC 0.5
  const bus = result.perFactor.find((f) => f.name === 'bus-factor');
  assert.equal(bus.auc, 0.5);
  // churn separates the fixed file from the clean one perfectly on this fixture
  assert.equal(result.perFactor.find((f) => f.name === 'churn-percentile').auc, 1);
  // without structural input the comparison degenerates cleanly, no fake delta
  assert.equal(result.historyOnlyAuc, result.auc);
  assert.equal(result.structureOnlyAuc, null);
  assert.equal(result.structureDelta, null);
  assert.equal(result.structureCaveat, undefined);
  assert.equal(result.comparison.files, result.evaluated);
  assert.match(result.comparison.basis, /no structural factors supplied/);
});

test('calibrateFileHealth: with structure, the delta is measured on ONE population and caveated', () => {
  const commits = healthCalFixture();
  const structure = [
    // hot.js is the file that gets fixed after the cut — make it the big one
    { file: 'hot.js', lines: 900, codeLines: 800, maxNestingDepth: 9, avgNestingDepth: 3 },
    { file: 'calm.js', lines: 60, codeLines: 40, maxNestingDepth: 1, avgNestingDepth: 0.5 }
  ];
  const graph = { nodes: [{ file: 'hot.js', imports: 10, importedBy: 20 }, { file: 'calm.js', imports: 0, importedBy: 1 }] };
  const result = calibrateFileHealth(commits, { horizonDays: 30, structure, graph });

  assert.deepEqual(result.perFactor.map((f) => f.name), [...HISTORY_FACTORS, ...STRUCTURE_FACTORS]);
  assert.deepEqual(
    result.perFactor.filter((f) => f.kind === 'structure').map((f) => f.name),
    [...STRUCTURE_FACTORS]);
  // structure alone ranks hot.js above calm.js here → perfect separation
  assert.equal(result.structureOnlyAuc, 1);
  assert.equal(typeof result.structureDelta, 'number');
  // the comparison is restricted to files that actually carry structure factors
  assert.equal(result.comparison.files, 2);
  assert.match(result.comparison.basis, /same population on both sides/);
  assert.equal(result.comparison.delta, result.structureDelta);
  // the leakage caveat is mandatory whenever structure took part
  assert.match(result.structureCaveat, /CURRENT working tree/);
  assert.match(result.verdict, /structure/);
  // determinism
  assert.equal(JSON.stringify(result),
    JSON.stringify(calibrateFileHealth(healthCalFixture(), { horizonDays: 30, structure, graph })));
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
  // 6.2 -> 5 when bus-factor dropped to weight 0 (AUC 0.50 on two repos);
  // the defect labels and the AUC-beats-random invariant are unchanged.
  assert.equal(byFile.get('hot.js').score, 5);
  assert.equal(byFile.get('hot.js').defective, true);
  assert.equal(byFile.get('hot.js').fixedBy, 'F1');
  assert.equal(byFile.get('calm.js').defective, false);
  assert.equal(byFile.get('quiet.js').defective, false);
  assert.equal(result.defective, 1);
  // the planted structure separates perfectly → AUC 1
  assert.equal(result.auc, 1);
  assert.ok(result.auc > 0.5);
  assert.match(result.verdict, /AUC 1\.00 over 3 files/);
  // The RANKING is right (AUC 1 above) and the verdict must still refuse to
  // endorse it: one positive cannot establish anything. This fixture used to
  // assert "gate met" — the same overclaim a colleague's repo produced in the
  // field, where a single fixed file yielded "the health ranking is defensible
  // on this repo". Correct number, false sentence.
  assert.equal(result.sufficientEvidence, false);
  assert.equal(result.minPositives, 10);
  assert.match(result.verdict, /only 1 fixed file\(s\)/);
  assert.match(result.verdict, /do NOT cite this number/);
  assert.doesNotMatch(result.verdict, /gate \(0\.6\) met/);
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
  // Values shifted when bus-factor went to weight 0 (AUC 0.50 on two repos);
  // the ORDER and the lowConfidence flags below are the real invariants.
  assert.deepEqual(parsed.files.map((f) => f.score), [4.3, 3, 1.3]);
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

/**
 * Scripted repo with PLANTED STRUCTURE (not just history): one oversized,
 * deeply nested file, one hub imported by 22 modules, and a two-file import
 * cycle — so every refactorPlan rule has something real to fire on.
 */
function bigJsSource() {
  const lines = ['export function giant(input) {'];
  for (let i = 0; i < 70; i++) lines.push(`  const v${i} = input + ${i};`);
  lines.push('  if (input) {', '    if (input > 1) {', '      if (input > 2) {',
    '        if (input > 3) {', '          if (input > 4) {', '            return v0;',
    '          }', '        }', '      }', '    }', '  }', '  return 0;', '}');
  for (let i = 0; i < 15; i++) {
    lines.push(`export function helper${i}(a) {`);
    for (let k = 0; k < 20; k++) lines.push(`  const t${k} = a + ${k};`);
    lines.push('  return a;', '}');
  }
  return lines.join('\n') + '\n';
}

function makeStructureRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-intel-struct-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  const write = (rel, text) => fs.writeFileSync(path.join(cwd, rel), text);
  write('big.js', bigJsSource());
  write('hub.js', 'export const HUB = 1;\n');
  for (let i = 0; i < 22; i++) {
    write(`u${i}.js`, `import { HUB } from './hub.js';\nexport const u${i} = HUB;\n`);
  }
  write('cycA.js', "import { b } from './cycB.js';\nexport const a = b;\n");
  write('cycB.js', "import { a } from './cycA.js';\nexport const b = a;\n");
  const dates = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'];
  dates.forEach((date, i) => {
    fs.appendFileSync(path.join(cwd, 'big.js'), `// touch ${i}\n`);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', `feat: structure ${i}`],
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  });
  return cwd;
}

test('brain-intel.mjs health --structure: structural columns and factors, opt-in only', () => {
  const cwd = makeStructureRepo();
  const nowFlag = ['--now', '2026-03-01T00:00:00Z'];

  // default stays history-only: no structural factor, no structure block
  const plain = JSON.parse(runIntel(cwd, ['health', '--json', ...nowFlag]).stdout);
  assert.ok(plain.files.every((f) => f.factors.length === 4));
  assert.equal(plain.params.structure, undefined);
  assert.equal(plain.files[0].structure, undefined);
  assert.equal(plain.structureNote, undefined);

  const r = runIntel(cwd, ['health', '--structure', '--json', ...nowFlag]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  const byFile = new Map(parsed.files.map((f) => [f.file, f]));
  const big = byFile.get('big.js');
  assert.deepEqual(big.factors.map((f) => f.name), [...HISTORY_FACTORS, ...STRUCTURE_FACTORS]);
  assert.equal(big.structure.maxNestingDepth, 6);
  assert.equal(big.structure.functionCount, 16);
  assert.ok(big.structure.codeLines >= 400);
  assert.equal(byFile.get('hub.js').graph.fanIn, 22);
  assert.equal(byFile.get('u0.js').graph.fanOut, 1);
  assert.match(parsed.structureNote, /shape metrics, not semantics/);
  assert.equal(parsed.params.structure.weights.size, FILE_HEALTH_STRUCTURE_WEIGHTS.size);

  // human table gains the structural columns
  const human = runIntel(cwd, ['health', '--structure', '--limit', '30', ...nowFlag]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /LINES\s+DEPTH\s+IN\/OUT/);
  assert.match(human.stdout, /Structure: \d+ file\(s\) measured, \d+ import edge\(s\)/);
  assert.match(human.stdout.trim().split('\n').at(-1), /^→ /);

  // byte-determinism as a CLI contract, structure included
  assert.equal(r.stdout, runIntel(cwd, ['health', '--structure', '--json', ...nowFlag]).stdout);
  // read-only discipline holds
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain')), false);
});

test('brain-intel.mjs health --plans: named moves with the number that fired them', () => {
  const cwd = makeStructureRepo();
  const nowFlag = ['--now', '2026-03-01T00:00:00Z'];
  const r = runIntel(cwd, ['health', '--plans', '--json', '--limit', '30', ...nowFlag]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  const plansOf = (file) => parsed.files.find((f) => f.file === file).plans;

  // --plans implies --structure: the measurements the moves rest on are present
  assert.ok(parsed.files.every((f) => Array.isArray(f.plans)));
  assert.ok(parsed.params.structure);

  const bigMoves = plansOf('big.js');
  const split = bigMoves.find((p) => p.move === 'split-file');
  assert.match(split.why, /code lines across 16 functions — split by responsibility/);
  assert.match(split.evidence, /codeLines \d+ ≥ 400, functions 16 ≥ 12/);
  assert.ok(bigMoves.some((p) => p.move === 'reduce-nesting'));
  assert.ok(bigMoves.some((p) => p.move === 'extract-function'));

  const hubMoves = plansOf('hub.js');
  const fanIn = hubMoves.find((p) => p.move === 'reduce-fan-in');
  assert.match(fanIn.why, /^22 file\(s\) import this/);
  assert.equal(fanIn.evidence, 'fanIn 22 ≥ 20');

  const cycle = plansOf('cycA.js').find((p) => p.move === 'break-cycle');
  assert.equal(cycle.evidence, 'cycle: cycA.js → cycB.js → cycA.js');

  // silence where nothing fires: a two-line importer gets no shape advice
  const leafMoves = plansOf('u0.js');
  assert.equal(leafMoves.some((p) => ['split-file', 'reduce-nesting', 'extract-function', 'reduce-fan-in'].includes(p.move)), false);

  // the mandatory action line becomes the MOVE, not a restatement of the score
  assert.match(parsed.nextAction, /^→ \S+ scores \d/);
  assert.match(parsed.nextAction, /(split-file|reduce-nesting|reduce-fan-in|break-cycle|extract-function|add-tests|add-owner):/);

  const human = runIntel(cwd, ['health', '--plans', '--limit', '30', ...nowFlag]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Refactor plans \(top \d+ by danger/);
  assert.match(human.stdout, /· split-file/);
  assert.match(human.stdout, /· break-cycle/);
  assert.equal(r.stdout, runIntel(cwd, ['health', '--plans', '--json', '--limit', '30', ...nowFlag]).stdout);
});

test('brain-intel.mjs health-calibrate: per-factor AUC table, with and without structure', () => {
  const cwd = makeHealthCalRepo();

  const plain = JSON.parse(runIntel(cwd, ['health-calibrate', '--json', '--horizon-days', '14']).stdout);
  assert.deepEqual(plain.perFactor.map((f) => f.name), [...HISTORY_FACTORS]);
  assert.ok(plain.perFactor.every((f) => f.kind === 'history'));
  assert.equal(plain.structureDelta, null);
  assert.equal(plain.structureCaveat, undefined);

  const r = runIntel(cwd, ['health-calibrate', '--structure', '--json', '--horizon-days', '14']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.perFactor.map((f) => f.name), [...HISTORY_FACTORS, ...STRUCTURE_FACTORS]);
  assert.ok(parsed.comparison.files > 0);
  assert.match(parsed.comparison.basis, /same population on both sides/);
  assert.match(parsed.structureCaveat, /upper bound/);

  const human = runIntel(cwd, ['health-calibrate', '--structure', '--horizon-days', '14']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Per-factor discrimination \(AUC of each factor ALONE/);
  assert.match(human.stdout, /FACTOR\s+KIND\s+WEIGHT\s+FILES\s+AUC/);
  assert.match(human.stdout, /NOT directly comparable/);
  assert.match(human.stdout, /Same-population comparison/);
  assert.match(human.stdout.trim().split('\n').at(-1), /^AUC /);
  // byte-determinism (no clock enters health-calibrate)
  assert.equal(r.stdout, runIntel(cwd, ['health-calibrate', '--structure', '--json', '--horizon-days', '14']).stdout);
});

test('brain-intel.mjs --help documents the structural flags', () => {
  const cwd = makeFixtureRepo();
  const help = runIntel(cwd, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--structure/);
  assert.match(help.stdout, /--plans/);
  assert.match(help.stdout, /Implies --structure/);
});

/* ---------------------------------------------------------------------------
 * Calibration power + the short-history diagnosis.
 *
 * Both defects were found by running health-calibrate across a colleague's
 * workspace of 23 unrelated repos. Small repos are the common case out there,
 * and both failures were confident, well-formatted, and wrong.
 * ------------------------------------------------------------------------ */

/** 12 files fixed after the cut, 12 clean — enough positives for the gate. */
function poweredFixture() {
  const log = [];
  for (let i = 0; i < 12; i++) {
    // churned + repeatedly fixed before the cut → high score
    log.push(hCal(`d${i}a`, 0 + i % 5, `feat: dirty ${i}`, [`dirty${i}.js`]));
    log.push(hCal(`d${i}b`, 2 + i % 5, `fix: dirty ${i}`, [`dirty${i}.js`]));
    log.push(hCal(`d${i}c`, 4 + i % 5, `feat: dirty ${i} again`, [`dirty${i}.js`]));
    // touched once before the cut → low score
    log.push(hCal(`k${i}`, 6 + i % 5, `feat: kalm ${i}`, [`kalm${i}.js`]));
    // the label: each dirty file is fixed again after the cut
    log.push(hCal(`F${i}`, 40, `fix: dirty ${i} exploded`, [`dirty${i}.js`]));
  }
  log.push(hCal('Z1', 60, 'chore: close observation window', ['closer.js']));
  return log;
}

test('calibrateFileHealth: the gate opens once there are enough fixed files', () => {
  const r = calibrateFileHealth(poweredFixture(), { horizonDays: 30 });
  assert.equal(r.defective, 12);
  assert.ok(r.defective >= r.minPositives, 'fixture must clear the power bar');
  assert.equal(r.sufficientEvidence, true);
  assert.ok(r.auc >= 0.6, `expected a separating fixture, got AUC ${r.auc}`);
  assert.match(r.verdict, /gate \(0\.6\) met/);
  assert.doesNotMatch(r.verdict, /do NOT cite/);
});

test('calibrateFileHealth: a repo younger than the horizon is told the real reason', () => {
  // Every commit inside a 10-day span, evaluated at a 30-day horizon → the cut
  // lands before the first commit, so there is no pre-cut period to score from.
  const log = [
    hCal('a1', 0, 'feat: one', ['a.js']),
    hCal('a2', 3, 'fix: two', ['a.js']),
    hCal('b1', 6, 'feat: three', ['b.js']),
    hCal('b2', 10, 'fix: four', ['b.js'])
  ];
  const r = calibrateFileHealth(log, { horizonDays: 30 });
  assert.equal(r.evaluated, 0);
  assert.equal(r.auc, null);
  assert.equal(r.sufficientEvidence, false);
  assert.equal(r.historySpanDays, 10);
  // The remedy must be the true one. It used to say "need both fixed and clean
  // files after the cut", sending the reader off to wait for fix commits —
  // which would never have helped, since the problem is upstream of labelling.
  assert.match(r.verdict, /shorter than the 30-day horizon/);
  assert.match(r.verdict, /--horizon-days/);
  assert.match(r.verdict, /more fix commits will NOT help/);

  // Same log, a horizon that fits inside the history → the real path runs.
  const ok = calibrateFileHealth(log, { horizonDays: 5 });
  assert.ok(ok.evaluated > 0, 'a horizon inside the span must produce rows');
  assert.doesNotMatch(ok.verdict, /shorter than the/);
});

test('calibrateFileHealth: an empty log still reports the label-variety reason', () => {
  const r = calibrateFileHealth([], { horizonDays: 30 });
  assert.equal(r.evaluated, 0);
  assert.equal(r.historySpanDays, 0);
  assert.match(r.verdict, /need both fixed and clean files/);
  assert.doesNotMatch(r.verdict, /shorter than the/);
});

test('calibrateFileHealth: scarcity of CLEAN files is underpowered too', () => {
  // The mirror image of the one-fixed-file case, taken from a repo where 34 of
  // 43 files were fixed after the cut: plenty of positives, almost no negatives.
  // The ranking has only a handful of clean files to be right about, so the
  // number is exactly as fragile — the gate must refuse it from both sides.
  const log = [];
  for (let i = 0; i < 14; i++) {
    log.push(hCal(`p${i}a`, i % 6, `feat: p${i}`, [`p${i}.js`]));
    log.push(hCal(`p${i}b`, 6 + i % 6, `feat: p${i} more`, [`p${i}.js`]));
    log.push(hCal(`F${i}`, 40, `fix: p${i} after the cut`, [`p${i}.js`]));
  }
  // Two lonely clean files.
  log.push(hCal('n1', 3, 'feat: clean one', ['clean1.js']));
  log.push(hCal('n2', 4, 'feat: clean two', ['clean2.js']));
  log.push(hCal('Z1', 60, 'chore: close observation window', ['closer.js']));

  const r = calibrateFileHealth(log, { horizonDays: 30 });
  assert.equal(r.defective, 14, 'fixture must have plenty of positives');
  assert.equal(r.evaluated - r.defective, 2, 'and almost no negatives');
  assert.ok(r.defective >= r.minPositives, 'positives alone would have passed the old gate');
  assert.equal(r.minorityClass, 2);
  assert.equal(r.sufficientEvidence, false);
  assert.match(r.verdict, /unfixed file\(s\) — nearly everything here was fixed/);
  assert.doesNotMatch(r.verdict, /gate \(0\.6\) met/);
});
