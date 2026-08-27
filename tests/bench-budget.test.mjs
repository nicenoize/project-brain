/**
 * CI latency budgets — the red-build half of the performance story.
 *
 * The numbers live in ONE place, BUDGETS in scripts/footprint.mjs, exactly like
 * the byte budgets in tests/footprint-budget.test.mjs. This file is that file's
 * millisecond sibling and mirrors its shape deliberately.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT REFUSES TO DO.
 * It catches ORDER-OF-MAGNITUDE regressions on the three paths everything else
 * waits on: the Control-Room read (/api/state), the ambient per-edit hook, and
 * the whole-repo import scan. It does NOT police percent-level drift. That is
 * scripts/bench.mjs --against's job, where both readings come from the same
 * machine and the noise band is measured rather than assumed.
 *
 * WHY THE HEADROOM IS SO LARGE (~15-20×). A flaky perf test cries wolf, and a
 * test that cries wolf gets `skip`-ed by whoever is trying to ship on a Friday
 * — within a week, and permanently. A budget that only fires on a genuine bug
 * is worth more than a tight one nobody trusts. The comment block on BUDGETS
 * records the measured medians these were derived from.
 *
 * WHY IT CAN SKIP ITSELF. Wall-clock assertions are only meaningful on a
 * machine that is actually running us. Before asserting anything, a trivial
 * busy loop is sampled and its jitter measured; if the box is descheduling us
 * hard, the budgets are SKIPPED with a stated reason rather than failed. A skip
 * says "no evidence"; a failure would claim "the code got slower", which would
 * be a lie about someone else's noisy CI runner. The calibration is
 * self-referential (spread of the loop against itself) rather than a
 * hard-coded expected duration, because a hard-coded ms expectation is itself a
 * cross-machine claim — the exact thing bench.mjs exists to avoid making.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { BUDGETS } from '../scripts/footprint.mjs';
import {
  calibrateMachine, calibrationVerdict, measureImportScan, measureAnswerHookLatency,
  apiPassInProcess, LOAD_JITTER_RATIO
} from '../scripts/bench.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Samples per budgeted case. 3 is enough for a median to survive one bad run. */
const RUNS = 3;

let load = { loaded: false, ratio: 0, reason: 'not calibrated' };

before(() => {
  load = calibrationVerdict(calibrateMachine({ runs: 5 }), { ratio: LOAD_JITTER_RATIO });
});

/** Skip (never fail) when the machine has proven it cannot be measured on. */
function skipIfLoaded(t) {
  if (!load.loaded) return false;
  t.skip(`machine too loaded to measure: ${load.reason}. Budgets are not evidence here — this is a skip, not a pass.`);
  return true;
}

/** The assertion message every budget shares: what broke, and where to look. */
function overBudget(name, measured, budget, extra = '') {
  return [
    `${name}: median ${measured.medianMs} ms over the ${budget} ms budget`,
    `(runs=${measured.runs}, min ${measured.minMs} ms, max ${measured.maxMs} ms, jitter ${load.ratio}×).`,
    'This budget has ~15-20× headroom over the measured baseline, so a breach is a bug,',
    'not a busy CI box. Run `node scripts/bench.mjs --against` to see which case moved',
    `and by how much. ${extra}`
  ].join(' ');
}

test('budget: import scan (buildImportGraph over the repo source set) ≤ BUDGETS.importScanMs', (t) => {
  if (skipIfLoaded(t)) return;
  const measured = measureImportScan(REPO, { runs: RUNS });
  assert.equal(measured.error, undefined, `import scan failed: ${measured.error}`);
  assert.ok(measured.runs === RUNS, `expected ${RUNS} samples, got ${measured.runs}`);
  assert.ok(
    measured.medianMs <= BUDGETS.importScanMs,
    overBudget('import-graph.scan', measured, BUDGETS.importScanMs, `Scanned: ${measured.detail}.`)
  );
});

test('budget: answer hook end-to-end ≤ BUDGETS.answerHookMs', (t) => {
  if (skipIfLoaded(t)) return;
  const measured = measureAnswerHookLatency(REPO, { runs: RUNS });
  assert.equal(measured.error, undefined, `answer hook failed: ${measured.error}`);
  assert.ok(
    measured.medianMs <= BUDGETS.answerHookMs,
    overBudget('answer-hook', measured, BUDGETS.answerHookMs,
      'Most of this is node startup — a breach usually means the hook grew work, not that node did.')
  );
});

test('budget: cold /api/state ≤ BUDGETS.apiStateMs', async (t) => {
  if (skipIfLoaded(t)) return;
  // ONE cold sample by construction: serve/*.mjs caches at module scope, so a
  // second daemon in this process would already be warm. A single sample is
  // noisy — which is precisely why this budget carries the widest headroom of
  // the three rather than pretending to a median it cannot have.
  const pass = await apiPassInProcess(REPO);
  assert.equal(pass.status['api/state'], 200, `/api/state answered ${pass.status['api/state']}`);
  const coldMs = Math.round(pass.cold['api/state'] * 10) / 10;
  assert.ok(
    coldMs <= BUDGETS.apiStateMs,
    overBudget('api/state.cold', { medianMs: coldMs, runs: 1, minMs: coldMs, maxMs: coldMs }, BUDGETS.apiStateMs,
      'This is a single cold sample; re-run before believing it.')
  );
});

test('BUDGETS: documents the agreed latency budgets (the comment block cites these)', () => {
  assert.equal(BUDGETS.apiStateMs, 100);
  assert.equal(BUDGETS.answerHookMs, 1000);
  assert.equal(BUDGETS.importScanMs, 1500);
  // Latency budgets are milliseconds and must never be confused with the byte
  // budgets sharing this object — a swap would silently pass forever.
  for (const key of ['apiStateMs', 'answerHookMs', 'importScanMs']) {
    assert.ok(Number.isInteger(BUDGETS[key]) && BUDGETS[key] > 0, `${key} must be a positive integer`);
  }
});

test('calibration: reports a jitter ratio and never claims a slow machine is a loaded one', () => {
  assert.ok(Number.isFinite(load.ratio), 'calibration must produce a ratio');
  assert.match(load.reason, /busy-loop jitter/);
});
