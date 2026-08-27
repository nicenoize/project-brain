/**
 * brain:release tests — the version-tagging + comparison layer.
 *
 * Two halves, deliberately separated:
 *   - PURE: the statistics adapter, the comparison verdicts, the semver
 *     derivation and the export-surface diff are exported functions, driven
 *     directly with hand-built data. No git, no clock, no spawning.
 *   - END-TO-END: everything that touches git runs against a throwaway
 *     `fs.mkdtempSync` repo, spawned with BRAIN_ROOT pointed at it. This suite
 *     NEVER creates a tag in this repo — a tag here is a published artifact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_VERSION,
  SNAPSHOT_MARKER,
  applyBump,
  buildTagMessage,
  compareSnapshots,
  deriveBump,
  detectCandidateBreaks,
  flattenBench,
  getPath,
  groupChangelog,
  headline,
  machineMatch,
  pairedMeanCI,
  parseConventionalSubject,
  parseTagMessage,
  percentileOf,
  reconcileBump,
  scanExports
} from '../scripts/brain-release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'scripts', 'brain-release.mjs');
const NOW = '2026-08-14T12:00:00.000Z';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function run(args, cwd, extraEnv = {}) {
  const env = { ...process.env, BRAIN_ROOT: cwd, ...extraEnv };
  delete env.GITHUB_BASE_REF;
  delete env.GITHUB_HEAD_REF;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env });
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/** Throwaway git repo with two source files and a couple of commits. */
function makeRepo({ pkg = null } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-release-'));
  git(['init', '--quiet', '-b', 'main'], cwd);
  git(['config', 'user.email', 't@example.com'], cwd);
  git(['config', 'user.name', 'Tester'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
  git(['config', 'tag.gpgsign', 'false'], cwd);
  if (pkg) fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(cwd, 'a.mjs'), 'export function foo() { return 1; }\nexport const KEEP = 2;\n');
  fs.writeFileSync(path.join(cwd, 'b.mjs'), "import { foo } from './a.mjs';\nexport function useFoo() { return foo(); }\n");
  git(['add', '-A'], cwd);
  commit(cwd, 'feat(core): initial modules');
  fs.appendFileSync(path.join(cwd, 'a.mjs'), '// touch\n');
  git(['add', '-A'], cwd);
  commit(cwd, 'fix(core): tidy a');
  return cwd;
}

function commit(cwd, subject, body = '') {
  const args = ['commit', '--quiet', '-m', subject];
  if (body) args.push('-m', body);
  git(args, cwd);
}

/** Minimal but structurally complete snapshot for the pure comparison tests. */
function fakeSnapshot(over = {}) {
  return {
    schema: SCHEMA_VERSION,
    version: 'v1',
    commit: 'a'.repeat(40),
    date: NOW,
    node: 'v20.0.0',
    platform: 'linux-x64',
    danger: { top10: [], median: 3, p90: 6, files: 10 },
    calibration: {
      fileHealth: { auc: 0.5, files: 100, positives: 10 },
      risk: { auc: 0.5, commits: 100, positives: 10 },
      lintRank: null
    },
    graph: { files: 10, edges: 20, cycles: 1, cyclesTruncated: false, orphans: 2, unresolvedRatio: 0.1 },
    structure: { files: 10, totalCodeLines: 1000, filesOverSplitThreshold: 1, maxNesting: 5, longestFunction: 40, splitThreshold: 400 },
    tests: { files: 10, wallClockMs: 1000 },
    bench: null,
    budgets: { skillBytes: 12000 },
    provenance: { tool: 'brain-release', schema: SCHEMA_VERSION, dirty: false, cpu: 'Test CPU', cores: 8, degraded: {} },
    caveats: [],
    ...over
  };
}

function dangerPair(files, scores) {
  return { top10: files.map((f, i) => ({ file: f, score: scores[i] })), median: 5, p90: 8, files: files.length };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('percentileOf is nearest-rank and total', () => {
  assert.equal(percentileOf([], 0.5), null);
  assert.equal(percentileOf([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentileOf([5], 0.9), 5);
});

test('getPath walks dotted paths and never throws on a missing hop', () => {
  assert.equal(getPath({ a: { b: 1 } }, 'a.b'), 1);
  assert.equal(getPath({ a: null }, 'a.b.c'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
});

test('pairedMeanCI delegates to the shared bootstrap and returns a usable CI', () => {
  const stats = pairedMeanCI([8, 8, 8, 8], [5, 5, 5, 5]);
  assert.equal(stats.delta, -3);
  assert.deepEqual(stats.ci95, [-3, -3]);
  assert.equal(stats.significant, true);
  assert.equal(stats.cases, 4);
  // Deterministic: same seed, same numbers.
  assert.deepEqual(pairedMeanCI([8, 8, 8, 8], [5, 5, 5, 5]).ci95, stats.ci95);
});

test('flattenBench flattens numeric leaves deterministically', () => {
  const rows = flattenBench({ search: { p50: 10, p95: 20 }, label: 'x', index: 5 });
  assert.deepEqual(rows.map((r) => r.metric), ['bench.index', 'bench.search.p50', 'bench.search.p95']);
});

// ---------------------------------------------------------------------------
// tag message round-trip
// ---------------------------------------------------------------------------

test('buildTagMessage round-trips through parseTagMessage', () => {
  const snap = fakeSnapshot();
  const message = buildTagMessage(snap, { name: 'v1.2.3', message: 'hello' });
  assert.ok(message.includes(SNAPSHOT_MARKER));
  assert.ok(message.includes('hello'));
  assert.deepEqual(parseTagMessage(message), snap);
});

test('parseTagMessage returns null for a message without a snapshot', () => {
  assert.equal(parseTagMessage('just a normal tag message'), null);
  assert.equal(parseTagMessage(`${SNAPSHOT_MARKER}\nnot json`), null);
  assert.equal(parseTagMessage(''), null);
});

test('headline flags a dirty snapshot', () => {
  assert.ok(!headline(fakeSnapshot()).includes('DIRTY'));
  const dirty = fakeSnapshot({ provenance: { dirty: true, degraded: {} } });
  assert.ok(headline(dirty).includes('DIRTY'));
});

// ---------------------------------------------------------------------------
// compare — the honesty rules
// ---------------------------------------------------------------------------

test('compare reports BETTER only when the paired-bootstrap CI excludes 0', () => {
  const files = ['x.js', 'y.js', 'z.js', 'w.js'];
  const a = fakeSnapshot({ danger: dangerPair(files, [8, 8, 8, 8]) });
  const b = fakeSnapshot({ danger: dangerPair(files, [5, 5, 5, 5]) });
  const report = compareSnapshots(a, b);
  const row = report.metrics.find((m) => m.metric === 'danger.top10.meanScore');
  assert.equal(row.evidence, 'paired-bootstrap');
  assert.equal(row.significant, true);
  assert.equal(row.verdict, 'better');
  assert.equal(report.verdict, 'better');
  assert.match(report.headline, /BETTER/);
});

test('compare reports WORSE when danger rises with a CI that excludes 0', () => {
  const files = ['x.js', 'y.js', 'z.js', 'w.js'];
  const a = fakeSnapshot({ danger: dangerPair(files, [4, 4, 4, 4]) });
  const b = fakeSnapshot({ danger: dangerPair(files, [7, 7, 7, 7]) });
  const report = compareSnapshots(a, b);
  assert.equal(report.verdict, 'worse');
  assert.match(report.headline, /WORSE/);
});

test('compare defaults to INDISTINGUISHABLE when the CI includes 0', () => {
  const files = ['x.js', 'y.js', 'z.js', 'w.js', 'v.js', 'u.js'];
  const a = fakeSnapshot({ danger: dangerPair(files, [5, 6, 7, 8, 9, 4]) });
  const b = fakeSnapshot({ danger: dangerPair(files, [6, 5, 8, 7, 8, 5]) });
  const report = compareSnapshots(a, b);
  const row = report.metrics.find((m) => m.metric === 'danger.top10.meanScore');
  assert.equal(row.significant, false);
  assert.equal(row.verdict, 'indistinguishable');
  assert.equal(report.verdict, 'indistinguishable');
  assert.match(report.headline, /INDISTINGUISHABLE/);
});

test('a moved scalar is an unverified-change, never significant without a CI', () => {
  const a = fakeSnapshot();
  const b = fakeSnapshot({
    calibration: { fileHealth: { auc: 0.9, files: 100, positives: 10 }, risk: { auc: 0.5, commits: 100, positives: 10 }, lintRank: null }
  });
  const report = compareSnapshots(a, b);
  const row = report.metrics.find((m) => m.metric === 'calibration.fileHealth.auc');
  assert.equal(row.evidence, 'raw-delta');
  assert.equal(row.delta, 0.4);
  assert.equal(row.verdict, 'unverified-change');
  assert.equal(row.significant, undefined);
  assert.match(row.note, /RAW DELTA/);
  // A big AUC jump still does not make the overall verdict "better".
  assert.equal(report.verdict, 'indistinguishable');
  assert.equal(report.summary.unverifiedChanges >= 1, true);
});

test('timing deltas across machines are not-comparable, not a number', () => {
  const a = fakeSnapshot();
  const b = fakeSnapshot({ platform: 'darwin-arm64', tests: { files: 10, wallClockMs: 250 } });
  const mismatch = machineMatch(a, b);
  assert.equal(mismatch.comparable, false);
  const report = compareSnapshots(a, b);
  const row = report.metrics.find((m) => m.metric === 'tests.wallClockMs');
  assert.equal(row.evidence, 'not-comparable');
  assert.equal(row.verdict, 'not-comparable');
  assert.equal(row.delta, null);
  assert.match(row.note, /different machines/);
});

test('timing deltas ARE compared when the machine matches', () => {
  const a = fakeSnapshot();
  const b = fakeSnapshot({ tests: { files: 10, wallClockMs: 250 } });
  const row = compareSnapshots(a, b).metrics.find((m) => m.metric === 'tests.wallClockMs');
  assert.equal(row.evidence, 'raw-delta');
  assert.equal(row.delta, -750);
});

test('a null sub-block is MISSING with its recorded reason, never zero', () => {
  const a = fakeSnapshot();
  const b = fakeSnapshot({
    graph: null,
    provenance: { dirty: false, cpu: 'Test CPU', degraded: { graph: 'git ls-files failed' } }
  });
  const report = compareSnapshots(a, b);
  const row = report.metrics.find((m) => m.metric === 'graph.cycles');
  assert.equal(row.evidence, 'missing');
  assert.equal(row.verdict, 'missing');
  assert.equal(row.delta, null);
  assert.match(row.note, /MISSING, not as zero/);
  assert.match(row.note, /git ls-files failed/);
  assert.equal(report.summary.missing > 0, true);
});

test('a degradation reason keyed by a DOTTED block path still reaches the output', () => {
  const withLint = fakeSnapshot({
    calibration: {
      fileHealth: { auc: 0.5, files: 100, positives: 10 },
      risk: { auc: 0.5, commits: 100, positives: 10 },
      lintRank: { auc: 0.48, severityBaseline: 0.44, advantage: 0.04, findings: 400, files: 60, positives: 9 }
    }
  });
  const without = fakeSnapshot({
    provenance: { dirty: false, cpu: 'Test CPU', degraded: { 'calibration.lintRank': 'no linter configured' } }
  });
  const row = compareSnapshots(withLint, without).metrics.find((m) => m.metric === 'calibration.lintRank.auc');
  assert.equal(row.verdict, 'missing');
  assert.match(row.note, /no linter configured/);
});

test('too few shared danger files means no CI and therefore no claim', () => {
  const a = fakeSnapshot({ danger: dangerPair(['x.js', 'q.js'], [8, 8]) });
  const b = fakeSnapshot({ danger: dangerPair(['x.js', 'r.js'], [2, 2]) });
  const row = compareSnapshots(a, b).metrics.find((m) => m.metric === 'danger.top10.meanScore');
  assert.equal(row.evidence, 'insufficient-pairs');
  assert.equal(row.verdict, 'indistinguishable');
  assert.equal(row.cases, 1);
});

// ---------------------------------------------------------------------------
// snapshot — shape, determinism, degradation
// ---------------------------------------------------------------------------

test('snapshot has the documented shape and exits 0', () => {
  const cwd = makeRepo();
  const r = run(['snapshot', '--json', '--now', NOW], cwd);
  assert.equal(r.status, 0, r.stderr);
  const snap = JSON.parse(r.stdout);
  assert.equal(snap.schema, SCHEMA_VERSION);
  assert.equal(snap.version, 'HEAD');
  assert.match(snap.commit, /^[0-9a-f]{40}$/);
  assert.equal(snap.date, NOW);
  assert.equal(snap.node, process.version);
  assert.ok(snap.danger.top10.length >= 1);
  assert.ok(typeof snap.danger.median === 'number');
  assert.ok(typeof snap.danger.p90 === 'number');
  assert.ok('fileHealth' in snap.calibration && 'risk' in snap.calibration && 'lintRank' in snap.calibration);
  assert.equal(snap.graph.files, 2);
  assert.equal(snap.graph.edges, 1);
  assert.equal(typeof snap.structure.totalCodeLines, 'number');
  assert.equal(snap.tests, null); // no tests/ dir in the fixture
  assert.equal(snap.bench, null);
  assert.equal(typeof snap.budgets.skillBytes, 'number');
  assert.ok(Array.isArray(snap.caveats));
  assert.match(r.stderr, /^Next: /m);
});

test('snapshot is byte-identical for the same tree and the same injected now', () => {
  const cwd = makeRepo();
  const first = run(['snapshot', '--json', '--now', NOW], cwd);
  const second = run(['snapshot', '--json', '--now', NOW], cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
});

test('every unavailable sub-block degrades to null with a stated reason', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-release-bare-'));
  const r = run(['snapshot', '--json', '--now', NOW], cwd);
  assert.equal(r.status, 0, r.stderr);
  const snap = JSON.parse(r.stdout);
  assert.equal(snap.danger, null);
  assert.equal(snap.graph, null);
  assert.equal(snap.structure, null);
  assert.equal(snap.calibration.fileHealth, null);
  assert.equal(snap.calibration.risk, null);
  assert.equal(snap.calibration.lintRank, null);
  assert.equal(snap.bench, null);
  for (const block of ['danger', 'graph', 'structure', 'calibration.fileHealth', 'calibration.risk', 'bench']) {
    assert.ok(snap.provenance.degraded[block], `expected a reason for ${block}`);
  }
  assert.ok(snap.caveats.some((c) => c.startsWith('danger: null —')));
});

test('snapshot --out writes the JSON to disk', () => {
  const cwd = makeRepo();
  const out = path.join(cwd, 'snap.json');
  const r = run(['snapshot', '--out', out, '--now', NOW], cwd);
  assert.equal(r.status, 0, r.stderr);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.date, NOW);
});

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

test('tag creates an ANNOTATED tag whose message parses back to the snapshot', () => {
  const cwd = makeRepo();
  const r = run(['tag', 'v0.1.0', '--message', 'first cut', '--json', '--now', NOW], cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(['cat-file', '-t', 'refs/tags/v0.1.0'], cwd).trim(), 'tag');
  const body = git(['tag', '-l', '--format=%(contents)', 'v0.1.0'], cwd);
  const parsed = parseTagMessage(body);
  assert.ok(parsed, 'tag message must carry a snapshot');
  assert.equal(parsed.date, NOW);
  assert.equal(parsed.schema, SCHEMA_VERSION);
  assert.ok(body.includes('first cut'));
  // What git stores is exactly what the command reported — the measurement
  // travels with the tag, byte for byte.
  assert.deepEqual(parsed, JSON.parse(r.stdout).snapshot);
  // And a fresh snapshot at the same commit now resolves `version` to the tag.
  const fresh = JSON.parse(run(['snapshot', '--json', '--now', NOW], cwd).stdout);
  assert.equal(fresh.version, 'v0.1.0');
  assert.equal(parsed.version, 'HEAD'); // taken before the tag existed
  assert.equal(fresh.commit, parsed.commit);
});

test('tag refuses a dirty tree, and records dirty: true under --allow-dirty', () => {
  const cwd = makeRepo();
  fs.writeFileSync(path.join(cwd, 'a.mjs'), 'export function foo() { return 99; }\n');
  const refused = run(['tag', 'v0.1.0', '--now', NOW], cwd);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /working tree is dirty/);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/tags/v0.1.0'], { cwd }).status !== 0, true);

  const allowed = run(['tag', 'v0.1.0', '--allow-dirty', '--json', '--now', NOW], cwd);
  assert.equal(allowed.status, 0, allowed.stderr);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.dirty, true);
  assert.equal(payload.snapshot.provenance.dirty, true);
  assert.equal(payload.roundTrip, true);
  assert.ok(payload.snapshot.caveats.some((c) => /DIRTY/.test(c)));
});

test('tag refuses to overwrite an existing tag', () => {
  const cwd = makeRepo();
  assert.equal(run(['tag', 'v0.1.0', '--now', NOW], cwd).status, 0);
  const again = run(['tag', 'v0.1.0', '--now', NOW], cwd);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test('tag rejects a suspicious tag name as a usage error', () => {
  const cwd = makeRepo();
  const r = run(['tag', '--now', NOW], cwd);
  assert.equal(r.status, 2);
});

// ---------------------------------------------------------------------------
// compare / list end-to-end
// ---------------------------------------------------------------------------

test('compare between a tag and HEAD says which side was recomputed', () => {
  const cwd = makeRepo();
  assert.equal(run(['tag', 'v0.1.0', '--now', NOW], cwd).status, 0);
  const r = run(['compare', 'v0.1.0', 'HEAD', '--json', '--now', NOW], cwd);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.a.source, 'tag');
  assert.equal(report.b.source, 'recomputed-at-HEAD');
  assert.equal(report.verdict, 'indistinguishable');
  assert.ok(report.caveats.some((c) => /RECOMPUTED/.test(c)));
});

test('compare refuses a ref that has neither a snapshot nor HEAD\'s commit', () => {
  const cwd = makeRepo();
  const older = git(['rev-parse', 'HEAD~1'], cwd).trim();
  const r = run(['compare', older, 'HEAD'], cwd);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot be reconstructed/);
});

test('list is newest-first and carries each snapshot headline', () => {
  const cwd = makeRepo();
  assert.equal(run(['tag', 'v0.1.0', '--now', '2026-01-01T00:00:00.000Z'], cwd).status, 0);
  assert.equal(run(['tag', 'v0.2.0', '--now', '2026-06-01T00:00:00.000Z'], cwd).status, 0);
  git(['tag', 'plain-lightweight'], cwd);
  const r = run(['list', '--json'], cwd);
  assert.equal(r.status, 0, r.stderr);
  const { tags } = JSON.parse(r.stdout);
  // Newest first by the SNAPSHOT's own date; the lightweight tag falls back to
  // its creator date, so only the relative order of the two snapshots is fixed.
  assert.deepEqual(tags.filter((t) => t.snapshot).map((t) => t.tag), ['v0.2.0', 'v0.1.0']);
  assert.equal(tags.find((t) => t.tag === 'v0.2.0').metrics.commit.length, 40);
  const lightweight = tags.find((t) => t.tag === 'plain-lightweight');
  assert.equal(lightweight.snapshot, null);
  assert.match(lightweight.headline, /no brain-release snapshot/);
});

test('list on a repo with no tags still exits 0 with a next action', () => {
  const cwd = makeRepo();
  const r = run(['list'], cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No release tags/);
  assert.match(r.stdout, /Next: /);
});

// ---------------------------------------------------------------------------
// propose — derivation
// ---------------------------------------------------------------------------

test('parseConventionalSubject reads type, scope, bang and the footer', () => {
  assert.deepEqual(parseConventionalSubject('feat(brain): add x'), {
    type: 'feat', scope: 'brain', breaking: false, breakingVia: null, description: 'add x'
  });
  assert.equal(parseConventionalSubject('feat(brain)!: add x').breaking, true);
  assert.equal(parseConventionalSubject('feat(brain)!: add x').breakingVia, '!');
  assert.equal(parseConventionalSubject('fix: y', 'BREAKING CHANGE: install shape moved').breaking, true);
  assert.equal(parseConventionalSubject('fix: y', 'BREAKING-CHANGE: install shape moved').breaking, true);
  assert.equal(parseConventionalSubject('Merge pull request #40 from x'), null);
  assert.equal(parseConventionalSubject('docs(brain) S4: no colon after scope'), null);
});

test('deriveBump maps each type to its bump and takes the maximum', () => {
  const c = (subject, body = '', parents = ['p']) => ({ sha: 'a'.repeat(40), subject, body, parents });
  assert.equal(deriveBump([c('docs: x'), c('test: y')]).bump, 'none');
  assert.equal(deriveBump([c('fix: x')]).bump, 'patch');
  assert.equal(deriveBump([c('perf: x')]).bump, 'patch');
  assert.equal(deriveBump([c('fix: x'), c('feat: y')]).bump, 'minor');
  assert.equal(deriveBump([c('feat: y'), c('fix!: x')]).bump, 'major');
  assert.equal(deriveBump([c('fix: x', 'BREAKING CHANGE: moved')]).bump, 'major');
});

test('deriveBump counts what it skipped instead of silently ignoring it', () => {
  const commits = [
    { sha: '1'.repeat(40), subject: 'feat: a', body: '', parents: ['p'] },
    { sha: '2'.repeat(40), subject: 'Merge pull request #1', body: '', parents: ['p', 'q'] },
    { sha: '3'.repeat(40), subject: 'wip whatever', body: '', parents: ['p'] },
    { sha: '4'.repeat(40), subject: 'docs(brain) S4: no colon', body: '', parents: ['p'] }
  ];
  const d = deriveBump(commits);
  assert.equal(d.bump, 'minor');
  assert.equal(d.skipped.merges, 1);
  assert.equal(d.skipped.nonConforming, 2);
  assert.equal(d.skipped.total, 3);
  assert.equal(d.commits.length, 1);
  assert.equal(d.skipped.nonConformingSamples.length, 2);
  // Conformance is measured over NON-MERGE commits: 1 of 3.
  assert.equal(d.skipped.conformanceRatio, 0.3333);
});

test('applyBump is plain semver arithmetic', () => {
  assert.equal(applyBump('1.2.3', 'major'), '2.0.0');
  assert.equal(applyBump('1.2.3', 'minor'), '1.3.0');
  assert.equal(applyBump('1.2.3', 'patch'), '1.2.4');
  assert.equal(applyBump('v1.2.3', 'patch'), '1.2.4');
  assert.equal(applyBump('1.2.3', 'none'), '1.2.3');
  assert.equal(applyBump('not-semver', 'patch'), null);
});

test('groupChangelog buckets by type in a fixed order', () => {
  const sections = groupChangelog([
    { sha: 'aaaaaaa1', type: 'fix', scope: null, description: 'f' },
    { sha: 'bbbbbbb2', type: 'feat', scope: 'x', description: 'a' },
    { sha: 'ccccccc3', type: 'docs', scope: null, description: 'd' },
    { sha: 'ddddddd4', type: 'perf', scope: null, description: 'p' }
  ]);
  assert.deepEqual(sections.map((s) => s.title), ['Features', 'Fixes', 'Performance', 'Other']);
  assert.equal(sections[0].entries[0].sha, 'bbbbbbb');
});

// ---------------------------------------------------------------------------
// propose — export-surface verification
// ---------------------------------------------------------------------------

test('scanExports is a regex scan that sees the common export forms', () => {
  const src = [
    'export function alpha() {}',
    'export async function beta() {}',
    'export const GAMMA = 1;',
    'export class Delta {}',
    'export default function () {}',
    'export { epsilon, zeta as eta };',
    "export * from './other.mjs';",
    'function notExported() {}'
  ].join('\n');
  assert.deepEqual(scanExports(src, 'x.mjs'), [
    '*from:./other.mjs', 'GAMMA', 'Delta', 'alpha', 'beta', 'default', 'epsilon', 'eta'
  ].sort());
  assert.deepEqual(scanExports(src, 'x.py'), []);
});

test('detectCandidateBreaks flags removed exports and vanished modules', () => {
  const before = new Map([['a.mjs', ['foo', 'KEEP']], ['gone.mjs', ['bar']]]);
  const after = new Map([['a.mjs', ['KEEP']]]);
  const rows = detectCandidateBreaks(before, after, (file) => ({
    importers: file === 'a.mjs' ? ['b.mjs', 'c.mjs'] : ['d.mjs'],
    referencing: file === 'a.mjs' ? ['b.mjs'] : []
  }));
  assert.equal(rows.length, 2);
  const foo = rows.find((r) => r.name === 'foo');
  assert.equal(foo.file, 'a.mjs');
  assert.equal(foo.importers, 2);
  assert.equal(foo.importersReferencingName, 1);
  assert.match(foo.evidence, /`foo` no longer exported from a\.mjs; 2 file\(s\) import it/);
  const bar = rows.find((r) => r.name === 'bar');
  assert.equal(bar.reason, 'module no longer exists at HEAD');
});

test('reconcileBump escalates to major when an export vanished under a fix:', () => {
  const r = reconcileBump({ derived: 'patch', candidateBreaks: [{ name: 'foo' }], breakingDeclarations: [] });
  assert.equal(r.recommended, 'major');
  assert.equal(r.escalated, true);
  assert.match(r.reason, /DISAPPEARED/);
});

test('reconcileBump reports over-declaration when nothing actually vanished', () => {
  const r = reconcileBump({ derived: 'major', candidateBreaks: [], breakingDeclarations: [{ sha: 'x' }] });
  assert.equal(r.recommended, 'major');
  assert.equal(r.escalated, false);
  assert.equal(r.overDeclared, true);
  assert.match(r.reason, /Over-declaration is harmless/);
});

test('reconcileBump says so when the export surface could not be verified', () => {
  const r = reconcileBump({ derived: 'minor', verified: false });
  assert.equal(r.recommended, 'minor');
  assert.match(r.reason, /could NOT be verified/);
});

test('propose escalates a fix: to MAJOR when a real export disappears', () => {
  const cwd = makeRepo();
  git(['tag', '-a', 'v1.0.0', '-m', 'baseline'], cwd);
  fs.writeFileSync(path.join(cwd, 'a.mjs'), 'export const KEEP = 2;\n');
  git(['add', '-A'], cwd);
  commit(cwd, 'fix(core): drop the helper');

  const r = run(['propose', '--json'], cwd);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.lastTag, 'v1.0.0');
  assert.equal(p.derivedBump, 'patch');
  assert.equal(p.recommendedBump, 'major');
  assert.equal(p.reconciliation.escalated, true);
  assert.equal(p.proposedVersion, '2.0.0');
  assert.equal(p.verification.verified, true);
  const foo = p.candidateBreaks.find((b) => b.name === 'foo');
  assert.ok(foo, 'expected `foo` to be flagged');
  assert.equal(foo.file, 'a.mjs');
  assert.equal(foo.importers, 1);            // b.mjs imports a.mjs
  assert.equal(foo.importersReferencingName, 1); // …and still names foo
  assert.match(foo.evidence, /1 file\(s\) import it/);
  // It proposes; it never publishes.
  assert.equal(p.publishes, false);
  assert.equal(git(['tag', '-l'], cwd).trim(), 'v1.0.0');
  assert.match(r.stderr, /^Next: /m);
});

test('propose reports over-declaration when a ! ships with no export removal', () => {
  const cwd = makeRepo();
  git(['tag', '-a', 'v1.0.0', '-m', 'baseline'], cwd);
  fs.appendFileSync(path.join(cwd, 'a.mjs'), 'export const EXTRA = 3;\n');
  git(['add', '-A'], cwd);
  commit(cwd, 'feat(core)!: rename the concept');

  const p = JSON.parse(run(['propose', '--json'], cwd).stdout);
  assert.equal(p.derivedBump, 'major');
  assert.equal(p.recommendedBump, 'major');
  assert.equal(p.candidateBreaks.length, 0);
  assert.equal(p.reconciliation.overDeclared, true);
  assert.equal(p.reconciliation.escalated, false);
  assert.equal(p.proposedVersion, '2.0.0');
  assert.equal(p.breakingDeclarations.length, 1);
});

test('propose on a repo with no tags takes the first-release path', () => {
  const cwd = makeRepo({ pkg: { name: 'x', version: '0.4.2' } });
  const p = JSON.parse(run(['propose', '--json'], cwd).stdout);
  assert.equal(p.lastTag, null);
  assert.equal(p.firstRelease, true);
  assert.equal(p.baseVersion, '0.4.2');
  assert.equal(p.proposedVersion, '0.4.2');
  assert.equal(p.verification.verified, false);
  assert.match(p.verification.reason, /no prior tag/);
  assert.equal(p.measurement.available, false);
  assert.match(p.versionReason, /first release/);
  assert.ok(p.commands.length >= 3);
});

test('propose reuses compare for the measurement delta when the tag carries a snapshot', () => {
  const cwd = makeRepo();
  assert.equal(run(['tag', 'v1.0.0', '--now', NOW], cwd).status, 0);
  fs.appendFileSync(path.join(cwd, 'a.mjs'), 'export const EXTRA = 3;\n');
  git(['add', '-A'], cwd);
  commit(cwd, 'feat(core): add extra');

  const p = JSON.parse(run(['propose', '--json', '--now', NOW], cwd).stdout);
  assert.equal(p.measurement.available, true);
  assert.equal(p.measurement.report.verdict, 'indistinguishable');
  assert.equal(p.measurement.report.a.label, 'v1.0.0');
  assert.equal(p.recommendedBump, 'minor');
  assert.equal(p.proposedVersion, '1.1.0');
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

test('every subcommand ends with a mandatory next action', () => {
  const cwd = makeRepo();
  assert.equal(run(['tag', 'v0.1.0', '--now', NOW], cwd).status, 0);
  for (const args of [['snapshot', '--now', NOW], ['list'], ['compare', 'v0.1.0', 'HEAD', '--now', NOW], ['propose']]) {
    const r = run(args, cwd);
    assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    assert.match(r.stdout, /\nNext: /, `${args[0]} must print a next action`);
  }
});

test('--json puts the next action on stderr and keeps stdout parseable', () => {
  const cwd = makeRepo();
  const r = run(['snapshot', '--json', '--now', NOW], cwd);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  assert.match(r.stderr, /^Next: /m);
});

test('usage errors exit 2, everything else exits 0', () => {
  const cwd = makeRepo();
  assert.equal(run(['nonsense'], cwd).status, 2);
  assert.equal(run(['snapshot', '--nope'], cwd).status, 2);
  assert.equal(run(['snapshot', '--now', 'not-a-date'], cwd).status, 2);
  assert.equal(run(['--help'], cwd).status, 0);
  assert.equal(run([], cwd).status, 2);
});
