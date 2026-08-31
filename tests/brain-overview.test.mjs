/**
 * brain:overview — the whole repository in under 2,000 tokens.
 *
 * An agent meeting a repository burns its tokens SEARCHING and DISCARDING, not
 * reading answers: `grep -i approv` returns 305 files, and semantic search put
 * documentation above the authorization code it was asked for. Everything
 * needed to skip that is already measured — this is a composer with a budget,
 * and the budget is the feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeOverview, DEFAULT_BUDGET_BYTES } from '../scripts/brain-overview.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/brain-overview.mjs', import.meta.url));
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const FULL = {
  name: 'demo',
  files: 400, languages: { ts: 300, js: 50 }, commits: 500, spanDays: 88, authors: 4,
  mostDependedOn: Array.from({ length: 12 }, (_, i) => ({ file: `lib/m${i}.ts`, count: 100 - i })),
  dangerous: Array.from({ length: 12 }, (_, i) => ({ file: `app/d${i}.ts`, score: 9 - i / 10, why: 'churn-percentile' })),
  calibration: { auc: 0.83, sufficientEvidence: true, minorityClass: 40 },
  owners: [{ prefix: 'lib', top: 'ana', share: 0.62, busFactor: 2 }],
  modules: ['Auth', 'Billing'], decisions: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
  cycles: 20, orphans: 3, unresolvedRatio: 0.42
};

test('composeOverview: need-to-know order, and it fits the budget', () => {
  const r = composeOverview(FULL);
  assert.ok(r.bytes <= DEFAULT_BUDGET_BYTES, `over budget: ${r.bytes} B`);
  // Load-bearing before dangerous before ownership: what an unfamiliar reader
  // needs first is what the whole codebase leans on, not who wrote it.
  const iLoad = r.text.indexOf('## Load-bearing');
  const iDanger = r.text.indexOf('## Most dangerous');
  const iOwners = r.text.indexOf('## Who knows what');
  assert.ok(iLoad > 0 && iLoad < iDanger && iDanger < iOwners, 'sections are out of order');
  assert.match(r.text, /lib\/m0\.ts — 100 dependent\(s\)/);
  assert.match(r.text, /4617|400 tracked file\(s\), 350 of them code/);
  assert.match(r.text, /No model, no network/);
});

test('composeOverview: every omission is named, never silent', () => {
  const r = composeOverview(FULL);
  // 12 load-bearing and 12 dangerous against a top-8 cut, 7 decisions against 5.
  assert.ok(r.omitted.some((o) => /4 more load-bearing/.test(o)), JSON.stringify(r.omitted));
  assert.ok(r.omitted.some((o) => /4 more scored file/.test(o)));
  assert.ok(r.omitted.some((o) => /2 more decision/.test(o)));
  assert.match(r.text, /Left out by the \d+ B budget:/);
});

test('composeOverview: a score never appears without its receipt', () => {
  // The overclaim this repo spent a week removing from its own tools.
  const strong = composeOverview(FULL);
  assert.match(strong.text, /AUC 0\.83 against this repo's own fix history — the ranking holds here/);

  const weak = composeOverview({ ...FULL, calibration: { auc: 0.91, sufficientEvidence: false, minorityClass: 3 } });
  assert.match(weak.text, /only 3 file\(s\) in the smaller class — measured, NOT established/);
  assert.doesNotMatch(weak.text, /ranking holds here/);

  const none = composeOverview({ ...FULL, calibration: {} });
  assert.match(none.text, /Not calibratable on this repo yet/);
});

test('composeOverview: a tight budget cuts from the END and says how much', () => {
  const tight = composeOverview({ ...FULL, budgetBytes: 700 });
  assert.ok(tight.bytes <= 700, `budget blown: ${tight.bytes} B`);
  // The reader loses the least important section first, and keeps the header
  // and the load-bearing list — the two things worth 700 bytes.
  assert.match(tight.text, /# demo — overview/);
  assert.match(tight.text, /## Load-bearing/);
  assert.ok(tight.omitted.some((o) => /trailing section/.test(o)), JSON.stringify(tight.omitted));
});

test('composeOverview: missing measurements are reported, never invented', () => {
  const bare = composeOverview({ name: 'empty' });
  assert.match(bare.text, /# empty — overview/);
  assert.ok(!/## Load-bearing/.test(bare.text), 'no graph → no load-bearing claims');
  assert.ok(!/## Most dangerous/.test(bare.text));
  assert.ok(bare.bytes < 400, `an empty repo should be tiny, got ${bare.bytes} B`);

  const broken = composeOverview({ name: 'x', graphDegraded: 'no readable source files' });
  assert.match(broken.text, /Load-bearing — not measured: no readable source files/);
});

test('composeOverview: deterministic — same input, byte-identical output', () => {
  // ADR 0030: a claim is re-derivable. That is what made this week's defects
  // findable at all.
  assert.equal(composeOverview(FULL).text, composeOverview(FULL).text);
});

test('brain-overview.mjs: runs on this repo inside the budget', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const bytes = Buffer.byteLength(r.stdout, 'utf8');
  assert.ok(bytes > 300, 'suspiciously empty for a real repo');
  assert.ok(bytes <= DEFAULT_BUDGET_BYTES, `over budget on a real repo: ${bytes} B`);
  assert.match(r.stdout, /## Load-bearing/);
  assert.match(r.stdout, /No model, no network/);
});
