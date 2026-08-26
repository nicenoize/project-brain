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
  leaseTargetMatches,
  RISK_WEIGHTS,
  RISK_SATURATION,
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
      })
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
