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
 *   brain-intel.mjs risk [--files a,b,c] [--since <rev|date>] [--json]
 *       (without --files: reads staged files via `git diff --cached --name-only`)
 *
 * Shared flags: --commits N (history window, default 500 commits to bound
 * cost — mirrors brain-why's -n convention; --since replaces the cap),
 * --now <iso> (clock override for reproducible output; the library never
 * calls Date.now() itself), --half-life N (hotspot decay, days).
 *
 * One `git log` invocation per run, stream-parsed. Human output: compact
 * ranked tables with the provenance line at the end; risk output always ends
 * with a concrete next action (Praktiken-Katalog: "kein Score ohne Aktion").
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, takeFlag, takeOption } from './common.mjs';
import {
  gitLogArgs,
  parseLog,
  hotspots,
  coChange,
  ownership,
  riskFactors,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_MIN_SUPPORT,
  DEFAULT_MIN_CONFIDENCE
} from './git-intel.mjs';

const DEFAULT_COMMIT_WINDOW = 500;
const DEFAULT_ROW_LIMIT = 15;

function usage() {
  return [
    'Usage: brain-intel.mjs <subcommand> [flags]',
    '',
    'Subcommands:',
    '  hotspots     Churn × recency-decay ranking of files.',
    '  co-change    "Who changes A usually changes B" pairs.',
    '  ownership    Top authors + bus factor per path prefix and file.',
    '  risk         Risk factors for a change-set (--files a,b,c or staged files).',
    '',
    'Flags:',
    '  --json            Parseable JSON on stdout, nothing else.',
    `  --limit N         Rows in human tables (default ${DEFAULT_ROW_LIMIT}).`,
    `  --commits N       History window in commits (default ${DEFAULT_COMMIT_WINDOW}, bounds cost).`,
    '  --since <rev|date> Analyze <rev>..HEAD or --since=<date> instead of the commit cap.',
    '  --files a,b,c     (risk) Change-set; default: staged files (git diff --cached).',
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

function cmdRisk(commits, files, { json, nowMs, halfLifeDays }) {
  const hs = hotspots(commits, { now: nowMs, halfLifeDays });
  const cc = coChange(commits);
  const result = riskFactors(files, { hotspots: hs, coChange: cc });
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
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    out(usage());
    process.exit(0);
  }

  const json = takeFlag(args, '--json');
  const limitRaw = takeOption(args, '--limit');
  const commitsRaw = takeOption(args, '--commits');
  const since = takeOption(args, '--since');
  const filesRaw = takeOption(args, '--files');
  const halfLifeRaw = takeOption(args, '--half-life');
  const nowRaw = takeOption(args, '--now');

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

  const sub = args.shift();
  if (!sub || !['hotspots', 'co-change', 'ownership', 'risk'].includes(sub)) {
    process.stderr.write(usage() + '\n');
    process.exit(1);
  }

  try {
    const commits = parseLog(runGitLog({ limit: commitWindow, since }));
    const opts = { json, limit, nowMs, halfLifeDays };
    if (sub === 'hotspots') return cmdHotspots(commits, opts);
    if (sub === 'co-change') return cmdCoChange(commits, opts);
    if (sub === 'ownership') return cmdOwnership(commits, opts);
    // risk
    const files = filesRaw
      ? filesRaw.split(',').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean)
      : stagedFiles();
    if (!files.length) {
      process.stderr.write('[brain:intel] risk: no --files given and nothing staged (git diff --cached is empty).\n');
      process.exit(1);
    }
    return cmdRisk(commits, files, opts);
  } catch (error) {
    process.stderr.write(`[brain:intel] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit (mirrors brain-why.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
