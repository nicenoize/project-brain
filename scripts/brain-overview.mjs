#!/usr/bin/env node
/**
 * brain:overview — the whole repository in under 2,000 tokens.
 *
 * WHY THIS EXISTS. An agent meeting a repository for the first time burns its
 * tokens SEARCHING and DISCARDING, not reading answers. `grep -i approv` on a
 * real repo returns 305 files; semantic search returned documentation above the
 * authorization code it was asked for. Either way the agent pays for a hundred
 * wrong files before it finds the right one.
 *
 * Everything needed to skip that is already measured and lying around: the
 * import graph knows what the whole codebase leans on, git knows what churns
 * and who owns it, the module records know what was meant. Nothing here is new
 * analysis. This is a COMPOSER with a budget.
 *
 * THE RULE, from decisions/0024 and every panel we shipped this week: ranked,
 * bounded, and honest about what was left out. A number without its omission is
 * a number that will be trusted further than it deserves. The footer always
 * states what the budget cut.
 *
 * PURE CORE. `composeOverview` takes measurements and returns lines; it has no
 * clock, no git, no fs. The CLI gathers, it decides. That is what makes the
 * output byte-identical for identical inputs (ADR 0030: a claim is
 * re-derivable), and what lets the whole thing be unit-tested without a repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, BRAIN_DIR, exists, read, takeFlag, takeOption } from './common.mjs';
import { gitLogArgs, parseLog, ownership, fileHealth, calibrateFileHealth } from './git-intel.mjs';
import { buildImportGraph, fanIn, cycles, langOf } from './import-graph.mjs';
import { estimateTokens } from './footprint.mjs';

/** The whole point: a repository briefing an agent can afford to read. */
export const DEFAULT_BUDGET_BYTES = 8000;   // ≈2,000 tokens
const COMMIT_WINDOW = 500;
const TOP_N = 8;

/** PURE. Byte-stable ordering — never localeCompare. */
function byString(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** PURE. `n` rendered with a fixed unit so columns line up in a terminal. */
function pct(n) { return `${Math.round(n * 100)}%`; }

/**
 * PURE. Compose the briefing.
 *
 * Sections are emitted in the order an unfamiliar reader needs them: what the
 * repo IS, what it leans on, where it is dangerous, who knows it, and what it
 * says about itself. Each is truncated independently so one big section cannot
 * starve the rest, and every truncation is counted into `omitted`.
 *
 * @param {object} m measurements (all optional; a missing one is reported, not faked)
 * @returns {{text: string, omitted: string[], bytes: number}}
 */
export function composeOverview(m = {}) {
  const budget = Number.isFinite(m.budgetBytes) && m.budgetBytes > 0
    ? m.budgetBytes : DEFAULT_BUDGET_BYTES;
  const lines = [];
  const omitted = [];
  const push = (s) => lines.push(s);

  push(`# ${m.name || 'repository'} — overview`);
  push('');

  // --- what it is ----------------------------------------------------------
  const langs = Object.entries(m.languages || {})
    .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]));
  const langStr = langs.slice(0, 5).map(([l, n]) => `${l} ${n}`).join(' · ');
  if (langs.length > 5) omitted.push(`${langs.length - 5} more language(s)`);
  const coded = langs.reduce((n, [, c]) => n + c, 0);
  push(`${m.files ?? '?'} tracked file(s), ${coded} of them code${langStr ? ` — ${langStr}` : ''}` +
    `${m.commits ? ` · ${m.commits} commit(s) in the window` : ''}` +
    `${m.spanDays ? ` spanning ~${m.spanDays} day(s)` : ''}`);
  if (m.authors) push(`${m.authors} author(s).`);
  push('');

  // --- what the codebase leans on -----------------------------------------
  // Fan-in first: it is the single most useful thing to know before touching
  // anything, and it is the one an agent cannot get from reading a few files.
  const load = (m.mostDependedOn || []).slice(0, TOP_N);
  if (load.length) {
    push('## Load-bearing — change these and the blast radius is wide');
    for (const f of load) push(`- ${f.file} — ${f.count} dependent(s)`);
    if ((m.mostDependedOn || []).length > TOP_N) {
      omitted.push(`${m.mostDependedOn.length - TOP_N} more load-bearing file(s)`);
    }
    push('');
  } else if (m.graphDegraded) {
    push(`## Load-bearing — not measured: ${m.graphDegraded}`);
    push('');
  }

  // --- where it is dangerous ----------------------------------------------
  const danger = (m.dangerous || []).slice(0, TOP_N);
  if (danger.length) {
    push('## Most dangerous — highest churn × co-change × fix density');
    for (const d of danger) {
      push(`- ${d.file} ${d.score}/10${d.why ? ` — ${d.why}` : ''}`);
    }
    if ((m.dangerous || []).length > TOP_N) {
      omitted.push(`${m.dangerous.length - TOP_N} more scored file(s)`);
    }
    // A score without its calibration is exactly the overclaim this repo spent
    // a week removing from its own tools.
    if (m.calibration && m.calibration.auc != null) {
      push(m.calibration.sufficientEvidence
        ? `  (AUC ${m.calibration.auc.toFixed(2)} against this repo's own fix history — the ranking holds here.)`
        : `  (AUC ${m.calibration.auc.toFixed(2)} but only ${m.calibration.minorityClass} file(s) in the smaller class — measured, NOT established.)`);
    } else if (m.calibration) {
      push('  (Not calibratable on this repo yet — treat the ranking as a hint, not a result.)');
    }
    push('');
  }

  // --- who knows it --------------------------------------------------------
  const owners = (m.owners || []).slice(0, 5);
  if (owners.length) {
    push('## Who knows what');
    for (const o of owners) {
      push(`- ${o.prefix} — ${o.top}${o.share != null ? ` (${pct(o.share)} of commits)` : ''}` +
        `${o.busFactor ? `, bus factor ${o.busFactor}` : ''}`);
    }
    if ((m.owners || []).length > 5) omitted.push(`${m.owners.length - 5} more area(s)`);
    push('');
  }

  // --- what it says about itself ------------------------------------------
  if ((m.modules || []).length) {
    push('## Documented modules');
    push((m.modules.slice(0, 12)).join(' · ') +
      (m.modules.length > 12 ? ` … +${m.modules.length - 12}` : ''));
    push('');
  }
  if ((m.decisions || []).length) {
    push(`## Decisions on record (${m.decisions.length})`);
    for (const d of m.decisions.slice(0, 5)) push(`- ${d}`);
    if (m.decisions.length > 5) omitted.push(`${m.decisions.length - 5} more decision(s)`);
    push('');
  }

  // --- what is structurally suspicious ------------------------------------
  const notes = [];
  if (m.cycles > 0) notes.push(`${m.cycles} import cycle(s)`);
  if (m.orphans > 0) notes.push(`${m.orphans} dead-code CANDIDATE(s) — candidates only, confirm before deleting`);
  if (m.unresolvedRatio != null && m.unresolvedRatio > 0.3) {
    notes.push(`${pct(m.unresolvedRatio)} of import specifiers unresolved — the graph sees less than it looks`);
  }
  if (notes.length) {
    push('## Worth knowing');
    for (const n of notes) push(`- ${n}`);
    push('');
  }

  // --- the honest footer ---------------------------------------------------
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  const footerFor = (om) => {
    const parts = [
      `_Deterministic: git log + import graph + .project-brain records. No model, no network._`,
      om.length ? `_Left out by the ${budget} B budget: ${om.join(', ')}._` : ''
    ].filter(Boolean);
    return `\n${parts.join('\n')}\n`;
  };

  // Trim from the END — the sections are already in need-to-know order, so the
  // reader loses the least important first, and the cut is always named.
  let cutSections = 0;
  while (Buffer.byteLength(text + footerFor([...omitted, `${cutSections} trailing section(s)`]), 'utf8') > budget) {
    const lastHeading = text.lastIndexOf('\n## ');
    if (lastHeading <= 0) break;
    text = text.slice(0, lastHeading);
    cutSections += 1;
  }
  if (cutSections) omitted.push(`${cutSections} trailing section(s)`);

  const out = `${text}\n${footerFor(omitted)}`.replace(/\n{3,}/g, '\n\n');
  return { text: out, omitted, bytes: Buffer.byteLength(out, 'utf8') };
}

// ---------------------------------------------------------------------------
// gathering (the only impure part)
// ---------------------------------------------------------------------------

function gitFiles(root) {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return [];
  return (r.stdout || '').split('\n').filter(Boolean);
}

function gitCommits(root, limit) {
  const r = spawnSync('git', gitLogArgs({ limit }), {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return [];
  return parseLog(r.stdout || '');
}

/** Frontmatter titles of the module/decision records, if any. */
function recordTitles(dir, limit) {
  const abs = path.join(BRAIN_DIR, dir);
  if (!exists(abs)) return [];
  try {
    return fs.readdirSync(abs).filter((f) => f.endsWith('.md')).sort(byString).slice(0, limit)
      .map((f) => {
        const m = read(path.join(abs, f)).match(/^title:\s*(.+)$/m);
        return (m ? m[1] : f.replace(/\.md$/, '')).trim().slice(0, 90);
      });
  } catch { return []; }
}

/**
 * Gather the measurements the briefing is composed from. Exported so the MCP
 * server can offer the same answer through the pull surface without shelling
 * out to the CLI — one implementation, one set of numbers.
 */
export async function gatherOverview(root, { budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  return gather(root, { budgetBytes });
}

async function gather(root, { budgetBytes }) {
  const files = gitFiles(root);
  const commits = gitCommits(root, COMMIT_WINDOW);
  const now = Date.now();

  const languages = {};
  for (const f of files) {
    const l = langOf(f);
    if (l) languages[l] = (languages[l] || 0) + 1;
  }

  const stamps = commits.map((c) => Date.parse(c.dateIso)).filter(Number.isFinite);
  const spanDays = stamps.length > 1
    ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 86_400_000) : 0;

  let graph = null;
  let graphDegraded = '';
  try {
    graph = buildImportGraph({
      files: files.filter((f) => langOf(f)),
      readFile: (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
    });
  } catch (error) {
    graphDegraded = String(error.message || error);
  }

  const health = commits.length ? fileHealth(commits, { now }) : { files: [] };
  let cal = null;
  if (commits.length) {
    try {
      const c = calibrateFileHealth(commits, { horizonDays: 30 });
      cal = {
        auc: c.auc,
        sufficientEvidence: c.sufficientEvidence,
        minorityClass: c.minorityClass
      };
    } catch { cal = null; }
  }
  const own = commits.length ? ownership(commits) : { prefixes: [] };

  return {
    name: path.basename(root),
    files: files.length,
    languages,
    commits: commits.length,
    spanDays,
    authors: new Set(commits.map((c) => c.author).filter(Boolean)).size,
    mostDependedOn: graph ? fanIn(graph).filter((e) => e.count).slice(0, TOP_N) : [],
    graphDegraded,
    cycles: graph ? cycles(graph, { maxCycles: 50 }).cycles.length : 0,
    orphans: 0,
    unresolvedRatio: graph && graph.coverage.totalSpecs
      ? graph.coverage.unresolvedSpecs / graph.coverage.totalSpecs : null,
    dangerous: (health.files || []).slice(0, TOP_N).map((f) => ({
      file: f.file,
      score: f.score,
      why: (f.factors || []).filter((x) => x.contribution > 0)
        .slice(0, 2).map((x) => x.name).join(', ')
    })),
    // The receipt. A danger ranking printed without it is the overclaim this
    // repo spent a week removing from its own tools — and on most repos the
    // honest answer is "not established here", which the reader needs to see.
    calibration: cal,
    owners: (own.prefixes || []).slice(0, 5).map((p) => ({
      prefix: p.path,
      top: p.topAuthors?.[0]?.author || 'unknown',
      share: p.topAuthors?.[0]?.share ?? null,
      busFactor: p.busFactor
    })),
    modules: recordTitles('modules', 40),
    decisions: recordTitles('decisions', 60),
    budgetBytes
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    process.stdout.write([
      'brain:overview — the whole repository in under 2,000 tokens.',
      '',
      '  npm run brain:overview [--json] [--budget-bytes N]',
      '',
      'Composes what is already measured — import graph, git history, module and',
      'decision records — into a bounded briefing, ranked, with every omission named.',
      'Deterministic: no model, no network, no index required.'
    ].join('\n') + '\n');
    return;
  }
  const json = takeFlag(args, '--json');
  const budgetBytes = Number(takeOption(args, '--budget-bytes')) || DEFAULT_BUDGET_BYTES;

  const measured = await gather(ROOT, { budgetBytes });
  const out = composeOverview(measured);
  if (json) {
    process.stdout.write(JSON.stringify({
      ...measured, text: out.text, bytes: out.bytes,
      tokens: estimateTokens(out.bytes), omitted: out.omitted
    }, null, 2) + '\n');
    return;
  }
  process.stdout.write(out.text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:overview] ${error.message || error}\n`);
    process.exit(1);
  });
}
