/**
 * lint-intel tests (scripts/lint-intel.mjs).
 *
 * The product claim under test is the RANKING: a linter emits 400
 * undifferentiated findings, and the value we add is saying which handful sit
 * where a change actually hurts. So the bulk of this file isolates ONE ranking
 * input at a time against hand-built fixtures — churn alone, dependents alone,
 * a foreign lease alone, fix density alone — and asserts both the arithmetic
 * and the receipt (every reason must carry its numbers).
 *
 * The second half is the two honesty contracts:
 *   - WHITELIST: a SARIF log carrying a secret-looking string in every field a
 *     tool could plausibly invent (properties, partialFingerprints, snippets,
 *     artifact contents, fix text) is pushed through parse → rank → report, and
 *     the fake secret is asserted to appear NOWHERE in the serialized output.
 *   - NOT SCANNED ≠ CLEAN: with no linter installed the CLI must exit 0, state
 *     every absence with a reason, and refuse to claim a clean bill of health.
 *
 * No linter, no network and no npm are required to run any of this: every
 * external tool is probed through an injected env/spawn, and the one subprocess
 * test scripts its own git repo under mkdtemp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const {
  parseSarif,
  normalizeEslintJson,
  normalizePhpstanJson,
  relativizeUri,
  fingerprintOf,
  rankFindings,
  buildLintReport,
  lintStatement,
  nextAction,
  calibrateLintRank,
  leaseTargetMatches,
  hasBin,
  runEslint,
  runRuff,
  runGolangciLint,
  runClippy,
  runPhpstan,
  readSarifFiles,
  LINT_RANK_WEIGHTS,
  LINT_RANK_SATURATION,
  LEVEL_RAW,
  RANK_NOTE,
  WEIGHTS_NOT_CALIBRATED_NOTE,
  SARIF_SAFETY_NOTE,
  NOT_SCANNED_NOTE,
  TOOL_NAMES
} = await import('../scripts/lint-intel.mjs');

const SCRIPT = fileURLToPath(new URL('../scripts/lint-intel.mjs', import.meta.url));

/** The fake secret that must never survive a round-trip through this module. */
const FAKE_SECRET = 'AKIAIOSFODNN7EXAMPLE-tHiSiSaFaKeLiNtSeCrEt-4c81';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function sarifLog({ toolName = 'eslint', rules = [], results = [] } = {}) {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{ tool: { driver: { name: toolName, rules } }, results }]
  };
}

function result({ ruleId = 'no-unused-vars', level = 'warning', text = 'x is unused', uri = 'src/a.js', startLine = 10, endLine, ruleIndex } = {}) {
  const r = {
    ruleId,
    level,
    message: { text },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine, ...(endLine ? { endLine } : {}) } } }]
  };
  if (ruleIndex !== undefined) { delete r.ruleId; r.ruleIndex = ruleIndex; }
  if (level === null) delete r.level;
  return r;
}

/** A hotspots()-shaped fixture: only `.files` is read by the ranker. */
function hotspotsFixture(files) {
  return { files: files.map((f) => ({ file: f.file, score: f.score ?? 1, commits: f.commits ?? 5, lastCommit: '2026-01-01T00:00:00Z' })) };
}

/** A buildImportGraph()-shaped fixture: nodes + edges are all the ranker reads. */
function graphFixture(edges) {
  const files = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  return {
    nodes: files.map((f) => ({
      file: f,
      lang: 'javascript',
      imports: edges.filter((e) => e.from === f).length,
      importedBy: edges.filter((e) => e.to === f).length
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, kind: 'import', confidence: 1 }))
  };
}

/** A fileHealth()-shaped fixture: only the fix-density factor is read. */
function healthFixture(entries) {
  return {
    files: entries.map((e) => ({
      file: e.file,
      score: 5,
      factors: [{ name: 'fix-density', weight: 0.25, raw: e.raw, contribution: 0, evidence: e.evidence || `${Math.round(e.raw * 10)} of 10 commits are fix/revert commits` }]
    }))
  };
}

const oneWarning = [{ tool: 'eslint', ruleId: 'r1', level: 'warning', message: 'm', file: 'src/a.js', startLine: 1, endLine: null, fingerprint: 'aaa' }];
const oneError = [{ tool: 'eslint', ruleId: 'r1', level: 'error', message: 'm', file: 'src/a.js', startLine: 1, endLine: null, fingerprint: 'bbb' }];

// ---------------------------------------------------------------------------
// SARIF ingestion
// ---------------------------------------------------------------------------

test('parseSarif: a valid log yields whitelist-constructed findings', () => {
  const parsed = parseSarif(sarifLog({
    results: [
      result({ ruleId: 'no-undef', level: 'error', text: "'foo' is not defined", uri: 'src/a.js', startLine: 3, endLine: 4 }),
      result({ ruleId: 'complexity', level: 'warning', text: 'too complex', uri: 'src/b.js', startLine: 12 })
    ]
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.runs, 1);
  assert.equal(parsed.total, 2);
  assert.deepEqual(Object.keys(parsed.findings[0]).sort(),
    ['endLine', 'file', 'fingerprint', 'level', 'message', 'ruleId', 'startLine', 'tool']);
  const a = parsed.findings.find((f) => f.file === 'src/a.js');
  assert.equal(a.tool, 'eslint');
  assert.equal(a.ruleId, 'no-undef');
  assert.equal(a.level, 'error');
  assert.equal(a.startLine, 3);
  assert.equal(a.endLine, 4);
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
});

test('parseSarif: missing OPTIONAL fields degrade instead of throwing', () => {
  const parsed = parseSarif({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'ruff' } },
      results: [
        // no region → no line numbers
        { ruleId: 'F401', level: 'error', message: { text: 'unused import' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.py' } } }] },
        // no locations at all → unplaceable but still reported
        { ruleId: 'E999', level: 'error', message: { text: 'syntax error' } },
        // no message, no ruleId, no level → defaults, never an invented 'error'
        { locations: [{ physicalLocation: { artifactLocation: { uri: 'c.py' }, region: { startLine: 2 } } }] }
      ]
    }]
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, 3);
  const byFile = Object.fromEntries(parsed.findings.map((f) => [f.file, f]));
  assert.equal(byFile['a.py'].startLine, null);
  assert.equal(byFile['a.py'].endLine, null);
  assert.equal(byFile[''].ruleId, 'E999');
  assert.equal(byFile['c.py'].ruleId, 'unknown-rule');
  assert.equal(byFile['c.py'].message, '');
  // SARIF default chain with no rule metadata is 'warning' — NOT 'error'.
  assert.equal(byFile['c.py'].level, 'warning');
});

test('parseSarif: level falls back to the rule default before the spec default', () => {
  const parsed = parseSarif(sarifLog({
    rules: [{ id: 'style/quotes', defaultConfiguration: { level: 'note' } }],
    results: [result({ level: null, ruleIndex: 0, uri: 'src/a.js' })]
  }));
  assert.equal(parsed.findings[0].level, 'note');
  assert.equal(parsed.findings[0].ruleId, 'style/quotes', 'ruleIndex resolves into the rule table');
});

test('parseSarif: a malformed run is SKIPPED WITH A COUNTED REASON, siblings still parse', () => {
  const parsed = parseSarif({
    version: '2.1.0',
    runs: [
      null,
      { tool: { driver: { name: 'brokenlint' } } }, // no results array
      { tool: { driver: { name: 'goodlint' } }, results: [result({ uri: 'src/ok.js' })] },
      'not an object'
    ]
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.runs, 1, 'only the well-formed run counts as parsed');
  assert.equal(parsed.skippedRuns.length, 3);
  assert.deepEqual(parsed.skippedRuns.map((r) => r.index), [0, 1, 3]);
  for (const skipped of parsed.skippedRuns) assert.match(skipped.reason, /run (is not an object|has no `results` array)/);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].tool, 'goodlint');
});

test('parseSarif: a malformed RESULT inside a good run is skipped and counted', () => {
  const parsed = parseSarif(sarifLog({ results: [null, 'nope', result({ uri: 'src/a.js' })] }));
  assert.equal(parsed.skippedResults, 2);
  assert.equal(parsed.findings.length, 1);
});

test('parseSarif: multi-run logs keep each run\'s own tool name', () => {
  const parsed = parseSarif({
    version: '2.1.0',
    runs: [
      { tool: { driver: { name: 'eslint' } }, results: [result({ uri: 'src/a.js', ruleId: 'no-undef' })] },
      { tool: { driver: { name: 'ruff' } }, results: [result({ uri: 'a.py', ruleId: 'F401' })] }
    ]
  });
  assert.equal(parsed.runs, 2);
  assert.deepEqual(parsed.findings.map((f) => f.tool).sort(), ['eslint', 'ruff']);
});

test('parseSarif: unusable input is a reason, never a throw', () => {
  for (const bad of [null, undefined, 42, 'a string', [], { version: '2.1.0' }, { runs: 'nope' }]) {
    const parsed = parseSarif(bad);
    assert.equal(parsed.ok, false, `expected ok:false for ${JSON.stringify(bad)}`);
    assert.equal(typeof parsed.reason, 'string');
    assert.ok(parsed.reason.length > 0);
    assert.deepEqual(parsed.findings, []);
  }
});

test('parseSarif: identical findings collapse to one row (fingerprint dedupe)', () => {
  const r = result({ uri: 'src/a.js', startLine: 5 });
  const parsed = parseSarif(sarifLog({ results: [r, { ...r }] }));
  assert.equal(parsed.total, 1);
});

// ---------------------------------------------------------------------------
// THE WHITELIST GUARANTEE
// ---------------------------------------------------------------------------

test('whitelist: a secret hidden in unexpected SARIF fields never reaches the output', () => {
  const hostile = {
    version: '2.1.0',
    properties: { env: FAKE_SECRET },
    runs: [{
      properties: { ciToken: FAKE_SECRET },
      tool: { driver: { name: 'hostilelint', properties: { license: FAKE_SECRET }, rules: [{ id: 'r1', help: { text: FAKE_SECRET }, properties: { note: FAKE_SECRET } }] } },
      artifacts: [{ location: { uri: 'src/a.js' }, contents: { text: `const key = "${FAKE_SECRET}";` } }],
      results: [{
        ruleId: 'r1',
        ruleIndex: 0,
        level: 'error',
        message: { text: 'hardcoded credential detected' },
        properties: { matched: FAKE_SECRET },
        partialFingerprints: { primaryLocationLineHash: FAKE_SECRET },
        fingerprints: { v1: FAKE_SECRET },
        fixes: [{ description: { text: FAKE_SECRET } }],
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: 'src/a.js' },
            region: { startLine: 4, snippet: { text: `const key = "${FAKE_SECRET}";` } },
            contextRegion: { snippet: { text: FAKE_SECRET } }
          }
        }]
      }]
    }]
  };

  const parsed = parseSarif(hostile);
  assert.equal(parsed.findings.length, 1);
  assert.ok(!JSON.stringify(parsed).includes(FAKE_SECRET), 'parseSarif leaked the secret');

  // …and it must not reappear anywhere downstream either.
  const ranked = rankFindings(parsed.findings, {
    hotspots: hotspotsFixture([{ file: 'src/a.js' }]),
    graph: graphFixture([{ from: 'src/b.js', to: 'src/a.js' }]),
    health: healthFixture([{ file: 'src/a.js', raw: 0.5 }]),
    leases: [{ target: 'src/**', lockedBy: 'bob', until: '' }],
    now: Date.parse('2026-01-01T00:00:00Z')
  });
  const report = buildLintReport({ tools: [{ name: 'hostilelint', ran: true, findings: 1 }], ranking: ranked, now: 0 });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(FAKE_SECRET), 'the ranked report leaked the secret');
  assert.ok(!serialized.includes('AKIAIOSFODNN7EXAMPLE'), 'a prefix of the secret leaked');
  assert.ok(!nextAction(report).includes(FAKE_SECRET));
  // The finding itself survived — we dropped the payload, not the signal.
  assert.equal(report.findings[0].ruleId, 'r1');
  assert.equal(report.findings[0].message, 'hardcoded credential detected');
});

test('whitelist: the fingerprint is ours, never the tool-supplied one', () => {
  const parsed = parseSarif(sarifLog({
    results: [{ ...result({ uri: 'src/a.js' }), partialFingerprints: { primaryLocationLineHash: 'TOOL-SUPPLIED-ID' } }]
  }));
  assert.notEqual(parsed.findings[0].fingerprint, 'TOOL-SUPPLIED-ID');
  assert.equal(parsed.findings[0].fingerprint, fingerprintOf(parsed.findings[0]));
});

// ---------------------------------------------------------------------------
// URI handling
// ---------------------------------------------------------------------------

test('relativizeUri: file:// URIs, percent-encoding, ./ prefixes and out-of-root paths', () => {
  assert.equal(relativizeUri('file:///repo/src/a.js', { root: '/repo' }), 'src/a.js');
  assert.equal(relativizeUri('/repo/src/a.js', { root: '/repo' }), 'src/a.js');
  assert.equal(relativizeUri('./src/a.js', { root: '/repo' }), 'src/a.js');
  assert.equal(relativizeUri('src/a.js', { root: '/repo' }), 'src/a.js');
  assert.equal(relativizeUri('file:///repo/src/my%20file.js', { root: '/repo' }), 'src/my file.js');
  // Outside the root: kept verbatim rather than silently rewritten into a repo
  // path that does not exist.
  assert.equal(relativizeUri('/elsewhere/x.js', { root: '/repo' }), '/elsewhere/x.js');
  assert.equal(relativizeUri('', { root: '/repo' }), '');
  assert.equal(relativizeUri(null, { root: '/repo' }), '');
});

// ---------------------------------------------------------------------------
// non-SARIF normalizers
// ---------------------------------------------------------------------------

test('normalizeEslintJson: severity mapping, and the code-bearing fields are dropped', () => {
  const out = normalizeEslintJson([{
    filePath: '/repo/src/a.js',
    messages: [
      { ruleId: 'no-undef', severity: 2, message: 'undefined', line: 3, endLine: 3, source: `secret=${FAKE_SECRET}`, fix: { text: FAKE_SECRET } },
      { ruleId: 'quotes', severity: 1, message: 'quotes', line: 9 },
      { ruleId: null, severity: 0, message: 'off but reported', line: 1 }
    ],
    output: FAKE_SECRET
  }], { root: '/repo' });
  assert.equal(out.ok, true);
  assert.equal(out.total, 3);
  assert.deepEqual(out.findings.map((f) => f.level).sort(), ['error', 'note', 'warning']);
  assert.equal(out.findings[0].file, 'src/a.js');
  assert.ok(out.findings.some((f) => f.ruleId === 'unknown-rule'));
  assert.ok(!JSON.stringify(out).includes(FAKE_SECRET));
});

test('normalizeEslintJson / normalizePhpstanJson: unusable input is a reason, not a throw', () => {
  assert.equal(normalizeEslintJson({ nope: true }).ok, false);
  assert.equal(normalizePhpstanJson([]).ok, false);
  assert.match(normalizePhpstanJson(null).reason, /files/);
});

test('normalizePhpstanJson: per-file messages become findings', () => {
  const out = normalizePhpstanJson({
    totals: { errors: 0, file_errors: 1 },
    files: { '/repo/src/A.php': { errors: 1, messages: [{ message: 'undefined method', line: 12, identifier: 'method.notFound' }] } }
  }, { root: '/repo' });
  assert.equal(out.total, 1);
  assert.equal(out.findings[0].file, 'src/A.php');
  assert.equal(out.findings[0].ruleId, 'method.notFound');
  assert.equal(out.findings[0].level, 'error');
});

test('fingerprintOf: deterministic, and sensitive to every identity field', () => {
  const base = { tool: 't', ruleId: 'r', file: 'f.js', startLine: 1, message: 'm' };
  assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
  for (const key of ['tool', 'ruleId', 'file', 'startLine', 'message']) {
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, [key]: 'CHANGED' }), `${key} must change the fingerprint`);
  }
});

// ---------------------------------------------------------------------------
// THE RANKING LAYER — one input isolated at a time
// ---------------------------------------------------------------------------

test('rankFindings: with NO signals, the weight is pure tool severity', () => {
  const ranked = rankFindings([
    { ...oneError[0], file: 'src/a.js' },
    { ...oneWarning[0], file: 'src/b.js' },
    { tool: 'eslint', ruleId: 'r3', level: 'note', message: 'm', file: 'src/c.js', startLine: 1, fingerprint: 'ccc' }
  ], {});
  assert.equal(ranked.available, false);
  assert.equal(ranked.degraded, true);
  assert.match(ranked.reason, /severity only/);
  assert.deepEqual(ranked.findings.map((f) => f.weight), [10, 5, 2]);
  for (const f of ranked.findings) {
    assert.deepEqual(f.factors.map((x) => x.name), ['severity']);
    assert.ok(f.reasons.some((r) => r.kind === 'severity' && /reports this as/.test(r.message)));
  }
});

test('rankFindings: churn alone — the percentile is computed and the reason carries it', () => {
  const hotspots = hotspotsFixture([{ file: 'src/hot.js', commits: 42 }, { file: 'src/cold.js', commits: 2 }]);
  const ranked = rankFindings([
    { ...oneWarning[0], file: 'src/hot.js', fingerprint: 'h' },
    { ...oneWarning[0], file: 'src/cold.js', fingerprint: 'c' }
  ], { hotspots, now: 0 });

  const hot = ranked.findings.find((f) => f.file === 'src/hot.js');
  const cold = ranked.findings.find((f) => f.file === 'src/cold.js');
  // rank 1 of 2 → percentile 1.0; rank 2 of 2 → 0.5.
  // 10 × (0.2×0.5 + 0.3×1.0) / 0.5 = 8.0 ; 10 × (0.1 + 0.15) / 0.5 = 5.0
  assert.equal(hot.weight, 8);
  assert.equal(cold.weight, 5);
  assert.ok(hot.weight > cold.weight, 'same rule, same severity — churn is the only difference');
  const reason = hot.reasons.find((r) => r.kind === 'churn');
  assert.match(reason.message, /churn rank #1 of 2/);
  assert.match(reason.message, /42 commit\(s\)/);
});

test('rankFindings: dependents alone — blast radius, with the count in the reason', () => {
  const graph = graphFixture([
    { from: 'src/x.js', to: 'src/core.js' },
    { from: 'src/y.js', to: 'src/core.js' },
    { from: 'src/z.js', to: 'src/x.js' } // transitive dependent of core
  ]);
  const ranked = rankFindings([
    { ...oneError[0], file: 'src/core.js', fingerprint: 'core' },
    { ...oneError[0], file: 'src/z.js', fingerprint: 'leaf' }
  ], { graph });

  const core = ranked.findings.find((f) => f.file === 'src/core.js');
  const leaf = ranked.findings.find((f) => f.file === 'src/z.js');
  // core: 3 transitive dependents → raw 3/25 = 0.12 → 10×(0.2 + 0.25×0.12)/0.45 = 5.1
  assert.equal(core.weight, 5.1);
  // leaf: no dependents → raw 0 → 10×0.2/0.45 = 4.4
  assert.equal(leaf.weight, 4.4);
  assert.match(core.reasons.find((r) => r.kind === 'dependents').message, /3 file\(s\) transitively import this \(2 directly\)/);
  assert.match(leaf.reasons.find((r) => r.kind === 'dependents').message, /no file in the import graph imports this/);
});

test('rankFindings: dependents saturate — 25 importers and 250 rank the same', () => {
  const many = (n) => graphFixture(Array.from({ length: n }, (_, i) => ({ from: `src/i${i}.js`, to: 'src/core.js' })));
  const at = rankFindings(oneError.map((f) => ({ ...f, file: 'src/core.js' })), { graph: many(LINT_RANK_SATURATION.dependents) });
  const way = rankFindings(oneError.map((f) => ({ ...f, file: 'src/core.js' })), { graph: many(LINT_RANK_SATURATION.dependents * 10) });
  assert.equal(at.findings[0].weight, way.findings[0].weight);
  assert.equal(at.findings[0].weight, 10);
});

test('rankFindings: a FOREIGN active lease lifts the finding, a self-held one does not', () => {
  const leases = [{ target: 'src/**', lockedBy: 'bob', until: '', notes: '' }];
  const now = Date.parse('2026-01-01T00:00:00Z');
  const foreign = rankFindings(oneError, { leases, now, self: 'alice' });
  const mine = rankFindings(oneError, { leases, now, self: 'bob' });
  // foreign: 10 × (0.2 + 0.1) / 0.3 = 10 ; self: 10 × 0.2 / 0.3 = 6.7
  assert.equal(foreign.findings[0].weight, 10);
  assert.equal(mine.findings[0].weight, 6.7);
  assert.match(foreign.findings[0].reasons.find((r) => r.kind === 'lease').message, /held by bob/);
  assert.equal(mine.findings[0].reasons.find((r) => r.kind === 'lease'), undefined);
});

test('rankFindings: an EXPIRED lease is dropped, an unparseable `until` is kept (fail toward caution)', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const expired = rankFindings(oneError, { leases: [{ target: 'src/**', lockedBy: 'bob', until: '2026-01-01T00:00:00Z' }], now, self: 'alice' });
  const vague = rankFindings(oneError, { leases: [{ target: 'src/**', lockedBy: 'bob', until: 'whenever' }], now, self: 'alice' });
  assert.equal(expired.findings[0].weight, 6.7);
  assert.equal(vague.findings[0].weight, 10);
});

test('rankFindings: fix density alone — a file that keeps getting repaired outranks one that does not', () => {
  const health = healthFixture([
    { file: 'src/fragile.js', raw: 0.5, evidence: '5 of 10 commits are fix/revert commits (50%)' },
    { file: 'src/stable.js', raw: 0 }
  ]);
  const ranked = rankFindings([
    { ...oneWarning[0], file: 'src/fragile.js', fingerprint: 'f' },
    { ...oneWarning[0], file: 'src/stable.js', fingerprint: 's' }
  ], { health });
  const fragile = ranked.findings.find((f) => f.file === 'src/fragile.js');
  const stable = ranked.findings.find((f) => f.file === 'src/stable.js');
  // 10 × (0.2×0.5 + 0.15×0.5) / 0.35 = 5.0 ; 10 × 0.1 / 0.35 = 2.9
  assert.equal(fragile.weight, 5);
  assert.equal(stable.weight, 2.9);
  assert.match(fragile.reasons.find((r) => r.kind === 'fix-density').message, /5 of 10 commits/);
});

test('rankFindings: a note in a hot, heavily-imported file outranks an error in a leaf — on purpose', () => {
  const hotspots = hotspotsFixture([{ file: 'src/core.js', commits: 90 }, { file: 'src/leaf.js', commits: 1 }]);
  const graph = graphFixture([
    ...Array.from({ length: 30 }, (_, i) => ({ from: `src/i${i}.js`, to: 'src/core.js' })),
    // leaf.js is a scanned node that nothing imports (it imports a util itself,
    // so it is genuinely IN the graph — a measured zero, not an unknown).
    { from: 'src/leaf.js', to: 'src/util.js' }
  ]);
  const ranked = rankFindings([
    { tool: 'eslint', ruleId: 'style', level: 'note', message: 'm', file: 'src/core.js', startLine: 1, fingerprint: 'n' },
    { tool: 'eslint', ruleId: 'bug', level: 'error', message: 'm', file: 'src/leaf.js', startLine: 1, fingerprint: 'e' }
  ], { hotspots, graph });
  assert.equal(ranked.findings[0].file, 'src/core.js');
  assert.equal(ranked.findings[0].level, 'note');
  assert.ok(ranked.findings[0].weight > ranked.findings[1].weight);
  // The tool's own verdict is never discarded — it is kept on the row.
  assert.equal(ranked.findings[1].level, 'error');
});

test('rankFindings: insufficient history — factors are OMITTED, not scored 0, and it is stated', () => {
  const hotspots = hotspotsFixture([{ file: 'src/old.js', commits: 10 }]);
  const health = healthFixture([{ file: 'src/old.js', raw: 0.4 }]);
  const ranked = rankFindings([{ ...oneError[0], file: 'src/brandnew.js', fingerprint: 'new' }], { hotspots, health });
  const f = ranked.findings[0];
  assert.equal(f.lowConfidence, true);
  assert.equal(f.reason, 'insufficient history');
  assert.deepEqual(f.factors.map((x) => x.name), ['severity'], 'history factors are omitted entirely');
  const stated = f.reasons.find((r) => r.kind === 'insufficient-history');
  assert.match(stated.message, /OMITTED rather than scored 0/);
  // Crucially: the unknown file is NOT pushed down as if it were safe.
  const noSignals = rankFindings([{ ...oneError[0], file: 'src/brandnew.js', fingerprint: 'new' }], {});
  assert.equal(f.weight, noSignals.findings[0].weight);
});

test('rankFindings: a finding with no file location is flagged, not silently ranked', () => {
  const ranked = rankFindings([{ tool: 'ruff', ruleId: 'E999', level: 'error', message: 'syntax', file: '', startLine: null, fingerprint: 'x' }], {
    hotspots: hotspotsFixture([{ file: 'a.py' }]),
    graph: graphFixture([{ from: 'b.py', to: 'a.py' }])
  });
  const f = ranked.findings[0];
  assert.equal(f.lowConfidence, true);
  assert.match(f.reason, /no file location/);
  assert.deepEqual(f.factors.map((x) => x.name), ['severity']);
});

test('rankFindings: every reason carries a number or a name — no bare adjectives', () => {
  const ranked = rankFindings([{ ...oneWarning[0], file: 'src/a.js' }], {
    hotspots: hotspotsFixture([{ file: 'src/a.js', commits: 7 }]),
    graph: graphFixture([{ from: 'src/b.js', to: 'src/a.js' }]),
    health: healthFixture([{ file: 'src/a.js', raw: 0.25 }]),
    leases: [{ target: 'src/a.js', lockedBy: 'bob', until: '' }],
    now: 0,
    self: 'alice'
  });
  const f = ranked.findings[0];
  assert.deepEqual(f.factors.map((x) => x.name), ['severity', 'churn', 'dependents', 'fixDensity', 'foreignLease']);
  for (const r of f.reasons) {
    assert.ok(/\d|bob|eslint/.test(r.message), `reason "${r.message}" carries no evidence`);
  }
});

test('rankFindings: weights are overridable and the params echo what was used', () => {
  const base = rankFindings(oneError, { graph: graphFixture([{ from: 'src/b.js', to: 'src/a.js' }]) });
  const tuned = rankFindings(oneError, { graph: graphFixture([{ from: 'src/b.js', to: 'src/a.js' }]), weights: { dependents: 0.9 } });
  assert.notEqual(base.findings[0].weight, tuned.findings[0].weight);
  assert.equal(tuned.params.weights.dependents, 0.9);
  assert.equal(tuned.params.weights.churn, LINT_RANK_WEIGHTS.churn, 'unspecified weights keep their default');
  assert.equal(base.params.levelRaw.error, LEVEL_RAW.error);
});

test('rankFindings: determinism — identical inputs give byte-identical output, ties broken stably', () => {
  const findings = [
    { tool: 'eslint', ruleId: 'b', level: 'warning', message: 'm', file: 'src/a.js', startLine: 2, fingerprint: '2' },
    { tool: 'eslint', ruleId: 'a', level: 'warning', message: 'm', file: 'src/a.js', startLine: 1, fingerprint: '1' },
    { tool: 'eslint', ruleId: 'c', level: 'warning', message: 'm', file: 'src/a.js', startLine: 1, fingerprint: '3' }
  ];
  const signals = { hotspots: hotspotsFixture([{ file: 'src/a.js' }]), now: 0 };
  const a = JSON.stringify(rankFindings(findings, signals));
  const b = JSON.stringify(rankFindings([...findings].reverse(), signals));
  assert.equal(a, b, 'input order must not change the output');
  const order = rankFindings(findings, signals).findings.map((f) => `${f.startLine}:${f.ruleId}`);
  assert.deepEqual(order, ['1:a', '1:c', '2:b']);
});

test('leaseTargetMatches: total — an unsupported target never throws, it just does not match', () => {
  assert.equal(leaseTargetMatches('src/**', 'src/a.js'), true);
  assert.equal(leaseTargetMatches('src/a.js', 'src/a.js'), true);
  assert.equal(leaseTargetMatches('other/**', 'src/a.js'), false);
  assert.equal(leaseTargetMatches('{a,b}/**/*.{js,ts}[!x]', 'src/a.js'), false);
});

// ---------------------------------------------------------------------------
// report assembly: NOT SCANNED is never CLEAN
// ---------------------------------------------------------------------------

test('buildLintReport: no tool ran → not scanned, no clean bill of health, exit-worthy reason per tool', () => {
  const report = buildLintReport({
    tools: [
      { name: 'eslint', ran: false, reason: 'no ESLint config in this repo' },
      { name: 'ruff', ran: false, reason: 'ruff not installed' }
    ],
    ranking: rankFindings([], {}),
    now: 0
  });
  assert.equal(report.claims.anyToolRan, false);
  assert.equal(report.claims.cleanBillOfHealth, false);
  assert.deepEqual(report.claims.toolsRan, []);
  assert.deepEqual(report.claims.toolsAbsent, ['eslint', 'ruff']);
  assert.match(report.statement, /NOT scanned/);
  assert.ok(!/no (lint )?findings/i.test(report.statement), 'an absent linter must never read as "no findings"');
  assert.equal(report.scannedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(report.provenance.notes.notScanned, NOT_SCANNED_NOTE);
  assert.equal(report.provenance.notes.rank, RANK_NOTE);
  assert.equal(report.provenance.notes.weights, WEIGHTS_NOT_CALIBRATED_NOTE);
  assert.equal(report.provenance.notes.sarif, SARIF_SAFETY_NOTE);
  for (const t of report.provenance.tools) assert.ok(t.ran === true || typeof t.reason === 'string');
  assert.match(nextAction(report), /no linter ran/);
});

test('buildLintReport: a tool that ran and found nothing MAY say so', () => {
  const report = buildLintReport({ tools: [{ name: 'ruff', ran: true, findings: 0 }], ranking: rankFindings([], {}), now: 0 });
  assert.equal(report.claims.cleanBillOfHealth, true);
  assert.match(report.statement, /ruff ran and reported no findings/);
  assert.match(nextAction(report), /found nothing/);
});

test('buildLintReport: the ranking is never advertised as calibrated', () => {
  const report = buildLintReport({ tools: [{ name: 'ruff', ran: true, findings: 1 }], ranking: rankFindings(oneError, {}), now: 0 });
  assert.equal(report.claims.rankingCalibrated, false);
  assert.match(report.ranking.calibration, /REVIEWABLE DEFAULTS/);
});

test('buildLintReport: --limit truncates the list but never the count', () => {
  const findings = Array.from({ length: 30 }, (_, i) => ({
    tool: 'eslint', ruleId: `r${i}`, level: 'warning', message: 'm', file: `src/f${i}.js`, startLine: 1, fingerprint: `fp${i}`
  }));
  const report = buildLintReport({ tools: [{ name: 'eslint', ran: true, findings: 30 }], ranking: rankFindings(findings, {}), now: 0, limit: 5 });
  assert.equal(report.findings.length, 5);
  assert.equal(report.total, 30);
  assert.equal(report.truncated, true);
  assert.equal(report.counts.warning, 30, 'counts cover every finding, not just the printed ones');
});

test('lintStatement: the sentence changes with the facts, and never overclaims', () => {
  assert.match(lintStatement({ anyToolRan: false, tools: [{ name: 'eslint', reason: 'not installed' }] }), /NOT scanned/);
  assert.match(lintStatement({ anyToolRan: true, tools: [{ name: 'ruff', ran: true }], total: 0 }), /reported no findings/);
  assert.match(
    lintStatement({ anyToolRan: true, tools: [{ name: 'ruff', ran: true }], total: 7, ranking: { available: false } }),
    /ordered by tool severity only/);
  assert.match(
    lintStatement({ anyToolRan: true, tools: [{ name: 'ruff', ran: true }], total: 7, ranking: { available: true } }),
    /ranked by situational exposure/);
});

// ---------------------------------------------------------------------------
// runners: every absence is a reason, never a throw
// ---------------------------------------------------------------------------

test('runners: an empty repo with nothing installed degrades with one reason each', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-empty-'));
  try {
    const env = { PATH: '' }; // nothing on PATH → hasBin false everywhere
    const spawn = () => { throw new Error('no tool should have been spawned'); };
    const results = [
      runEslint({ root: dir, env, spawn, files: ['src/a.js'] }),
      runRuff({ root: dir, env, spawn, files: ['a.py'] }),
      runGolangciLint({ root: dir, env, spawn, files: ['a.go'] }),
      runClippy({ root: dir, env, spawn }),
      runPhpstan({ root: dir, env, spawn })
    ];
    assert.deepEqual(results.map((r) => r.name), TOOL_NAMES);
    for (const r of results) {
      assert.equal(r.ran, false);
      assert.ok(r.reason && r.reason.length > 5, `${r.name} degraded without a reason`);
    }
    assert.match(results[0].reason, /no ESLint config/);
    assert.match(results[1].reason, /ruff not installed/);
    assert.match(results[2].reason, /golangci-lint not installed/);
    assert.match(results[3].reason, /no Cargo\.toml/);
    assert.match(results[4].reason, /no composer\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runners: a language with no files in the repo is a stated skip, not a silent pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-nolang-'));
  try {
    const env = { PATH: '', BRAIN_LINT_RUFF_BIN: '/usr/bin/true', BRAIN_LINT_GOLANGCI_LINT_BIN: '/usr/bin/true' };
    const spawn = () => { throw new Error('no tool should have been spawned'); };
    assert.match(runRuff({ root: dir, env, spawn, files: ['src/a.js'] }).reason, /no Python files/);
    assert.match(runGolangciLint({ root: dir, env, spawn, files: ['src/a.js'] }).reason, /no Go files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runners: kill switches are honoured and named in the reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-off-'));
  try {
    const spawn = () => { throw new Error('disabled tools must not spawn'); };
    assert.match(runEslint({ root: dir, env: { BRAIN_LINT_ESLINT: '0' }, spawn }).reason, /BRAIN_LINT_ESLINT=0/);
    assert.match(runRuff({ root: dir, env: { BRAIN_LINT_RUFF: '0' }, spawn }).reason, /BRAIN_LINT_RUFF=0/);
    assert.match(runGolangciLint({ root: dir, env: { BRAIN_LINT_GOLANGCI: '0' }, spawn }).reason, /BRAIN_LINT_GOLANGCI=0/);
    assert.match(runClippy({ root: dir, env: { BRAIN_LINT_CLIPPY: '0' }, spawn }).reason, /BRAIN_LINT_CLIPPY=0/);
    assert.match(runPhpstan({ root: dir, env: { BRAIN_LINT_PHPSTAN: '0' }, spawn }).reason, /BRAIN_LINT_PHPSTAN=0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runners: a tool that runs but emits garbage degrades with a reason, never a throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-garbage-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
    const env = { BRAIN_LINT_RUFF_BIN: '/usr/bin/ruff' };
    const spawn = () => ({ status: 0, stdout: 'not json at all', stderr: '' });
    const r = runRuff({ root: dir, env, spawn, files: ['a.py'] });
    assert.equal(r.ran, false);
    assert.match(r.reason, /no parseable SARIF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runners: a real SARIF payload from an injected spawn is ingested and attributed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-ruff-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.py'), 'import os\n');
    const payload = JSON.stringify({
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'ruff' } }, results: [result({ ruleId: 'F401', level: 'error', uri: `file://${dir}/a.py`, startLine: 1 })] }]
    });
    const r = runRuff({
      root: dir,
      env: { BRAIN_LINT_RUFF_BIN: '/usr/bin/ruff' },
      spawn: (bin, args) => {
        assert.deepEqual(args, ['check', '--output-format', 'sarif', '.']);
        return { status: 1, stdout: payload, stderr: '' };
      },
      files: ['a.py']
    });
    assert.equal(r.ran, true);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].file, 'a.py', 'the absolute URI is relativized against the root');
    assert.equal(r.findings[0].tool, 'ruff');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasBin: a *_BIN override makes a tool present without touching PATH', () => {
  assert.equal(hasBin('definitely-not-a-real-binary-xyz', { env: { PATH: '' } }), false);
  assert.equal(hasBin('golangci-lint', { env: { PATH: '', BRAIN_LINT_GOLANGCI_LINT_BIN: '/opt/golangci-lint' } }), true);
});

test('readSarifFiles: a missing or malformed file is a reason, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-sarif-'));
  try {
    fs.writeFileSync(path.join(dir, 'broken.sarif'), '{ not json');
    fs.writeFileSync(path.join(dir, 'notsarif.sarif'), '{"hello":"world"}');
    const out = readSarifFiles(['missing.sarif', 'broken.sarif', 'notsarif.sarif'], { root: dir });
    assert.equal(out.length, 3);
    for (const entry of out) {
      assert.equal(entry.ran, false);
      assert.ok(entry.reason.length > 0);
    }
    assert.match(out[0].reason, /could not read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// calibration: a question, not a claim
// ---------------------------------------------------------------------------

function commit(hash, dateIso, subject, files) {
  return { hash, author: 'a', dateIso, subject, files };
}

test('calibrateLintRank: no findings → nothing to calibrate, and it says so', () => {
  const cal = calibrateLintRank([], [commit('a1', '2026-01-01T00:00:00Z', 'feat: x', ['src/a.js'])], { horizonDays: 30 });
  assert.equal(cal.evaluated, 0);
  assert.equal(cal.auc, null);
  assert.match(cal.verdict, /nothing to calibrate/);
  assert.match(cal.verdict, /not a passing grade/);
  assert.match(cal.method, /NOT a cross-repo benchmark/);
  assert.match(cal.caveat, /upper bound/);
});

test('calibrateLintRank: one class only → AUC undefined, reported as "too few findings to say"', () => {
  const commits = [
    commit('a1', '2026-01-01T00:00:00Z', 'feat: x', ['src/a.js']),
    commit('a2', '2026-01-02T00:00:00Z', 'feat: y', ['src/b.js']),
    commit('a3', '2026-03-01T00:00:00Z', 'feat: later', ['src/c.js'])
  ];
  const findings = [
    { tool: 'eslint', ruleId: 'r', level: 'error', message: 'm', file: 'src/a.js', startLine: 1, fingerprint: '1' },
    { tool: 'eslint', ruleId: 'r', level: 'error', message: 'm', file: 'src/b.js', startLine: 1, fingerprint: '2' }
  ];
  const cal = calibrateLintRank(findings, commits, { horizonDays: 30 });
  assert.equal(cal.auc, null);
  assert.match(cal.verdict, /Too few findings to say/);
});

test('calibrateLintRank: with both classes present it reports AUC AND the severity-only baseline', () => {
  // Files a..d churn a lot before the cut; a and b get fixed after it.
  const commits = [];
  for (let i = 0; i < 20; i++) {
    commits.push(commit(`h${i}`, `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`, 'feat: work', ['src/a.js', 'src/b.js']));
  }
  for (let i = 0; i < 3; i++) {
    commits.push(commit(`c${i}`, `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`, 'feat: work', ['src/c.js']));
  }
  commits.push(commit('f1', '2026-03-10T00:00:00Z', 'fix: repair a', ['src/a.js']));
  commits.push(commit('f2', '2026-03-11T00:00:00Z', 'fix: repair b', ['src/b.js']));
  const findings = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'].map((file, i) => ({
    tool: 'eslint', ruleId: 'r', level: i === 3 ? 'error' : 'warning', message: 'm', file, startLine: 1, fingerprint: `fp${i}`
  }));

  const cal = calibrateLintRank(findings, commits, { horizonDays: 30, minEvaluated: 2 });
  assert.ok(cal.evaluated >= 3);
  assert.equal(typeof cal.auc, 'number');
  assert.equal(typeof cal.severityOnlyAuc, 'number');
  assert.equal(cal.delta, Number((cal.auc - cal.severityOnlyAuc).toFixed(4)));
  assert.ok(cal.quantiles.length >= 1);
  for (const q of cal.quantiles) assert.ok(q.files > 0 && q.defectRate >= 0 && q.defectRate <= 1);
  assert.equal(cal.defective, 2);
  assert.match(cal.verdict, /AUC/);
  assert.match(cal.verdict, /Severity-only baseline/);
  // The cut point is derived, never Date.now().
  assert.equal(typeof cal.params.cut, 'string');
});

test('calibrateLintRank: a small positive count is called out as unreadable', () => {
  const commits = [];
  for (let i = 0; i < 20; i++) commits.push(commit(`h${i}`, '2026-01-05T00:00:00Z', 'feat: work', [`src/f${i}.js`]));
  commits.push(commit('fx', '2026-03-10T00:00:00Z', 'fix: repair', ['src/f0.js']));
  const findings = Array.from({ length: 20 }, (_, i) => ({
    tool: 'eslint', ruleId: 'r', level: 'warning', message: 'm', file: `src/f${i}.js`, startLine: 1, fingerprint: `p${i}`
  }));
  const cal = calibrateLintRank(findings, commits, { horizonDays: 30, minEvaluated: 20 });
  assert.equal(cal.defective, 1);
  assert.match(cal.verdict, /too few outcomes to say|Too few findings to say|statistically meaningless/i);
});

test('calibrateLintRank: deterministic — no clocks anywhere in the pure path', () => {
  const commits = [
    commit('a1', '2026-01-01T00:00:00Z', 'feat: x', ['src/a.js']),
    commit('a2', '2026-03-01T00:00:00Z', 'fix: y', ['src/a.js'])
  ];
  const findings = [{ tool: 'eslint', ruleId: 'r', level: 'error', message: 'm', file: 'src/a.js', startLine: 1, fingerprint: '1' }];
  const a = JSON.stringify(calibrateLintRank(findings, commits, { horizonDays: 30 }));
  const b = JSON.stringify(calibrateLintRank(findings, commits, { horizonDays: 30 }));
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// CLI (subprocess)
// ---------------------------------------------------------------------------

function git(dir, args) {
  execFileSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com'
    }
  });
}

/** A scripted repo: two source files, one imported by the other, with history. */
function scriptedRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-repo-')));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'src', 'core.mjs'), 'export const core = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'leaf.mjs'), "import { core } from './core.mjs';\nexport const leaf = core;\n");
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'feat: initial']);
  // Give core.mjs a churn + fix history that leaf.mjs does not have.
  for (let i = 0; i < 4; i++) {
    fs.appendFileSync(path.join(dir, 'src', 'core.mjs'), `export const v${i} = ${i};\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', i % 2 ? `fix: repair core ${i}` : `feat: extend core ${i}`]);
  }
  return dir;
}

test('CLI: --sarif on a scripted repo ranks the hot, imported file above the leaf', () => {
  const dir = scriptedRepo();
  try {
    const sarif = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'eslint' } },
        results: [
          // A mere NOTE in the hot, imported file …
          result({ ruleId: 'style/quotes', level: 'note', text: 'prefer single quotes', uri: `file://${dir}/src/core.mjs`, startLine: 1 }),
          // … versus a hard ERROR in the leaf nobody imports.
          result({ ruleId: 'no-undef', level: 'error', text: "'x' is not defined", uri: `file://${dir}/src/leaf.mjs`, startLine: 2 })
        ]
      }]
    };
    const sarifPath = path.join(dir, 'report.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify(sarif));

    const stdout = execFileSync(process.execPath, [SCRIPT, '--sarif', sarifPath, '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BRAIN_ROOT: dir, BRAIN_LINT_ESLINT: '0', BRAIN_LINT_RUFF: '0', BRAIN_LINT_GOLANGCI: '0', BRAIN_LINT_CLIPPY: '0', BRAIN_LINT_PHPSTAN: '0' }
    });
    const report = JSON.parse(stdout);

    assert.equal(report.claims.anyToolRan, true, 'the --sarif file counts as a tool that ran');
    assert.equal(report.total, 2);
    assert.equal(report.ranking.available, true);
    assert.equal(report.ranking.inputs.hotspots, true);
    assert.equal(report.ranking.inputs.graph, true);

    const [top, second] = report.findings;
    assert.equal(top.file, 'src/core.mjs');
    assert.equal(top.level, 'note');
    assert.equal(second.file, 'src/leaf.mjs');
    assert.equal(second.level, 'error');
    assert.ok(top.weight > second.weight, 'churn + dependents + fix density beat raw severity here');

    // The receipts are present and carry numbers.
    const kinds = top.reasons.map((r) => r.kind);
    for (const kind of ['severity', 'churn', 'dependents', 'fix-density']) assert.ok(kinds.includes(kind), `missing reason: ${kind}`);
    assert.match(top.reasons.find((r) => r.kind === 'churn').message, /churn rank #1 of 2/);
    assert.match(top.reasons.find((r) => r.kind === 'dependents').message, /1 file\(s\) transitively import this/);
    assert.match(top.reasons.find((r) => r.kind === 'fix-density').message, /fix\/revert/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --sarif --calibrate on a tiny repo answers "too few", not a number', () => {
  const dir = scriptedRepo();
  try {
    const sarifPath = path.join(dir, 'report.sarif');
    fs.writeFileSync(sarifPath, JSON.stringify({
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'eslint' } }, results: [result({ uri: `file://${dir}/src/core.mjs`, startLine: 1 })] }]
    }));
    const stdout = execFileSync(process.execPath, [SCRIPT, '--sarif', sarifPath, '--calibrate', '--json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: dir }
    });
    const { calibration } = JSON.parse(stdout);
    assert.equal(calibration.auc, null);
    assert.match(calibration.verdict, /too few|nothing to calibrate|undefined/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: no tool present → exit 0, every absence stated, no false clean claim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-cli-empty-'));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--json'], {
      cwd: dir,
      encoding: 'utf8',
      // Force the absent-tool path regardless of what is installed on this
      // machine — the assertion is about the DEGRADED contract.
      env: {
        ...process.env,
        BRAIN_ROOT: dir,
        BRAIN_LINT_ESLINT: '0', BRAIN_LINT_RUFF: '0', BRAIN_LINT_GOLANGCI: '0',
        BRAIN_LINT_CLIPPY: '0', BRAIN_LINT_PHPSTAN: '0'
      }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.claims.anyToolRan, false);
    assert.equal(report.claims.cleanBillOfHealth, false);
    assert.equal(report.total, 0);
    assert.deepEqual(report.findings, []);
    assert.match(report.statement, /NOT scanned/);
    for (const t of report.tools) assert.match(t.reason, /=0/);
    assert.match(JSON.stringify(report.provenance.notes), /not scanned/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the human report states tools, caveats and one next action', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-cli-human-'));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BRAIN_ROOT: dir, BRAIN_LINT_ESLINT: '0', BRAIN_LINT_RUFF: '0', BRAIN_LINT_GOLANGCI: '0', BRAIN_LINT_CLIPPY: '0', BRAIN_LINT_PHPSTAN: '0' }
    });
    assert.match(stdout, /Tools:/);
    assert.match(stdout, /ABSENT/);
    assert.match(stdout, /NOT scanned/);
    assert.match(stdout, /Rank caveat:/);
    assert.match(stdout, /Calibration: LINT_RANK_WEIGHTS are REVIEWABLE DEFAULTS/);
    assert.match(stdout, /\nNext: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --help exits 0, runs nothing, and says the weights are uncalibrated', () => {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(stdout, /Usage: lint-intel\.mjs/);
  assert.match(stdout, /THE WEIGHTS ARE NOT CALIBRATED/);
  assert.match(stdout, /--sarif <path>/);
});

test('CLI: --tool narrows the run and says so for the others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-intel-cli-tool-'));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--tool', 'ruff', '--json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: dir }
    });
    const report = JSON.parse(stdout);
    const others = report.tools.filter((t) => t.name !== 'ruff');
    for (const t of others) assert.match(t.reason, /not selected \(--tool ruff\)/);
    assert.equal(report.claims.cleanBillOfHealth, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
