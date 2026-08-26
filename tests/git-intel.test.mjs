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
  riskFactors
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

test('parseLog: parses hash, author, dateIso, files from the delimited stream', () => {
  const raw =
    `${RS}aaa111${FS}Jane Dev${FS}2026-06-21T10:00:00+00:00--FILES--\n` +
    'scripts/a.mjs\nscripts/b.mjs\n' +
    `${RS}bbb222${FS}Bob Builder${FS}2026-06-20T09:30:00+00:00--FILES--\n`;
  const commits = parseLog(raw);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    hash: 'aaa111',
    author: 'Jane Dev',
    dateIso: '2026-06-21T10:00:00+00:00',
    files: ['scripts/a.mjs', 'scripts/b.mjs']
  });
  // merge-style commit: no files under --name-only
  assert.deepEqual(commits[1].files, []);
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
      })
    });
  };
  // Fixtures are rebuilt from scratch on each call — only the values match.
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
});
