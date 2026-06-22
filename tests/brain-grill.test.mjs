import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure exports — importing the script must NOT run its CLI (isMain guard).
import { generateChallenges, renderInterview } from '../scripts/brain-grill.mjs';
import { serializeGrill, parseGrill, GRILL_VERDICTS } from '../scripts/findings.mjs';
import { inferType } from '../scripts/infer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const GRILL_SCRIPT = path.join(scriptsDir, 'brain-grill.mjs');

// ---------------------------------------------------------------------------
// inferType registration
// ---------------------------------------------------------------------------

test('inferType: .project-brain/grills/*.md → grill', () => {
  assert.equal(inferType('.project-brain/grills/grill-fix-x.md'), 'grill');
});

// ---------------------------------------------------------------------------
// grill record (de)serialization
// ---------------------------------------------------------------------------

test('grill roundtrip preserves every field incl. nested sources', () => {
  const rec = {
    title: 'Cache hybridScore',
    target: 'cache-hybridscore',
    targetType: 'finding',
    category: 'performance',
    verdict: 'revise',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    actor: 'tester',
    module: 'scripts/retrieval',
    sources: [{ path: 'scripts/retrieval.mjs', sha256: 'a'.repeat(64) }, { path: 'gone.mjs', sha256: null }],
    body: '## Contract\n1. q\n   - **A:** answer\n'
  };
  const md = serializeGrill(rec);
  assert.match(md, /^type: grill$/m);
  assert.match(md, /^verdict: revise$/m);

  const back = parseGrill(md);
  assert.equal(back.title, rec.title);
  assert.equal(back.target, rec.target);
  assert.equal(back.targetType, 'finding');
  assert.equal(back.category, 'performance');
  assert.equal(back.verdict, 'revise');
  assert.equal(back.module, 'scripts/retrieval');
  assert.equal(back.sources.length, 2);
  assert.equal(back.sources[0].path, 'scripts/retrieval.mjs');
  assert.equal(back.sources[0].sha256, 'a'.repeat(64));
  assert.equal(back.sources[1].sha256, null);
  assert.match(back.body, /answer/);
});

test('grill verdict vocabulary is the documented set', () => {
  assert.deepEqual(GRILL_VERDICTS, ['open', 'proceed', 'revise', 'block']);
});

// ---------------------------------------------------------------------------
// generateChallenges — the pure adversarial-question core
// ---------------------------------------------------------------------------

test('generateChallenges: blast-radius produces grounded contract + test questions', () => {
  const challenges = generateChallenges({
    targetType: 'finding',
    category: 'performance',
    blast: [
      { symbol: 'hybridScore', callerFiles: ['a.mjs', 'b.mjs'], testFiles: ['x.test.mjs'], crossInbound: [{ from: 'workers', kind: 'http-client' }] },
      { symbol: 'tfidfScore', callerFiles: ['c.mjs'], testFiles: [], crossInbound: [] }
    ]
  });
  const text = JSON.stringify(challenges);
  // contract question names the symbol + caller count
  assert.match(text, /hybridScore/);
  assert.match(text, /2 caller file/);
  // cross-project consumer surfaced
  assert.match(text, /workers via http-client/);
  // symbol with dependents but no tests → "regression test you will add"
  assert.match(text, /no tests in the index/);
  // category bank present
  assert.ok(challenges.some(c => c.section === 'Performance'));
  // generic always present
  assert.ok(challenges.some(c => c.section === 'Fundamentals'));
});

test('generateChallenges: ADRs and related findings become explicit challenges', () => {
  const challenges = generateChallenges({
    targetType: 'finding',
    category: 'correctness',
    adrs: [{ decision: '0014-lexical-candidate-union', title: 'Lexical union' }],
    relatedFindings: [{ slug: 'other-bug', title: 'Other bug', status: 'open' }]
  });
  const text = JSON.stringify(challenges);
  assert.match(text, /0014-lexical-candidate-union/);
  assert.match(text, /supersede/);
  assert.match(text, /other-bug/);
  assert.ok(challenges.some(c => c.section === 'Decisions'));
  assert.ok(challenges.some(c => c.section === 'Conflicts'));
});

test('generateChallenges: with no evidence still asks category + generic (model-free path)', () => {
  const challenges = generateChallenges({ targetType: 'proposal', category: 'security' });
  assert.ok(challenges.length >= 6); // 2 security + 5 generic
  assert.ok(challenges.some(c => c.section === 'Security'));
  assert.ok(challenges.some(c => c.section === 'Fundamentals'));
  // No fabricated contract/decision questions without evidence.
  assert.ok(!challenges.some(c => c.section === 'Contract'));
  assert.ok(!challenges.some(c => c.section === 'Decisions'));
});

test('renderInterview: numbers questions sequentially across sections + emits answer slots', () => {
  const challenges = generateChallenges({ targetType: 'proposal', category: 'testing' });
  const md = renderInterview({ title: 'T', target: 't', targetType: 'proposal', category: 'testing' }, challenges);
  assert.match(md, /^# Grill: T$/m);
  assert.match(md, /^## Testing$/m);
  assert.match(md, /^## Fundamentals$/m);
  assert.match(md, /\*\*A:\*\*/);
  assert.match(md, /## Verdict/);
  // Sequential numbering: there is a "1." and the count matches challenges.
  const nums = (md.match(/^\d+\. /gm) || []).length;
  assert.equal(nums, challenges.length);
});

// ---------------------------------------------------------------------------
// CLI: save → check staleness lifecycle (reuses evaluateExplainers/hashSource)
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grill-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 1;\n');
  return cwd;
}
function runGrill(cwd, args, input) {
  return spawnSync(process.execPath, [GRILL_SCRIPT, ...args], { cwd, encoding: 'utf8', input });
}

test('CLI save writes a grill record; check reports fresh, then STALE after source drift', () => {
  const cwd = makeRepo();
  const save = runGrill(cwd, ['save', '--title', 'Cache it', '--target-type', 'proposal', '--category', 'performance', '--verdict', 'proceed', '--sources', 'src.mjs'], 'A: defended.\n');
  assert.equal(save.status, 0, save.stderr);
  assert.match(save.stdout, /\.project-brain\/grills\/grill-cache-it\.md/);

  const fresh = runGrill(cwd, ['check', '--json']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).stale, 0);

  // Mutate the cited source → grill goes stale.
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 2;\n');
  const stale = runGrill(cwd, ['check', '--json']);
  assert.equal(JSON.parse(stale.stdout).stale, 1);
  // --strict exits non-zero on stale.
  const strict = runGrill(cwd, ['check', '--strict']);
  assert.equal(strict.status, 1);
});

test('CLI list shows the verdict and is JSON-clean', () => {
  const cwd = makeRepo();
  runGrill(cwd, ['save', '--title', 'Ship X', '--verdict', 'block', '--sources', 'src.mjs'], 'no.\n');
  const list = runGrill(cwd, ['list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  const rows = JSON.parse(list.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'block');
});
