import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  extractDocSymbols,
  liveSymbolSet,
  extractCitedPaths,
  isIllustrativePath,
  hasEmptyRationale,
  findCoverageGaps,
  findDecisionDecay,
  findContradictions,
  runGaps
} from '../scripts/brain-gaps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'scripts', 'brain-gaps.mjs');

const NOW = Date.parse('2026-06-01T00:00:00Z');
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// ===========================================================================
// (a) COVERAGE GAPS
// ===========================================================================

test('coverage: flags a module with code but no decision and no module doc', () => {
  const records = [
    { type: 'code', file: 'lib/pay/charge.mjs', module: 'lib/pay', mtime: ago(1) },
    // lib/auth is covered by a module doc → not flagged
    { type: 'code', file: 'lib/auth/login.mjs', module: 'lib/auth', mtime: ago(1) },
    { type: 'module', file: '.project-brain/modules/auth.md', module: 'lib/auth', text: '# auth' }
  ];
  const gaps = findCoverageGaps(records);
  const undoc = gaps.filter(g => g.subkind === 'undocumented-module');
  assert.equal(undoc.length, 1);
  assert.equal(undoc[0].module, 'lib/pay');
  assert.equal(undoc[0].severity, 'medium');
});

test('coverage: a decision referencing the module in its body counts as coverage', () => {
  const records = [
    { type: 'code', file: 'lib/pay/charge.mjs', module: 'lib/pay', mtime: ago(1) },
    {
      type: 'decision',
      file: '.project-brain/decisions/0001-pay.md',
      // no module frontmatter field, but mentions the module path in prose
      text: '# Payments\n## Context\nWe wire lib/pay through Stripe with strong idempotency guarantees and retries.'
    }
  ];
  const undoc = findCoverageGaps(records).filter(g => g.subkind === 'undocumented-module');
  assert.equal(undoc.length, 0, 'body reference to module path satisfies coverage');
});

test('coverage: flags a feature with code but no tests; clears when a test record exists', () => {
  const withoutTest = [
    { type: 'code', file: 'app/checkout/page.tsx', feature: 'checkout', mtime: ago(1) }
  ];
  const g1 = findCoverageGaps(withoutTest).filter(g => g.subkind === 'untested-feature');
  assert.equal(g1.length, 1);
  assert.equal(g1[0].feature, 'checkout');
  assert.equal(g1[0].severity, 'high');

  const withTest = [
    ...withoutTest,
    { type: 'code', file: 'tests/checkout.test.mjs', feature: 'checkout', mtime: ago(1) }
  ];
  const g2 = findCoverageGaps(withTest).filter(g => g.subkind === 'untested-feature');
  assert.equal(g2.length, 0, 'a test record clears the untested-feature gap');
});

test('coverage: flags a decision with a Needs-Review / empty rationale', () => {
  const records = [
    {
      type: 'decision',
      file: '.project-brain/decisions/0009-stub.md',
      text: '# Some decision\n\nNeeds Review'
    },
    {
      type: 'decision',
      file: '.project-brain/decisions/0010-good.md',
      text: '# Good decision\n## Decision\nWe will adopt X because it removes the duplicate code path and is measurably faster on the hot loop.\n## Consequences\nLess code to maintain.'
    }
  ];
  const empties = findCoverageGaps(records).filter(g => g.subkind === 'empty-rationale');
  assert.equal(empties.length, 1);
  assert.match(empties[0].file, /0009-stub/);
});

test('hasEmptyRationale: heading with no prose beneath is empty; substantive prose is not', () => {
  assert.equal(hasEmptyRationale('# T\n## Decision\n\n## Consequences\nstuff happens here'), true);
  assert.equal(hasEmptyRationale('# T\n## Decision\nWe pick A over B because the coupling is lower and tests pass.'), false);
  assert.equal(hasEmptyRationale('# T\n\nNeeds Review'), true);
});

test('coverage: synthetic/summary/template records are ignored', () => {
  const records = [
    { type: 'module-summary', isSummary: true, file: '.project-brain/modules/x.md', module: 'lib/x', mtime: ago(1) },
    { type: 'code', file: 'templates/brain/findings/_template.md', module: 'templates', mtime: ago(1) },
    { type: 'code', file: 'lib/real/a.mjs', module: 'lib/real', mtime: ago(1) }
  ];
  const undoc = findCoverageGaps(records).filter(g => g.subkind === 'undocumented-module');
  // only lib/real should be considered (summary + template skipped)
  assert.deepEqual(undoc.map(g => g.module), ['lib/real']);
});

// ===========================================================================
// (b) DECISION DECAY
// ===========================================================================

test('decay: flags an old decision whose module code changed after it', () => {
  const records = [
    { type: 'decision', file: '.project-brain/decisions/0002-retr.md', module: 'scripts', mtime: ago(200) },
    { type: 'code', file: 'scripts/retrieval.mjs', module: 'scripts', mtime: ago(10) } // churned after ADR
  ];
  const gaps = findDecisionDecay(records, { now: NOW, decayDays: 90 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].subkind, 'decision-decay');
  assert.equal(gaps[0].module, 'scripts');
  assert.ok(gaps[0].ageDays >= 90);
  assert.ok(gaps[0].churnLagDays > 0);
});

test('decay: a recent decision is not flagged even if code changed after it', () => {
  const records = [
    { type: 'decision', file: '.project-brain/decisions/0003.md', module: 'scripts', mtime: ago(30) },
    { type: 'code', file: 'scripts/a.mjs', module: 'scripts', mtime: ago(5) }
  ];
  assert.equal(findDecisionDecay(records, { now: NOW, decayDays: 90 }).length, 0);
});

test('decay: an old decision whose module code is older than the ADR is not flagged', () => {
  const records = [
    { type: 'decision', file: '.project-brain/decisions/0004.md', module: 'scripts', mtime: ago(200) },
    { type: 'code', file: 'scripts/a.mjs', module: 'scripts', mtime: ago(300) } // code predates ADR
  ];
  assert.equal(findDecisionDecay(records, { now: NOW, decayDays: 90 }).length, 0);
});

test('decay: prefers a Date: line embedded in the decision body over mtime', () => {
  const records = [
    {
      type: 'decision',
      file: '.project-brain/decisions/0005.md',
      module: 'scripts',
      mtime: ago(1), // mtime says fresh…
      text: '# T\ndate: 2025-01-01\n## Decision\nold call'
    },
    { type: 'code', file: 'scripts/a.mjs', module: 'scripts', mtime: ago(10) }
  ];
  const gaps = findDecisionDecay(records, { now: NOW, decayDays: 90 });
  assert.equal(gaps.length, 1, 'body date (2025-01-01) is old enough to decay despite fresh mtime');
});

// ===========================================================================
// (c) STRUCTURAL CONTRADICTIONS
// ===========================================================================

test('extractDocSymbols picks code-ish backticked tokens, skips prose/paths/env', () => {
  const out = extractDocSymbols('Call `hybridScore()` and `withStateLock`, see `lib/db.ts`. `lease` and `BRAIN_TASK` are not.');
  assert.ok(out.includes('hybridScore'));
  assert.ok(out.includes('withStateLock'));
  assert.ok(!out.includes('lib/db.ts'));
  assert.ok(!out.includes('lease'));
  assert.ok(!out.includes('BRAIN_TASK'));
});

test('liveSymbolSet only collects from code records', () => {
  const live = liveSymbolSet([
    { type: 'code', symbols: ['hybridScore'], exportedSymbols: ['tfidfScore'] },
    { type: 'decision', symbols: ['Ignored'] }
  ]);
  assert.ok(live.has('hybridscore'));
  assert.ok(live.has('tfidfscore'));
  assert.ok(!live.has('ignored'));
});

test('contradictions: flags symbol-drift for a renamed symbol still named in an ADR', () => {
  const records = [
    { type: 'code', file: 'scripts/retrieval.mjs', symbols: ['hybridScore'], text: 'export function hybridScore() {}' },
    { type: 'decision', file: '.project-brain/decisions/0001.md', text: 'We use `legacyScore()` to rank.' }
  ];
  const { gaps, symbolDriftChecked } = findContradictions(records, { fileExists: () => true, dirExists: () => true });
  assert.equal(symbolDriftChecked, true);
  const drift = gaps.filter(g => g.subkind === 'symbol-drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].symbol, 'legacyScore');
});

test('contradictions: symbol-drift auto-skips when no code symbols are indexed', () => {
  const records = [
    { type: 'decision', file: '.project-brain/decisions/0001.md', text: 'Uses `SomeStruct`.' }
  ];
  const { gaps, symbolDriftChecked } = findContradictions(records, { fileExists: () => true, dirExists: () => true });
  assert.equal(symbolDriftChecked, false);
  assert.equal(gaps.filter(g => g.subkind === 'symbol-drift').length, 0);
});

test('contradictions: flags a cited path missing on disk when its directory still exists', () => {
  const records = [
    { type: 'code', file: 'scripts/a.mjs', symbols: ['foo'], text: 'export const foo = 1;' },
    {
      type: 'module',
      file: '.project-brain/modules/x.md',
      text: 'See `scripts/gone.mjs` and `scripts/a.mjs` for details.'
    }
  ];
  const fileExists = (p) => p === 'scripts/a.mjs'; // gone.mjs does not exist
  const dirExists = (p) => p === 'scripts';        // but scripts/ still does
  const { gaps } = findContradictions(records, { fileExists, dirExists });
  const pathDrift = gaps.filter(g => g.subkind === 'path-drift');
  assert.equal(pathDrift.length, 1);
  assert.equal(pathDrift[0].citedPath, 'scripts/gone.mjs');
  assert.equal(pathDrift[0].severity, 'high');
});

test('contradictions: a missing path whose directory is ALSO gone is treated as illustrative (skipped)', () => {
  const records = [
    { type: 'code', file: 'scripts/a.mjs', symbols: ['foo'], text: 'export const foo = 1;' },
    { type: 'module', file: '.project-brain/modules/x.md', text: 'Maybe `oldpkg/legacy/thing.mjs` once existed.' }
  ];
  const { gaps } = findContradictions(records, { fileExists: () => false, dirExists: () => false });
  assert.equal(gaps.filter(g => g.subkind === 'path-drift').length, 0, 'whole dir absent → not a confident drift signal');
});

test('extractCitedPaths returns concrete dir-separated citations, dropping urls/bare names/placeholders', () => {
  const paths = extractCitedPaths('see `scripts/a.mjs`, `README.md`, https://example.com/x.md, `docs/guide.md`, `lib/foo.ts`, `specs/X/spec.md`');
  assert.ok(paths.includes('scripts/a.mjs'));
  assert.ok(paths.includes('docs/guide.md'));
  assert.ok(!paths.includes('README.md'), 'bare filename (no dir) is too ambiguous → skipped');
  assert.ok(!paths.some(p => p.startsWith('http')), 'urls excluded');
  assert.ok(!paths.includes('lib/foo.ts'), 'placeholder segment foo → skipped');
  assert.ok(!paths.includes('specs/X/spec.md'), 'opt-in spec-kit + placeholder X → skipped');
});

test('isIllustrativePath filters placeholders, runtime artifacts, and opt-in roots', () => {
  // illustrative / runtime / opt-in → true
  for (const p of [
    'lib/foo.ts', 'src/bar.ts', 'specs/X/spec.md', 'specs/something.md',
    '.project-brain/.active_state.lock', '.project-brain/.sync-bg.lock',
    '.project-brain/sessions/2026-01-01.md', '.claude/settings.json',
    '.specify/memory/constitution.md', 'history/YYYY-MM.md', 'node_modules/x/y.js'
  ]) assert.equal(isIllustrativePath(p), true, `should be illustrative: ${p}`);
  // real, concrete source paths → false
  for (const p of ['scripts/brain-gaps.mjs', 'docs/eval-methodology.md', 'lib/auth/session.ts'])
    assert.equal(isIllustrativePath(p), false, `should be concrete: ${p}`);
});

// ===========================================================================
// runGaps aggregation
// ===========================================================================

test('runGaps aggregates the three checks, sorts by severity, and counts', () => {
  const records = [
    // untested feature 'checkout' (high)
    { type: 'code', file: 'app/checkout/page.tsx', feature: 'checkout', module: 'app/checkout', mtime: ago(1) },
    // undocumented module 'app/checkout' (medium) — no doc/decision
    // old decayed decision (medium)
    { type: 'decision', file: '.project-brain/decisions/0001.md', module: 'scripts', mtime: ago(200) },
    { type: 'code', file: 'scripts/a.mjs', module: 'scripts', symbols: ['foo'], text: 'export const foo=1;', mtime: ago(5) },
    // path-drift (high): cites a concrete missing file whose dir still exists
    { type: 'module', file: '.project-brain/modules/m.md', module: 'lib/m', text: 'See `lib/m/removed.mjs`.' },
    { type: 'code', file: 'lib/m/a.mjs', module: 'lib/m', mtime: ago(1) } // doc present → module m not "undocumented"
  ];
  const report = runGaps(records, {
    now: NOW, decayDays: 90,
    fileExists: (p) => !p.includes('removed'),
    dirExists: () => true
  });
  assert.equal(report.ok, false);
  assert.ok(report.counts.total >= 4, JSON.stringify(report.counts));
  assert.ok(report.counts.high >= 2);
  // highest-severity gaps sort first
  assert.equal(report.gaps[0].severity, 'high');
  assert.ok(report.symbolDriftChecked);
});

test('runGaps reports clean state for a fully-covered fixture', () => {
  const records = [
    { type: 'code', file: 'lib/a/a.mjs', module: 'lib/a', feature: 'fa', symbols: ['foo'], text: 'export const foo=1;', mtime: ago(2) },
    { type: 'code', file: 'tests/a.test.mjs', module: 'lib/a', feature: 'fa', mtime: ago(1) },
    { type: 'module', file: '.project-brain/modules/a.md', module: 'lib/a', text: 'documents `foo`.' }
  ];
  const report = runGaps(records, { now: NOW, decayDays: 90, fileExists: () => true });
  assert.equal(report.ok, true, JSON.stringify(report.counts));
  assert.equal(report.counts.total, 0);
});

// ===========================================================================
// spawn test: --json + --as-findings writes finding files (real CLI, JSON store)
// ===========================================================================

function seedRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-gaps-'));
  const brain = path.join(cwd, '.project-brain');
  fs.mkdirSync(brain, { recursive: true });
  // A real on-disk source so a cited path resolves, plus an absent one to flag.
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'a.mjs'), 'export const foo = 1;\n');

  const records = [
    // untested feature 'checkout' (high)
    { id: '1', file: 'app/checkout/page.tsx', type: 'code', feature: 'checkout', module: 'app/checkout', mtime: ago(2), text: 'x', chunk: 0, vector: [] },
    // module 'app/checkout' undocumented (medium)
    // symbol-drift in a module doc (medium): names GoneSymbol, not in code
    { id: '2', file: '.project-brain/modules/m.md', type: 'module', module: 'lib/m', text: 'Uses `GoneSymbol()` and cites `scripts/missing.mjs` and `scripts/a.mjs`.', chunk: 0, vector: [] },
    // a real code record so liveSymbolSet is non-empty (symbol-drift runs)
    { id: '3', file: 'scripts/a.mjs', type: 'code', module: 'scripts', symbols: ['foo'], text: 'export const foo = 1;', mtime: ago(2), chunk: 0, vector: [] }
  ];
  fs.writeFileSync(
    path.join(brain, 'search_index.json'),
    JSON.stringify({ version: 2, backend: 'json', model: 'test', records }, null, 2)
  );
  return cwd;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_STORE: 'json', BRAIN_QUIET: '1', BRAIN_EMBED_PROVIDER: 'local' }
  });
}

test('spawn: --json reports gaps without mutating (read-only default)', () => {
  const cwd = seedRepo();
  const r = runCli(cwd, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.counts.total >= 3, JSON.stringify(report.counts));
  // read-only: no findings directory created
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain', 'findings')), false);
  assert.deepEqual(report.findingsWritten, []);
});

test('spawn: --as-findings writes one finding file per gap (reusing serializeFinding)', () => {
  const cwd = seedRepo();
  const r = runCli(cwd, ['--json', '--as-findings']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.ok(report.findingsWritten.length >= 3, JSON.stringify(report.findingsWritten));

  const findingsDir = path.join(cwd, '.project-brain', 'findings');
  assert.ok(fs.existsSync(findingsDir), 'findings dir created');
  const files = fs.readdirSync(findingsDir).filter(f => f.endsWith('.md'));
  assert.ok(files.length >= 3);
  // every emitted file is a valid finding record
  for (const f of files) {
    const body = fs.readFileSync(path.join(findingsDir, f), 'utf8');
    assert.match(body, /^type: finding$/m);
    assert.match(body, /^status: open$/m);
    assert.match(body, /brain:gaps/);
    assert.ok(f.startsWith('gap-'), `slug prefixed: ${f}`);
  }

  // idempotent: a second run preserves `created` and does not multiply files
  const before = fs.readdirSync(findingsDir).filter(f => f.endsWith('.md')).length;
  const createdBefore = fs.readFileSync(path.join(findingsDir, files[0]), 'utf8').match(/^created: (.*)$/m)[1];
  const r2 = runCli(cwd, ['--as-findings']);
  assert.equal(r2.status, 0, r2.stderr);
  const after = fs.readdirSync(findingsDir).filter(f => f.endsWith('.md')).length;
  assert.equal(after, before, 'no duplicate finding files on re-run');
  const createdAfter = fs.readFileSync(path.join(findingsDir, files[0]), 'utf8').match(/^created: (.*)$/m)[1];
  assert.equal(createdAfter, createdBefore, 'created timestamp preserved (idempotent)');
});

test('spawn: --strict exits non-zero when gaps exist', () => {
  const cwd = seedRepo();
  const r = runCli(cwd, ['--strict', '--json']);
  assert.equal(r.status, 1, 'strict + gaps → non-zero exit');
});

test('spawn: --help exits 0 and prints usage', () => {
  const cwd = seedRepo();
  const r = runCli(cwd, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain:gaps/);
  assert.match(r.stdout, /--as-findings/);
});
