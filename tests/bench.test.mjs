/**
 * Tests for the regression instrument (scripts/bench.mjs).
 *
 * The pure half is where the honesty lives, so that is where the assertions
 * are: the median never gets replaced by a mean, the stability note fires when
 * a run strays, the noise band is DERIVED from the measured spread (and stays
 * robust against a single warm-up outlier), and the verdict never calls a
 * within-noise wobble a regression.
 *
 * Exactly one subprocess run of the real CLI (--runs 1) guards the wiring: the
 * case list is complete and the process exits 0. Everything else is pure and
 * instant, so the whole file stays well under the ~10s the suite can afford.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BENCH_CASES, BENCH_SCHEMA, NOISE_FLOOR_PCT, MIN_RESOLVABLE_MS, STABILITY_RATIO, LOAD_JITTER_RATIO,
  median, summarize, noiseBandPct, classifyCase, diffReports, sameMachine,
  renderTable, renderDiff, calibrationVerdict, calibrateMachine, machineFacts
} from '../scripts/bench.mjs';

const BENCH = fileURLToPath(new URL('../scripts/bench.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

test('median: odd, even, unsorted, and degenerate inputs', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), 0);
  assert.equal(median(null), 0);
  // A mean would be dragged to 204 by the outlier; the median must not move.
  assert.equal(median([10, 10, 10, 10, 1000]), 10);
});

// ---------------------------------------------------------------------------
// summarize: median/min/max + the two widths + the stability note
// ---------------------------------------------------------------------------

test('summarize: reports median/min/max and both spread widths', () => {
  const s = summarize('x', [10, 12, 11, 13, 14]);
  assert.equal(s.case, 'x');
  assert.equal(s.runs, 5);
  assert.equal(s.medianMs, 12);
  assert.equal(s.minMs, 10);
  assert.equal(s.maxMs, 14);
  assert.equal(s.stable, true);
  assert.equal(s.note, undefined);
  // full range (14-10)/12 = 33.3%
  assert.equal(s.spreadPct, 33.3);
  // deviations |10-12|,|12-12|,|11-12|,|13-12|,|14-12| = 2,0,1,1,2 → median 1 → 8.3%
  assert.equal(s.madPct, 8.3);
});

test('summarize: stability note fires exactly when max/median exceeds the ratio', () => {
  const quiet = summarize('quiet', [10, 10, 10, 19]); // 19/10 = 1.9× → stable
  assert.equal(quiet.stable, true);
  assert.equal(quiet.note, undefined);

  const noisy = summarize('noisy', [10, 10, 10, 41]); // 41/10 = 4.1× → unstable
  assert.equal(noisy.stable, false);
  assert.match(noisy.note, /UNSTABLE/);
  assert.match(noisy.note, /4\.1×/);
  assert.ok(noisy.spreadRatio > STABILITY_RATIO);

  // Exactly at the ratio is still stable — the note is for strictly worse.
  const edge = summarize('edge', [10, 10, 20]);
  assert.equal(edge.spreadRatio, 2);
  assert.equal(edge.stable, true);
});

test('summarize: madPct ignores a single warm-up outlier the full range cannot', () => {
  // The shape import-graph.scan actually produces: one slow JIT run, four tight ones.
  const s = summarize('scan', [86, 90, 103, 110, 192]);
  assert.equal(s.medianMs, 103);
  assert.ok(s.spreadPct > 100, `full range should be blown out, got ${s.spreadPct}`);
  assert.ok(s.madPct < 20, `robust width should stay usable, got ${s.madPct}`);
});

test('summarize: an error marks the case failed and unstable, never a fake zero', () => {
  const s = summarize('boom', [], { error: 'git log failed' });
  assert.equal(s.runs, 0);
  assert.equal(s.stable, false);
  assert.equal(s.error, 'git log failed');
  assert.match(s.note, /FAILED/);
});

// ---------------------------------------------------------------------------
// noise band: measured, not guessed
// ---------------------------------------------------------------------------

test('noiseBandPct: derived from the measured spread, widest side wins, floored', () => {
  const tight = summarize('a', [100, 100, 100]);
  const loose = summarize('b', [80, 100, 130]); // mad = 20 → 20%
  // Two perfectly tight readings still get the floor — identical code re-run
  // is never bit-identical in wall time.
  assert.equal(noiseBandPct(tight, tight), NOISE_FLOOR_PCT);
  // The blurrier half sets the band, whichever side it is on.
  assert.equal(noiseBandPct(loose, tight), loose.madPct);
  assert.equal(noiseBandPct(tight, loose), loose.madPct);
});

test('noiseBandPct: a baseline predating madPct degrades to the wider full range', () => {
  const current = summarize('a', [100, 100, 100]);
  const legacy = { case: 'a', medianMs: 100, spreadPct: 42 }; // no madPct field
  assert.equal(noiseBandPct(current, legacy), 42);
});

// ---------------------------------------------------------------------------
// delta + verdict
// ---------------------------------------------------------------------------

const base = summarize('case', [100, 100, 100, 100, 100]); // madPct 0 → band = floor (5%)

test('classifyCase: SLOWER when the delta clears the band', () => {
  const cur = summarize('case', [140, 140, 140, 140, 140]);
  const c = classifyCase(cur, base);
  assert.equal(c.verdict, 'slower');
  assert.equal(c.deltaPct, 40);
  assert.equal(c.bandPct, NOISE_FLOOR_PCT);
  assert.match(c.message, /SLOWER by 40%/);
});

test('classifyCase: faster when the delta clears the band downward', () => {
  const c = classifyCase(summarize('case', [50, 50, 50]), base);
  assert.equal(c.verdict, 'faster');
  assert.equal(c.deltaPct, -50);
  assert.match(c.message, /faster by 50%/);
});

test('classifyCase: unchanged inside the band, on both sides of it', () => {
  for (const value of [90, 110]) {
    const c = classifyCase(summarize('case', [value, value, value]), base);
    assert.equal(c.verdict, 'unchanged', `${value} should be unchanged`);
    assert.match(c.message, new RegExp(`inside the ±${NOISE_FLOOR_PCT}% measured noise band`));
  }
  // An identical reading is unchanged too — via the resolution gate, since
  // there is no move at all to divide by the band.
  assert.equal(classifyCase(summarize('case', [100, 100, 100]), base).verdict, 'unchanged');
});

test('classifyCase: a jittery pair needs a bigger move than a tight one', () => {
  const jittery = summarize('case', [60, 100, 140]); // mad = 40 → 40%
  // +30% is a regression against a tight baseline…
  assert.equal(classifyCase(summarize('case', [130, 130, 130]), base).verdict, 'slower');
  // …and not yet evidence against a jittery one. That asymmetry is the point.
  assert.equal(classifyCase(summarize('case', [130, 130, 130]), jittery).verdict, 'unchanged');
});

test('classifyCase: sub-resolution moves are never graded in percent', () => {
  // The exact false positive this guard exists for: one 0.1 ms reporting step
  // on a sub-millisecond case reads as +16.7% and would be called a regression.
  const tiny = summarize('api/state.warm', [0.5, 0.5, 0.5]);
  const tinier = summarize('api/state.warm', [0.7, 0.7, 0.7]);
  const c = classifyCase(tinier, tiny);
  assert.equal(c.verdict, 'unchanged');
  assert.ok(Math.abs(c.deltaPct) > NOISE_FLOOR_PCT, 'the percentage really does clear the band');
  assert.match(c.message, new RegExp(`below the ${MIN_RESOLVABLE_MS} ms this instrument can resolve`));
  // …but a move that clears the absolute floor is judged normally again.
  assert.equal(classifyCase(summarize('x', [1.5, 1.5, 1.5]), tiny).verdict, 'slower');
});

test('classifyCase: new / missing / failed cases never fabricate a delta', () => {
  const n = classifyCase(summarize('case', [10]), null);
  assert.equal(n.verdict, 'new');
  assert.equal(n.deltaPct, null);

  const m = classifyCase(null, base);
  assert.equal(m.verdict, 'missing');
  assert.equal(m.deltaPct, null);

  const f = classifyCase(summarize('case', [], { error: 'nope' }), base);
  assert.equal(f.verdict, 'failed');
  assert.equal(f.deltaPct, null);

  const zero = classifyCase(summarize('case', [10]), summarize('case', []));
  assert.equal(zero.verdict, 'failed');
});

// ---------------------------------------------------------------------------
// diffReports against a fixture baseline
// ---------------------------------------------------------------------------

const FIXTURE_MACHINE = { node: 'v20.0.0', platform: 'linux', arch: 'x64', cpus: 8, cpuModel: 'Fixture CPU' };

const FIXTURE_BASELINE = {
  schema: BENCH_SCHEMA,
  generatedAt: '2026-01-01T00:00:00.000Z',
  runs: 5,
  commitWindow: 300,
  machine: FIXTURE_MACHINE,
  cases: [
    { case: 'import-graph.scan', runs: 5, medianMs: 100, minMs: 95, maxMs: 110, spreadPct: 15, madPct: 4, stable: true },
    { case: 'api/state.cold', runs: 5, medianMs: 5, minMs: 5, maxMs: 5.2, spreadPct: 4, madPct: 0, stable: true },
    { case: 'answer-hook', runs: 5, medianMs: 60, minMs: 58, maxMs: 63, spreadPct: 8, madPct: 2, stable: true },
    { case: 'retired-case', runs: 5, medianMs: 9, minMs: 9, maxMs: 9, spreadPct: 0, madPct: 0, stable: true }
  ]
};

test('diffReports: per-case verdicts, regression count, added and vanished cases', () => {
  const current = {
    schema: BENCH_SCHEMA,
    generatedAt: '2026-02-01T00:00:00.000Z',
    runs: 5,
    commitWindow: 300,
    machine: FIXTURE_MACHINE,
    cases: [
      { case: 'import-graph.scan', runs: 5, medianMs: 150, minMs: 148, maxMs: 155, spreadPct: 5, madPct: 1, stable: true },
      { case: 'api/state.cold', runs: 5, medianMs: 5.1, minMs: 5, maxMs: 5.3, spreadPct: 6, madPct: 1, stable: true },
      { case: 'answer-hook', runs: 5, medianMs: 30, minMs: 29, maxMs: 31, spreadPct: 3, madPct: 1, stable: true },
      { case: 'brand-new-case', runs: 5, medianMs: 1, minMs: 1, maxMs: 1, spreadPct: 0, madPct: 0, stable: true }
    ]
  };
  const diff = diffReports(current, FIXTURE_BASELINE);
  const by = new Map(diff.cases.map((c) => [c.case, c]));

  assert.equal(by.get('import-graph.scan').verdict, 'slower');
  assert.equal(by.get('import-graph.scan').deltaPct, 50);
  assert.equal(by.get('api/state.cold').verdict, 'unchanged');
  assert.equal(by.get('answer-hook').verdict, 'faster');
  assert.equal(by.get('brand-new-case').verdict, 'new');
  // A case the baseline had and this run did not must be visible, not absent.
  assert.equal(by.get('retired-case').verdict, 'missing');

  assert.equal(diff.regressions, 1);
  assert.equal(diff.machineMatch, true);
  assert.equal(diff.baselineGeneratedAt, '2026-01-01T00:00:00.000Z');
});

test('sameMachine: any differing fact breaks the comparison', () => {
  assert.equal(sameMachine(FIXTURE_MACHINE, { ...FIXTURE_MACHINE }), true);
  assert.equal(sameMachine(FIXTURE_MACHINE, { ...FIXTURE_MACHINE, cpus: 4 }), false);
  assert.equal(sameMachine(FIXTURE_MACHINE, { ...FIXTURE_MACHINE, node: 'v22.0.0' }), false);
  assert.equal(sameMachine(FIXTURE_MACHINE, { ...FIXTURE_MACHINE, cpuModel: 'Other' }), false);
  assert.equal(sameMachine(null, FIXTURE_MACHINE), false);
});

// ---------------------------------------------------------------------------
// renderers: the honesty has to be visible, not just present in the JSON
// ---------------------------------------------------------------------------

test('renderTable: header carries the machine facts and the cross-machine warning', () => {
  const report = {
    generatedAt: '2026-02-01T00:00:00.000Z',
    runs: 5,
    commitWindow: 300,
    machine: FIXTURE_MACHINE,
    cases: [summarize('noisy', [10, 10, 10, 90]), summarize('calm', [1, 1, 1])]
  };
  const out = renderTable(report);
  assert.match(out, /node v20\.0\.0/);
  assert.match(out, /linux\/x64/);
  assert.match(out, /8× Fixture CPU/);
  assert.match(out, /meaningless/);
  assert.match(out, /⚠ UNSTABLE/);
  assert.match(out, /1\/2 case\(s\) measured unstably/);
});

test('renderDiff: shouts on a machine mismatch and summarises the regressions', () => {
  const current = { machine: { ...FIXTURE_MACHINE, cpus: 4 }, cases: FIXTURE_BASELINE.cases.slice(0, 1) };
  const mismatched = renderDiff(diffReports(current, FIXTURE_BASELINE));
  assert.match(mismatched, /MACHINE MISMATCH/);

  const matched = renderDiff(diffReports(
    { machine: FIXTURE_MACHINE, runs: 5, cases: FIXTURE_BASELINE.cases }, FIXTURE_BASELINE
  ));
  assert.ok(!matched.includes('MACHINE MISMATCH'));
  assert.match(matched, /No case is slower than baseline/);
  assert.ok(!matched.includes('UNDER-SAMPLED'));
});

test('renderDiff: warns when either side was under-sampled', () => {
  const thin = renderDiff(diffReports(
    { machine: FIXTURE_MACHINE, runs: 2, cases: FIXTURE_BASELINE.cases }, FIXTURE_BASELINE
  ));
  assert.match(thin, /UNDER-SAMPLED \(current=2, expected ≥5 runs\)/);
  assert.match(thin, /false SLOWER verdicts/);

  const thinBaseline = renderDiff(diffReports(
    { machine: FIXTURE_MACHINE, runs: 5, cases: FIXTURE_BASELINE.cases },
    { ...FIXTURE_BASELINE, runs: 1 }
  ));
  assert.match(thinBaseline, /UNDER-SAMPLED \(baseline=1/);
});

// ---------------------------------------------------------------------------
// machine-load calibration
// ---------------------------------------------------------------------------

test('calibrationVerdict: self-referential jitter, no hard-coded expected time', () => {
  assert.equal(calibrationVerdict([10, 11, 12]).loaded, false);
  const loaded = calibrationVerdict([10, 11, 90]);
  assert.equal(loaded.loaded, true);
  assert.ok(loaded.ratio > LOAD_JITTER_RATIO);
  assert.match(loaded.reason, /descheduling/);
  // A slow-but-steady machine is NOT loaded — that is the whole point of not
  // comparing against an absolute expectation. A 5-second-per-loop potato with
  // no contention must still be allowed to enforce budgets.
  assert.equal(calibrationVerdict([5000, 5100, 5200]).loaded, false);
  assert.equal(calibrationVerdict([1]).loaded, false); // not enough samples → no claim
});

test('calibrationVerdict: max/median, so ONE slow run does not condemn the machine', () => {
  // max/min would call this 5× loaded on the strength of a single sample.
  const oneSpike = calibrationVerdict([10, 10, 10, 10, 20]);
  assert.equal(oneSpike.ratio, 2);
  assert.equal(oneSpike.loaded, false);
  // Contention shows up as most-of-the-time slowness against a fast floor —
  // several runs descheduled, some not. THAT is what gets caught.
  assert.equal(calibrationVerdict([10, 10, 10, 60, 70]).loaded, true);
  // Uniform slowness is deliberately NOT caught: [10,50,60,70,80] is a machine
  // that is simply slow, and a slow machine can still enforce a budget.
  assert.equal(calibrationVerdict([10, 50, 60, 70, 80]).loaded, false);
});

test('calibrateMachine: discards the warm-up iterations rather than measuring V8 tiering', () => {
  const samples = calibrateMachine({ runs: 3, iterations: 10_000, warmup: 4 });
  assert.equal(samples.length, 3, 'only post-warm-up samples are returned');
  assert.ok(samples.every((s) => Number.isFinite(s) && s >= 0));
  assert.equal(calibrateMachine({ runs: 2, iterations: 1000, warmup: 0 }).length, 2);
});

test('machineFacts: reports the facts a millisecond needs to be interpretable', () => {
  const m = machineFacts();
  assert.equal(m.node, process.version);
  assert.equal(m.platform, process.platform);
  assert.equal(m.arch, process.arch);
  assert.ok(m.cpus >= 1);
  assert.ok(typeof m.cpuModel === 'string' && m.cpuModel.length > 0);
});

// ---------------------------------------------------------------------------
// one live CLI run — wiring guard, not a measurement
// ---------------------------------------------------------------------------

test('CLI: --runs 1 --json exits 0 on this repo and produces the complete case list', () => {
  const r = spawnSync(process.execPath, [BENCH, '--runs', '1', '--json'], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, BRAIN_USAGE_LOG: '0' }
  });
  assert.equal(r.status, 0, `bench must exit 0:\n${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.schema, BENCH_SCHEMA);
  assert.equal(report.runs, 1);
  assert.deepEqual(report.cases.map((c) => c.case), [...BENCH_CASES]);
  // Every case really measured something on this repo (no silent failures).
  for (const c of report.cases) {
    assert.equal(c.error, undefined, `${c.case} failed: ${c.error}`);
    assert.equal(c.runs, 1, `${c.case} produced ${c.runs} samples`);
    assert.ok(c.medianMs >= 0, `${c.case} has no median`);
  }
  assert.ok(report.machine.cpus >= 1);
}, { timeout: 120000 });

test('CLI: --runs rejects junk instead of quietly picking a default', () => {
  for (const bad of ['0', '-3', 'lots', '99']) {
    const r = spawnSync(process.execPath, [BENCH, '--runs', bad], { cwd: REPO, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, `--runs ${bad} should be rejected`);
    assert.match(r.stderr, /--runs must be an integer/);
  }
});

test('CLI: a typo\'d flag is rejected, not silently ignored', () => {
  const r = spawnSync(process.execPath, [BENCH, '--runs', '1', '--baselines'], {
    cwd: REPO, encoding: 'utf8', timeout: 30000
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument\(s\): --baselines/);
});

test('CLI: --against a missing baseline says what to do, and never invents one', () => {
  const missing = path.join(REPO, '.project-brain', 'no-such-baseline.json');
  const r = spawnSync(process.execPath, [BENCH, '--runs', '1', '--against', missing], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, env: { ...process.env, BRAIN_USAGE_LOG: '0' }
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no baseline at/);
  assert.match(r.stderr, /--baseline/);
}, { timeout: 120000 });
