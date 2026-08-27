/**
 * brain:intel — thin CLI over the git-intelligence core (scripts/git-intel.mjs).
 *
 * Strategy M2.5 (ADR 0028): language-agnostic signals straight from `git log`,
 * zero-LLM, deterministic. Fills the Control Room's empty state and feeds
 * brief/grill/risk. Invoked as `project-brain x intel` (the CLI dispatcher's
 * escape hatch); this file deliberately does NOT touch bin/cli.mjs.
 *
 *   brain-intel.mjs hotspots  [--limit N] [--since <rev|date>] [--json]
 *   brain-intel.mjs co-change [--limit N] [--since <rev|date>] [--json]
 *   brain-intel.mjs ownership [--limit N] [--since <rev|date>] [--json]
 *   brain-intel.mjs risk [--files a,b,c] [--score] [--since <rev|date>] [--json]
 *       (without --files: reads staged files via `git diff --cached --name-only`)
 *   brain-intel.mjs calibrate [--window N] [--horizon-days K] [--json]
 *   brain-intel.mjs health [--limit N] [--structure] [--plans] [--json]
 *       (per-file 0-10 danger score: churn percentile × co-change scatter ×
 *        bus factor × fix density — receipt-backed, lowConfidence-flagged;
 *        --structure adds the three code-shape factors, --plans adds named
 *        refactoring moves per file)
 *   brain-intel.mjs health-calibrate [--window N] [--horizon-days K]
 *                                    [--structure] [--json]
 *       (cut-point replay: do TODAY's file scores predict NEAR-FUTURE fixes?
 *        always reports per-factor AUC so structure can be judged, not assumed)
 *
 * Shared flags: --commits N (history window, default 500 commits to bound
 * cost — mirrors brain-why's -n convention; --since replaces the cap),
 * --now <iso> (clock override for reproducible output; the library never
 * calls Date.now() itself), --half-life N (hotspot decay, days).
 *
 * `risk` stays factors-only by default: the aggregated 0-10 score is opt-in
 * via --score UNTIL calibrate proves the weights on this repo (plan
 * discipline: eval-gated before default-on). With --score, two optional
 * factors are wired when their inputs exist: blast radius from the ts-graph
 * import graph (TS repos only — silently omitted elsewhere) and lease
 * conflicts from .project-brain/active_state.md (read-only; never created).
 *
 * `calibrate` replays history: every commit in the window is scored against
 * ONLY the commits before it and labeled defective iff a later fix/revert
 * commit within the horizon touches the same files — in-repo self-calibration,
 * not a cross-repo benchmark (the output says so).
 *
 * One `git log` invocation per run, stream-parsed. Human output: compact
 * ranked tables with the provenance line at the end; risk output always ends
 * with a concrete next action (Praktiken-Katalog: "kein Score ohne Aktion").
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, listIndexableFiles, takeFlag, takeOption } from './common.mjs';
import { ACTIVE_STATE, activeStateJson } from './active-state.mjs';
import { loadTsSemanticContext } from './ts-graph.mjs';
import {
  gitLogArgs,
  parseLog,
  hotspots,
  coChange,
  ownership,
  riskFactors,
  riskScore,
  calibrateRisk,
  fileHealth,
  calibrateFileHealth,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MIN_SUPPORT,
  DEFAULT_MIN_CONFIDENCE
} from './git-intel.mjs';
import { buildImportGraph, cycles } from './import-graph.mjs';
import { measureFiles, refactorPlan, STRUCTURE_NOTE } from './code-structure.mjs';

const DEFAULT_COMMIT_WINDOW = 500;
const DEFAULT_ROW_LIMIT = 15;
const DEFAULT_CALIBRATE_WINDOW = 300;
const DEFAULT_HORIZON_DAYS = 30;

function usage() {
  return [
    'Usage: brain-intel.mjs <subcommand> [flags]',
    '',
    'Subcommands:',
    '  hotspots     Churn × recency-decay ranking of files.',
    '  co-change    "Who changes A usually changes B" pairs.',
    '  ownership    Top authors + bus factor per path prefix and file.',
    '  risk         Risk factors for a change-set (--files a,b,c or staged files).',
    '  calibrate    Validate the risk weights against this repo\'s own fix/revert history.',
    '  health       Per-file 0-10 danger score (churn × coupling × bus factor × fix density).',
    '  health-calibrate  Validate the health score: do today\'s scores predict near-future fixes?',
    '',
    'Flags:',
    '  --json            Parseable JSON on stdout, nothing else.',
    `  --limit N         Rows in human tables (default ${DEFAULT_ROW_LIMIT}).`,
    `  --commits N       History window in commits (default ${DEFAULT_COMMIT_WINDOW}, bounds cost).`,
    '  --since <rev|date> Analyze <rev>..HEAD or --since=<date> instead of the commit cap.',
    '  --files a,b,c     (risk) Change-set; default: staged files (git diff --cached).',
    '  --score           (risk) Aggregate factors into the 0-10 score (opt-in until calibrated).',
    '  --structure       (health, health-calibrate) Add the code-shape factors (size, nesting,',
    '                    coupling). Opt-in: without it the score is byte-identical to history-only.',
    '  --plans           (health) Named refactoring moves per file. Implies --structure.',
    `  --window N        (calibrate) Commits to evaluate; (health-calibrate) prefix commits scored (default ${DEFAULT_CALIBRATE_WINDOW}).`,
    `  --horizon-days K  (calibrate, health-calibrate) Fix-observation horizon in days (default ${DEFAULT_HORIZON_DAYS}).`,
    `  --half-life N     Hotspot decay half-life in days (default ${DEFAULT_HALF_LIFE_DAYS}).`,
    '  --now <iso>       Clock override for reproducible hotspot/risk output.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// git plumbing (the only impure part)
// ---------------------------------------------------------------------------

function runGitLog({ limit, since }) {
  const r = spawnSync('git', gitLogArgs({ limit, since }), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git log failed (status ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout || '';
}

function stagedFiles() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return [];
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// structural context (import graph + shape metrics) — only built on --structure
// ---------------------------------------------------------------------------

/** Every source extension both import-graph and code-structure understand. */
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/i;
/** Never scanned. Mirrors brain-graph-scan's set (duplicated on purpose: this
 * command must not mutate shared discovery). */
const IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees)(\/|$)/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CYCLE_LEN = 8;
const MAX_CYCLES = 50;

/** Tracked + untracked-but-not-ignored source files. null outside a git work tree. */
function gitSourceFiles() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter((f) => f && SOURCE_EXT_RE.test(f));
}

/**
 * Build the structural context: shape metrics per file plus the import graph
 * (fan-in/fan-out and cycles). The only impure part is discovery + reads; both
 * pure libraries take an injected readFile, and every file is read at most once
 * (the graph and the measurer share one memo).
 */
async function structuralContext() {
  const discovered = gitSourceFiles() ?? (await listIndexableFiles()).filter((f) => SOURCE_EXT_RE.test(f));
  const files = [...new Set(discovered)].filter((f) => !IGNORE_DIR_RE.test(f)).sort();
  const memo = new Map();
  const readFile = (rel) => {
    if (memo.has(rel)) {
      const cached = memo.get(rel);
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const abs = path.join(ROOT, rel);
      if (fs.statSync(abs).size > MAX_SOURCE_BYTES) throw new Error('file exceeds the 2MB scan cap');
      const text = fs.readFileSync(abs, 'utf8');
      memo.set(rel, text);
      return text;
    } catch (error) {
      memo.set(rel, error);
      throw error;
    }
  };
  const graph = buildImportGraph({ files, readFile });
  const measured = measureFiles({ files, readFile });
  const cycleView = cycles(graph, { maxLen: MAX_CYCLE_LEN, maxCycles: MAX_CYCLES });
  return {
    files,
    graph,
    measured,
    cycles: cycleView,
    measureByFile: new Map(measured.files.map((m) => [m.file, m])),
    degreeByFile: new Map(graph.nodes.map((n) => [n.file, { fanIn: n.importedBy, fanOut: n.imports }]))
  };
}

/**
 * Share of commits by the most prolific author in the window (0..1). Used to
 * detect an effectively-solo repo — a distinct-name count would be fooled by
 * one person committing under several git identities.
 */
function topAuthorShareOf(commits) {
  const counts = new Map();
  let total = 0;
  for (const c of commits || []) {
    const a = (c && c.author || '').trim();
    if (!a) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
    total += 1;
  }
  if (!total) return null;
  return Math.max(...counts.values()) / total;
}

/** Per-file graph facts in the shape refactorPlan() expects. */
function graphFactsFor(ctx, file) {
  const deg = ctx.degreeByFile.get(file) || { fanIn: 0, fanOut: 0 };
  return { file, fanIn: deg.fanIn, fanOut: deg.fanOut, cycles: ctx.cycles.cycles };
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function out(text) { process.stdout.write(text + '\n'); }

function printJson(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function provenanceLine(result) {
  const w = result.window || {};
  const span = w.since ? ` since ${String(w.since).slice(0, 10)}` : '';
  return `— basis: ${result.basis} · source: ${result.source} · window: ${w.commits} commits${span}`;
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  out(line(headers));
  for (const r of rows) out(line(r));
}

function pct(n) { return `${Math.round(n * 100)}%`; }

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function cmdHotspots(commits, { json, limit, nowMs, halfLifeDays }) {
  const result = hotspots(commits, { now: nowMs, halfLifeDays });
  if (json) return printJson(result);
  out(`Hotspots (churn × recency decay, half-life ${halfLifeDays}d)`);
  if (!result.files.length) { out('  (no commits found)'); out(provenanceLine(result)); return; }
  table(
    result.files.slice(0, limit).map((f, i) =>
      [i + 1, f.score.toFixed(3), f.commits, (f.lastCommit || '').slice(0, 10), f.file]),
    ['#', 'SCORE', 'COMMITS', 'LAST', 'FILE']
  );
  out(provenanceLine(result));
}

function cmdCoChange(commits, { json, limit }) {
  const result = coChange(commits);
  if (json) return printJson(result);
  out(`Co-change pairs (support ≥ ${DEFAULT_MIN_SUPPORT}, confidence ≥ ${DEFAULT_MIN_CONFIDENCE}` +
    (result.skippedLargeCommits ? `, ${result.skippedLargeCommits} bulk commit(s) excluded)` : ')'));
  if (!result.pairs.length) { out('  (no pairs above thresholds)'); out(provenanceLine(result)); return; }
  table(
    result.pairs.slice(0, limit).map((p) =>
      [pct(p.confidence), `${p.together}×`, `${p.a} → ${p.b}`]),
    ['CONF', 'TOGETHER', 'PAIR']
  );
  out(provenanceLine(result));
}

function cmdOwnership(commits, { json, limit }) {
  const result = ownership(commits);
  if (json) return printJson(result);
  out('Ownership by path prefix');
  if (!result.prefixes.length) { out('  (no commits found)'); out(provenanceLine(result)); return; }
  table(
    result.prefixes.slice(0, limit).map((p) => {
      const top = p.topAuthors[0];
      return [p.commits, p.busFactor, top ? `${top.author} (${pct(top.share)})` : '-', p.path];
    }),
    ['COMMITS', 'BUS', 'TOP AUTHOR', 'PATH']
  );
  out('');
  out('Lowest bus factor, most-touched files');
  table(
    [...result.files]
      .sort((a, b) => a.busFactor - b.busFactor || b.commits - a.commits || (a.path < b.path ? -1 : 1))
      .slice(0, limit)
      .map((f) => {
        const top = f.topAuthors[0];
        return [f.commits, f.busFactor, top ? `${top.author} (${pct(top.share)})` : '-', f.path];
      }),
    ['COMMITS', 'BUS', 'TOP AUTHOR', 'FILE']
  );
  out(provenanceLine(result));
}

/** "Kein Score ohne Aktion": every risk result carries a concrete next step. */
function nextActionFor(result) {
  if (result.missingPartners.length) {
    const top = result.missingPartners[0];
    return `→ consider: also touch ${top.missing} (co-changes with ${top.changed} in ` +
      `${pct(top.confidence)} of its commits, ${top.together}×) or explain why not; run: project-brain grill`;
  }
  if (result.hotspotHits.length) {
    const top = result.hotspotHits[0];
    return `→ hotspot territory (${top.file} is churn rank #${top.rank}): keep the diff small ` +
      'and defend the plan first; run: project-brain grill';
  }
  return '→ no elevated git-history factors; a quick plan check is still cheap: project-brain brief';
}

async function cmdRisk(commits, files, { json, nowMs, halfLifeDays, score }) {
  const hs = hotspots(commits, { now: nowMs, halfLifeDays });
  const cc = coChange(commits);
  const result = riskFactors(files, { hotspots: hs, coChange: cc });
  if (!score) {
    // Default path: factors only, no 0-10 aggregation — the score stays
    // opt-in via --score until `calibrate` validates the weights on this repo.
    const withAction = { ...result, nextAction: nextActionFor(result) };
    if (json) return printJson(withAction);
    out(`Risk factors for ${result.files.length} file(s): ${result.files.join(', ')}`);
    if (result.hotspotHits.length) {
      out('  Hotspots touched:');
      for (const h of result.hotspotHits) {
        out(`    - ${h.file} (churn rank #${h.rank}, score ${h.score.toFixed(3)}, ${h.commits} commits)`);
      }
    }
    if (result.missingPartners.length) {
      out('  Usual co-change partners missing from this change-set:');
      for (const m of result.missingPartners) {
        out(`    - ${m.missing} (changes with ${m.changed} in ${pct(m.confidence)} of its commits, ${m.together}×)`);
      }
    }
    if (!result.hotspotHits.length && !result.missingPartners.length) {
      out('  No hotspot hits and no missing co-change partners.');
    }
    out(provenanceLine(result));
    out(withAction.nextAction);
    return;
  }

  // --score: full aggregation with the optional factors wired when available.
  const blastRadius = await blastRadiusFor(files);
  const leases = readLeasesSafe(nowMs);
  const scored = riskScore(files, {
    hotspots: hs,
    coChange: cc,
    ...(blastRadius ? { blastRadius } : {}),
    ...(leases ? { leases } : {})
  });
  const withAction = { ...scored, nextAction: nextActionForScore(scored, result) };
  if (json) return printJson(withAction);
  out(`Change-risk score ${scored.score.toFixed(1)}/10 for ${scored.files.length} file(s): ${scored.files.join(', ')}` +
    (scored.reason ? ` (${scored.reason})` : ''));
  out('  Factors (weight × raw = contribution; score = 10 × Σcontribution / Σweight):');
  for (const f of scored.factors) {
    out(`    - ${f.name.padEnd(18)} ${f.weight.toFixed(2)} × ${f.raw.toFixed(2)} = ${f.contribution.toFixed(3)}  ${f.evidence}`);
  }
  out('  Weights are uncalibrated defaults — validate them with: project-brain x intel calibrate');
  out(provenanceLine(scored));
  out(withAction.nextAction);
}

/**
 * Blast radius via the ts-graph import graph: files whose resolved imports
 * include a touched file. Guarded — returns null (factor omitted) for repos
 * without .ts/.tsx sources, without the optional `typescript` dependency, or
 * when graph construction fails. Never throws.
 */
async function blastRadiusFor(files) {
  if (process.env.BRAIN_TS_GRAPH === '0') return null;
  try {
    const indexable = await listIndexableFiles();
    // Cheap guard: without TS sources the loose program is empty anyway, and
    // loading the optional `typescript` package would only cost time + warns.
    if (!indexable.some((f) => /\.(ts|tsx)$/.test(f))) return null;
    const ctx = await loadTsSemanticContext(ROOT, new Set(indexable));
    if (!ctx) return null;
    const touched = new Set(files);
    const dependents = [];
    for (const rel of indexable) {
      if (touched.has(rel)) continue;
      const info = ctx.get(rel);
      if (info?.resolvedImports?.some((imp) => touched.has(imp))) dependents.push(rel);
    }
    dependents.sort();
    return { dependents, source: 'ts-graph' };
  } catch {
    return null;
  }
}

/**
 * Leases from .project-brain/active_state.md via active-state.mjs readers.
 * Read-only: returns null (factor omitted) when the file does not exist —
 * a risk query must never create brain state. Leases with a parseable
 * expired `until` are dropped; unparseable `until` values are kept (fail
 * toward caution).
 */
function readLeasesSafe(nowMs) {
  try {
    if (!fs.existsSync(ACTIVE_STATE)) return null;
    const { leases } = activeStateJson();
    return leases.filter((l) => {
      if (!l.target) return false;
      const until = Date.parse(l.until);
      return !(Number.isFinite(until) && until < nowMs);
    });
  } catch {
    return null;
  }
}

/** Score-mode action: lease conflicts outrank everything, then the factor actions. */
function nextActionForScore(scored, base) {
  const lease = scored.factors.find((f) => f.name === 'lease-conflicts' && f.raw > 0);
  if (lease) {
    const c = lease.data.conflicts[0];
    return `→ lease conflict: ${c.file} overlaps '${c.target}'` +
      `${c.lockedBy ? ` held by ${c.lockedBy}` : ''}${c.until ? ` until ${c.until}` : ''} — ` +
      'coordinate or split the lease before editing; run: project-brain lease';
  }
  return nextActionFor(base);
}

function cmdCalibrate(commits, { json, window, horizonDays, halfLifeDays }) {
  const result = calibrateRisk(commits, { window, horizonDays, halfLifeDays });
  if (json) return printJson(result);
  out(`Risk-weight calibration — ${result.method}`);
  out(`  Each commit is scored from history strictly BEFORE it; "defective" = a later`);
  out(`  fix/revert/hotfix/regression commit within ${result.params.horizonDays}d touches the same file(s).`);
  out(`  evaluated ${result.evaluated} · defective ${result.defective} · ` +
    `censored ${result.censored} (younger than horizon) · ` +
    `skipped ${result.skipped.merge} merge + ${result.skipped.bulk} bulk`);
  if (result.quantiles.length) {
    out('');
    table(
      result.quantiles.map((q) =>
        [q.quantile, `${q.scoreMin.toFixed(1)}–${q.scoreMax.toFixed(1)}`, q.commits, q.defective, pct(q.defectRate)]),
      ['BIN', 'SCORE', 'COMMITS', 'DEFECTIVE', 'RATE']
    );
  }
  out('');
  out(provenanceLine(result));
  out(result.verdict);
}

// ---------------------------------------------------------------------------
// health — per-file danger score + its calibration receipt
// ---------------------------------------------------------------------------

/** The factor that drives a file's score: highest contribution, name tiebreak. */
function topFactorOf(entry) {
  return [...entry.factors]
    .sort((a, b) => b.contribution - a.contribution || (a.name < b.name ? -1 : 1))[0];
}

/** "Kein Score ohne Aktion": the health table always ends in a concrete next step. */
function healthNextAction(result, plansByFile) {
  const top = result.files.find((f) => !f.lowConfidence) || result.files[0];
  if (!top) return '→ no git history to rank yet; start with: project-brain brief';
  const riskCmd = `before touching: project-brain x intel risk --files ${top.file}`;
  // With --plans the action is the move itself: a named refactoring beats a
  // restatement of the score every time.
  const plan = plansByFile && (plansByFile.get(top.file) || [])[0];
  if (plan) {
    return `→ ${top.file} scores ${top.score.toFixed(1)}/10 — ${plan.move}: ${plan.why}; ${riskCmd}`;
  }
  const bus = top.factors.find((f) => f.name === 'bus-factor');
  if (bus && bus.raw >= 1) {
    return `→ highest-risk file ${top.file} also has bus factor 1 — pair or document it; ${riskCmd}`;
  }
  const lead = topFactorOf(top);
  return `→ ${top.file} scores ${top.score.toFixed(1)}/10, driven by ${lead.name} ` +
    `(${lead.evidence}); ${riskCmd}`;
}

async function cmdHealth(commits, { json, limit, nowMs, halfLifeDays, structure, plans }) {
  const ctx = structure ? await structuralContext() : null;
  const result = fileHealth(commits, {
    now: nowMs,
    halfLifeDays,
    ...(ctx ? { structure: ctx.measured, graph: ctx.graph } : {})
  });

  // Plans are per FILE, computed from the same three inputs the score used.
  const plansByFile = plans && ctx
    ? new Map(result.files.map((f) => [
      f.file,
      refactorPlan(
        ctx.measureByFile.get(f.file) || null,
        graphFactsFor(ctx, f.file),
        f.factors,
        // Top author's share of the window: gates the add-owner move, which is
        // vacuous in an effectively-solo repo (every file would carry it).
        { topAuthorShare: topAuthorShareOf(commits), fileScore: f.score }
      )
    ]))
    : null;

  const withAction = {
    ...result,
    ...(ctx
      ? {
        files: result.files.map((f) => ({
          ...f,
          structure: ctx.measureByFile.get(f.file) || null,
          graph: ctx.degreeByFile.get(f.file) || null,
          ...(plansByFile ? { plans: plansByFile.get(f.file) || [] } : {})
        })),
        structureNote: STRUCTURE_NOTE
      }
      : {}),
    nextAction: healthNextAction(result, plansByFile)
  };
  if (json) return printJson(withAction);

  out('File health (0-10, 10 = most dangerous: churn percentile × co-change scatter × bus factor × fix density' +
    (ctx ? ' × size × nesting × coupling)' : ')'));
  if (!result.files.length) {
    out('  (no commits found)');
    out(provenanceLine(result));
    out(withAction.nextAction);
    return;
  }
  const rows = result.files.slice(0, limit);
  if (ctx) {
    table(
      rows.map((f, i) => {
        const m = ctx.measureByFile.get(f.file);
        const d = ctx.degreeByFile.get(f.file);
        return [
          i + 1,
          f.score.toFixed(1) + (f.lowConfidence ? '*' : ' '),
          f.commits,
          m ? m.codeLines : '-',
          m ? m.maxNestingDepth : '-',
          d ? `${d.fanIn}/${d.fanOut}` : '-',
          topFactorOf(f).evidence,
          f.file
        ];
      }),
      ['#', 'SCORE', 'COMMITS', 'LINES', 'DEPTH', 'IN/OUT', 'TOP FACTOR', 'FILE']
    );
  } else {
    table(
      rows.map((f, i) =>
        [i + 1, f.score.toFixed(1) + (f.lowConfidence ? '*' : ' '), f.commits, topFactorOf(f).evidence, f.file]),
      ['#', 'SCORE', 'COMMITS', 'TOP FACTOR', 'FILE']
    );
  }
  if (result.files.some((f) => f.lowConfidence)) {
    out(`  * low confidence: fewer than ${result.params.minCommits} commits — insufficient history`);
  }
  if (plansByFile) {
    out('');
    out(`Refactor plans (top ${rows.length} by danger; a file with no rule firing gets no advice)`);
    let anyPlan = false;
    for (const f of rows) {
      const items = plansByFile.get(f.file) || [];
      if (!items.length) continue;
      anyPlan = true;
      out(`  ${f.file} — ${f.score.toFixed(1)}/10`);
      for (const item of items) out(`    · ${item.move.padEnd(17)} ${item.why}  [${item.evidence}]`);
    }
    if (!anyPlan) out('  (no rule fired on these files — nothing to recommend)');
  }
  if (ctx) {
    out('');
    out(`  Structure: ${ctx.measured.files.length} file(s) measured, ${ctx.graph.coverage.resolvedEdges} import edge(s), ` +
      `${ctx.cycles.cycles.length} cycle(s)${ctx.cycles.truncated ? '+' : ''} — ${STRUCTURE_NOTE}`);
  }
  out('  Weights are uncalibrated defaults — validate with: project-brain x intel health-calibrate' +
    (ctx ? ' --structure' : ''));
  out(provenanceLine(result));
  out(withAction.nextAction);
}

async function cmdHealthCalibrate(commits, { json, window, horizonDays, halfLifeDays, structure }) {
  const ctx = structure ? await structuralContext() : null;
  const result = calibrateFileHealth(commits, {
    window,
    horizonDays,
    halfLifeDays,
    ...(ctx ? { structure: ctx.measured, graph: ctx.graph } : {})
  });
  if (json) return printJson(result);
  out(`File-health calibration — ${result.method}`);
  out(`  Every file is scored from commits at or before the cut (${(result.params.cut || '').slice(0, 10) || 'n/a'});`);
  out(`  "defective" = a fix/revert/hotfix/regression commit within the ${horizonDays}d after the cut touches it.`);
  out(`  evaluated ${result.evaluated} file(s) · fixed after cut ${result.defective} · ` +
    `future commits ${result.futureCommits} (${result.futureFixCommits} fix)`);
  if (result.quantiles.length) {
    out('');
    table(
      result.quantiles.map((q) =>
        [q.quantile, `${q.scoreMin.toFixed(1)}–${q.scoreMax.toFixed(1)}`, q.files, q.defective, pct(q.defectRate)]),
      ['BIN', 'SCORE', 'FILES', 'FIXED', 'RATE']
    );
  }
  if (result.perFactor.length) {
    out('');
    out('Per-factor discrimination (AUC of each factor ALONE — 0.50 = coin flip)');
    table(
      result.perFactor.map((f) =>
        [f.name, f.kind, f.weight.toFixed(2), f.evaluated, f.auc === null ? 'n/a' : f.auc.toFixed(2)]),
      ['FACTOR', 'KIND', 'WEIGHT', 'FILES', 'AUC']
    );
    const fmt = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(2));
    const c = result.comparison;
    out(`  Per-factor AUCs are NOT directly comparable across rows: each is computed over the files`);
    out(`  that carry that factor (FILES column). The apples-to-apples comparison is below.`);
    out(`  Same-population comparison over ${c.files} file(s) — ${c.basis} — of which ${c.defective} fixed: ` +
      `history-only ${fmt(c.historyOnlyAuc)} · combined ${fmt(c.combinedAuc)}` +
      (c.structureOnlyAuc !== null ? ` · structure-only ${fmt(c.structureOnlyAuc)}` : '') +
      (c.delta !== null ? ` · delta ${c.delta > 0 ? '+' : ''}${c.delta.toFixed(2)}` : ''));
    out(`  Headline AUC ${fmt(result.auc)} covers all ${result.evaluated} evaluated file(s).`);
    if (result.structureCaveat) out(`  ⚠ ${result.structureCaveat}`);
  }
  out('');
  out(provenanceLine(result));
  out(result.verdict);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    out(usage());
    process.exit(0);
  }

  const json = takeFlag(args, '--json');
  const score = takeFlag(args, '--score');
  const plans = takeFlag(args, '--plans');
  // --plans needs the measurements the moves are derived from, so it implies
  // --structure rather than silently producing an empty plan list.
  const structure = takeFlag(args, '--structure') || plans;
  const limitRaw = takeOption(args, '--limit');
  const commitsRaw = takeOption(args, '--commits');
  const since = takeOption(args, '--since');
  const filesRaw = takeOption(args, '--files');
  const halfLifeRaw = takeOption(args, '--half-life');
  const nowRaw = takeOption(args, '--now');
  const windowRaw = takeOption(args, '--window');
  const horizonRaw = takeOption(args, '--horizon-days');

  const limit = limitRaw ? Number(limitRaw) : DEFAULT_ROW_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    process.stderr.write(`[brain:intel] --limit must be a positive integer, got: ${limitRaw}\n`);
    process.exit(1);
  }
  const commitWindow = commitsRaw ? Number(commitsRaw) : (since ? 0 : DEFAULT_COMMIT_WINDOW);
  if (commitsRaw && (!Number.isFinite(commitWindow) || commitWindow <= 0)) {
    process.stderr.write(`[brain:intel] --commits must be a positive integer, got: ${commitsRaw}\n`);
    process.exit(1);
  }
  const halfLifeDays = halfLifeRaw ? Number(halfLifeRaw) : DEFAULT_HALF_LIFE_DAYS;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    process.stderr.write(`[brain:intel] --half-life must be a positive number of days, got: ${halfLifeRaw}\n`);
    process.exit(1);
  }
  const nowMs = nowRaw ? Date.parse(nowRaw) : Date.now();
  if (!Number.isFinite(nowMs)) {
    process.stderr.write(`[brain:intel] --now must be an ISO date/time, got: ${nowRaw}\n`);
    process.exit(1);
  }
  const window = windowRaw ? Number(windowRaw) : DEFAULT_CALIBRATE_WINDOW;
  if (!Number.isFinite(window) || window <= 0) {
    process.stderr.write(`[brain:intel] --window must be a positive integer, got: ${windowRaw}\n`);
    process.exit(1);
  }
  const horizonDays = horizonRaw ? Number(horizonRaw) : DEFAULT_HORIZON_DAYS;
  if (!Number.isFinite(horizonDays) || horizonDays <= 0) {
    process.stderr.write(`[brain:intel] --horizon-days must be a positive number of days, got: ${horizonRaw}\n`);
    process.exit(1);
  }

  const sub = args.shift();
  if (!sub || !['hotspots', 'co-change', 'ownership', 'risk', 'calibrate', 'health', 'health-calibrate'].includes(sub)) {
    process.stderr.write(usage() + '\n');
    process.exit(1);
  }

  try {
    const commits = parseLog(runGitLog({ limit: commitWindow, since }));
    const opts = { json, limit, nowMs, halfLifeDays, score, window, horizonDays, structure, plans };
    if (sub === 'hotspots') return cmdHotspots(commits, opts);
    if (sub === 'co-change') return cmdCoChange(commits, opts);
    if (sub === 'ownership') return cmdOwnership(commits, opts);
    if (sub === 'calibrate') return cmdCalibrate(commits, opts);
    if (sub === 'health') return await cmdHealth(commits, opts);
    if (sub === 'health-calibrate') return await cmdHealthCalibrate(commits, opts);
    // risk
    const files = filesRaw
      ? filesRaw.split(',').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean)
      : stagedFiles();
    if (!files.length) {
      process.stderr.write('[brain:intel] risk: no --files given and nothing staged (git diff --cached is empty).\n');
      process.exit(1);
    }
    return await cmdRisk(commits, files, opts);
  } catch (error) {
    process.stderr.write(`[brain:intel] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit (mirrors brain-why.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:intel] ${error.message || error}\n`);
    process.exit(1);
  });
}
