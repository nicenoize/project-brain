#!/usr/bin/env node
/**
 * bench.mjs — a REGRESSION INSTRUMENT, not a verdict machine.
 *
 * WHAT THIS CAN AND CANNOT SAY.
 * It cannot say "project-brain is fast". Absolute latency depends on the
 * machine, the OS page cache, the repo's size and history, and whatever else
 * is running — none of which this process controls or measures. What it CAN
 * say, and the only claim it makes, is:
 *
 *     "on THIS machine, THIS path is 41% slower than the baseline you
 *      committed on THIS machine."
 *
 * That is a difference between two readings taken the same way, so the
 * machine's unknowns cancel. Compare two numbers from two different machines
 * and you have measured the machines, not the code — the header of every
 * report says so out loud, and `--against` shouts when the baseline's machine
 * facts do not match the current ones.
 *
 * WHAT IT MEASURES (the hot paths we already know matter):
 *   import-graph.scan       buildImportGraph over the repo's `git ls-files`
 *                           source set — the scan behind /api/blast, /api/graph
 *                           and brain:impact. Files are re-read every run.
 *   git-log.parse           parseLog over a fixed commit window (the spawn
 *                           cost is captured once in `detail`, not timed —
 *                           it measures git, not us).
 *   file-health             fileHealth() over that same window.
 *   calibrate-file-health   calibrateFileHealth() over that same window.
 *   api/{state,risk,blast,graph}.{cold,warm}
 *                           real HTTP against an in-process daemon
 *                           (startServer on port 0, 127.0.0.1). COLD and WARM
 *                           are reported SEPARATELY and never averaged: the
 *                           per-HEAD caches in serve/git.mjs + serve/graph.mjs
 *                           ARE the design, and folding the cold miss into the
 *                           warm hits would flatter both numbers into fiction.
 *                           risk/blast run against a PINNED ?files= set, not
 *                           the working tree — see PINNED_FILES for why a
 *                           tree-derived change set would make the numbers
 *                           track your editor instead of the code.
 *   answer-hook             end-to-end spawn of brain-answer-hook.mjs with a
 *                           synthetic Edit payload — the ambient per-edit cost
 *                           (same driving shape as footprint.mjs's
 *                           measureAnswerHook, which measures its BYTES; this
 *                           measures its MILLISECONDS).
 *
 * HOW COLD IS KEPT COLD. The daemon's caches are MODULE-level, so a second
 * startServer() in the same process is already warm. Every cold sample is
 * therefore taken in a fresh child process (`--cold-worker`), which does one
 * cold pass over all four endpoints in a fixed order and then one warm pass,
 * and prints both as JSON. N runs = N child processes. Honest wrinkle worth
 * knowing: the endpoints SHARE those caches, so /api/blast's "cold" already
 * benefits from /api/risk's cold pass ahead of it in the fixed order. That is
 * the real first-dashboard-load sequence, which is why it is the one measured.
 *
 * STATISTICS, DELIBERATELY MINIMAL. Median + min + max, never a mean (one
 * descheduled run would drag a mean and hide behind it). A case whose
 * max/median exceeds STABILITY_RATIO carries a printed stability note — a
 * noisy measurement has to say so rather than pretend precision.
 *
 * THE NOISE BAND IS MEASURED, NOT GUESSED. `--against` calls a case unchanged
 * when the delta falls inside a band derived from the observed spread of the
 * two readings being compared, floored at NOISE_FLOOR_PCT and gated by
 * MIN_RESOLVABLE_MS. A jittery case therefore needs a bigger move before it is
 * called a regression — which is exactly right, and impossible with a fixed
 * threshold. The flip side, stated plainly rather than buried: this instrument
 * resolves regressions of roughly 20% and up. A 15% regression will read as
 * "unchanged" here. Both constants carry the measurements they were derived
 * from.
 *
 * BASELINES ARE COMMITTED DATA. `--baseline` writes
 * .project-brain/bench-baseline.json, and that file IS meant to be committed:
 * it is the reference every later `--against` diffs from, so it has to travel
 * with the code it describes. It is not in .gitignore. Re-write it
 * deliberately (a green measurement after an intended optimisation), never as
 * a reflex to silence a regression — a baseline refreshed to make red go away
 * is the one failure mode that turns this tool into decoration.
 *
 * PURE / IMPURE SPLIT. Everything above `--- measurement ---` is pure and unit
 * tested (median, summarize, stability, the noise band, the delta+verdict, the
 * renderers). Everything below spawns, reads or binds.
 *
 * USAGE
 *   node scripts/bench.mjs [--runs N] [--json]
 *   node scripts/bench.mjs --baseline            # write the committed baseline
 *   node scripts/bench.mjs --against [file]      # diff vs baseline (+ --fail-on-regression)
 *
 * (`project-brain x <name>` resolves scripts/brain-<name>.mjs, so this library
 * has no `x` verb; it is invoked by path like scripts/footprint.mjs's peers.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ROOT, takeFlag, takeOption } from './common.mjs';
import { buildImportGraph } from './import-graph.mjs';
import { gitLogArgs, parseLog, fileHealth, calibrateFileHealth } from './git-intel.mjs';

const SELF = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SELF);

/** Report schema id — bumped when the case list or field shapes change. */
export const BENCH_SCHEMA = 'project-brain-bench/1';

/** Where the COMMITTED baseline lives (relative to the repo root). */
export const BASELINE_REL = path.join('.project-brain', 'bench-baseline.json');

/** Default sample count. 5 is enough for a median to survive one bad run. */
export const DEFAULT_RUNS = 5;

/** Commit window for every git-derived case. Fixed so runs stay comparable. */
export const COMMIT_WINDOW = 300;

/** max/median above this ⇒ the case prints a stability note. */
export const STABILITY_RATIO = 2;

/**
 * Floor under the measured noise band, in percent — and therefore this
 * instrument's stated RESOLUTION: it cannot see a regression smaller than
 * this, and does not pretend to.
 *
 * DERIVED FROM CONTROL RUNS, NOT PICKED. Repeated 5-run measurements of
 * BYTE-IDENTICAL code on an idle dev machine still drift median-to-median. The
 * observed false deltas across those control runs reached +12.1%
 * (api/graph.cold), +16.9% (api/risk.warm) and +16.5% (answer-hook) — every
 * one of them a case where nothing whatsoever had changed. 20% sits above the
 * worst of them with a little margin.
 *
 * Per-run spread (madPct) cannot see this drift: it measures variation WITHIN
 * one run, while this is variation BETWEEN runs — page cache state, JIT
 * tier-up, CPU frequency scaling, whatever the OS did in between. Only the
 * floor covers it.
 *
 * The cost is worth naming rather than hiding: a real 15% regression will be
 * reported as "unchanged" here. Resolving that would need a rig this tool does
 * not have (pinned cores, far more runs, a quiet machine) — and a tool that
 * flagged it anyway would just be guessing with a confident voice. What this
 * catches is the class of regression that actually ships: the 40%+ kind.
 */
export const NOISE_FLOOR_PCT = 20;

/**
 * Absolute resolution floor, in milliseconds. Below this, a percentage is
 * arithmetic on rounding error: medians are reported to 0.1 ms, so a 0.6 ms
 * case moving to 0.7 ms is ONE rounding step and reads as "+16.7% SLOWER".
 * Sub-millisecond cases (api/state.warm, git-log.parse) exist to show they are
 * still sub-millisecond, not to be graded in percent.
 */
export const MIN_RESOLVABLE_MS = 0.5;

/**
 * Preferred pinned change set for /api/risk and /api/blast.
 *
 * WHY PINNED AT ALL: both endpoints default their change set to staged ∪
 * unstaged. Measured that way, a clean tree makes /api/risk return
 * `{score:null, reason:'no-changes'}` in ~30 ms while a dirty tree makes it do
 * the full calibration+blast work in ~1.2 s. The number would then track your
 * editor, not the code — a baseline taken mid-edit would "detect" a 97%
 * speedup the moment you committed. `?files=` pins it. Repos without these
 * paths fall back to the first two files of the sorted source set, so the
 * choice stays deterministic per repo (and comparable only within it).
 */
export const PINNED_FILES = Object.freeze(['scripts/git-intel.mjs', 'scripts/import-graph.mjs']);

/** The four endpoints, in the order a first dashboard load hits them. */
export const API_CASES = Object.freeze([
  { name: 'api/state', path: () => '/api/state' },
  { name: 'api/risk', path: (files) => `/api/risk?files=${encodeURIComponent(files.join(','))}` },
  { name: 'api/blast', path: (files) => `/api/blast?files=${encodeURIComponent(files.join(','))}&depth=2` },
  { name: 'api/graph', path: () => '/api/graph' }
]);

/** Every case this tool reports, in report order. A run is incomplete without all of them. */
export const BENCH_CASES = Object.freeze([
  'import-graph.scan',
  'git-log.parse',
  'file-health',
  'calibrate-file-health',
  ...API_CASES.flatMap((c) => [`${c.name}.cold`, `${c.name}.warm`]),
  'answer-hook'
]);

// ---------------------------------------------------------------------------
// pure core
// ---------------------------------------------------------------------------

/** PURE. Median of a numeric sample (even count → mean of the two middles). NaN-free: [] → 0. */
export function median(values) {
  const xs = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Round to one decimal — the precision a wall-clock ms reading actually has. */
function ms(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * PURE. Turn raw per-run millisecond samples into a reported case.
 *
 * TWO different widths, on purpose, because they answer two different
 * questions:
 *   `spreadPct`   = (max-min)/median — the FULL range. Answers "how soft is
 *                   this number?", so it drives the stability note. The worst
 *                   run is exactly what you want to know there.
 *   `madPct`      = median(|x - median|)/median — the robust width. Answers
 *                   "how big a move would I need to see before believing it?",
 *                   so it drives the noise band. It has to be robust: a JIT
 *                   warm-up on run 1 pushes import-graph.scan's full range past
 *                   100%, and a ±100% band would happily call a real 40%
 *                   regression "unchanged". MAD ignores that single outlier
 *                   without anyone choosing a threshold.
 *
 * `stable:false` is not a failure — it is the case telling you its own number
 * is soft, so a later diff against it should be read with that in mind.
 *
 * @param {string} name
 * @param {number[]} samples milliseconds
 * @param {{detail?: string, error?: string}} [meta]
 */
export function summarize(name, samples, meta = {}) {
  const xs = (samples || []).map(Number).filter(Number.isFinite);
  const med = median(xs);
  const min = xs.length ? Math.min(...xs) : 0;
  const max = xs.length ? Math.max(...xs) : 0;
  const spreadRatio = med > 0 ? max / med : 0;
  const spreadPct = med > 0 ? ((max - min) / med) * 100 : 0;
  const mad = median(xs.map((x) => Math.abs(x - med)));
  const madPct = med > 0 ? (mad / med) * 100 : 0;
  const stable = !(spreadRatio > STABILITY_RATIO);
  const out = {
    case: String(name),
    runs: xs.length,
    medianMs: ms(med),
    minMs: ms(min),
    maxMs: ms(max),
    spreadRatio: Math.round(spreadRatio * 100) / 100,
    spreadPct: Math.round(spreadPct * 10) / 10,
    madPct: Math.round(madPct * 10) / 10,
    stable
  };
  if (!stable) {
    out.note = `UNSTABLE: slowest run was ${out.spreadRatio}× the median — treat this number as a range, not a value`;
  }
  if (meta.detail) out.detail = String(meta.detail);
  if (meta.error) {
    out.error = String(meta.error);
    out.stable = false;
    out.note = `FAILED: ${out.error}`;
  }
  return out;
}

/**
 * PURE. The band inside which a delta counts as "unchanged", in percent,
 * DERIVED from the two readings' own observed spread rather than picked. The
 * wider of the two wins (a comparison is only as sharp as its blurrier half),
 * floored at NOISE_FLOOR_PCT.
 *
 * Uses `madPct` (robust) rather than `spreadPct` (full range) — see summarize()
 * for why. Baselines written before madPct existed fall back to spreadPct, so
 * an old baseline degrades to a wider, more conservative band instead of a
 * zero-width one that would call everything a regression.
 */
export function noiseBandPct(current, baseline) {
  const width = (s) => {
    if (!s) return 0;
    if (Number.isFinite(s.madPct)) return Math.abs(s.madPct);
    return Number.isFinite(s.spreadPct) ? Math.abs(s.spreadPct) : 0;
  };
  return Math.round(Math.max(NOISE_FLOOR_PCT, width(current), width(baseline)) * 10) / 10;
}

/**
 * PURE. Compare one case against its baseline.
 *
 * @returns {{case, baselineMs, currentMs, deltaPct, bandPct,
 *            verdict: 'faster'|'unchanged'|'slower'|'new'|'missing'|'failed', message}}
 */
export function classifyCase(current, baseline) {
  const name = String((current && current.case) || (baseline && baseline.case) || '');
  if (!baseline) {
    return {
      case: name, baselineMs: null, currentMs: current ? current.medianMs : null,
      deltaPct: null, bandPct: null, verdict: 'new',
      message: 'NEW — not in the baseline, nothing to compare'
    };
  }
  if (!current) {
    return {
      case: name, baselineMs: baseline.medianMs, currentMs: null,
      deltaPct: null, bandPct: null, verdict: 'missing',
      message: 'MISSING — the baseline has this case but this run did not produce it'
    };
  }
  if (current.error || baseline.error) {
    return {
      case: name, baselineMs: baseline.medianMs, currentMs: current.medianMs,
      deltaPct: null, bandPct: null, verdict: 'failed',
      message: `FAILED — ${current.error || baseline.error}`
    };
  }
  const base = Number(baseline.medianMs);
  const cur = Number(current.medianMs);
  if (!(base > 0)) {
    return {
      case: name, baselineMs: base, currentMs: cur, deltaPct: null, bandPct: null,
      verdict: 'failed', message: 'FAILED — baseline median is zero, nothing to divide by'
    };
  }
  const deltaPct = Math.round(((cur - base) / base) * 1000) / 10;
  const bandPct = noiseBandPct(current, baseline);
  // Absolute resolution gate first: a percentage computed across less than one
  // reporting step is arithmetic on rounding, not a measurement.
  if (Math.abs(cur - base) < MIN_RESOLVABLE_MS) {
    return {
      case: name, baselineMs: base, currentMs: cur, deltaPct, bandPct, verdict: 'unchanged',
      message: `unchanged (moved ${ms(Math.abs(cur - base))} ms, below the ${MIN_RESOLVABLE_MS} ms this instrument can resolve)`
    };
  }
  let verdict = 'unchanged';
  let message = `unchanged (${deltaPct >= 0 ? '+' : ''}${deltaPct}% is inside the ±${bandPct}% measured noise band)`;
  if (deltaPct > bandPct) {
    verdict = 'slower';
    message = `SLOWER by ${deltaPct}% (noise band ±${bandPct}%)`;
  } else if (deltaPct < -bandPct) {
    verdict = 'faster';
    message = `faster by ${Math.abs(deltaPct)}% (noise band ±${bandPct}%)`;
  }
  return { case: name, baselineMs: base, currentMs: cur, deltaPct, bandPct, verdict, message };
}

/**
 * PURE. Diff a whole report against a baseline report. Case order follows the
 * current report, then any baseline-only cases so a vanished case is visible
 * rather than silently absent.
 */
export function diffReports(current, baseline) {
  const byName = (r) => new Map((r && r.cases ? r.cases : []).map((c) => [c.case, c]));
  const cur = byName(current);
  const base = byName(baseline);
  const names = [...cur.keys(), ...[...base.keys()].filter((n) => !cur.has(n))];
  const cases = names.map((n) => classifyCase(cur.get(n), base.get(n)));
  return {
    cases,
    regressions: cases.filter((c) => c.verdict === 'slower').length,
    machineMatch: sameMachine(current && current.machine, baseline && baseline.machine),
    currentMachine: (current && current.machine) || null,
    baselineMachine: (baseline && baseline.machine) || null,
    baselineGeneratedAt: (baseline && baseline.generatedAt) || null,
    currentRuns: Number((current && current.runs) || 0),
    baselineRuns: Number((baseline && baseline.runs) || 0)
  };
}

/**
 * PURE. Do two machine stamps describe the same box closely enough that the
 * comparison means anything? node/platform/arch/cpu model must all match; the
 * cpu COUNT is compared too because a 4-core CI runner and a 10-core laptop
 * schedule our spawns very differently.
 */
export function sameMachine(a, b) {
  if (!a || !b) return false;
  return ['node', 'platform', 'arch', 'cpus', 'cpuModel'].every((k) => String(a[k]) === String(b[k]));
}

/** PURE. Fixed-width column helper (padEnd on the rendered string). */
function col(value, width, right = false) {
  const s = String(value);
  return right ? s.padStart(width) : s.padEnd(width);
}

/**
 * PURE. The measurement table plus the header that makes the numbers legible
 * at all: what box produced them, and the standing warning that they are not
 * comparable to anyone else's.
 */
export function renderTable(report) {
  const m = report.machine || {};
  const lines = [
    'project-brain bench — regression instrument',
    `machine: node ${m.node} · ${m.platform}/${m.arch} · ${m.cpus}× ${m.cpuModel}`,
    `runs: ${report.runs} per case · commit window: ${report.commitWindow} · generated: ${report.generatedAt}`,
    'These milliseconds describe THIS machine only. Comparing them to numbers from any',
    'other machine is meaningless — the only honest use is `--against` a baseline taken here.',
    ''
  ];
  const nameW = Math.max(20, ...report.cases.map((c) => c.case.length));
  lines.push(`${col('case', nameW)}  ${col('runs', 4, true)}  ${col('median', 10, true)}  ${col('min', 10, true)}  ${col('max', 10, true)}  detail`);
  lines.push('-'.repeat(nameW + 46));
  for (const c of report.cases) {
    lines.push(
      `${col(c.case, nameW)}  ${col(c.runs, 4, true)}  ${col(`${c.medianMs} ms`, 10, true)}  ` +
      `${col(`${c.minMs} ms`, 10, true)}  ${col(`${c.maxMs} ms`, 10, true)}  ${c.detail || ''}`
    );
    if (c.note) lines.push(`${' '.repeat(nameW + 2)}⚠ ${c.note}`);
  }
  const unstable = report.cases.filter((c) => !c.stable);
  lines.push('');
  lines.push(unstable.length
    ? `${unstable.length}/${report.cases.length} case(s) measured unstably — see the ⚠ lines above.`
    : `All ${report.cases.length} cases measured stably (max/median ≤ ${STABILITY_RATIO}).`);
  return lines.join('\n');
}

/** PURE. The diff table: one verdict line per case, plus the machine-mismatch shout. */
export function renderDiff(diff) {
  const lines = ['project-brain bench — current vs baseline', ''];
  if (!diff.machineMatch) {
    const a = diff.currentMachine || {};
    const b = diff.baselineMachine || {};
    lines.push('⚠ MACHINE MISMATCH — this diff compares two different boxes, so it measures the boxes,');
    lines.push('  not the code. Re-run --baseline here before trusting any verdict below.');
    lines.push(`    current:  node ${a.node} · ${a.platform}/${a.arch} · ${a.cpus}× ${a.cpuModel}`);
    lines.push(`    baseline: node ${b.node} · ${b.platform}/${b.arch} · ${b.cpus}× ${b.cpuModel}`);
    lines.push('');
  }
  lines.push(`baseline generated: ${diff.baselineGeneratedAt || 'unknown'}`);
  lines.push('');
  const nameW = Math.max(20, ...diff.cases.map((c) => c.case.length));
  lines.push(`${col('case', nameW)}  ${col('baseline', 11, true)}  ${col('current', 11, true)}  ${col('delta', 8, true)}  verdict`);
  lines.push('-'.repeat(nameW + 48));
  for (const c of diff.cases) {
    const base = c.baselineMs === null ? '—' : `${c.baselineMs} ms`;
    const cur = c.currentMs === null ? '—' : `${c.currentMs} ms`;
    const delta = c.deltaPct === null ? '—' : `${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct}%`;
    lines.push(`${col(c.case, nameW)}  ${col(base, 11, true)}  ${col(cur, 11, true)}  ${col(delta, 8, true)}  ${c.message}`);
  }
  lines.push('');
  lines.push(diff.regressions
    ? `${diff.regressions} case(s) SLOWER than baseline beyond their measured noise band.`
    : 'No case is slower than baseline beyond its measured noise band.');
  // Under-sampling is the most common way to read a regression that is not
  // there: at --runs 3 a control run of identical code produced four false
  // SLOWER verdicts on this machine. Say so where the verdicts are, not only
  // in the source.
  const thin = [
    diff.currentRuns && diff.currentRuns < DEFAULT_RUNS ? `current=${diff.currentRuns}` : '',
    diff.baselineRuns && diff.baselineRuns < DEFAULT_RUNS ? `baseline=${diff.baselineRuns}` : ''
  ].filter(Boolean);
  if (thin.length) {
    lines.push(`⚠ UNDER-SAMPLED (${thin.join(', ')}, expected ≥${DEFAULT_RUNS} runs) — false SLOWER verdicts`);
    lines.push(`  are common below ${DEFAULT_RUNS} runs. Re-measure before acting on anything above.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// machine-load calibration (pure verdict over impure samples)
// ---------------------------------------------------------------------------

/**
 * A busy-loop is called jittery when its slowest run exceeds this × its MEDIAN.
 *
 * Calibrated against the HEADROOM it protects, not picked for roundness. The
 * budgets in footprint.mjs sit ~15-20× above their measured medians, so a
 * machine with 3× scheduling jitter can still clear them with an order of
 * magnitude to spare — skipping there throws away coverage for nothing. (It
 * did, observably: a full `npm test` alongside two other agents calibrated at
 * 3.08× and skipped all three budgets, which then passed comfortably when
 * re-run.) 5× is where a reading stops being worth arguing with while the
 * budget still has ~4× of its headroom left.
 */
export const LOAD_JITTER_RATIO = 5;

/** Discarded warm-up iterations before calibration sampling starts. */
export const CALIBRATION_WARMUP = 4;

/**
 * PURE. Is this machine demonstrably too busy to measure on?
 *
 * SELF-REFERENTIAL on purpose: it compares a trivial busy-loop's slowest run to
 * its own MEDIAN on the same box in the same second. A hard-coded "expected ms"
 * would be exactly the cross-machine claim this whole tool refuses to make — on
 * a slow-but-idle ARM runner it would cry wolf, and on a fast-but-hammered box
 * it would stay silent. Descheduling is what makes timings lie, and
 * descheduling shows up as spread.
 *
 * max/MEDIAN, not max/min, and measured only after CALIBRATION_WARMUP discarded
 * iterations. Both corrections were forced by measurement: with max/min over
 * cold samples, V8's own tier-up made the loop's first runs ~2× its last ones,
 * so a perfectly idle machine calibrated at 2.3-5.4× and the budget tests
 * skipped themselves roughly half the time. A guard that skips at random is
 * strictly worse than no guard — it converts a red build into a green one
 * without anyone noticing.
 */
export function calibrationVerdict(samples, { ratio = LOAD_JITTER_RATIO } = {}) {
  const xs = (samples || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (xs.length < 2) return { loaded: false, ratio: 0, reason: 'not enough calibration samples' };
  const med = median(xs);
  const max = Math.max(...xs);
  const observed = med > 0 ? Math.round((max / med) * 100) / 100 : 0;
  return observed > ratio
    ? { loaded: true, ratio: observed, reason: `busy-loop jitter ${observed}× (> ${ratio}×) — the machine is descheduling us; timings here are not evidence` }
    : { loaded: false, ratio: observed, reason: `busy-loop jitter ${observed}× (≤ ${ratio}×)` };
}

/**
 * Run the trivial busy loop and return the millisecond samples AFTER the
 * warm-up iterations are discarded — those measure V8 tiering up, not the
 * machine's load.
 */
export function calibrateMachine({ runs = 5, iterations = 2_000_000, warmup = CALIBRATION_WARMUP } = {}) {
  const samples = [];
  const total = warmup + runs;
  for (let r = 0; r < total; r++) {
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < iterations; i++) acc += i % 7;
    const elapsed = performance.now() - t0;
    if (r >= warmup) samples.push(elapsed);
    if (acc === -1) throw new Error('unreachable'); // keep the loop from being elided
  }
  return samples;
}

// ---------------------------------------------------------------------------
// --- measurement (impure below this line) ---
// ---------------------------------------------------------------------------

/** The machine facts without which a millisecond is not even interpretable. */
export function machineFacts() {
  let cpus = [];
  try { cpus = os.cpus() || []; } catch { cpus = []; }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus.length,
    cpuModel: (cpus[0] && String(cpus[0].model).trim()) || 'unknown'
  };
}

/** Time `fn` `runs` times. A throw is captured as the case's error, never rethrown. */
export function timeRuns(name, runs, fn, meta = {}) {
  const samples = [];
  try {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn(i);
      samples.push(performance.now() - t0);
    }
  } catch (error) {
    return summarize(name, samples, { ...meta, error: String((error && error.message) || error) });
  }
  return summarize(name, samples, meta);
}

const SOURCE_EXT_RE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/;

/** The repo's scannable source set, straight from git (same discovery as serve/graph.mjs). */
export function sourceFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return [];
  return (r.stdout || '')
    .split('\n')
    .filter((f) => f && SOURCE_EXT_RE.test(f) && !f.includes('node_modules/'))
    .sort();
}

/**
 * import-graph.scan — buildImportGraph over the git file set, files re-read
 * every run. "Cold" here means cold w.r.t. OUR caches; the OS page cache is
 * warm after run 1 and we do not pretend otherwise.
 */
export function measureImportScan(root, { runs = DEFAULT_RUNS } = {}) {
  const files = sourceFiles(root);
  const readFile = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  let edges = 0;
  const summary = timeRuns('import-graph.scan', runs, () => {
    edges = buildImportGraph({ files, readFile }).edges.length;
  });
  summary.detail = `${files.length} files → ${edges} edges`;
  return summary;
}

/** One `git log` over the fixed window. Returns the raw stream + its spawn cost. */
function captureGitLog(root) {
  const t0 = performance.now();
  const r = spawnSync('git', gitLogArgs({ limit: COMMIT_WINDOW }), {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
  });
  const spawnMs = performance.now() - t0;
  if (r.error || r.status !== 0) throw new Error(`git log failed: ${(r.stderr || r.error || '').toString().trim()}`);
  return { raw: r.stdout || '', spawnMs };
}

/** git-log.parse + file-health + calibrate-file-health, all over one captured window. */
export function measureGitCases(root, { runs = DEFAULT_RUNS } = {}) {
  let captured;
  try {
    captured = captureGitLog(root);
  } catch (error) {
    const err = { error: String(error.message || error) };
    return [
      summarize('git-log.parse', [], err),
      summarize('file-health', [], err),
      summarize('calibrate-file-health', [], err)
    ];
  }
  const commits = parseLog(captured.raw);
  // Fixed `now` = newest commit in the window, so the numbers do not drift with
  // the wall clock between a baseline and the run diffed against it.
  const newest = commits.reduce((acc, c) => Math.max(acc, Date.parse(c.dateIso) || 0), 0) || Date.now();

  const parse = timeRuns('git-log.parse', runs, () => { parseLog(captured.raw); }, {
    detail: `${commits.length} commits, ${captured.raw.length} B (git spawn ${ms(captured.spawnMs)} ms, not timed)`
  });
  const health = timeRuns('file-health', runs, () => { fileHealth(commits, { now: newest }); }, {
    detail: `${commits.length} commits`
  });
  const calib = timeRuns('calibrate-file-health', runs, () => {
    calibrateFileHealth(commits, { window: COMMIT_WINDOW, horizonDays: 30 });
  }, { detail: `${commits.length} commits, 30d horizon` });

  return [parse, health, calib];
}

/** answer-hook — the ambient per-edit hook, spawned end-to-end like the real thing. */
export function measureAnswerHookLatency(root, { runs = DEFAULT_RUNS, file = 'scripts/git-intel.mjs' } = {}) {
  const hook = path.join(SCRIPTS_DIR, 'brain-answer-hook.mjs');
  if (!fs.existsSync(hook)) return summarize('answer-hook', [], { error: `missing ${hook}` });
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }
  });
  let status = null;
  let bytes = 0;
  const summary = timeRuns('answer-hook', runs, () => {
    const r = spawnSync(process.execPath, [hook], {
      cwd: root,
      input: payload,
      encoding: 'utf8',
      timeout: 30000,
      // Dedupe off: measure the RAW per-edit cost, not the runtime's second-hit
      // shortcut. Usage log off: a measurement must not pollute the ledger.
      env: { ...process.env, BRAIN_ANSWER_DEDUPE: '0', BRAIN_USAGE_LOG: '0' }
    });
    status = r.status ?? null;
    bytes = Buffer.byteLength(String(r.stdout || ''), 'utf8');
  });
  summary.detail = `exit ${status}, ${bytes} B stdout (includes node startup)`;
  return summary;
}

/**
 * PURE-ish (one fs.existsSync per candidate). The pinned change set for this
 * repo: PINNED_FILES when they exist, else the first two entries of the sorted
 * source set. Deterministic for a given repo at a given commit.
 */
export function pinnedFiles(root) {
  const present = PINNED_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  if (present.length === PINNED_FILES.length) return [...present];
  return sourceFiles(root).slice(0, 2);
}

/**
 * ONE cold+warm pass over the API in THIS process. Only meaningful in a
 * freshly spawned process — serve/git.mjs and serve/graph.mjs cache per HEAD
 * at module scope, so calling this twice in one process yields two warm passes.
 * Used by --cold-worker (and directly by the budget test, which wants exactly
 * one cold /api/state reading).
 *
 * @returns {Promise<{files: string[], cold: Record<string, number>,
 *                    warm: Record<string, number>, status: Record<string, number>}>}
 */
export async function apiPassInProcess(root) {
  const serve = await import('./brain-serve.mjs');
  const token = 'b'.repeat(64);
  const files = pinnedFiles(root);
  const daemon = await serve.startServer({ root, port: 0, token });
  const get = (pathname) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: daemon.port, path: pathname, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.byteLength(body) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  const cold = {};
  const warm = {};
  const status = {};
  try {
    // Cold pass over ALL endpoints first, in the fixed order — that is the
    // sequence a first dashboard load actually produces, shared caches and all.
    for (const c of API_CASES) {
      const t0 = performance.now();
      const r = await get(c.path(files));
      cold[c.name] = performance.now() - t0;
      status[c.name] = r.status;
    }
    for (const c of API_CASES) {
      const t0 = performance.now();
      await get(c.path(files));
      warm[c.name] = performance.now() - t0;
    }
  } finally {
    await daemon.close();
  }
  return { files, cold, warm, status };
}

/**
 * N cold+warm API samples, each from its own child process (the only way to
 * get a genuinely cold cache more than once). A worker that fails contributes
 * nothing rather than a fabricated number; if every worker fails the cases
 * carry the error.
 */
export function measureApiCases(root, { runs = DEFAULT_RUNS } = {}) {
  const cold = new Map(API_CASES.map((c) => [c.name, []]));
  const warm = new Map(API_CASES.map((c) => [c.name, []]));
  const statuses = new Map();
  const errors = [];
  let files = [];
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(process.execPath, [SELF, '--cold-worker', '--root', root], {
      cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, BRAIN_USAGE_LOG: '0' }
    });
    let parsed = null;
    try { parsed = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || 'null'); } catch { parsed = null; }
    if (!parsed || parsed.error) {
      errors.push(String((parsed && parsed.error) || (r.stderr || '').trim() || `worker exit ${r.status}`));
      continue;
    }
    if (Array.isArray(parsed.files)) files = parsed.files;
    for (const c of API_CASES) {
      if (Number.isFinite(parsed.cold?.[c.name])) cold.get(c.name).push(parsed.cold[c.name]);
      if (Number.isFinite(parsed.warm?.[c.name])) warm.get(c.name).push(parsed.warm[c.name]);
      if (parsed.status?.[c.name] !== undefined && !statuses.has(c.name)) statuses.set(c.name, parsed.status[c.name]);
    }
  }
  const err = cold.get(API_CASES[0].name).length ? undefined : (errors[0] || 'no worker produced a sample');
  const pinned = files.length ? ` files=${files.length}` : '';
  const out = [];
  for (const c of API_CASES) {
    const httpStatus = statuses.has(c.name) ? statuses.get(c.name) : '?';
    out.push(summarize(`${c.name}.cold`, cold.get(c.name), {
      detail: `HTTP ${httpStatus}, fresh process per run${pinned}`, error: err
    }));
    out.push(summarize(`${c.name}.warm`, warm.get(c.name), {
      detail: `HTTP ${httpStatus}, caches primed by the cold pass${pinned}`, error: err
    }));
  }
  return out;
}

/** Run every case. Cases are independent: one failure never aborts the rest. */
export function runBench({ root = ROOT, runs = DEFAULT_RUNS } = {}) {
  const cases = [
    measureImportScan(root, { runs }),
    ...measureGitCases(root, { runs }),
    ...measureApiCases(root, { runs }),
    measureAnswerHookLatency(root, { runs })
  ];
  return {
    schema: BENCH_SCHEMA,
    generatedAt: new Date().toISOString(),
    runs,
    commitWindow: COMMIT_WINDOW,
    machine: machineFacts(),
    cases
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: node scripts/bench.mjs [--runs N] [--json] [--baseline] [--against [file]]',
    '',
    'A regression instrument. It reports how much SLOWER or FASTER a path got',
    'relative to a baseline taken on the SAME machine. It never claims a path is fast.',
    '',
    'Flags:',
    `  --runs N          Samples per case (default ${DEFAULT_RUNS}).`,
    '  --json            Emit the raw report/diff as JSON on stdout, nothing else.',
    `  --baseline        Write the measurement to ${BASELINE_REL} (COMMIT that file).`,
    `  --against [file]  Diff against a baseline (default ${BASELINE_REL}).`,
    '  --fail-on-regression   With --against, exit 1 when any case is SLOWER.',
    '',
    'Budgets for the fast paths are enforced separately, as a CI test:',
    'tests/bench-budget.test.mjs against BUDGETS in scripts/footprint.mjs.'
  ].join('\n');
}

async function coldWorker(root) {
  try {
    const result = await apiPassInProcess(root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String((error && error.message) || error) })}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const rootOpt = takeOption(args, '--root');
  const root = rootOpt ? path.resolve(rootOpt) : ROOT;

  if (takeFlag(args, '--cold-worker')) {
    await coldWorker(root);
    process.exit(0);
  }

  const json = takeFlag(args, '--json');
  const writeBaseline = takeFlag(args, '--baseline');
  const failOnRegression = takeFlag(args, '--fail-on-regression');
  // `--against` takes an OPTIONAL path: `--against` alone means the committed
  // baseline, so only consume the next token when it is not another flag.
  const againstIdx = args.indexOf('--against');
  let against = null;
  if (againstIdx !== -1) {
    const next = args[againstIdx + 1];
    against = next && !next.startsWith('--') ? next : BASELINE_REL;
    args.splice(againstIdx, next && !next.startsWith('--') ? 2 : 1);
  }
  const runsRaw = takeOption(args, '--runs');
  const runs = runsRaw ? Number(runsRaw) : DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    process.stderr.write(`[bench] --runs must be an integer 1-50, got: ${runsRaw}\n`);
    process.exit(1);
  }
  // A silently-ignored typo means someone waits 20 s for a measurement they did
  // not ask for and reads it as if they had.
  if (args.length) {
    process.stderr.write(`[bench] unknown argument(s): ${args.join(' ')}\n${usage()}\n`);
    process.exit(1);
  }

  const report = runBench({ root, runs });

  if (against) {
    const file = path.isAbsolute(against) ? against : path.join(root, against);
    if (!fs.existsSync(file)) {
      process.stderr.write(`[bench] no baseline at ${file} — run \`node scripts/bench.mjs --baseline\` first (and commit it).\n`);
      process.exit(1);
    }
    let baseline;
    try {
      baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      process.stderr.write(`[bench] unreadable baseline ${file}: ${error.message}\n`);
      process.exit(1);
    }
    const diff = diffReports(report, baseline);
    process.stdout.write(json ? `${JSON.stringify({ diff, current: report }, null, 2)}\n` : `${renderDiff(diff)}\n`);
    process.exit(failOnRegression && diff.regressions ? 1 : 0);
  }

  if (writeBaseline) {
    const file = path.join(root, BASELINE_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    // Results on stdout, notices on stderr — --json stays parseable.
    process.stderr.write(`[bench] baseline written to ${BASELINE_REL} — COMMIT it; it is the reference every --against diffs from.\n`);
  }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderTable(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    process.stderr.write(`[bench] ${(error && error.message) || error}\n`);
    process.exit(1);
  });
}
