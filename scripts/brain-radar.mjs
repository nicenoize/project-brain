/**
 * brain:radar — proactive pre-touch / PR briefing (read-only, deterministic).
 *
 * brain:brief answers "what should I know before I touch my *changed* files"
 * as a flat advisory stream. brain:radar is the file-centric companion: given
 * an explicit target set (--for / positional files / --staged), it emits a
 * per-file report so you can sweep one file or a whole PR and see, for each,
 * exactly what the brain already knows.
 *
 * For each target file it reports, all from EXISTING index/brain state:
 *   1. Active leases on that file/glob          (active_state.md via active-state.mjs)
 *   2. Governing ADRs                           (records type 'decision' matching the file's module)
 *   3. Downstream cross-project consumers       (cross-project-edge records whose edgeTo owns the file's project)
 *   4. Open findings citing the file            (loadFindings; status open/planned; sources path match)
 *   5. Optional one-line blast-radius           (buildImpact for symbols the file defines — opt-in, fast-skippable)
 *
 * Deterministic and index-only: NO LLM, NO new embeddings on a hot path (it
 * only reads the already-built index via store.getAll()). Read-only: never
 * mutates state. Plain run always exits 0 (advisory).
 *
 * The core is a PURE exported function `radarFor(file, records, {findings,
 * leases})` so it is unit-testable with fixture records — no real index,
 * embedder, or model required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { ROOT, takeFlag, takeOption } from './common.mjs';

const SEV = { conflict: '🚨', mine: '⚠', adr: '📐', edge: '↯', finding: '🔎', impact: '💥' };

// ---------------------------------------------------------------------------
// Pure core (unit-testable without git / store / disk).
// ---------------------------------------------------------------------------

/**
 * Build the radar report for ONE target file from already-loaded brain state.
 * Pure: no I/O. Everything is passed in.
 *
 * @param {string} file                              target file (repo-relative)
 * @param {Array<object>} records                    indexed records (store.getAll() shape)
 * @param {object} [ctx]
 * @param {Array<{slug,title,status,category,sources,impact}>} [ctx.findings]
 * @param {Array<{target,lockedBy,until,notes,project}>}       [ctx.leases]
 * @param {string} [ctx.actor]                        current actor (own leases → ⚠ not 🚨)
 * @param {(file:string)=>(string|null)} [ctx.projectForFile]  resolve a file's project (fleet)
 * @param {(file:string)=>object|null}   [ctx.blastFor]        optional precomputed blast-radius
 * @returns {{file,module,project,leases,adrs,downstream,findings,blast,counts,hasConflict}}
 */
export function radarFor(file, records = [], ctx = {}) {
  const target = normFile(file);
  const module = moduleOf(target, records);
  const project = (ctx.projectForFile ? ctx.projectForFile(target) : projectOf(target, records)) || '';
  const actor = (ctx.actor || '').trim();

  // 1. Leases on the file or its module.
  const leaseHits = [];
  let hasConflict = false;
  for (const lease of ctx.leases || []) {
    if (!leaseTargetMatches(lease.target, target, module)) continue;
    const owner = (lease.lockedBy || '').trim() || 'unowned';
    const mine = actor && owner === actor;
    if (!mine) hasConflict = true;
    leaseHits.push({
      target: lease.target || '',
      lockedBy: owner,
      until: lease.until || '',
      notes: lease.notes || '',
      project: lease.project || '',
      mine: Boolean(mine),
      severity: mine ? 'mine' : 'conflict'
    });
  }

  // 2. Governing ADRs: decision records whose module matches the file's module.
  //    Exact module match is the strong signal. ADRs in practice often use a
  //    curated short module name (e.g. `retrieval`) while a file infers the
  //    path-y `scripts/retrieval` (or just `scripts`), so we also accept a
  //    match on the module's / file's last meaningful segment. Both sides are
  //    deterministic, index-only fields — no fuzzy text search.
  const moduleAliases = new Set([module, lastSegment(module), fileStem(target)].filter(Boolean));
  const adrs = [];
  const seenAdr = new Set();
  for (const record of records) {
    if (record.type !== 'decision') continue;
    if (!record.module || !moduleAliases.has(record.module)) continue;
    const id = record.decision || record.file || '';
    if (seenAdr.has(id)) continue;
    seenAdr.add(id);
    adrs.push({
      decision: record.decision || '',
      file: record.file || '',
      module: record.module || '',
      title: record.heading || record.title || ''
    });
  }

  // 3. Downstream cross-project consumers: edges whose edgeTo owns this file's
  //    project. edgeTo === us means edgeFrom depends on us → changing us may
  //    break edgeFrom (mirrors brain:impact's "inbound" direction).
  const downstream = [];
  if (project) {
    const seenEdge = new Set();
    for (const record of records) {
      if (record.type !== 'cross-project-edge') continue;
      if (record.edgeTo !== project) continue;
      const consumer = record.edgeFrom || '';
      if (!consumer) continue;
      const key = `${consumer}|${record.edgeKind}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      downstream.push({
        consumer,
        kind: record.edgeKind || '',
        confidence: record.edgeConfidence || ''
      });
    }
  }

  // 4. Open findings citing the file (status open/planned; match by source path).
  const findingHits = [];
  for (const finding of ctx.findings || []) {
    const status = (finding.status || 'open').trim();
    if (status !== 'open' && status !== 'planned') continue;
    const sources = (finding.sources || []).map(s => normFile(s && s.path)).filter(Boolean);
    if (!sources.includes(target)) continue;
    findingHits.push({
      slug: finding.slug || '',
      title: finding.title || '',
      status,
      category: finding.category || '',
      impact: Number(finding.impact) || 0
    });
  }
  findingHits.sort((a, b) => b.impact - a.impact);

  // 5. Optional blast-radius (callers/tests counts) for symbols this file
  //    defines. Precomputed by the caller (buildImpact is async + needs a
  //    store) and threaded back in; pure core just normalizes the shape.
  const blast = ctx.blastFor ? (ctx.blastFor(target) || null) : null;

  return {
    file: target,
    module,
    project,
    leases: leaseHits,
    adrs,
    downstream,
    findings: findingHits,
    blast,
    counts: {
      leases: leaseHits.length,
      adrs: adrs.length,
      downstream: downstream.length,
      findings: findingHits.length
    },
    hasConflict
  };
}

/** Symbols a file defines, from its code records (drives optional blast-radius). */
export function symbolsDefinedIn(file, records = []) {
  const target = normFile(file);
  const out = new Set();
  for (const record of records) {
    if (record.type !== 'code' || record.isSummary) continue;
    if (normFile(record.file) !== target) continue;
    for (const s of record.exportedSymbols || []) if (s) out.add(s);
    for (const s of record.symbols || []) if (s) out.add(s);
  }
  return [...out];
}

/** Scan a set of files → one radar report each. Pure given its inputs. */
export function radarScan(files = [], records = [], ctx = {}) {
  const targets = unique((files || []).map(normFile).filter(Boolean));
  const reports = targets.map(f => radarFor(f, records, ctx));
  return {
    reports,
    summary: {
      files: reports.length,
      conflicts: reports.filter(r => r.hasConflict).length,
      withAdvisories: reports.filter(r => hasAnything(r)).length
    }
  };
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

function hasAnything(report) {
  return report.counts.leases || report.counts.adrs || report.counts.downstream || report.counts.findings;
}

/** Inferred module for a file: prefer an indexed record's module, else path heuristic. */
function moduleOf(file, records) {
  for (const record of records) {
    if (normFile(record.file) === file && record.module) return record.module;
  }
  return inferModuleFromPath(file);
}

/** Same shape as store.mjs/infer.mjs inferModule, kept local (no command import). */
function inferModuleFromPath(file) {
  if (!file) return '';
  if (file.includes('/modules/')) return path.basename(file, path.extname(file));
  const parts = file.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) {
    return parts.slice(0, 2).join('/');
  }
  return path.dirname(file) === '.' ? '' : path.dirname(file);
}

/** The file's project, read off any indexed record for that exact file. */
function projectOf(file, records) {
  for (const record of records) {
    if (normFile(record.file) === file && record.project) return record.project;
  }
  return '';
}

/** Does a lease target (file/glob, comma/space list tolerated) hit the file or its module? */
function leaseTargetMatches(target, file, module) {
  if (!target) return false;
  const parts = String(target).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (matchesPath(part, file)) return true;
    if (module && matchesPath(part, module)) return true;
  }
  return false;
}

/** Exact, directory-prefix, or `*`-glob match. */
function matchesPath(target, candidate) {
  const t = normFile(target);
  const c = normFile(candidate);
  if (!t || !c) return false;
  if (t === c) return true;
  const dirT = t.replace(/\/$/, '');
  if (c === dirT || c.startsWith(`${dirT}/`)) return true;
  if (t.includes('*')) {
    const re = new RegExp('^' + t.split('*').map(escapeRe).join('.*') + '$');
    if (re.test(c)) return true;
    if (re.test(path.basename(c))) return true;
  }
  return false;
}

/** Last `/`-segment of a module id (e.g. "scripts/retrieval" → "retrieval"). */
function lastSegment(m) { return String(m || '').split('/').filter(Boolean).pop() || ''; }
/** File stem without extension (e.g. "scripts/retrieval.mjs" → "retrieval"). */
function fileStem(file) { return path.basename(String(file || ''), path.extname(String(file || ''))); }

function normFile(f) { return String(f || '').trim().replace(/^\.\//, '').replace(/\\/g, '/'); }
function unique(a) { return [...new Set(a)]; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// I/O loaders (CLI only; fail soft → empty).
// ---------------------------------------------------------------------------

/** Git-staged files (added/copied/modified/renamed) via diff --cached; soft → []. */
function gitStagedFiles(root = ROOT) {
  try {
    return execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** Working-tree changed files (default target when nothing else is given). */
function gitChangedFiles(root = ROOT) {
  try {
    return execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map(line => line.slice(3).trim())
      .filter(Boolean)
      .map(p => (p.includes(' -> ') ? p.split(' -> ').pop() : p));
  } catch { return []; }
}

/** Leases from active_state.md via the canonical helper; soft → []. */
async function loadLeases() {
  try {
    const { activeStateJson } = await import('./active-state.mjs');
    return activeStateJson().leases || [];
  } catch { return []; }
}

/** Findings via the act-axis loader; soft → []. */
async function loadFindingsSafe() {
  try {
    const { loadFindings } = await import('./findings.mjs');
    return loadFindings() || [];
  } catch { return []; }
}

/** Discovered fleet projects for project-aware file→project resolution; soft → null. */
async function loadProjectResolver() {
  try {
    const { discoverProjects, findProjectForFile } = await import('./projects.mjs');
    const projects = discoverProjects(ROOT);
    if (!projects?.length) return null;
    return (file) => {
      const hit = findProjectForFile(file, projects);
      return hit ? hit.name : null;
    };
  } catch { return null; }
}

/**
 * Open the index once and return its records (+ a live store/embedder so the
 * caller can run buildImpact against the same store). Soft → null on any
 * failure (no index yet, model download blocked, etc.).
 */
async function openIndex() {
  try {
    const { openEmbedder } = await import('./embed.mjs');
    const { openStore } = await import('./store.mjs');
    const embedder = openEmbedder();
    const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
    const records = await store.getAll();
    return { embedder, store, records };
  } catch {
    return null;
  }
}

/**
 * Build a precomputed `blastFor(file)` over the open index by running
 * buildImpact for the file's defined symbols. Returns a one-line summary
 * {symbols, callers, tests}. Capped + soft so it can never hang the radar.
 */
async function buildBlastMap(files, index, opts = {}) {
  if (!index) return new Map();
  const map = new Map();
  const maxSymbols = Number(opts.maxSymbols || process.env.BRAIN_RADAR_MAX_SYMBOLS || 6);
  let buildImpact;
  let listIndexableFiles;
  try {
    ({ buildImpact } = await import('./brain-impact.mjs'));
    ({ listIndexableFiles } = await import('./common.mjs'));
  } catch { return map; }
  let indexable = [];
  try { indexable = await listIndexableFiles(); } catch { /* soft */ }
  for (const file of files) {
    const symbols = symbolsDefinedIn(file, index.records).slice(0, maxSymbols);
    if (!symbols.length) continue;
    const callers = new Set();
    const tests = new Set();
    for (const symbol of symbols) {
      try {
        const impact = await buildImpact(symbol, index.records, index.store, index.embedder, {
          root: ROOT, indexable, crossProject: false
        });
        for (const c of impact.callers || []) callers.add(c.file);
        for (const t of impact.tests || []) tests.add(t.file);
      } catch { /* skip this symbol */ }
    }
    map.set(file, { symbols, callers: callers.size, tests: tests.size });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function renderText(scan) {
  const lines = [];
  lines.push(`# Radar — ${scan.summary.files} file(s)`);
  if (!scan.reports.length) {
    lines.push('');
    lines.push('No target files. Pass --for <file>, positional files, or --staged.');
    return lines.join('\n');
  }
  lines.push('');
  for (const report of scan.reports) {
    lines.push(`## ${report.file}`);
    const meta = [report.module && `module: ${report.module}`, report.project && `project: ${report.project}`]
      .filter(Boolean).join(' · ');
    if (meta) lines.push(`_${meta}_`);

    if (!hasAnything(report) && !report.blast) {
      lines.push('✅ Nothing on radar — no leases, ADRs, downstream consumers, or open findings.');
      lines.push('');
      continue;
    }

    for (const lease of report.leases) {
      const glyph = lease.mine ? SEV.mine : SEV.conflict;
      const who = lease.mine ? `${lease.lockedBy} — that's you` : lease.lockedBy;
      lines.push(`- ${glyph} lease held by ${who}` +
        (lease.until ? ` until ${lease.until}` : '') +
        (lease.target && normFile(lease.target) !== report.file ? ` (on ${lease.target})` : ''));
    }
    for (const adr of report.adrs) {
      lines.push(`- ${SEV.adr} ADR ${adr.decision || adr.file}${adr.title ? `: ${adr.title}` : ''}`);
    }
    for (const edge of report.downstream) {
      lines.push(`- ${SEV.edge} changing this may break ${edge.consumer} via ${edge.kind}` +
        (edge.confidence ? ` (${edge.confidence})` : ''));
    }
    for (const finding of report.findings) {
      lines.push(`- ${SEV.finding} open finding ${finding.slug}${finding.title ? `: ${finding.title}` : ''}` +
        ` [${finding.category || 'finding'}, impact ${finding.impact}, ${finding.status}]`);
    }
    if (report.blast && report.blast.symbols?.length) {
      lines.push(`- ${SEV.impact} blast radius: ${report.blast.callers} caller file(s), ` +
        `${report.blast.tests} test file(s) across ${report.blast.symbols.length} symbol(s)`);
    }
    lines.push('');
  }
  if (scan.summary.conflicts) {
    lines.push(`🚨 ${scan.summary.conflicts} file(s) with a lease held by someone else.`);
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint (skipped when imported for unit tests).
// ---------------------------------------------------------------------------

function helpText() {
  return [
    'Usage: npm run brain:radar -- [--for <file>] [files...] [--staged] [--no-impact] [--json]',
    '',
    'Proactive pre-touch / PR briefing. For each target file, surfaces what the',
    'brain already knows: active leases, governing ADRs, downstream cross-project',
    'consumers, open findings citing it, and an optional one-line blast radius.',
    '',
    'Targets (first match wins):',
    '  --for <file>     a single file (repeatable: --for a --for b)',
    '  <files...>       positional files',
    '  --staged         git-staged files',
    '  (default)        working-tree changed files',
    '',
    'Flags:',
    '  --no-impact      skip the blast-radius pass (faster; index still read)',
    '  --json           machine-readable output',
    '  --help, -h       this help'
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  const json = takeFlag(args, '--json');
  const staged = takeFlag(args, '--staged');
  const noImpact = takeFlag(args, '--no-impact');

  // --for is repeatable; drain every occurrence.
  const forFiles = [];
  let f;
  while ((f = takeOption(args, '--for'))) forFiles.push(f);

  // Remaining non-flag args are positional files.
  const positional = args.filter(a => !a.startsWith('-'));

  let files = unique([...forFiles, ...positional].flatMap(splitList));
  if (!files.length && staged) files = gitStagedFiles();
  if (!files.length) files = gitChangedFiles();
  files = unique(files.map(s => normFile(s)).filter(Boolean));

  const actor = process.env.BRAIN_ACTOR || '';
  const [leases, findings, projectForFile] = await Promise.all([
    loadLeases(),
    loadFindingsSafe(),
    loadProjectResolver()
  ]);

  const index = files.length ? await openIndex() : null;
  const records = index?.records || [];

  let blastMap = new Map();
  if (index && !noImpact && files.length) {
    blastMap = await buildBlastMap(files, index);
  }
  const blastFor = (file) => blastMap.get(normFile(file)) || null;

  const scan = radarScan(files, records, {
    findings, leases, actor,
    projectForFile: projectForFile || undefined,
    blastFor
  });

  if (index?.store) { try { await index.store.close?.(); } catch { /* soft */ } }

  if (json) process.stdout.write(JSON.stringify(scan, null, 2) + '\n');
  else process.stdout.write(renderText(scan) + '\n');

  return 0;
}

function splitList(s) { return String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean); }

// MANDATORY isMain guard: importing this module (e.g. from tests) must NOT run
// the CLI, open the store, or call process.exit. A past bug had scripts firing
// their CLI on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[brain:radar] ${err.message || err}\n`);
    process.exit(1);
  });
}
