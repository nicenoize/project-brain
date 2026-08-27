/**
 * brain-draft — generate a module-record DRAFT that a human (or agent) then OWNS.
 *
 * WHY THIS EXISTS. `/api/map` already reports the honest gap: top-level code
 * areas that no `.project-brain/modules/*.md` record claims. Nothing here
 * closes that gap for you, because the thing that is missing from an orphan
 * area is the WHY, and no scanner can recover a WHY from a file tree. What IS
 * missing and mechanical is the blank page: the file list, the importers, the
 * hotspots, the ADRs that already point at the area. So this command emits a
 * DRAFT of exactly those measured facts and stops.
 *
 * >>> THIS IS NOT A GENERATED WIKI. <<<
 * The distinction is the whole product:
 *   - a generated wiki regenerates itself, so it can never hold a decision;
 *   - this draft is written ONCE, to stdout by default, and is adopted by a
 *     person who edits it and commits it. Nothing re-runs behind their back.
 * Consequently `status: draft` is stamped into the frontmatter (a human flips
 * it to `canonical` when they adopt it), a banner names the date and the
 * missing WHY, and `## Why it is this way` is emitted EMPTY on purpose.
 *
 * >>> NO SENTENCE IN THE OUTPUT MAY ASSERT INTENT. <<<
 * Every generated line is a measured fact with its number, or an explicit
 * "not measured / none found". No rationale, no design goals, no "handles" /
 * "is responsible for" prose. If it cannot be stated as a count, a path, a
 * date or an author, it is not written — it is left for the reader to write.
 *
 * Facts come from the existing measurement libraries, never from a new one:
 *   import-graph.mjs   file→file edges (regex/line scanner, NOT a parser),
 *                      bounded cycles, resolution confidence
 *   code-structure.mjs shape metrics (code lines)
 *   git-intel.mjs      hotspots (churn × recency), authors, bus factor
 *   .project-brain/    existing module records (overlap) + decisions (links)
 *
 * Usage:
 *   project-brain x draft module <path-or-glob> [--out] [--force] [--json]
 *                               [--now <iso>] [--top N] [--commits N]
 *
 * Default output is the draft markdown on stdout and nothing else, so
 * `… > /tmp/draft.md` and `… | pbcopy` are the intended workflows; the scan
 * summary and the next action go to stderr. `--out` writes
 * `.project-brain/modules/<slug>.md` and REFUSES to clobber an existing record
 * unless `--force` — and prints what would be lost either way.
 *
 * The emitted `globs:` line is the same comma-separated form brain-serve's
 * `moduleGlobs()` reads, so an adopted draft claims its files exactly like a
 * hand-written record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, BRAIN_DIR, ensureDir, exists, read, slugify, parseDoc, takeFlag, takeOption
} from './common.mjs';
import {
  buildImportGraph, cycles as importCycles, parseImports, resolveSpecWithConfidence,
  defaultRoots, globToRegExp, langOf
} from './import-graph.mjs';
import { measureFiles } from './code-structure.mjs';
import { gitLogArgs, parseLog, hotspots, busFactorOf } from './git-intel.mjs';

/** Every source extension import-graph.mjs can scan (mirrors brain-graph-scan). */
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/i;
/** Never scanned. Duplicated from brain-graph-scan on purpose: no shared mutation. */
const IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees)(\/|$)/;

const DEFAULT_TOP = 8;
const DEFAULT_COMMITS = 500;
const MAX_FILE_ROWS = 40;
const MAX_CYCLE_LEN = 8;
const MAX_CYCLES = 25;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_ENTRIES = 20000;

function usage() {
  return [
    'Usage: project-brain x draft module <path-or-glob> [flags]',
    '',
    'Emit a DRAFT module record built only from measured structure. The draft is',
    'yours the moment it is written: edit it, write the WHY, commit it. Nothing',
    'regenerates it behind your back.',
    '',
    'Flags:',
    '  --out            Write .project-brain/modules/<slug>.md (default: stdout).',
    '  --force          With --out: replace an existing record (prints what is lost).',
    '  --json           Facts + markdown as JSON on stdout, nothing else.',
    '  --now <iso>      Clock override, for reproducible output.',
    `  --top N          Rows in the ranked tables (default ${DEFAULT_TOP}).`,
    `  --commits N      Git log window (default ${DEFAULT_COMMITS}).`,
    '',
    'Examples:',
    '  project-brain x draft module ui',
    '  project-brain x draft module "scripts/edges/**" --out',
    '  project-brain x draft module scripts/brain-serve.mjs --json'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// pure: area resolution
// ---------------------------------------------------------------------------

/** Deterministic byte-order compare (NOT localeCompare). */
function byString(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * PURE. Turn a CLI argument into the area a draft describes.
 * A directory becomes `<dir>/**`, an explicit glob is kept, anything else is
 * treated as one exact file. `isDirectory` is injected so this stays testable.
 *
 * @returns {{spec, glob, slug, kind: 'dir'|'glob'|'file'} | null}
 */
export function parseAreaSpec(spec, isDirectory = () => false) {
  const raw = String(spec || '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || raw.split('/').includes('..')) return null;
  const kind = raw.includes('*') ? 'glob' : isDirectory(raw) ? 'dir' : 'file';
  const glob = kind === 'dir' ? `${raw}/**` : raw;
  return { spec: raw, glob, slug: slugify(glob), kind };
}

/** PURE. Membership test for the area's glob. */
export function areaMatcher(glob) {
  const re = globToRegExp(String(glob || ''));
  return (file) => re.test(String(file || '').replace(/^\.\//, ''));
}

/**
 * PURE. Names a decision's `module:` frontmatter may plausibly use for this
 * area — the same widening brain:radar/brain-serve apply (a curated ADR says
 * `retrieval` where a path infers `scripts/retrieval`). Matching on these is a
 * measured string match, never a claim that the ADR is *about* the area.
 */
export function areaAliases(area) {
  const bare = String(area.glob || '').replace(/\/?\*+$/, '');
  const parts = bare.split('/').filter(Boolean);
  const out = new Set([area.slug, bare, parts[parts.length - 1] || '']);
  if (parts.length) out.add(parts.slice(0, 2).join('/'));
  const last = parts[parts.length - 1] || '';
  if (last.includes('.')) out.add(last.slice(0, last.lastIndexOf('.')));
  out.delete('');
  return out;
}

/** PURE. Path-looking tokens in a record body (used to link ADRs that cite files). */
export function citedPaths(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.*-]+/g)) {
    out.add(m[0].replace(/^\.\//, '').replace(/[.,;:)]+$/, ''));
  }
  return [...out].sort(byString);
}

// ---------------------------------------------------------------------------
// pure: fact gathering
// ---------------------------------------------------------------------------

/**
 * PURE. Everything the draft is allowed to say, and nothing else. All inputs
 * are already-computed measurements, so this function has no I/O and the same
 * inputs always produce the same facts.
 *
 * @param {{area, files, texts: Map<string,string>, graph, commits, now,
 *          moduleRecords, decisions, top, unreadable}} input
 */
export function gatherFacts(input = {}) {
  const area = input.area;
  const inArea = areaMatcher(area.glob);
  const top = Number.isFinite(input.top) && input.top > 0 ? Math.floor(input.top) : DEFAULT_TOP;
  const texts = input.texts instanceof Map ? input.texts : new Map();
  const graph = input.graph || { nodes: [], edges: [], external: [], coverage: {} };
  const commits = input.commits || [];
  const nowMs = Number.isFinite(input.now) ? input.now : Date.parse(input.now || '') || 0;
  const date = new Date(nowMs).toISOString().slice(0, 10);

  const areaFiles = [...new Set((input.files || []).map((f) => String(f).replace(/^\.\//, '')))]
    .filter(inArea)
    .sort(byString);
  const areaSet = new Set(areaFiles);

  // --- what's in it --------------------------------------------------------
  const measured = measureFiles({
    files: areaFiles.filter((f) => texts.has(f)),
    readFile: (f) => texts.get(f)
  });
  const measureByFile = new Map(measured.files.map((m) => [m.file, m]));
  const rows = areaFiles.map((file) => {
    const ext = path.posix.extname(file).replace(/^\./, '') || '(none)';
    const m = measureByFile.get(file);
    const text = texts.get(file);
    const lines = m ? m.lines : (typeof text === 'string' ? (text ? text.split('\n').length : 0) : null);
    return { file, ext, lines, code: m ? m.codeLines : null };
  });
  const codeLines = rows.reduce((sum, r) => sum + (r.code || 0), 0);
  const byExtCounts = new Map();
  for (const r of rows) byExtCounts.set(r.ext, (byExtCounts.get(r.ext) || 0) + 1);
  const byExt = [...byExtCounts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || byString(a.ext, b.ext));

  // --- overlap with existing records ---------------------------------------
  const claims = [];
  for (const rec of input.moduleRecords || []) {
    const matchers = (rec.globs || []).map(areaMatcher);
    const hits = areaFiles.filter((f) => matchers.some((m) => m(f)));
    if (hits.length) {
      claims.push({ file: rec.file, module: rec.module || rec.name, globs: rec.globs, matched: hits.length });
    }
  }
  claims.sort((a, b) => b.matched - a.matched || byString(a.file, b.file));

  // --- public surface: who outside imports what inside ---------------------
  const inbound = new Map();  // area file → importers outside the area
  const inAreaIn = new Map(); // area file → importers inside the area
  const outbound = new Map(); // file outside the area → importers inside it
  for (const e of graph.edges || []) {
    const fromIn = areaSet.has(e.from);
    const toIn = areaSet.has(e.to);
    if (toIn && !fromIn) push(inbound, e.to, e.from);
    else if (toIn && fromIn) push(inAreaIn, e.to, e.from);
    if (fromIn && !toIn) push(outbound, e.to, e.from);
  }
  const publicSurface = {
    exposedFiles: inbound.size,
    outsideImporters: new Set([...inbound.values()].flat()).size,
    rows: entries(inbound).slice(0, top),
    truncated: inbound.size > top
  };
  const inAreaFanIn = entries(inAreaIn)
    .map((r) => ({ file: r.file, count: r.importers.length }))
    .sort((a, b) => b.count - a.count || byString(a.file, b.file))
    .slice(0, top);

  // --- what the area imports ----------------------------------------------
  const dependsOn = entries(outbound)
    .map((r) => ({ file: r.file, count: r.importers.length, importers: r.importers }))
    .sort((a, b) => b.count - a.count || byString(a.file, b.file));
  const external = externalSpecs(areaFiles, texts, input.files || []);

  // --- cycles strictly inside the area ------------------------------------
  const cycleView = importCycles(graph, { maxLen: MAX_CYCLE_LEN, maxCycles: MAX_CYCLES });
  const cyclesInside = (cycleView.cycles || []).filter((c) => c.every((f) => areaSet.has(f)));

  // --- history -------------------------------------------------------------
  const areaCommits = commits.filter((c) => (c.files || []).some(inArea));
  const authorCounts = new Map();
  for (const c of areaCommits) authorCounts.set(c.author || '(unknown)', (authorCounts.get(c.author || '(unknown)') || 0) + 1);
  const authors = [...authorCounts.entries()]
    .map(([author, n]) => ({ author, commits: n, sharePct: Math.round((n / areaCommits.length) * 100) }))
    .sort((a, b) => b.commits - a.commits || byString(a.author, b.author))
    .slice(0, top);
  const dated = areaCommits.filter((c) => c.dateIso).sort((a, b) => byString(a.dateIso, b.dateIso));
  const last = dated.length ? dated[dated.length - 1] : null;
  const hot = nowMs
    ? hotspots(commits, { now: nowMs }).files.filter((f) => inArea(f.file)).slice(0, top)
    : [];
  const history = {
    commitsScanned: commits.length,
    areaCommits: areaCommits.length,
    firstIso: dated.length ? dated[0].dateIso : null,
    lastIso: last ? last.dateIso : null,
    lastCommit: last ? { hash: last.hash.slice(0, 8), author: last.author, dateIso: last.dateIso, subject: last.subject } : null,
    authors,
    busFactor: busFactorOf(authorCounts),
    hotspots: hot
  };

  // --- decisions already pointing here ------------------------------------
  const aliases = new Set([...areaAliases(area)].map((s) => s.toLowerCase()));
  const bare = String(area.glob).replace(/\/?\*+$/, '');
  const decisions = [];
  for (const d of input.decisions || []) {
    const byModule = d.module && aliases.has(String(d.module).toLowerCase());
    const cited = (d.paths || []).filter((p) => inArea(p) || p === bare || p.startsWith(`${bare}/`));
    if (!byModule && !cited.length) continue;
    decisions.push({
      file: d.file,
      name: d.name,
      title: d.title,
      module: d.module || '',
      matchedOn: byModule ? `frontmatter module: ${d.module}` : `cites ${cited.slice(0, 3).sort(byString).join(', ')}`
    });
  }
  decisions.sort((a, b) => byString(a.name, b.name));

  return {
    area,
    date,
    files: {
      count: areaFiles.length,
      codeLines,
      measuredFiles: measured.files.length,
      byExt,
      rows,
      unreadable: (input.unreadable || []).slice().sort((a, b) => byString(a.file, b.file))
    },
    claims,
    publicSurface,
    inAreaFanIn,
    dependsOn,
    external,
    cycles: { inside: cyclesInside, truncated: Boolean(cycleView.truncated), params: cycleView.params },
    history,
    decisions,
    scan: {
      sourceFilesScanned: graph.coverage.filesScanned || 0,
      resolvedEdges: graph.coverage.resolvedEdges || 0,
      unresolvedSpecs: graph.coverage.unresolvedSpecs || 0
    }
  };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function entries(map) {
  return [...map.entries()]
    .map(([file, set]) => ({ file, importers: [...set].sort(byString) }))
    .sort((a, b) => b.importers.length - a.importers.length || byString(a.file, b.file));
}

/**
 * PURE. Specifiers used by area files that resolve to nothing in the repo —
 * packages, stdlib, or a scanner blind spot. Reported, never dropped: that is
 * the same contract buildImportGraph applies repo-wide.
 */
function externalSpecs(areaFiles, texts, allFiles) {
  const fileSet = new Set(allFiles.map((f) => String(f).replace(/^\.\//, '')));
  const roots = defaultRoots(fileSet);
  const counts = new Map();
  for (const file of areaFiles) {
    const source = texts.get(file);
    if (typeof source !== 'string' || !langOf(file)) continue;
    let imports = [];
    try { imports = parseImports(source, { file }); } catch { continue; }
    for (const imp of imports) {
      let found = null;
      try { found = resolveSpecWithConfidence(imp.spec, { fromFile: file, files: fileSet, roots }); } catch { found = null; }
      if (found) continue;
      counts.set(imp.spec, (counts.get(imp.spec) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([spec, count]) => ({ spec, count }))
    .sort((a, b) => b.count - a.count || byString(a.spec, b.spec));
}

// ---------------------------------------------------------------------------
// pure: rendering
// ---------------------------------------------------------------------------

/** The one comment a reader must delete to take ownership of the file. */
export function draftBanner(date) {
  return `<!-- DRAFT: generated from structure on ${date}. Facts below are measured; ` +
    'the WHY is missing and only you can write it. Delete this comment when you adopt it. -->';
}

/** The empty section, and the one line that says why it is empty. */
export const WHY_PROMPT = 'unwritten — the structure above cannot answer this.';

function table(headers, rows) {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out;
}

function code(s) { return '`' + String(s) + '`'; }

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/**
 * PURE. Render the draft record. Every line is a measured fact with its number
 * or an explicit "none found" — the renderer has no branch that writes prose
 * about intent, and there is no template sentence for it to fill in.
 */
export function renderDraft(facts, opts = {}) {
  const { area, date } = facts;
  const top = Number.isFinite(opts.top) && opts.top > 0 ? Math.floor(opts.top) : DEFAULT_TOP;
  const L = [];

  L.push('---');
  L.push(`title: ${area.slug} module`);
  L.push('status: draft');
  L.push('layer: architecture');
  L.push(`module: ${area.slug}`);
  L.push(`date: ${date}`);
  L.push(`globs: ${area.glob}`);
  L.push('---');
  L.push('');
  L.push(draftBanner(date));
  L.push('');
  L.push(`# ${area.slug} module`);
  L.push('');
  L.push(`Area: ${code(area.glob)} — ${plural(facts.files.count, 'file', 'files')}, ` +
    `${facts.files.codeLines} code line(s) measured across ${facts.files.measuredFiles} of them.`);

  if (facts.claims.length) {
    L.push('');
    for (const c of facts.claims) {
      L.push(`> Overlap: ${code(c.file)} (module ${code(c.module)}, globs ${code(c.globs.join(', '))}) ` +
        `already claims ${c.matched} of the ${facts.files.count} file(s) in this area.`);
    }
  }

  // --- what's in it --------------------------------------------------------
  L.push('');
  L.push("## What's in it");
  L.push('');
  if (!facts.files.count) {
    L.push(`No file in the scanned set matches ${code(area.glob)}.`);
  } else {
    L.push(`By extension: ${facts.files.byExt.map((e) => `${e.ext} ${e.count}`).join(', ')}.`);
    L.push('');
    const shown = facts.files.rows.slice(0, MAX_FILE_ROWS);
    L.push(...table(['FILE', 'EXT', 'LINES', 'CODE LINES'], shown.map((r) => [
      code(r.file), r.ext, r.lines == null ? '—' : String(r.lines), r.code == null ? '—' : String(r.code)
    ])));
    if (facts.files.rows.length > shown.length) {
      L.push('');
      L.push(`… and ${facts.files.rows.length - shown.length} more file(s); the full list is in ` +
        code(`project-brain x draft module ${area.spec} --json`) + '.');
    }
    L.push('');
    L.push('`CODE LINES` counts non-blank lines outside comments and string bodies; ' +
      '`—` marks an extension with no line metric.');
  }
  if (facts.files.unreadable.length) {
    L.push('');
    L.push(`Unread: ${facts.files.unreadable.map((u) => `${code(u.file)} (${u.reason})`).join(', ')}.`);
  }

  // --- public surface ------------------------------------------------------
  L.push('');
  L.push('## What imports it');
  L.push('');
  if (facts.publicSurface.exposedFiles) {
    L.push(`${plural(facts.publicSurface.outsideImporters, 'file', 'files')} outside ${code(area.glob)} ` +
      `import ${plural(facts.publicSurface.exposedFiles, 'file', 'files')} inside it. ` +
      'Those files are the area\'s measured surface:');
    L.push('');
    L.push(...table(['FILE INSIDE', 'IMPORTED BY (OUTSIDE)'], facts.publicSurface.rows.map((r) => [
      code(r.file), r.importers.map(code).join(', ')
    ])));
    if (facts.publicSurface.truncated) {
      L.push('');
      L.push(`… ${facts.publicSurface.exposedFiles - facts.publicSurface.rows.length} more imported file(s) not shown (--top ${top}).`);
    }
  } else {
    L.push(`No file outside ${code(area.glob)} statically imports a file inside it.`);
    // Fall back to the in-area ranking, but only where it says something: a
    // table of files with exactly one importer each is filler, not a fact.
    const shared = facts.inAreaFanIn.filter((r) => r.count > 1);
    L.push('');
    if (shared.length) {
      L.push('Files imported by more than one other file *inside* the area:');
      L.push('');
      L.push(...table(['FILE', 'IN-AREA IMPORTERS'], shared.map((r) => [code(r.file), String(r.count)])));
    } else {
      L.push('No file inside the area is imported by more than one other file inside it.');
    }
  }
  L.push('');
  L.push('An unimported file is not evidence of an unused file: entry points, HTML script tags, ' +
    'dynamic specifiers, autoloaders and build config are invisible to this scan.');

  // --- what it imports -----------------------------------------------------
  L.push('');
  L.push('## What it imports');
  L.push('');
  if (facts.dependsOn.length) {
    const shown = facts.dependsOn.slice(0, top);
    L.push(`Files inside the area import ${plural(facts.dependsOn.length, 'file', 'files')} outside it:`);
    L.push('');
    L.push(...table(['FILE OUTSIDE', 'IMPORTED BY (INSIDE)'], shown.map((r) => [code(r.file), String(r.count)])));
    if (facts.dependsOn.length > shown.length) {
      L.push('');
      L.push(`… ${facts.dependsOn.length - shown.length} more outside file(s) not shown (--top ${top}).`);
    }
  } else {
    L.push('No import from inside the area resolves to a file outside it.');
  }
  if (facts.external.length) {
    const shown = facts.external.slice(0, top);
    L.push('');
    L.push('Specifiers that resolve to nothing in this repo (packages, stdlib, or a scanner blind spot): ' +
      shown.map((e) => `${code(e.spec)} ×${e.count}`).join(', ') +
      (facts.external.length > shown.length ? `, and ${facts.external.length - shown.length} more.` : '.'));
  }

  // --- cycles --------------------------------------------------------------
  L.push('');
  L.push('## Import cycles inside the area');
  L.push('');
  if (facts.cycles.inside.length) {
    L.push(`${plural(facts.cycles.inside.length, 'cycle', 'cycles')} found (length ≤ ${facts.cycles.params.maxLen}):`);
    L.push('');
    for (const c of facts.cycles.inside) L.push(`- ${c.map(code).join(' → ')} → ${code(c[0])}`);
  } else {
    L.push(`None found within the scan caps (length ≤ ${facts.cycles.params.maxLen}, cap ${facts.cycles.params.maxCycles}).`);
  }

  // --- history -------------------------------------------------------------
  L.push('');
  L.push('## History facts');
  L.push('');
  const h = facts.history;
  if (!h.commitsScanned) {
    L.push('No commit history readable in this working tree — every number below would be invented, so none is written.');
  } else if (!h.areaCommits) {
    L.push(`None of the ${h.commitsScanned} commit(s) in the scanned window touches ${code(area.glob)}.`);
  } else {
    const first = h.firstIso ? h.firstIso.slice(0, 10) : '';
    const latest = h.lastIso ? h.lastIso.slice(0, 10) : '';
    const span = !first ? '' : first === latest ? `, all on ${first}` : `, between ${first} and ${latest}`;
    L.push(`${plural(h.areaCommits, 'commit', 'commits')} of the ${h.commitsScanned} scanned touch this area${span}.`);
    if (h.lastCommit) {
      L.push('');
      L.push(`Last change: ${h.lastCommit.dateIso.slice(0, 10)} — ${code(h.lastCommit.hash)} ` +
        `"${h.lastCommit.subject}" (${h.lastCommit.author}).`);
    }
    if (h.authors.length) {
      L.push('');
      L.push(`Authors (bus factor ${h.busFactor} — smallest set of authors covering ≥ 50% of these commits):`);
      L.push('');
      L.push(...table(['AUTHOR', 'COMMITS', 'SHARE'], h.authors.map((a) => [a.author, String(a.commits), `${a.sharePct}%`])));
    }
    if (h.hotspots.length) {
      L.push('');
      L.push('Hotspots (churn weighted by recency, 90-day half-life):');
      L.push('');
      L.push(...table(['FILE', 'SCORE', 'COMMITS', 'LAST COMMIT'], h.hotspots.map((f) => [
        code(f.file), f.score.toFixed(2), String(f.commits), f.lastCommit ? f.lastCommit.slice(0, 10) : '—'
      ])));
    }
  }

  // --- decisions -----------------------------------------------------------
  L.push('');
  L.push('## Related decisions');
  L.push('');
  if (facts.decisions.length) {
    for (const d of facts.decisions) {
      L.push(`- [[${d.name}]] — ${d.title} (matched on: ${d.matchedOn})`);
    }
  } else {
    L.push('No record in `.project-brain/decisions/` names this area, by `module:` frontmatter or by a path it cites.');
  }

  // --- the empty section ---------------------------------------------------
  L.push('');
  L.push('## Why it is this way');
  L.push('');
  L.push(WHY_PROMPT);

  L.push('');
  L.push('---');
  L.push('');
  L.push(`Draft from ${code(`project-brain x draft module ${area.spec}`)} on ${date}. ` +
    `Repo scan: ${facts.scan.sourceFilesScanned} source file(s), ${facts.scan.resolvedEdges} resolved import edge(s), ` +
    `${facts.scan.unresolvedSpecs} specifier(s) unresolved. Import edges come from a regex/line scanner, not a parser.`);
  L.push('');
  return L.join('\n');
}

/**
 * PURE. What `--out --force` would destroy, in diff-shaped terms. Never a
 * character of the old file's prose is carried into the draft, so the summary
 * counts what is lost instead of pretending to merge it.
 */
export function replacementSummary(existingText, relPath) {
  const { data, body } = parseDoc(relPath, String(existingText || ''));
  const headings = body.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim());
  const words = body.split(/\s+/).filter(Boolean).length;
  return [
    `Would replace ${relPath}:`,
    `  ${String(existingText || '').split('\n').length} line(s) · status: ${data.status || '(none)'} · ` +
      `module: ${data.module || '(none)'} · date: ${data.date || '(none)'}`,
    `  ${headings.length} heading(s): ${headings.join(' · ') || '(none)'}`,
    `  ${words} word(s) of authored text. The draft does NOT contain any of it, and this is not reversible from here.`
  ].join('\n');
}

// ---------------------------------------------------------------------------
// I/O (the only impure part)
// ---------------------------------------------------------------------------

/** Tracked + untracked-but-not-ignored files. null outside a git work tree. */
function gitFiles(root) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.error || top.status !== 0) return null;
  if (path.resolve(top.stdout.trim()) !== path.resolve(root)) return null;
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter(Boolean);
}

/** Bounded recursive walk — the fallback for non-git roots (tarballs, fixtures). */
function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_WALK_ENTRIES) {
    const rel = stack.pop();
    let dirents = [];
    try { dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (IGNORE_DIR_RE.test(`/${child}`)) continue;
      if (d.isDirectory()) stack.push(child);
      else if (d.isFile()) out.push(child);
    }
  }
  return out;
}

function discoverFiles(root) {
  const listed = gitFiles(root) ?? walkFiles(root);
  return [...new Set(listed.map((f) => f.replace(/^\.\//, '')))]
    .filter((f) => !IGNORE_DIR_RE.test(f))
    .sort(byString);
}

function runGitLog(root, limit) {
  const r = spawnSync('git', gitLogArgs({ limit }), {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return '';
  return r.stdout || '';
}

/** Read the brain's own records. A missing directory is "none", never an error. */
function loadRecords(root, kind) {
  const dir = path.join(root, '.project-brain', kind);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('_')); } catch { return []; }
  const out = [];
  for (const name of names.sort(byString)) {
    const rel = path.posix.join('.project-brain', kind, name);
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const { data, body } = parseDoc(rel, text);
    const explicit = String(data.globs ?? data.fileGlobs ?? data.files ?? '').trim();
    out.push({
      file: rel,
      name: name.replace(/\.md$/, ''),
      title: String(data.title || name.replace(/\.md$/, '')),
      module: String(data.module || '').trim(),
      status: String(data.status || '').trim(),
      // Same comma-separated form brain-serve's moduleGlobs() reads.
      globs: explicit ? [...new Set(explicit.split(',').map((g) => g.trim().replace(/^\.\//, '')).filter(Boolean))] : [],
      paths: citedPaths(body)
    });
  }
  return out;
}

function fail(message) {
  process.stderr.write(`[brain:draft] ${message}\n`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const json = takeFlag(args, '--json');
  const wantOut = takeFlag(args, '--out');
  const force = takeFlag(args, '--force');
  const nowRaw = takeOption(args, '--now');
  const topRaw = takeOption(args, '--top');
  const commitsRaw = takeOption(args, '--commits');

  const kind = (args.shift() || '').trim();
  if (!kind) fail(`missing draft kind.\n${usage()}`);
  if (kind !== 'module') fail(`unknown draft kind "${kind}". Only \`module\` exists today.`);
  const spec = (args.shift() || '').trim();
  if (!spec) fail(`draft module needs a path or glob.\n${usage()}`);

  const nowMs = nowRaw ? Date.parse(nowRaw) : Date.now();
  if (!Number.isFinite(nowMs)) fail(`--now must be an ISO date, got: ${nowRaw}`);
  const top = topRaw ? Number(topRaw) : DEFAULT_TOP;
  if (!Number.isFinite(top) || top <= 0) fail(`--top must be a positive integer, got: ${topRaw}`);
  const commitWindow = commitsRaw ? Number(commitsRaw) : DEFAULT_COMMITS;
  if (!Number.isFinite(commitWindow) || commitWindow <= 0) fail(`--commits must be a positive integer, got: ${commitsRaw}`);

  const root = ROOT;
  const isDirectory = (rel) => {
    try { return fs.statSync(path.join(root, rel)).isDirectory(); } catch { return false; }
  };
  const area = parseAreaSpec(spec, isDirectory);
  if (!area) fail(`"${spec}" is not a repo-relative path or glob.`);

  const files = discoverFiles(root);
  const inArea = areaMatcher(area.glob);
  const areaFiles = files.filter(inArea);
  if (!areaFiles.length) {
    fail(`no file matches ${area.glob}. Check the path, or pass an explicit glob:\n` +
      `  project-brain x draft module "${area.spec}/**"`);
  }

  // Read once: area files (for the file table + shape metrics) and every source
  // file (for the graph, which must see importers OUTSIDE the area).
  const texts = new Map();
  const unreadable = [];
  const sourceFiles = files.filter((f) => SOURCE_EXT_RE.test(f));
  for (const file of [...new Set([...areaFiles, ...sourceFiles])].sort(byString)) {
    const abs = path.join(root, file);
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_SOURCE_BYTES) {
        if (inArea(file)) unreadable.push({ file, reason: `larger than ${MAX_SOURCE_BYTES} bytes` });
        continue;
      }
      texts.set(file, fs.readFileSync(abs, 'utf8'));
    } catch (error) {
      if (inArea(file)) unreadable.push({ file, reason: String((error && error.code) || 'unreadable') });
    }
  }

  const graph = buildImportGraph({
    files: sourceFiles,
    readFile: (f) => {
      const text = texts.get(f);
      if (typeof text !== 'string') throw new Error('unread');
      return text;
    }
  });
  const commits = parseLog(runGitLog(root, commitWindow));

  const facts = gatherFacts({
    area,
    files,
    texts,
    graph,
    commits,
    now: nowMs,
    top,
    unreadable,
    moduleRecords: loadRecords(root, 'modules'),
    decisions: loadRecords(root, 'decisions')
  });
  const markdown = renderDraft(facts, { top });

  if (json) {
    process.stdout.write(JSON.stringify({ ...facts, markdown }, null, 2) + '\n');
    return;
  }

  if (!wantOut) {
    process.stdout.write(markdown);
    process.stderr.write(
      `[brain:draft] ${facts.files.count} file(s), ${facts.files.codeLines} code line(s); ` +
      `${facts.publicSurface.exposedFiles} file(s) imported from outside; ` +
      `${facts.history.areaCommits} commit(s) in the window; ${facts.decisions.length} related decision(s).\n` +
      `[brain:draft] → this draft asserts no intent. Write \`## Why it is this way\`, then commit it as ` +
      `.project-brain/modules/${area.slug}.md (or re-run with --out).\n`
    );
    return;
  }

  const dest = path.join(BRAIN_DIR, 'modules', `${area.slug}.md`);
  const rel = path.relative(root, dest).split(path.sep).join('/');
  if (exists(dest)) {
    const summary = replacementSummary(read(dest), rel);
    if (!force) {
      process.stderr.write(`${summary}\n`);
      fail(`refusing to overwrite an authored record. Re-run with --force to replace it, ` +
        `or review the draft first:\n  project-brain x draft module ${area.spec} > /tmp/${area.slug}.md`);
    }
    process.stdout.write(`${summary}\n`);
  }
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, markdown, 'utf8');
  process.stdout.write(`Wrote ${rel} (status: draft).\n`);
  process.stdout.write(
    `→ It is yours now: write \`## Why it is this way\`, delete the DRAFT comment, flip ` +
    `\`status: draft\` to \`canonical\`, and commit. Nothing regenerates it behind you.\n`
  );
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit (mirrors brain-graph-scan.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error.message || error);
  }
}
