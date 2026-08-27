/**
 * brain:release — version tagging + comparison layer (`project-brain x release`).
 *
 * WHY THIS EXISTS. We now ship several scores whose weights we GUESSED
 * (fileHealth's structure factors, fleet attention, the lint ranking). On this
 * repo the lint ranking measured AUC 0.4818 against a 0.4375 severity
 * baseline — both BELOW chance. "Is version B better than version A?" has to
 * stop being an argument and become a query with a confidence interval, and a
 * tag has to be a RETURN TICKET: when a weight change makes the numbers worse,
 * the way back is `git checkout <tag>`, not archaeology.
 *
 *   release snapshot [--json] [--out <path>]   measure HEAD into deterministic JSON
 *   release tag <name> [--message <m>]         annotated tag whose MESSAGE IS the snapshot
 *   release compare <refA> <refB> [--json]     per-metric deltas, CI where the data allows
 *   release list [--json]                      tags + snapshot headline, newest first
 *   release propose [--json]                   derive the next semver + changelog, and VERIFY it
 *
 * >>> `propose` PROPOSES. IT NEVER PUBLISHES. <<<
 * It creates no tag, pushes nothing, and does not touch package.json — it
 * prints the exact commands a human would run. A release is outward-facing and
 * hard to reverse, with a wider blast radius than a merge; ADR 0028's rule that
 * the human keeps the merge boundary applies here with MORE force, not less.
 * Do not "helpfully" automate this later.
 *
 * WHY `propose` VERIFIES INSTEAD OF TRUSTING THE PREFIXES. This repo's history
 * is ~91% conventional-commit conformant, but `BREAKING CHANGE` has never once
 * been used — while real breaking changes shipped under `fix:` (moving
 * @xenova/transformers from dependencies to optionalDependencies changed every
 * consumer's install shape). A version derived from subject prefixes alone is
 * therefore wrong in exactly the direction that hurts. So `propose` also diffs
 * the EXPORT SURFACE between the last tag and HEAD and reconciles the two: a
 * vanished export outranks a `fix:` prefix.
 *
 * KNOWN BLIND SPOT, stated up front: the export diff sees MODULE surfaces only.
 * The @xenova/transformers case above was an INSTALL-SHAPE break (a dependency
 * moved to optionalDependencies) with no export change at all, and this scan
 * would not have caught it. It catches the class of break it can see and says
 * so; it does not pretend to certify a release as non-breaking. Measured on
 * this repo's whole history, zero exports have ever disappeared — which is why
 * a package.json/behavioural detector, not a bigger export scan, is the next
 * thing worth building.
 *
 * >>> THE KEY DESIGN POINT <<<
 * The measurement travels WITH the tag. `tag` writes the whole snapshot into
 * the annotated tag's message body, so a comparison never depends on being
 * able to re-run the old code: six months and four refactors later,
 * `release compare v1 v2` still works because v1's numbers are in v1's tag
 * object, not in a script that no longer exists.
 *
 * >>> HONESTY RULES (product rules, not style) <<<
 *  1. NEVER report a delta as significant without a CI. Only metrics whose
 *     underlying data is a set of PAIRED ITEMS get one, and they get it from
 *     the existing paired-bootstrap machinery (`pairedBootstrap` in
 *     scripts/eval-lib.mjs — the same instrument brain:eval:compare uses;
 *     there is deliberately no second statistics implementation in this file).
 *     Single scalars (cycle count, an AUC, a byte budget) are reported as RAW
 *     DELTAS and labelled `raw-delta` / `unverified-change`.
 *  2. The default verdict is "indistinguishable at this sample size"
 *     (docs/eval-methodology.md): "better"/"worse" require a 95% CI that
 *     excludes 0.
 *  3. Timing metrics measured on DIFFERENT MACHINES are not a comparison.
 *     A node/platform/cpu mismatch marks every timing delta `not-comparable`
 *     instead of printing a number.
 *  4. A missing sub-block is `missing`, never 0. Every degradation records a
 *     reason in `provenance.degraded` and travels into the comparison output.
 *
 * Determinism: every sub-block is byte-stable for a given repo state, and
 * `--now <iso>` injects the clock (the underlying libraries never call
 * Date.now() themselves). Two snapshots of the same tree with the same `--now`
 * are byte-identical — that is what makes a stored snapshot trustworthy.
 *
 * Exit codes: 0 always, except genuine usage errors (2: unknown subcommand /
 * missing or malformed arguments) and refusals (1: dirty tree without
 * --allow-dirty, tag already exists, no snapshot to compare).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ROOT, takeFlag, takeOption } from './common.mjs';
import {
  gitLogArgs,
  parseLog,
  fileHealth,
  calibrateFileHealth,
  calibrateRisk,
  STRUCTURE_LEAKAGE_CAVEAT
} from './git-intel.mjs';
import {
  buildImportGraph,
  cycles as importCycles,
  orphans as importOrphans,
  defaultEntryPoints,
  ORPHAN_CAVEAT
} from './import-graph.mjs';
import { measureFiles, REFACTOR_THRESHOLDS } from './code-structure.mjs';
import { BUDGETS } from './footprint.mjs';
import { pairedBootstrap, round } from './eval-lib.mjs';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Bump only on a breaking snapshot-shape change; compare refuses to mix majors. */
export const SCHEMA_VERSION = 1;

/**
 * The sentinel that separates the human header from the machine payload inside
 * a tag message. Parsing keys off this exact line, so a human may edit the
 * header freely without breaking `compare`.
 */
export const SNAPSHOT_MARKER = '--- BRAIN-RELEASE-SNAPSHOT-V1 (JSON below, do not edit) ---';

const DEFAULT_COMMIT_WINDOW = 500;
const DEFAULT_CALIBRATE_WINDOW = 300;
const DEFAULT_HORIZON_DAYS = 30;
const DEFAULT_RESAMPLES = 10000;
const DEFAULT_SEED = 42;
const TOP_DANGER = 10;
const MIN_PAIRS_FOR_CI = 3;

/** Source extensions both import-graph and code-structure understand. */
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/i;
/** Never scanned. Mirrors brain-intel's set (duplicated on purpose — this command must not mutate shared discovery). */
const IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees)(\/|$)/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CYCLE_LEN = 8;
const MAX_CYCLES = 50;

const CI_CAVEAT_DANGER =
  'the danger CI is a paired bootstrap over the files present in BOTH top-10 lists — a SELECTED, ' +
  'not a random, sample. It answers "did the worst files move", not "did the repo move".';
const RAW_DELTA_CAVEAT =
  'metrics marked `raw-delta` are single scalars per snapshot: there is no per-item data to ' +
  'resample, so no confidence interval exists for them. A raw delta is a direction, never a result.';
const TIMING_CAVEAT =
  'timing metrics are only comparable when both snapshots were taken on the same machine (node, ' +
  'platform and CPU model all equal). Otherwise they are reported as `not-comparable`.';

// ---------------------------------------------------------------------------
// tiny helpers (pure)
// ---------------------------------------------------------------------------

/** Read a dotted path out of an object. Returns undefined for any missing hop. */
export function getPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Nearest-rank percentile over an ascending array. Deterministic, no interpolation. */
export function percentileOf(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return round(sortedAsc[idx]);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// git plumbing (the only impure part of snapshotting)
// ---------------------------------------------------------------------------

function git(args, { cwd, input } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '').trim(),
    error: r.error || null
  };
}

/** Tracked + untracked-but-not-ignored source files, filtered + sorted. null outside a git work tree. */
function gitSourceFiles(root) {
  const r = git(['ls-files', '-co', '--exclude-standard'], { cwd: root });
  if (!r.ok) return null;
  const files = r.stdout
    .split('\n')
    .filter((f) => f && SOURCE_EXT_RE.test(f) && !IGNORE_DIR_RE.test(f));
  return [...new Set(files)].sort(byString);
}

function makeReadFile(root) {
  const memo = new Map();
  return (rel) => {
    if (memo.has(rel)) {
      const cached = memo.get(rel);
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const abs = path.join(root, rel);
      if (fs.statSync(abs).size > MAX_SOURCE_BYTES) throw new Error('file exceeds the 2MB scan cap');
      const text = fs.readFileSync(abs, 'utf8');
      memo.set(rel, text);
      return text;
    } catch (error) {
      memo.set(rel, error);
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

/**
 * Capture the repo's measurable state at HEAD.
 *
 * TOTAL by construction: every sub-block is wrapped, and a failure degrades the
 * block to `null` with a reason recorded in `provenance.degraded` (and echoed
 * into `caveats`) rather than aborting the snapshot. A snapshot that says
 * "I could not measure the graph, because X" is worth far more than no snapshot.
 *
 * @param {{root?, now?, commitWindow?, calibrateWindow?, horizonDays?,
 *          withTests?, withLint?, sarifPaths?}} opts
 * @returns {object} deterministic snapshot (stable key order, stable arrays)
 */
export function buildSnapshot(opts = {}) {
  const root = opts.root || ROOT;
  const nowIso = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const commitWindow = Number(opts.commitWindow) > 0 ? Number(opts.commitWindow) : DEFAULT_COMMIT_WINDOW;
  const calibrateWindow = Number(opts.calibrateWindow) > 0 ? Number(opts.calibrateWindow) : DEFAULT_CALIBRATE_WINDOW;
  const horizonDays = Number(opts.horizonDays) > 0 ? Number(opts.horizonDays) : DEFAULT_HORIZON_DAYS;

  const degraded = {};
  const caveats = [];
  const degrade = (block, reason) => {
    degraded[block] = reason;
    caveats.push(`${block}: null — ${reason}`);
    return null;
  };

  // -- git identity -------------------------------------------------------
  const revParse = git(['rev-parse', 'HEAD'], { cwd: root });
  const commit = revParse.ok ? revParse.stdout.trim() : null;
  const describe = git(['describe', '--tags', '--exact-match', 'HEAD'], { cwd: root });
  const version = describe.ok && describe.stdout.trim() ? describe.stdout.trim() : 'HEAD';
  const branchRes = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const branch = branchRes.ok ? branchRes.stdout.trim() : null;
  const statusRes = git(['status', '--porcelain'], { cwd: root });
  const dirty = statusRes.ok ? statusRes.stdout.trim().length > 0 : false;
  if (!commit) caveats.push('commit: null — `git rev-parse HEAD` failed (not a git work tree, or no commits yet).');
  if (dirty) {
    caveats.push(
      'the working tree was DIRTY when this snapshot was taken, so these numbers describe the tree, ' +
      `not commit ${commit ? commit.slice(0, 7) : '(unknown)'} alone.`
    );
  }

  // -- commit history (feeds danger + both git calibrations) --------------
  let commits = null;
  let commitsReason = '';
  {
    const r = git(gitLogArgs({ limit: commitWindow }), { cwd: root });
    if (!r.ok) commitsReason = `git log failed (status ${r.status}): ${r.stderr || 'no stderr'}`;
    else {
      try {
        commits = parseLog(r.stdout);
        if (!commits.length) { commits = null; commitsReason = 'git log returned no commits in this repo'; }
      } catch (error) {
        commits = null;
        commitsReason = `git log could not be parsed: ${error.message || error}`;
      }
    }
  }

  // -- danger -------------------------------------------------------------
  let danger = null;
  if (!commits) danger = degrade('danger', commitsReason);
  else {
    try {
      const health = fileHealth(commits, { now: nowMs });
      const scores = health.files.map((f) => f.score).filter(isNum).sort((a, b) => a - b);
      danger = {
        top10: health.files.slice(0, TOP_DANGER).map((f) => ({ file: f.file, score: round(f.score) })),
        median: percentileOf(scores, 0.5),
        p90: percentileOf(scores, 0.9),
        files: scores.length
      };
    } catch (error) {
      danger = degrade('danger', `fileHealth() threw: ${error.message || error}`);
    }
  }

  // -- structural context (shared by graph + structure) --------------------
  const sourceFiles = gitSourceFiles(root);
  const readFile = makeReadFile(root);

  // -- graph --------------------------------------------------------------
  let graph = null;
  if (!sourceFiles) graph = degrade('graph', '`git ls-files` failed — cannot enumerate source files outside a git work tree');
  else if (!sourceFiles.length) graph = degrade('graph', 'no scannable source files in this repo');
  else {
    try {
      const g = buildImportGraph({ files: sourceFiles, readFile });
      const cyc = importCycles(g, { maxLen: MAX_CYCLE_LEN, maxCycles: MAX_CYCLES });
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { pkg = {}; }
      const orph = importOrphans(g, { entryPoints: defaultEntryPoints({ pkg, files: sourceFiles }) });
      const cov = g.coverage || {};
      graph = {
        files: g.nodes.length,
        edges: g.edges.length,
        cycles: cyc.cycles.length,
        cyclesTruncated: Boolean(cyc.truncated),
        orphans: orph.candidates.length,
        unresolvedRatio: cov.totalSpecs ? round(cov.unresolvedSpecs / cov.totalSpecs) : 0
      };
      caveats.push(`graph.orphans: ${ORPHAN_CAVEAT}`);
      if (cyc.truncated) {
        caveats.push(
          `graph.cycles: enumeration hit the cap (maxLen ${MAX_CYCLE_LEN}, maxCycles ${MAX_CYCLES}) — ` +
          'the count is a floor, so a cycle delta across snapshots may be an artefact of the cap.'
        );
      }
    } catch (error) {
      graph = degrade('graph', `buildImportGraph() threw: ${error.message || error}`);
    }
  }

  // -- structure ----------------------------------------------------------
  let structure = null;
  if (!sourceFiles) structure = degrade('structure', '`git ls-files` failed — cannot enumerate source files outside a git work tree');
  else if (!sourceFiles.length) structure = degrade('structure', 'no measurable source files in this repo');
  else {
    try {
      const measured = measureFiles({ files: sourceFiles, readFile });
      const rows = measured.files;
      structure = {
        files: rows.length,
        totalCodeLines: rows.reduce((sum, m) => sum + (m.codeLines || 0), 0),
        filesOverSplitThreshold: rows.filter((m) => (m.codeLines || 0) > REFACTOR_THRESHOLDS.splitCodeLines).length,
        maxNesting: rows.reduce((max, m) => Math.max(max, m.maxNestingDepth || 0), 0),
        longestFunction: rows.reduce((max, m) => Math.max(max, m.longestFunctionLines || 0), 0),
        splitThreshold: REFACTOR_THRESHOLDS.splitCodeLines
      };
    } catch (error) {
      structure = degrade('structure', `measureFiles() threw: ${error.message || error}`);
    }
  }

  // -- calibration --------------------------------------------------------
  const calibration = {
    fileHealth: null,
    risk: null,
    lintRank: null
  };
  if (!commits) {
    calibration.fileHealth = degrade('calibration.fileHealth', commitsReason);
    calibration.risk = degrade('calibration.risk', commitsReason);
  } else {
    try {
      const cal = calibrateFileHealth(commits, { window: calibrateWindow, horizonDays });
      calibration.fileHealth = {
        auc: isNum(cal.auc) ? round(cal.auc) : null,
        files: cal.evaluated,
        positives: cal.defective,
        // An AUC without power is a number, not evidence — a snapshot that
        // records one without the flag invites a later `compare` to read a
        // swing in noise as progress.
        sufficientEvidence: cal.sufficientEvidence === true,
        minorityClass: cal.minorityClass ?? null
      };
      if (!isNum(cal.auc)) {
        caveats.push('calibration.fileHealth.auc is null — the cut point left no mixed population (need both fixed and clean files after the cut).');
      } else if (!cal.sufficientEvidence) {
        caveats.push(`calibration.fileHealth: UNDERPOWERED — ${cal.minorityClass} file(s) in the smaller class, below the ${cal.minPositives} this AUC needs to mean anything. Recorded, not citable.`);
      }
    } catch (error) {
      calibration.fileHealth = degrade('calibration.fileHealth', `calibrateFileHealth() threw: ${error.message || error}`);
    }
    try {
      const cal = calibrateRisk(commits, { window: calibrateWindow, horizonDays });
      calibration.risk = {
        auc: isNum(cal.auc) ? round(cal.auc) : null,
        commits: cal.evaluated,
        positives: cal.defective,
        sufficientEvidence: cal.sufficientEvidence === true,
        minorityClass: cal.minorityClass ?? null
      };
      if (!isNum(cal.auc)) {
        caveats.push('calibration.risk.auc is null — the window held no mixed population (need both defective and clean commits).');
      } else if (!cal.sufficientEvidence) {
        caveats.push(`calibration.risk: UNDERPOWERED — ${cal.minorityClass} commit(s) in the smaller class, below the ${cal.minPositives} this AUC needs to mean anything. Recorded, not citable.`);
      }
    } catch (error) {
      calibration.risk = degrade('calibration.risk', `calibrateRisk() threw: ${error.message || error}`);
    }
  }
  if (!opts.withLint) {
    calibration.lintRank = degrade(
      'calibration.lintRank',
      'lint calibration not requested — pass --with-lint (it spawns the configured linters, which is slow and environment-dependent)'
    );
  } else if (!commits) {
    calibration.lintRank = degrade('calibration.lintRank', commitsReason);
  } else if (!opts.lintIntel) {
    calibration.lintRank = degrade('calibration.lintRank', 'scripts/lint-intel.mjs could not be loaded in this checkout');
  } else {
    const lint = collectLintCalibration({ lint: opts.lintIntel, root, commits, horizonDays, sarifPaths: opts.sarifPaths || [] });
    if (lint.error) calibration.lintRank = degrade('calibration.lintRank', lint.error);
    else {
      calibration.lintRank = lint.block;
      for (const c of lint.caveats) caveats.push(c);
    }
  }

  // -- tests --------------------------------------------------------------
  let tests = null;
  {
    const files = countTestFiles(root);
    if (files === null) tests = degrade('tests', 'no tests/ directory in this repo');
    else if (!opts.withTests) {
      tests = { files, wallClockMs: null };
      caveats.push('tests.wallClockMs is null — the suite was not run (pass --with-tests). Timing is opt-in because it is slow and machine-bound.');
    } else {
      const timed = runTests(root);
      tests = { files, wallClockMs: timed.ms, exitCode: timed.exitCode };
      if (timed.exitCode !== 0) {
        caveats.push(`tests: the suite exited ${timed.exitCode} — the wall clock is the time to FAIL, not the time to pass.`);
      }
    }
  }

  // -- bench (owned by a parallel agent; treat as existing-or-absent) ------
  let bench = null;
  {
    const benchScript = path.join(root, 'scripts', 'bench.mjs');
    const baselineFile = path.join(root, '.project-brain', 'bench-baseline.json');
    if (!fs.existsSync(benchScript)) {
      bench = degrade('bench', 'scripts/bench.mjs is not present in this repo — no bench baseline to embed');
    } else if (!fs.existsSync(baselineFile)) {
      bench = degrade('bench', 'scripts/bench.mjs exists but .project-brain/bench-baseline.json does not — run the bench to record a baseline first');
    } else {
      try {
        bench = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
        caveats.push('bench: the RECORDED baseline was embedded verbatim (bench-baseline.json), not re-run at snapshot time — it may predate this commit.');
      } catch (error) {
        bench = degrade('bench', `.project-brain/bench-baseline.json is unreadable: ${error.message || error}`);
      }
    }
  }

  const cpus = safeCpus();

  return {
    schema: SCHEMA_VERSION,
    version,
    commit,
    date: nowIso,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    danger,
    calibration,
    graph,
    structure,
    tests,
    bench,
    budgets: { ...BUDGETS },
    provenance: {
      tool: 'brain-release',
      schema: SCHEMA_VERSION,
      branch,
      dirty,
      cpu: cpus.model,
      cores: cpus.count,
      commitWindow,
      calibrateWindow,
      horizonDays,
      commitsAnalyzed: commits ? commits.length : 0,
      sourceFiles: sourceFiles ? sourceFiles.length : 0,
      withTests: Boolean(opts.withTests),
      withLint: Boolean(opts.withLint),
      degraded
    },
    caveats
  };
}

function safeCpus() {
  try {
    const list = os.cpus() || [];
    return { model: list.length ? String(list[0].model).trim() : null, count: list.length };
  } catch {
    return { model: null, count: 0 };
  }
}

/** Count `*.test.mjs` under tests/. null when there is no tests/ directory. */
function countTestFiles(root) {
  const dir = path.join(root, 'tests');
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    return fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.test.mjs')).length;
  } catch {
    return 0;
  }
}

function runTests(root) {
  const started = Date.now();
  const r = spawnSync('npm', ['test', '--silent'], { cwd: root, encoding: 'utf8', timeout: 15 * 60_000 });
  return { ms: Date.now() - started, exitCode: r.error ? -1 : (r.status ?? -1) };
}

/**
 * Run the configured linters and calibrate their ranking against this repo's
 * own fix history. The lint-intel MODULE is injected (`opts.lintIntel`) rather
 * than imported here: it is a large module, and a snapshot without --with-lint
 * must not pay for it — while buildSnapshot() itself stays synchronous, so
 * determinism never depends on scheduling.
 */
function collectLintCalibration({ lint, root, commits, horizonDays, sarifPaths }) {
  const findings = [];
  const notRun = [];
  const runners = [
    ['eslint', lint.runEslint],
    ['ruff', lint.runRuff],
    ['golangci-lint', lint.runGolangciLint],
    ['clippy', lint.runClippy],
    ['phpstan', lint.runPhpstan]
  ];
  for (const [name, run] of runners) {
    if (typeof run !== 'function') continue;
    let result;
    try { result = run({ root }); } catch (error) { result = { name, ran: false, reason: String(error.message || error) }; }
    if (result && result.ran) findings.push(...(result.findings || []));
    else notRun.push(`${name}: ${(result && result.reason) || 'did not run'}`);
  }
  if (sarifPaths.length && typeof lint.readSarifFiles === 'function') {
    for (const entry of lint.readSarifFiles(sarifPaths, { root })) {
      if (entry.ran) findings.push(...(entry.findings || []));
      else notRun.push(`sarif: ${entry.reason || 'unreadable'}`);
    }
  }
  if (!findings.length) {
    return { error: `no linter produced findings (${notRun.join('; ') || 'no runners available'})` };
  }
  let cal;
  try {
    cal = lint.calibrateLintRank(findings, commits, { horizonDays });
  } catch (error) {
    return { error: `calibrateLintRank() threw: ${error.message || error}` };
  }
  const caveats = [`calibration.lintRank: ${lint.LINT_CALIBRATION_CAVEAT}`];
  if (lint.WEIGHTS_NOT_CALIBRATED_NOTE) caveats.push(`calibration.lintRank: ${lint.WEIGHTS_NOT_CALIBRATED_NOTE}`);
  const auc = isNum(cal.auc) ? round(cal.auc) : null;
  const baseline = isNum(cal.severityOnlyAuc) ? round(cal.severityOnlyAuc) : null;
  return {
    caveats,
    block: {
      auc,
      severityBaseline: baseline,
      advantage: auc !== null && baseline !== null ? round(auc - baseline) : null,
      findings: cal.findingsConsidered,
      files: cal.evaluated,
      positives: cal.defective
    }
  };
}

// ---------------------------------------------------------------------------
// tag message: snapshot ⇄ text
// ---------------------------------------------------------------------------

/** Human-readable one-liner used in the tag header and by `list`. */
export function headline(snapshot) {
  if (!snapshot) return '(no snapshot)';
  const parts = [];
  parts.push(String(snapshot.date || '').slice(0, 10) || 'undated');
  parts.push(snapshot.commit ? String(snapshot.commit).slice(0, 7) : 'no-commit');
  const fh = getPath(snapshot, 'calibration.fileHealth.auc');
  parts.push(`health AUC ${fmtNum(fh)}`);
  const lr = getPath(snapshot, 'calibration.lintRank.auc');
  if (lr !== undefined && lr !== null) parts.push(`lint AUC ${fmtNum(lr)}`);
  parts.push(`danger p90 ${fmtNum(getPath(snapshot, 'danger.p90'))}`);
  parts.push(`cycles ${fmtNum(getPath(snapshot, 'graph.cycles'))}`);
  if (getPath(snapshot, 'provenance.dirty')) parts.push('DIRTY');
  return parts.join(' · ');
}

function fmtNum(v) {
  if (v === null || v === undefined) return 'n/a';
  return typeof v === 'number' ? String(v) : String(v);
}

/**
 * The tag message: a human header a person can read with `git show`, then the
 * sentinel, then the snapshot as ONE line of compact JSON. `parseTagMessage`
 * is the exact inverse of the JSON half.
 */
export function buildTagMessage(snapshot, { name = '', message = '' } = {}) {
  const lines = [];
  lines.push(`project-brain release ${name || snapshot.version || 'snapshot'}`);
  lines.push('');
  if (message) { lines.push(message); lines.push(''); }
  lines.push(headline(snapshot));
  lines.push('');
  lines.push(`commit    ${snapshot.commit || 'n/a'}`);
  lines.push(`date      ${snapshot.date}`);
  lines.push(`runtime   node ${snapshot.node} on ${snapshot.platform}`);
  if (snapshot.provenance && snapshot.provenance.dirty) {
    lines.push('WARNING   taken on a DIRTY working tree — these numbers do not describe the commit alone.');
  }
  const missing = Object.keys((snapshot.provenance && snapshot.provenance.degraded) || {});
  if (missing.length) lines.push(`missing   ${missing.join(', ')}`);
  lines.push('');
  lines.push('This measurement travels with the tag: `project-brain x release compare <this> <other>`');
  lines.push('works without re-running the code that produced it. Return ticket: `git checkout <this>`.');
  lines.push('');
  lines.push(SNAPSHOT_MARKER);
  lines.push(JSON.stringify(snapshot));
  return lines.join('\n') + '\n';
}

/** Inverse of buildTagMessage's payload half. Returns null when no snapshot is stored. */
export function parseTagMessage(text) {
  const raw = String(text || '');
  const at = raw.indexOf(SNAPSHOT_MARKER);
  if (at === -1) return null;
  const payload = raw.slice(at + SNAPSHOT_MARKER.length).trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

/**
 * Are the two snapshots' TIMING numbers comparable at all? A benchmark taken
 * on a different machine is not a slower/faster verdict, it is a different
 * experiment — so any mismatch here turns every timing delta into
 * `not-comparable` rather than a printed number.
 */
export function machineMatch(a, b) {
  const mismatches = [];
  const check = (label, va, vb) => {
    if (va !== vb) mismatches.push(`${label}: ${va === null || va === undefined ? 'unknown' : va} vs ${vb === null || vb === undefined ? 'unknown' : vb}`);
  };
  check('node', a.node, b.node);
  check('platform', a.platform, b.platform);
  check('cpu', getPath(a, 'provenance.cpu'), getPath(b, 'provenance.cpu'));
  return { comparable: mismatches.length === 0, mismatches };
}

/**
 * A paired-bootstrap CI over two equal-length numeric series, delegating ALL
 * statistics to `pairedBootstrap` in scripts/eval-lib.mjs — the same 10k-resample,
 * seeded, 95%-percentile instrument brain:eval:compare uses. The values ride in
 * the `hit` slot (the second slot is zeroed and ignored); this file deliberately
 * contains no resampling code of its own.
 */
export function pairedMeanCI(valuesA, valuesB, { resamples = DEFAULT_RESAMPLES, seed = DEFAULT_SEED } = {}) {
  const pairsA = valuesA.map((v) => ({ hit: v, reciprocalRank: 0 }));
  const pairsB = valuesB.map((v) => ({ hit: v, reciprocalRank: 0 }));
  const stats = pairedBootstrap(pairsA, pairsB, { resamples, seed });
  return {
    delta: stats.hit.delta,
    ci95: stats.hit.ci95,
    significant: stats.hit.significant,
    cases: stats.cases,
    resamples: stats.resamples,
    seed: stats.seed
  };
}

/** Scalar metrics we know how to read out of a snapshot, with their polarity. */
const METRIC_SPECS = [
  { block: 'danger', key: 'median', better: 'lower' },
  { block: 'danger', key: 'p90', better: 'lower' },
  { block: 'calibration.fileHealth', key: 'auc', better: 'higher' },
  { block: 'calibration.fileHealth', key: 'files', better: 'neutral' },
  { block: 'calibration.fileHealth', key: 'positives', better: 'neutral' },
  { block: 'calibration.risk', key: 'auc', better: 'higher' },
  { block: 'calibration.risk', key: 'commits', better: 'neutral' },
  { block: 'calibration.risk', key: 'positives', better: 'neutral' },
  { block: 'calibration.lintRank', key: 'auc', better: 'higher' },
  { block: 'calibration.lintRank', key: 'severityBaseline', better: 'neutral' },
  { block: 'calibration.lintRank', key: 'advantage', better: 'higher' },
  { block: 'calibration.lintRank', key: 'findings', better: 'neutral' },
  { block: 'graph', key: 'files', better: 'neutral' },
  { block: 'graph', key: 'edges', better: 'neutral' },
  { block: 'graph', key: 'cycles', better: 'lower' },
  { block: 'graph', key: 'orphans', better: 'lower' },
  { block: 'graph', key: 'unresolvedRatio', better: 'lower' },
  { block: 'structure', key: 'totalCodeLines', better: 'neutral' },
  { block: 'structure', key: 'filesOverSplitThreshold', better: 'lower' },
  { block: 'structure', key: 'maxNesting', better: 'lower' },
  { block: 'structure', key: 'longestFunction', better: 'lower' },
  { block: 'tests', key: 'files', better: 'higher' },
  { block: 'tests', key: 'wallClockMs', better: 'lower', timing: true }
];

/** Flatten a bench baseline to dotted numeric leaves. Deterministic, depth- and size-capped. */
export function flattenBench(bench, prefix = 'bench', depth = 0, out = []) {
  if (depth > 4 || bench === null || typeof bench !== 'object') return out;
  const keys = Array.isArray(bench) ? bench.map((_, i) => String(i)) : Object.keys(bench).sort(byString);
  for (const key of keys) {
    const value = bench[key];
    const label = `${prefix}.${key}`;
    if (isNum(value)) out.push({ metric: label, value });
    else if (value && typeof value === 'object') flattenBench(value, label, depth + 1, out);
    if (out.length >= 40) break;
  }
  return out;
}

function missingRow(metric, better, a, b, blockPath) {
  const sides = [];
  if (getPath(a, blockPath) == null) sides.push('A');
  if (getPath(b, blockPath) == null) sides.push('B');
  const reasons = sides
    .map((side) => {
      const snap = side === 'A' ? a : b;
      // `degraded` is keyed by the LITERAL block path ("calibration.lintRank"),
      // so index it directly — getPath would split that key on its dot.
      const reason = (getPath(snap, 'provenance.degraded') || {})[blockPath];
      return `${side}: ${reason || 'no reason recorded'}`;
    })
    .join(' | ');
  return {
    metric,
    a: null,
    b: null,
    delta: null,
    betterWhen: better,
    evidence: 'missing',
    verdict: 'missing',
    note: `sub-block \`${blockPath}\` is absent on ${sides.join(' and ')} — reported as MISSING, not as zero. ${reasons}`
  };
}

function rawDeltaRow({ metric, va, vb, better, timing, machine }) {
  if (timing && !machine.comparable) {
    return {
      metric,
      a: va,
      b: vb,
      delta: null,
      betterWhen: better,
      evidence: 'not-comparable',
      verdict: 'not-comparable',
      note: `timing measured on different machines (${machine.mismatches.join('; ')}) — a delta here would be a machine difference, not a code difference.`
    };
  }
  const delta = round(vb - va);
  if (delta === 0) {
    return { metric, a: va, b: vb, delta, betterWhen: better, evidence: 'raw-delta', verdict: 'unchanged', note: 'identical on both snapshots.' };
  }
  if (better === 'neutral') {
    return {
      metric, a: va, b: vb, delta, betterWhen: better, evidence: 'raw-delta', verdict: 'changed',
      note: 'context metric — a change here is neither better nor worse on its own; it sizes the other deltas.'
    };
  }
  const improved = better === 'lower' ? delta < 0 : delta > 0;
  return {
    metric, a: va, b: vb, delta, betterWhen: better, evidence: 'raw-delta', verdict: 'unverified-change',
    note: `${improved ? 'moved in the better direction' : 'moved in the worse direction'} — RAW DELTA only. ` +
      'A single scalar per snapshot cannot be resampled, so no CI backs this; it is a direction, not a result.'
  };
}

/**
 * Per-metric comparison of two snapshots.
 *
 * Where the snapshot stores PAIRED ITEMS (today: the per-file danger scores)
 * the delta comes with a 95% CI from the shared paired bootstrap. Everywhere
 * else it is an explicitly labelled raw delta. The overall verdict defaults to
 * "indistinguishable" and only moves when a CI excludes 0.
 */
export function compareSnapshots(a, b, opts = {}) {
  const labelA = opts.labelA || a.version || 'A';
  const labelB = opts.labelB || b.version || 'B';
  const machine = machineMatch(a, b);
  const metrics = [];
  const caveats = [];

  // --- the one metric with per-item data: danger scores, paired by file ----
  const topA = new Map((getPath(a, 'danger.top10') || []).map((r) => [r.file, r.score]));
  const topB = new Map((getPath(b, 'danger.top10') || []).map((r) => [r.file, r.score]));
  if (a.danger == null || b.danger == null) {
    metrics.push(missingRow('danger.top10.meanScore', 'lower', a, b, 'danger'));
  } else {
    const shared = [...topA.keys()].filter((f) => topB.has(f)).sort(byString);
    if (shared.length < MIN_PAIRS_FOR_CI) {
      metrics.push({
        metric: 'danger.top10.meanScore',
        a: null, b: null, delta: null, betterWhen: 'lower',
        evidence: 'insufficient-pairs',
        verdict: 'indistinguishable',
        cases: shared.length,
        note: `only ${shared.length} file(s) appear in BOTH top-10 danger lists — too few pairs to bootstrap. ` +
          'No CI, therefore no claim.'
      });
    } else {
      const stats = pairedMeanCI(
        shared.map((f) => topA.get(f)),
        shared.map((f) => topB.get(f)),
        { resamples: opts.resamples || DEFAULT_RESAMPLES, seed: opts.seed || DEFAULT_SEED }
      );
      const improved = stats.delta < 0; // lower danger is better
      metrics.push({
        metric: 'danger.top10.meanScore',
        a: round(mean(shared.map((f) => topA.get(f)))),
        b: round(mean(shared.map((f) => topB.get(f)))),
        delta: stats.delta,
        betterWhen: 'lower',
        evidence: 'paired-bootstrap',
        ci95: stats.ci95,
        significant: stats.significant,
        cases: stats.cases,
        resamples: stats.resamples,
        seed: stats.seed,
        verdict: stats.significant ? (improved ? 'better' : 'worse') : 'indistinguishable',
        note: stats.significant
          ? '95% CI excludes 0.'
          : `95% CI [${stats.ci95[0]}, ${stats.ci95[1]}] includes 0 — indistinguishable at n=${stats.cases}.`
      });
      caveats.push(CI_CAVEAT_DANGER);
    }
  }

  // --- scalar metrics -----------------------------------------------------
  for (const spec of METRIC_SPECS) {
    const metric = `${spec.block}.${spec.key}`;
    const blockA = getPath(a, spec.block);
    const blockB = getPath(b, spec.block);
    if (blockA == null || blockB == null) {
      metrics.push(missingRow(metric, spec.better, a, b, spec.block));
      continue;
    }
    const va = blockA[spec.key];
    const vb = blockB[spec.key];
    if (!isNum(va) || !isNum(vb)) {
      metrics.push({
        metric, a: isNum(va) ? va : null, b: isNum(vb) ? vb : null, delta: null,
        betterWhen: spec.better, evidence: 'missing', verdict: 'missing',
        note: `\`${spec.key}\` was not recorded as a number on ${!isNum(va) ? 'A' : ''}${!isNum(va) && !isNum(vb) ? ' and ' : ''}${!isNum(vb) ? 'B' : ''} — reported as MISSING, not as zero.`
      });
      continue;
    }
    metrics.push(rawDeltaRow({ metric, va, vb, better: spec.better, timing: spec.timing, machine }));
  }

  // --- budgets (key set may differ across schema versions) -----------------
  const budgetKeys = [...new Set([...Object.keys(a.budgets || {}), ...Object.keys(b.budgets || {})])].sort(byString);
  for (const key of budgetKeys) {
    const metric = `budgets.${key}`;
    const va = (a.budgets || {})[key];
    const vb = (b.budgets || {})[key];
    if (!isNum(va) || !isNum(vb)) {
      metrics.push({
        metric, a: isNum(va) ? va : null, b: isNum(vb) ? vb : null, delta: null,
        betterWhen: 'neutral', evidence: 'missing', verdict: 'missing',
        note: 'budget key absent on one side — a budget that did not exist yet is MISSING, not 0.'
      });
      continue;
    }
    metrics.push(rawDeltaRow({ metric, va, vb, better: 'neutral', machine }));
  }

  // --- bench (timing by definition) ---------------------------------------
  if (a.bench == null || b.bench == null) {
    metrics.push(missingRow('bench', 'lower', a, b, 'bench'));
  } else {
    const flatA = new Map(flattenBench(a.bench).map((r) => [r.metric, r.value]));
    const flatB = new Map(flattenBench(b.bench).map((r) => [r.metric, r.value]));
    const shared = [...flatA.keys()].filter((k) => flatB.has(k)).sort(byString);
    if (!shared.length) {
      metrics.push({
        metric: 'bench', a: null, b: null, delta: null, betterWhen: 'lower',
        evidence: 'missing', verdict: 'missing',
        note: 'both snapshots carry a bench baseline but they share no numeric key — the baselines are not the same experiment.'
      });
    } else {
      for (const key of shared) {
        metrics.push(rawDeltaRow({ metric: key, va: flatA.get(key), vb: flatB.get(key), better: 'lower', timing: true, machine }));
      }
    }
  }

  metrics.sort((x, y) => byString(x.metric, y.metric));

  // --- verdict ------------------------------------------------------------
  const withCI = metrics.filter((m) => m.evidence === 'paired-bootstrap');
  const sigBetter = withCI.filter((m) => m.verdict === 'better');
  const sigWorse = withCI.filter((m) => m.verdict === 'worse');
  const unverified = metrics.filter((m) => m.verdict === 'unverified-change');
  const missing = metrics.filter((m) => m.verdict === 'missing');
  const notComparable = metrics.filter((m) => m.verdict === 'not-comparable');

  let verdict;
  let headlineText;
  if (sigWorse.length) {
    verdict = 'worse';
    headlineText = `WORSE — ${sigWorse.map((m) => m.metric).join(', ')}: 95% CI excludes 0 in the wrong direction.`;
  } else if (sigBetter.length) {
    verdict = 'better';
    headlineText = `BETTER — ${sigBetter.map((m) => m.metric).join(', ')}: 95% CI excludes 0 in the right direction.`;
  } else {
    verdict = 'indistinguishable';
    headlineText =
      `INDISTINGUISHABLE at this sample size — no metric's 95% CI excludes 0` +
      (unverified.length
        ? `, and the ${unverified.length} metric(s) that moved are raw deltas with no CI behind them.`
        : '.');
  }

  caveats.push(RAW_DELTA_CAVEAT);
  if (!machine.comparable) caveats.push(TIMING_CAVEAT);
  if (opts.recomputed && opts.recomputed.length) {
    caveats.push(
      `${opts.recomputed.join(' and ')} had no stored snapshot and was RECOMPUTED from the current ` +
      'working tree. That is a weaker comparison: it measures today\'s code, not the code that ref names.'
    );
  }
  for (const side of [['A', a], ['B', b]]) {
    if (getPath(side[1], 'provenance.dirty')) {
      caveats.push(`side ${side[0]} (${side[0] === 'A' ? labelA : labelB}) was snapshotted on a DIRTY tree — it does not describe its commit alone.`);
    }
  }

  return {
    a: sideSummary(a, labelA, opts.sourceA),
    b: sideSummary(b, labelB, opts.sourceB),
    machine,
    metrics,
    summary: {
      metrics: metrics.length,
      withCI: withCI.length,
      significant: sigBetter.length + sigWorse.length,
      unverifiedChanges: unverified.length,
      missing: missing.length,
      notComparable: notComparable.length
    },
    verdict,
    headline: headlineText,
    caveats
  };
}

function sideSummary(snap, label, source) {
  return {
    label,
    source: source || 'tag',
    version: snap.version || null,
    commit: snap.commit || null,
    date: snap.date || null,
    node: snap.node || null,
    platform: snap.platform || null,
    dirty: Boolean(getPath(snap, 'provenance.dirty')),
    headline: headline(snap)
  };
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

// ---------------------------------------------------------------------------
// next-action lines (mandatory on every subcommand — "kein Score ohne Aktion")
// ---------------------------------------------------------------------------

export function nextActionForSnapshot(snapshot) {
  const missing = Object.keys(getPath(snapshot, 'provenance.degraded') || {});
  if (missing.length) {
    return `Next: this snapshot is missing ${missing.join(', ')} — read \`caveats\` for why, then ` +
      '`project-brain x release tag <name>` to store it anyway (a partial measurement beats none).';
  }
  return 'Next: `project-brain x release tag <name>` — store this in an annotated tag so the numbers ' +
    'outlive the code that produced them (return ticket: `git checkout <name>`).';
}

export function nextActionForCompare(report) {
  if (report.verdict === 'worse') {
    return `Next: \`git checkout ${report.a.label}\` — ${report.b.label} measured worse with a CI that excludes 0. ` +
      'That checkout is the return ticket; do not argue with the interval.';
  }
  if (report.verdict === 'better') {
    return `Next: keep ${report.b.label} and record the CI in the PR body — a 95% CI excluding 0 is what ` +
      'docs/eval-methodology.md requires before anything ships default-ON.';
  }
  return 'Next: ship nothing on this evidence. Either enlarge the sample (more tagged snapshots, more ' +
    'paired items per metric) or keep the current defaults — "indistinguishable" is a result, not a stall.';
}

// ---------------------------------------------------------------------------
// human formatting
// ---------------------------------------------------------------------------

export function formatSnapshot(snapshot) {
  const lines = [];
  lines.push(`Snapshot ${snapshot.version} @ ${snapshot.commit ? snapshot.commit.slice(0, 7) : 'no-commit'}${getPath(snapshot, 'provenance.dirty') ? ' (DIRTY TREE)' : ''}`);
  lines.push(`  ${snapshot.date} · node ${snapshot.node} · ${snapshot.platform}`);
  lines.push('');
  const row = (label, value) => lines.push(`  ${label.padEnd(30)} ${value}`);
  if (snapshot.danger) {
    row('danger median / p90', `${fmtNum(snapshot.danger.median)} / ${fmtNum(snapshot.danger.p90)} over ${snapshot.danger.files} file(s)`);
    for (const t of snapshot.danger.top10.slice(0, 5)) row(`  top: ${t.file}`, String(t.score));
  } else row('danger', 'MISSING — see caveats');
  const cal = snapshot.calibration || {};
  const power = (b) => (b && b.auc != null && b.sufficientEvidence === false ? ' UNDERPOWERED' : '');
  row('fileHealth AUC', cal.fileHealth ? `${fmtNum(cal.fileHealth.auc)} (n=${cal.fileHealth.files}, positives=${cal.fileHealth.positives})${power(cal.fileHealth)}` : 'MISSING');
  row('risk AUC', cal.risk ? `${fmtNum(cal.risk.auc)} (n=${cal.risk.commits}, positives=${cal.risk.positives})${power(cal.risk)}` : 'MISSING');
  row('lintRank AUC vs severity', cal.lintRank ? `${fmtNum(cal.lintRank.auc)} vs ${fmtNum(cal.lintRank.severityBaseline)} (Δ ${fmtNum(cal.lintRank.advantage)}, n=${cal.lintRank.files})` : 'MISSING');
  row('graph files / edges', snapshot.graph ? `${snapshot.graph.files} / ${snapshot.graph.edges}` : 'MISSING');
  row('graph cycles / orphans', snapshot.graph ? `${snapshot.graph.cycles} / ${snapshot.graph.orphans}` : 'MISSING');
  row('graph unresolved ratio', snapshot.graph ? String(snapshot.graph.unresolvedRatio) : 'MISSING');
  row('code lines / over split', snapshot.structure ? `${snapshot.structure.totalCodeLines} / ${snapshot.structure.filesOverSplitThreshold}` : 'MISSING');
  row('max nesting / longest fn', snapshot.structure ? `${snapshot.structure.maxNesting} / ${snapshot.structure.longestFunction}` : 'MISSING');
  row('tests files / wall clock', snapshot.tests ? `${snapshot.tests.files} / ${snapshot.tests.wallClockMs === null ? 'not measured' : snapshot.tests.wallClockMs + 'ms'}` : 'MISSING');
  row('bench baseline', snapshot.bench ? 'embedded' : 'MISSING');
  row('budgets', Object.entries(snapshot.budgets || {}).map(([k, v]) => `${k}=${v}`).join(' '));
  if (snapshot.caveats.length) {
    lines.push('');
    lines.push('Caveats:');
    for (const c of snapshot.caveats) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

export function formatComparison(report) {
  const lines = [];
  lines.push(`Compare  A=${report.a.label} (${report.a.source})  →  B=${report.b.label} (${report.b.source})`);
  lines.push(`  A: ${report.a.headline}`);
  lines.push(`  B: ${report.b.headline}`);
  if (!report.machine.comparable) {
    lines.push(`  machine mismatch: ${report.machine.mismatches.join('; ')} — timing metrics are NOT comparable.`);
  }
  lines.push('');
  const shown = report.metrics.filter((m) => m.verdict !== 'unchanged');
  const rows = shown.map((m) => [
    m.metric,
    m.a === null ? '—' : String(m.a),
    m.b === null ? '—' : String(m.b),
    m.delta === null ? '—' : (m.delta > 0 ? `+${m.delta}` : String(m.delta)),
    m.ci95 ? `[${m.ci95[0]}, ${m.ci95[1]}]` : (m.evidence === 'raw-delta' ? 'no CI' : m.evidence),
    m.verdict
  ]);
  const headers = ['metric', 'A', 'B', 'Δ (B−A)', '95% CI', 'verdict'];
  if (rows.length) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
    lines.push(line(headers));
    for (const r of rows) lines.push(line(r));
  } else {
    lines.push('  (every comparable metric is identical on both snapshots)');
  }
  const unchanged = report.metrics.length - shown.length;
  if (unchanged) lines.push(`  … plus ${unchanged} metric(s) identical on both sides.`);
  lines.push('');
  lines.push(`VERDICT: ${report.headline}`);
  lines.push(
    `  ${report.summary.withCI} metric(s) carry a CI · ${report.summary.unverifiedChanges} unverified change(s) · ` +
    `${report.summary.missing} missing · ${report.summary.notComparable} not-comparable`
  );
  const notes = report.metrics.filter((m) => ['missing', 'not-comparable', 'better', 'worse'].includes(m.verdict));
  if (notes.length) {
    lines.push('');
    for (const m of notes) lines.push(`  ${m.metric}: ${m.note}`);
  }
  if (report.caveats.length) {
    lines.push('');
    lines.push('Caveats:');
    for (const c of report.caveats) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

export function formatList(rows) {
  if (!rows.length) return 'No release tags in this repo yet.';
  const lines = [];
  for (const r of rows) {
    lines.push(`${r.tag}${r.snapshot ? '' : '  (no snapshot stored)'}`);
    lines.push(`  ${r.headline}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// tag / list / compare plumbing
// ---------------------------------------------------------------------------

/** Annotated-tag contents, or null for a lightweight tag / missing ref. */
export function readTagSnapshot(name, { root } = {}) {
  const type = git(['cat-file', '-t', `refs/tags/${name}`], { cwd: root });
  if (!type.ok) return { exists: false, annotated: false, snapshot: null, contents: '' };
  if (type.stdout.trim() !== 'tag') return { exists: true, annotated: false, snapshot: null, contents: '' };
  const contents = git(['tag', '-l', '--format=%(contents)', name], { cwd: root });
  const text = contents.ok ? contents.stdout : '';
  return { exists: true, annotated: true, snapshot: parseTagMessage(text), contents: text };
}

/** Every tag with its stored snapshot headline, newest first. */
export function listTags({ root } = {}) {
  const r = git(['for-each-ref', 'refs/tags', '--format=%(refname:short)%09%(creatordate:iso-strict)'], { cwd: root });
  if (!r.ok) return [];
  const rows = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [tag, created] = line.split('\t');
    const read = readTagSnapshot(tag, { root });
    rows.push({
      tag,
      created: created || null,
      annotated: read.annotated,
      snapshot: read.snapshot,
      date: (read.snapshot && read.snapshot.date) || created || '',
      headline: read.snapshot ? headline(read.snapshot) : 'no brain-release snapshot stored on this tag',
      metrics: read.snapshot
        ? {
          commit: read.snapshot.commit,
          fileHealthAuc: getPath(read.snapshot, 'calibration.fileHealth.auc') ?? null,
          lintRankAuc: getPath(read.snapshot, 'calibration.lintRank.auc') ?? null,
          dangerP90: getPath(read.snapshot, 'danger.p90') ?? null,
          cycles: getPath(read.snapshot, 'graph.cycles') ?? null
        }
        : null
    });
  }
  // Newest first by the snapshot's own date (creator date is the fallback);
  // tag name breaks ties so the ordering is total and reproducible.
  rows.sort((x, y) => byString(y.date, x.date) || byString(x.tag, y.tag));
  return rows;
}

/**
 * Resolve one side of a comparison: a stored snapshot if the ref carries one,
 * otherwise a recomputation — but ONLY when the ref is HEAD's own commit,
 * because a snapshot of the current working tree says nothing about a
 * different commit's tree.
 */
function resolveSide(ref, { root, snapshotOpts }) {
  const tag = readTagSnapshot(ref, { root });
  if (tag.snapshot) return { snapshot: tag.snapshot, source: 'tag' };

  const refSha = git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root });
  if (!refSha.ok) {
    return { snapshot: null, source: 'unresolved', error: `\`${ref}\` is not a tag with a stored snapshot and does not resolve to a commit.` };
  }
  const headSha = git(['rev-parse', 'HEAD'], { cwd: root });
  if (!headSha.ok || refSha.stdout.trim() !== headSha.stdout.trim()) {
    return {
      snapshot: null,
      source: 'unresolved',
      error:
        `\`${ref}\` carries no stored snapshot and is not HEAD. A snapshot cannot be reconstructed for ` +
        'another commit without checking out its tree — check it out and run `release tag`, or compare against HEAD.'
    };
  }
  return { snapshot: buildSnapshot({ root, ...snapshotOpts }), source: 'recomputed-at-HEAD' };
}

// ---------------------------------------------------------------------------
// propose: derive a version from the commits, then VERIFY it against the code
// ---------------------------------------------------------------------------

/** Conventional-commit types that carry a release meaning. Everything else is "Other". */
const RELEASE_TYPES = Object.freeze({ feat: 'minor', fix: 'patch', perf: 'patch' });
const BUMP_RANK = Object.freeze({ none: 0, patch: 1, minor: 2, major: 3 });
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE\s*:/m;
const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

/**
 * PURE. Parse a conventional-commit subject. Returns null for anything that is
 * not `type(scope)!: description` — non-conformance is COUNTED, never guessed at.
 */
export function parseConventionalSubject(subject, body = '') {
  const match = CONVENTIONAL_RE.exec(String(subject || '').trim());
  if (!match) return null;
  const [, type, scope, bang, description] = match;
  return {
    type,
    scope: scope || null,
    breaking: Boolean(bang) || BREAKING_FOOTER_RE.test(String(body || '')),
    breakingVia: bang ? '!' : (BREAKING_FOOTER_RE.test(String(body || '')) ? 'BREAKING CHANGE footer' : null),
    description: description.trim()
  };
}

/**
 * PURE. Derive a semver bump from a commit list.
 *
 * Merge commits (>1 parent) and non-conforming subjects are SKIPPED — and both
 * counts are reported, because a derivation that silently ignores a fifth of
 * the history is not a derivation, it is a guess with a number attached.
 *
 * @param {Array<{sha, subject, body, parents}>} commits newest-first is fine; order is preserved
 */
export function deriveBump(commits) {
  const counts = {};
  const releasable = [];
  const breakingDeclarations = [];
  let merges = 0;
  const nonConforming = [];
  let bump = 'none';

  for (const commit of commits || []) {
    if ((commit.parents || []).length > 1) { merges += 1; continue; }
    const parsed = parseConventionalSubject(commit.subject, commit.body);
    if (!parsed) { nonConforming.push({ sha: commit.sha, subject: commit.subject }); continue; }
    counts[parsed.type] = (counts[parsed.type] || 0) + 1;
    const entry = { ...commit, ...parsed };
    releasable.push(entry);
    if (parsed.breaking) breakingDeclarations.push({ sha: commit.sha, subject: commit.subject, via: parsed.breakingVia });
    const implied = parsed.breaking ? 'major' : (RELEASE_TYPES[parsed.type] || 'none');
    if (BUMP_RANK[implied] > BUMP_RANK[bump]) bump = implied;
  }

  return {
    bump,
    counts,
    commits: releasable,
    breakingDeclarations,
    skipped: {
      total: merges + nonConforming.length,
      merges,
      nonConforming: nonConforming.length,
      nonConformingSamples: nonConforming.slice(0, 5),
      conformanceRatio: (commits || []).length
        ? round((commits.length - merges - nonConforming.length) / Math.max(1, commits.length - merges))
        : 0
    }
  };
}

/** PURE. Apply a bump to a semver string. Unparseable input returns null. */
export function applyBump(version, bump) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return null;
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor}.${patch}`;
}

/**
 * PURE. Exported names of a JS/TS module by REGEX — deliberately not a parser.
 *
 * That is a stated limitation, not an oversight: a cheap scan that says "these
 * names left the surface" is enough to raise a CANDIDATE, and a human confirms.
 * It does NOT see computed exports (`exports[key] = …`), conditional exports,
 * or names re-exported through `export * from` (those are recorded as the
 * star-specifier itself, so a vanished re-export still shows up). A name that
 * merely MOVED to another module still counts as gone from this one — which is
 * correct for an importer of this module.
 */
export function scanExports(source, file = '') {
  const names = new Set();
  if (typeof source !== 'string' || !source) return [];
  if (!/\.(?:m|c)?[jt]sx?$/i.test(file)) return [];
  const push = (n) => { const t = String(n || '').trim(); if (t) names.add(t); };

  for (const m of source.matchAll(/^[ \t]*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) push(m[1]);
  for (const m of source.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) push(m[1]);
  for (const m of source.matchAll(/^[ \t]*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) push(m[1]);
  for (const m of source.matchAll(/^[ \t]*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) push(m[1]);
  if (/^[ \t]*export\s+default\b/m.test(source)) push('default');
  for (const m of source.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const as = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(part.trim());
      push(as ? as[1] : part.trim());
    }
  }
  for (const m of source.matchAll(/^[ \t]*export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+['"]([^'"]+)['"]/gm)) push(`*from:${m[1]}`);

  return [...names].sort(byString);
}

/**
 * PURE. Which exported names disappeared between two export surfaces.
 *
 * @param {Map<string,string[]>} before  file → exported names at the baseline ref
 * @param {Map<string,string[]>} after   file → exported names at HEAD (absent key = module vanished)
 * @param {(file:string) => {importers:string[], referencing:string[]}} importersOf
 *        module-level importers from the import graph, plus the subset whose
 *        source still mentions the vanished identifier
 */
export function detectCandidateBreaks(before, after, importersOf) {
  const rows = [];
  for (const file of [...before.keys()].sort(byString)) {
    const oldNames = before.get(file) || [];
    if (!oldNames.length) continue;
    const moduleGone = !after.has(file);
    const newNames = new Set(after.get(file) || []);
    const lost = oldNames.filter((n) => !newNames.has(n));
    if (!lost.length) continue;
    for (const name of lost) {
      const imp = importersOf(file, name) || { importers: [], referencing: [] };
      rows.push({
        file,
        name,
        reason: moduleGone ? 'module no longer exists at HEAD' : 'export removed from the module',
        importers: imp.importers.length,
        importersReferencingName: imp.referencing.length,
        evidence: `\`${name}\` no longer exported from ${file}${moduleGone ? ' (module gone)' : ''}; ` +
          `${imp.importers.length} file(s) import it` +
          (imp.referencing.length ? `, ${imp.referencing.length} still mention the name` : '')
      });
    }
  }
  return rows.sort((a, b) =>
    b.importersReferencingName - a.importersReferencingName ||
    b.importers - a.importers ||
    byString(a.file, b.file) || byString(a.name, b.name));
}

/**
 * PURE. Reconcile the prefix-derived bump with what the export surface actually
 * did. The code wins: a vanished export outranks a `fix:` prefix, because the
 * consumer's install breaks either way.
 */
export function reconcileBump({ derived, candidateBreaks = [], breakingDeclarations = [], verified = true }) {
  const breaks = candidateBreaks.length;
  const declared = breakingDeclarations.length;
  if (!verified) {
    return {
      recommended: derived,
      escalated: false,
      overDeclared: false,
      reason: `derived \`${derived}\` from the commit subjects. The export surface could NOT be verified ` +
        '(no baseline ref to diff against), so this rests on prefixes alone — which this repo has already ' +
        'shipped breaking changes under. Treat it as unverified.'
    };
  }
  if (breaks && derived !== 'major') {
    return {
      recommended: 'major',
      escalated: true,
      overDeclared: false,
      reason: `the subjects imply \`${derived}\`, but ${breaks} exported name(s) DISAPPEARED between the ` +
        'baseline and HEAD and no commit declared a breaking change. The export surface outranks the ' +
        'prefix: recommend MAJOR, or restore/deprecate the names below and re-run.'
    };
  }
  if (breaks && derived === 'major') {
    return {
      recommended: 'major',
      escalated: false,
      overDeclared: false,
      reason: `\`major\` is both declared (${declared} commit(s)) and corroborated by ${breaks} vanished export(s).`
    };
  }
  if (declared && !breaks) {
    return {
      recommended: derived,
      escalated: false,
      overDeclared: true,
      reason: `${declared} commit(s) declared a breaking change, but NO exported name disappeared between ` +
        'the baseline and HEAD. Over-declaration is harmless — it is stated here so the major bump is a ' +
        'decision rather than an accident (the break may be behavioural, or in a surface this scan cannot see).'
    };
  }
  return {
    recommended: derived,
    escalated: false,
    overDeclared: false,
    reason: `\`${derived}\` from the commit subjects, corroborated: no exported name disappeared between the ` +
      'baseline and HEAD.'
  };
}

/** PURE. Group releasable commits into changelog sections in a fixed order. */
export function groupChangelog(commits) {
  const sections = [
    { title: 'Features', types: ['feat'] },
    { title: 'Fixes', types: ['fix'] },
    { title: 'Performance', types: ['perf'] },
    { title: 'Other', types: null }
  ];
  const claimed = new Set(['feat', 'fix', 'perf']);
  return sections
    .map((section) => ({
      title: section.title,
      entries: (commits || [])
        .filter((c) => (section.types ? section.types.includes(c.type) : !claimed.has(c.type)))
        .map((c) => ({
          sha: String(c.sha || '').slice(0, 7),
          type: c.type,
          scope: c.scope,
          breaking: Boolean(c.breaking),
          description: c.description
        }))
    }))
    .filter((section) => section.entries.length);
}

/** Read commits in `range` with parents + body. Returns [] when git fails. */
function readCommits(root, range) {
  const args = ['log', '--format=%H%x1f%P%x1f%s%x1f%b%x1e'];
  if (range) args.push(range);
  const r = git(args, { cwd: root });
  if (!r.ok) return [];
  return r.stdout
    .split('\x1e')
    .map((chunk) => chunk.replace(/^\n/, ''))
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [sha, parents, subject, body] = chunk.split('\x1f');
      return {
        sha: (sha || '').trim(),
        parents: (parents || '').trim().split(/\s+/).filter(Boolean),
        subject: subject || '',
        body: body || ''
      };
    })
    .filter((c) => c.sha);
}

/** Export surface of `files` at `rev` (`git show rev:file`). Missing file → key absent. */
function exportSurfaceAt(root, rev, files) {
  const surface = new Map();
  for (const file of files) {
    const r = git(['show', `${rev}:${file}`], { cwd: root });
    if (!r.ok) continue;
    surface.set(file, scanExports(r.stdout, file));
  }
  return surface;
}

/**
 * Build the whole proposal. Impure (git + file reads); every pure decision it
 * makes lives in the exported helpers above so the tests can drive them directly.
 */
export function buildProposal({ root = ROOT, snapshotOpts = {}, resamples = DEFAULT_RESAMPLES, seed = DEFAULT_SEED } = {}) {
  const notes = [];
  const describe = git(['describe', '--tags', '--abbrev=0', 'HEAD'], { cwd: root });
  const lastTag = describe.ok && describe.stdout.trim() ? describe.stdout.trim() : null;
  const firstRelease = !lastTag;

  const range = lastTag ? `${lastTag}..HEAD` : '';
  const commits = readCommits(root, range);
  const derivation = deriveBump(commits);

  // Baseline version: the last tag when it is semver, else package.json.
  let pkgVersion = null;
  try { pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch { pkgVersion = null; }
  const tagIsSemver = lastTag && /^v?\d+\.\d+\.\d+/.test(lastTag);
  const baseVersion = (tagIsSemver ? lastTag.replace(/^v/, '') : null) || pkgVersion || '0.0.0';
  if (lastTag && !tagIsSemver) {
    notes.push(`the last tag \`${lastTag}\` is not semver, so package.json's ${baseVersion} was used as the baseline.`);
  }

  // --- export-surface verification ---------------------------------------
  let candidateBreaks = [];
  let verified = false;
  let verification = { verified: false, reason: '', filesCompared: 0, truncated: false };
  if (!lastTag) {
    verification.reason = 'no prior tag exists — there is no earlier export surface to diff against, so ' +
      'the bump rests on commit subjects alone.';
    notes.push(verification.reason);
  } else {
    const diff = git(['diff', '--name-only', `${lastTag}..HEAD`], { cwd: root });
    if (!diff.ok) {
      verification.reason = `\`git diff ${lastTag}..HEAD\` failed: ${diff.stderr || 'unknown error'}`;
    } else {
      const all = diff.stdout.split('\n')
        .filter((f) => f && /\.(?:m|c)?[jt]sx?$/i.test(f) && !IGNORE_DIR_RE.test(f))
        .sort(byString);
      const MAX = 400;
      const changed = all.slice(0, MAX);
      const before = exportSurfaceAt(root, lastTag, changed);
      const after = exportSurfaceAt(root, 'HEAD', changed);

      // Module-level importers from HEAD's import graph, narrowed by whether the
      // importer's source still mentions the vanished identifier.
      const sourceFiles = gitSourceFiles(root) || [];
      const readFile = makeReadFile(root);
      let importedBy = new Map();
      try {
        const g = buildImportGraph({ files: sourceFiles, readFile });
        for (const edge of g.edges) {
          if (!importedBy.has(edge.to)) importedBy.set(edge.to, []);
          if (!importedBy.get(edge.to).includes(edge.from)) importedBy.get(edge.to).push(edge.from);
        }
      } catch (error) {
        notes.push(`import graph unavailable (${error.message || error}) — importer counts are 0, not absent.`);
        importedBy = new Map();
      }
      const importersOf = (file, name) => {
        const importers = (importedBy.get(file) || []).slice().sort(byString);
        const referencing = importers.filter((imp) => {
          try { return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(readFile(imp)); } catch { return false; }
        });
        return { importers, referencing };
      };

      candidateBreaks = detectCandidateBreaks(before, after, importersOf);
      verified = true;
      verification = {
        verified: true,
        reason: `compared the export surface of ${changed.length} changed JS/TS file(s) between ${lastTag} and HEAD ` +
          '(regex scan, not a parser — see scanExports).',
        filesCompared: changed.length,
        truncated: all.length > MAX
      };
      if (all.length > MAX) {
        notes.push(`${all.length} JS/TS files changed; only the first ${MAX} were scanned for export removals — ` +
          'the candidate-break list is a floor, not a ceiling.');
      }
    }
  }

  const reconciliation = reconcileBump({
    derived: derivation.bump,
    candidateBreaks,
    breakingDeclarations: derivation.breakingDeclarations,
    verified
  });

  // --- proposed version ---------------------------------------------------
  let proposedVersion;
  let versionReason;
  if (firstRelease) {
    proposedVersion = baseVersion;
    versionReason =
      `first release — no prior tag exists, so there is nothing to bump FROM; package.json's ` +
      `${baseVersion} is the proposal. (Against a baseline these ${derivation.commits.length} releasable ` +
      `commit(s) would have implied \`${reconciliation.recommended}\`.)`;
  } else if (reconciliation.recommended === 'none') {
    proposedVersion = baseVersion;
    versionReason = `no releasable commits since ${lastTag} (${derivation.skipped.total} skipped) — nothing to release.`;
  } else {
    proposedVersion = applyBump(baseVersion, reconciliation.recommended);
    versionReason = `${baseVersion} → ${proposedVersion} (\`${reconciliation.recommended}\`). ${reconciliation.reason}`;
  }

  // --- measurement delta vs the last tag (reuses `compare` wholesale) ------
  let measurement = null;
  if (!lastTag) {
    measurement = { available: false, reason: 'no prior tag — there is no stored snapshot to compare HEAD against.' };
  } else {
    const stored = readTagSnapshot(lastTag, { root });
    if (!stored.snapshot) {
      measurement = {
        available: false,
        reason: `\`${lastTag}\` carries no brain-release snapshot, so the measurement delta cannot be computed. ` +
          'Tags created before this tool exist without one; future releases should be tagged with `release tag`.'
      };
    } else {
      const head = buildSnapshot({ root, ...snapshotOpts });
      measurement = {
        available: true,
        report: compareSnapshots(stored.snapshot, head, {
          labelA: lastTag, labelB: 'HEAD', sourceA: 'tag', sourceB: 'recomputed-at-HEAD',
          resamples, seed, recomputed: ['B (HEAD)']
        })
      };
    }
  }

  const tagName = `v${proposedVersion}`;
  return {
    lastTag,
    firstRelease,
    baseVersion,
    packageVersion: pkgVersion,
    proposedVersion,
    proposedTag: tagName,
    derivedBump: derivation.bump,
    recommendedBump: reconciliation.recommended,
    versionReason,
    reconciliation,
    verification,
    counts: derivation.counts,
    skipped: derivation.skipped,
    breakingDeclarations: derivation.breakingDeclarations,
    candidateBreaks,
    changelog: groupChangelog(derivation.commits),
    measurement,
    notes,
    publishes: false,
    commands: [
      `npm version ${proposedVersion} --no-git-tag-version   # or edit package.json by hand`,
      `git commit -am "chore(brain): release ${proposedVersion}"`,
      `node scripts/brain-release.mjs tag ${tagName} --message "release ${proposedVersion}"`,
      `git push origin main --follow-tags`
    ]
  };
}

export function formatProposal(p) {
  const lines = [];
  lines.push(`Proposal  ${p.baseVersion} → ${p.proposedVersion}  (tag ${p.proposedTag})`);
  lines.push(`  baseline: ${p.lastTag ? `tag ${p.lastTag}` : 'no tag yet — FIRST RELEASE path'}`);
  lines.push(`  ${p.versionReason}`);
  lines.push('');
  lines.push(`Commits: ${Object.entries(p.counts).sort((a, b) => byString(a[0], b[0])).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`);
  lines.push(`Skipped: ${p.skipped.total} (${p.skipped.merges} merge commit(s), ${p.skipped.nonConforming} non-conforming) · ` +
    `conformance ${Math.round(p.skipped.conformanceRatio * 100)}% of non-merge commits`);
  for (const s of p.skipped.nonConformingSamples) lines.push(`    skipped: ${s.sha.slice(0, 7)} ${s.subject}`);
  lines.push('');
  lines.push(`Export-surface check: ${p.verification.verified ? 'RAN' : 'NOT RUN'} — ${p.verification.reason}`);
  if (p.candidateBreaks.length) {
    lines.push(`  ${p.candidateBreaks.length} CANDIDATE BREAKING CHANGE(S):`);
    for (const b of p.candidateBreaks.slice(0, 20)) lines.push(`    - ${b.evidence}`);
    if (p.candidateBreaks.length > 20) lines.push(`    … and ${p.candidateBreaks.length - 20} more`);
  } else if (p.verification.verified) {
    lines.push('  no exported name disappeared.');
  }
  if (p.reconciliation.escalated) {
    lines.push('');
    lines.push(`  !! ESCALATED to MAJOR: ${p.reconciliation.reason}`);
  } else if (p.reconciliation.overDeclared) {
    lines.push('');
    lines.push(`  note: ${p.reconciliation.reason}`);
  }
  lines.push('');
  lines.push('Changelog:');
  if (!p.changelog.length) lines.push('  (nothing releasable)');
  for (const section of p.changelog) {
    lines.push(`  ${section.title}`);
    for (const e of section.entries.slice(0, 40)) {
      lines.push(`    - ${e.breaking ? 'BREAKING ' : ''}${e.scope ? `(${e.scope}) ` : ''}${e.description} (${e.sha})`);
    }
    if (section.entries.length > 40) lines.push(`    … and ${section.entries.length - 40} more`);
  }
  lines.push('');
  if (p.measurement.available) {
    lines.push(`Measurement vs ${p.lastTag}: ${p.measurement.report.headline}`);
  } else {
    lines.push(`Measurement delta: unavailable — ${p.measurement.reason}`);
  }
  if (p.notes.length) {
    lines.push('');
    lines.push('Notes:');
    for (const n of p.notes) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push('This command PROPOSES ONLY — no tag was created, nothing was pushed, package.json is untouched.');
  lines.push('Run these yourself if you agree:');
  for (const c of p.commands) lines.push(`  ${c}`);
  return lines.join('\n');
}

export function nextActionForPropose(p) {
  if (p.reconciliation.escalated) {
    return `Next: decide on the ${p.candidateBreaks.length} vanished export(s) above — restore/deprecate them, or ` +
      `release ${p.proposedVersion} as a MAJOR. Nothing was tagged; the decision is yours.`;
  }
  if (p.recommendedBump === 'none' && !p.firstRelease) {
    return `Next: nothing to release since ${p.lastTag}. Keep working, or check the ${p.skipped.total} skipped commit(s) ` +
      'if you expected a bump.';
  }
  return `Next: run the four commands above to release ${p.proposedVersion}. This tool will not run them for you — ` +
    'a release is outward-facing and hard to reverse (ADR 0028: the human keeps that boundary).';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: brain-release.mjs <subcommand> [flags]',
    '',
    'Subcommands:',
    '  snapshot [--json] [--out <path>]        Measure HEAD into a deterministic JSON snapshot.',
    '  tag <name> [--message <m>]              Annotated tag whose message body IS the snapshot.',
    '  compare <refA> <refB> [--json]          Per-metric deltas; a 95% CI wherever the data allows one.',
    '  list [--json]                           Tags with their snapshot headline, newest first.',
    '  propose [--json]                        Derive the next semver + changelog, VERIFIED against',
    '                                          the export surface. Proposes only — never publishes.',
    '',
    'Flags:',
    '  --json                Parseable JSON on stdout, nothing else (next action goes to stderr).',
    '  --out <path>          (snapshot) Also write the JSON snapshot to a file.',
    '  --now <iso>           Clock override — makes a snapshot byte-reproducible.',
    `  --commits N           History window in commits (default ${DEFAULT_COMMIT_WINDOW}).`,
    `  --window N            Calibration prefix window (default ${DEFAULT_CALIBRATE_WINDOW}).`,
    `  --horizon-days K      Fix-observation horizon (default ${DEFAULT_HORIZON_DAYS}).`,
    '  --with-tests          Run the test suite and record wall-clock ms (slow, machine-bound).',
    '  --with-lint           Run the configured linters and calibrate the lint ranking (slow).',
    '  --sarif <path>        (with --with-lint) Additional SARIF file to fold in. Repeatable.',
    '  --allow-dirty         (tag) Tag a dirty tree anyway; the snapshot records dirty: true.',
    `  --resamples N         (compare) Bootstrap resamples (default ${DEFAULT_RESAMPLES}).`,
    `  --seed N              (compare) Bootstrap seed (default ${DEFAULT_SEED}).`,
    '',
    'Exit: 0 always, except 2 (usage error) and 1 (refusal: dirty tree, duplicate tag, no snapshot).'
  ].join('\n');
}

function fail(code, message) {
  process.stderr.write(`[brain:release] ${message}\n`);
  process.exit(code);
}

function emit({ json, payload, human, nextAction }) {
  if (json) {
    process.stdout.write(JSON.stringify({ ...payload, nextAction }, null, 2) + '\n');
    process.stderr.write(nextAction + '\n');
  } else {
    process.stdout.write(human + '\n\n' + nextAction + '\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const invokedBare = args.length === 0;
  if (takeFlag(args, '--help') || takeFlag(args, '-h') || invokedBare) {
    process.stdout.write(usage() + '\n');
    // Bare invocation is a usage error (2); an explicit --help is not (0).
    process.exit(invokedBare ? 2 : 0);
  }

  const json = takeFlag(args, '--json');
  const withTests = takeFlag(args, '--with-tests');
  const withLint = takeFlag(args, '--with-lint');
  const allowDirty = takeFlag(args, '--allow-dirty');
  const outPath = takeOption(args, '--out');
  const nowRaw = takeOption(args, '--now');
  const message = takeOption(args, '--message');
  const commitWindow = Number(takeOption(args, '--commits') || 0) || undefined;
  const calibrateWindow = Number(takeOption(args, '--window') || 0) || undefined;
  const horizonDays = Number(takeOption(args, '--horizon-days') || 0) || undefined;
  const resamples = Number(takeOption(args, '--resamples') || 0) || DEFAULT_RESAMPLES;
  const seed = Number(takeOption(args, '--seed') || 0) || DEFAULT_SEED;
  const sarifPaths = [];
  for (;;) {
    const p = takeOption(args, '--sarif');
    if (!p) break;
    sarifPaths.push(p);
  }

  if (nowRaw && !Number.isFinite(Date.parse(nowRaw))) fail(2, `--now: not an ISO timestamp: ${nowRaw}`);
  const unknownFlag = args.find((a) => a.startsWith('--'));
  if (unknownFlag) fail(2, `unknown flag: ${unknownFlag}\n\n${usage()}`);

  const root = ROOT;
  const snapshotOpts = {
    now: nowRaw || undefined,
    commitWindow,
    calibrateWindow,
    horizonDays,
    withTests,
    withLint,
    sarifPaths
  };
  // lint-intel is only loaded when asked for: it is a large module and the
  // snapshot pipeline itself is synchronous.
  if (withLint) {
    try { snapshotOpts.lintIntel = await import('./lint-intel.mjs'); } catch { snapshotOpts.lintIntel = null; }
  }

  const sub = args.shift();

  if (sub === 'snapshot') {
    const snapshot = buildSnapshot({ root, ...snapshotOpts });
    if (outPath) {
      const abs = path.isAbsolute(outPath) ? outPath : path.join(root, outPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(snapshot, null, 2) + '\n');
      process.stderr.write(`[brain:release] wrote ${abs}\n`);
    }
    emit({ json, payload: snapshot, human: formatSnapshot(snapshot), nextAction: nextActionForSnapshot(snapshot) });
    process.exit(0);
  }

  if (sub === 'tag') {
    const name = args.shift();
    if (!name) fail(2, `tag: missing <name>.\n\n${usage()}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) fail(2, `tag: refusing a suspicious tag name: ${name}`);
    if (args.length) fail(2, `tag: unexpected argument: ${args[0]}`);

    const inRepo = git(['rev-parse', '--git-dir'], { cwd: root });
    if (!inRepo.ok) fail(1, 'tag: not a git work tree — nothing to tag.');
    const exists = git(['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], { cwd: root });
    if (exists.ok) {
      fail(1, `tag: \`${name}\` already exists. A tag is a return ticket — overwriting one rewrites history ` +
        `you may need. Pick another name, or delete it deliberately: git tag -d ${name}`);
    }
    const status = git(['status', '--porcelain'], { cwd: root });
    const dirty = status.ok && status.stdout.trim().length > 0;
    if (dirty && !allowDirty) {
      fail(1,
        'tag: the working tree is dirty. A snapshot of uncommitted work does not describe the commit it ' +
        'points at, so the tag would lie. Commit or stash first, or pass --allow-dirty (the snapshot then ' +
        'records dirty: true and every consumer is warned).');
    }
    const snapshot = buildSnapshot({ root, ...snapshotOpts });
    const body = buildTagMessage(snapshot, { name, message });
    const created = git(['tag', '-a', '--cleanup=verbatim', '-F', '-', name], { cwd: root, input: body });
    if (!created.ok) fail(1, `tag: git refused to create the tag: ${created.stderr || `status ${created.status}`}`);

    const back = readTagSnapshot(name, { root });
    const payload = {
      tag: name,
      created: true,
      dirty,
      roundTrip: Boolean(back.snapshot),
      snapshot
    };
    const human = [
      `Tagged ${name} @ ${snapshot.commit ? snapshot.commit.slice(0, 7) : 'no-commit'}${dirty ? ' (DIRTY TREE — recorded in the snapshot)' : ''}`,
      `  ${headline(snapshot)}`,
      `  snapshot stored in the tag message (${body.length} B); reads back: ${back.snapshot ? 'yes' : 'NO — investigate'}`
    ].join('\n');
    emit({
      json, payload, human,
      nextAction: `Next: \`project-brain x release compare ${name} HEAD\` — and when a later change makes the ` +
        `numbers worse, \`git checkout ${name}\` is the way back.`
    });
    process.exit(0);
  }

  if (sub === 'compare') {
    const refA = args.shift();
    const refB = args.shift();
    if (!refA || !refB) fail(2, `compare: needs two refs.\n\n${usage()}`);
    if (args.length) fail(2, `compare: unexpected argument: ${args[0]}`);

    const sideA = resolveSide(refA, { root, snapshotOpts });
    const sideB = resolveSide(refB, { root, snapshotOpts });
    for (const [ref, side] of [[refA, sideA], [refB, sideB]]) {
      if (!side.snapshot) {
        fail(1, `compare: ${side.error}\n  Fix: \`git checkout ${ref} && project-brain x release tag ${ref}-snapshot\`, ` +
          'or compare a tagged snapshot against HEAD.');
      }
    }
    if (sideA.snapshot.schema !== sideB.snapshot.schema) {
      fail(1, `compare: schema mismatch (A=${sideA.snapshot.schema}, B=${sideB.snapshot.schema}) — the two ` +
        'snapshots do not describe the same measurements. Re-tag the older side with this version.');
    }
    const recomputed = [];
    if (sideA.source !== 'tag') recomputed.push(`A (${refA})`);
    if (sideB.source !== 'tag') recomputed.push(`B (${refB})`);

    const report = compareSnapshots(sideA.snapshot, sideB.snapshot, {
      labelA: refA, labelB: refB, sourceA: sideA.source, sourceB: sideB.source,
      resamples, seed, recomputed
    });
    emit({ json, payload: report, human: formatComparison(report), nextAction: nextActionForCompare(report) });
    process.exit(0);
  }

  if (sub === 'list') {
    if (args.length) fail(2, `list: unexpected argument: ${args[0]}`);
    const rows = listTags({ root });
    const nextAction = rows.length
      ? `Next: \`project-brain x release compare ${rows[0].tag} HEAD\` — measure what changed since the newest tag.`
      : 'Next: `project-brain x release tag <name>` — there is nothing to compare against yet.';
    emit({ json, payload: { tags: rows }, human: formatList(rows), nextAction });
    process.exit(0);
  }

  if (sub === 'propose') {
    if (args.length) fail(2, `propose: unexpected argument: ${args[0]}`);
    const proposal = buildProposal({ root, snapshotOpts, resamples, seed });
    emit({ json, payload: proposal, human: formatProposal(proposal), nextAction: nextActionForPropose(proposal) });
    process.exit(0);
  }

  fail(2, `unknown subcommand: ${sub}\n\n${usage()}`);
}

// MANDATORY isMain guard: importing this module must not parse argv / spawn / exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:release] ${error.stack || error.message || error}\n`);
    process.exit(1);
  });
}
