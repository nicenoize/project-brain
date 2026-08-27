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
 *   brain-intel.mjs health [--limit N] [--json]
 *       (per-file 0-10 danger score: churn percentile × co-change scatter ×
 *        bus factor × fix density — receipt-backed, lowConfidence-flagged)
 *   brain-intel.mjs health-calibrate [--window N] [--horizon-days K] [--json]
 *       (cut-point replay: do TODAY's file scores predict NEAR-FUTURE fixes?)
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
function healthNextAction(result) {
  const top = result.files.find((f) => !f.lowConfidence) || result.files[0];
  if (!top) return '→ no git history to rank yet; start with: project-brain brief';
  const riskCmd = `before touching: project-brain x intel risk --files ${top.file}`;
  const bus = top.factors.find((f) => f.name === 'bus-factor');
  if (bus && bus.raw >= 1) {
    return `→ highest-risk file ${top.file} also has bus factor 1 — pair or document it; ${riskCmd}`;
  }
  const lead = topFactorOf(top);
  return `→ ${top.file} scores ${top.score.toFixed(1)}/10, driven by ${lead.name} ` +
    `(${lead.evidence}); ${riskCmd}`;
}

function cmdHealth(commits, { json, limit, nowMs, halfLifeDays }) {
  const result = fileHealth(commits, { now: nowMs, halfLifeDays });
  const withAction = { ...result, nextAction: healthNextAction(result) };
  if (json) return printJson(withAction);
  out('File health (0-10, 10 = most dangerous: churn percentile × co-change scatter × bus factor × fix density)');
  if (!result.files.length) {
    out('  (no commits found)');
    out(provenanceLine(result));
    out(withAction.nextAction);
    return;
  }
  table(
    result.files.slice(0, limit).map((f, i) => {
      const lead = topFactorOf(f);
      return [i + 1, f.score.toFixed(1) + (f.lowConfidence ? '*' : ' '), f.commits, lead.evidence, f.file];
    }),
    ['#', 'SCORE', 'COMMITS', 'TOP FACTOR', 'FILE']
  );
  if (result.files.some((f) => f.lowConfidence)) {
    out(`  * low confidence: fewer than ${result.params.minCommits} commits — insufficient history`);
  }
  out('  Weights are uncalibrated defaults — validate with: project-brain x intel health-calibrate');
  out(provenanceLine(result));
  out(withAction.nextAction);
}

function cmdHealthCalibrate(commits, { json, window, horizonDays, halfLifeDays }) {
  const result = calibrateFileHealth(commits, { window, horizonDays, halfLifeDays });
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
    const opts = { json, limit, nowMs, halfLifeDays, score, window, horizonDays };
    if (sub === 'hotspots') return cmdHotspots(commits, opts);
    if (sub === 'co-change') return cmdCoChange(commits, opts);
    if (sub === 'ownership') return cmdOwnership(commits, opts);
    if (sub === 'calibrate') return cmdCalibrate(commits, opts);
    if (sub === 'health') return cmdHealth(commits, opts);
    if (sub === 'health-calibrate') return cmdHealthCalibrate(commits, opts);
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
