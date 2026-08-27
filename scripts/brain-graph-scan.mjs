/**
 * brain-graph-scan — thin CLI over the multi-language import graph
 * (scripts/import-graph.mjs). Invoked as `project-brain x graph-scan`; this
 * file deliberately does NOT touch bin/cli.mjs (the `x` escape hatch resolves
 * `graph-scan` → `brain-graph-scan.mjs` on its own).
 *
 *   brain-graph-scan.mjs [--json] [--cycles] [--orphans]
 *                        [--file <path> --dependents [--depth N]]
 *                        [--top N] [--external N] [--max-len N] [--max-cycles N]
 *
 * All heavy lifting is pure and lives in import-graph.mjs; this file only does
 * I/O (file discovery + reads) and formatting. The scanner is a regex/line
 * scanner, NOT a parser — every run therefore prints its real coverage
 * ("scanned N files, resolved E edges, U specifiers unresolved") plus the
 * limitation note, so nobody mistakes the graph for compiler truth. Human
 * output always ends with a concrete next action (Praktiken-Katalog: "kein
 * Score ohne Aktion").
 *
 * Discovery = common.mjs's listIndexableFiles() (respects the project's
 * ignores) WIDENED to every source extension the graph understands. Widening is
 * the whole point of this command: the indexer's globs are markdown/TS-shaped
 * (they list `tests/**` only for .ts/.js, and .py/.go only behind
 * BRAIN_POLYGLOT_SYMBOLS), while the graph exists precisely for the files the
 * TS path cannot see. The widening pass prefers `git ls-files` — instant, and
 * it honours .gitignore, so a 780MB node_modules is never walked — and falls
 * back to a bounded fast-glob outside git repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, listIndexableFiles, takeFlag, takeOption } from './common.mjs';
import {
  buildImportGraph,
  dependents,
  cycles,
  fanIn,
  fanOut,
  orphans,
  defaultEntryPoints,
  SCAN_NOTE
} from './import-graph.mjs';

const DEFAULT_TOP = 5;
const DEFAULT_EXTERNAL = 10;
const DEFAULT_MAX_LEN = 8;
const DEFAULT_MAX_CYCLES = 25;

/** Every source extension import-graph.mjs can scan. */
const SOURCE_GLOB = '**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,go,rb,php,rs}';

/**
 * Manifests the resolver reads to place imports, alongside the source files.
 * Not source, never scanned, never a node — but without go.mod, Go's absolute
 * intra-module import paths (`acme/operator/factory`) have nothing to resolve
 * against, and a package-structured Go repo yields zero internal edges. Found
 * on a real operator whose go.mod sits in src/, which is exactly why this is a
 * path pattern and not a fixed root-level probe like tsconfig's.
 */
const MANIFEST_RE = /(?:^|\/)go\.mod$/;
const MANIFEST_GLOB = '**/go.mod';
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/i;

/**
 * Directories never scanned. Mirrors common.mjs's ignore set (duplicated on
 * purpose: this command must not mutate shared discovery) and is applied to the
 * git listing too, since a repo may legitimately track a vendor/ tree.
 */
const IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees|\.claude|\.cursor|\.vscode|\.idea|\.impeccable|\.obsidian)(\/|$)/;

/** Both forms per directory: fast-glob prunes reliably only when it can match the dir itself. */
const IGNORE_GLOBS = [
  // Vendored tool directories are somebody else's source: scanning them puts
  // a plugin's scripts into the user's orphan list (found on club-ops, whose
  // .claude/skills/** showed up as dead-code candidates).
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.claude', '.cursor', '.vscode', '.idea', '.impeccable', '.obsidian',
  '.gocache', '__pycache__', '.venv', '.tox', 'target', '.worktrees'
].flatMap((d) => [`**/${d}`, `**/${d}/**`]).concat('**/.project-brain/vector-db/**');

function usage() {
  return [
    'Usage: brain-graph-scan.mjs [flags]',
    '',
    'Deterministic multi-language import/reference graph (JS/TS, Python, Go, Ruby, PHP, Rust).',
    'Regex/line scanner, NOT a parser — coverage numbers are printed, never hidden.',
    '',
    'Flags:',
    '  --json               Parseable JSON on stdout, nothing else.',
    '  --cycles             Report bounded import cycles.',
    '  --orphans            Report dead-code CANDIDATES (nothing imports them).',
    '  --file <path>        Focus a file (repo-relative).',
    '  --dependents         With --file: reverse reachability = blast radius.',
    '  --depth N            With --dependents: max hops (default: unbounded).',
    `  --top N              Rows in the fan-in/fan-out tables (default ${DEFAULT_TOP}).`,
    `  --external N         Unresolved specifiers to list (default ${DEFAULT_EXTERNAL}).`,
    `  --max-len N          Longest cycle to enumerate (default ${DEFAULT_MAX_LEN}).`,
    `  --max-cycles N       Cycle cap (default ${DEFAULT_MAX_CYCLES}).`
  ].join('\n');
}

function out(text) { process.stdout.write(text + '\n'); }
function printJson(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  out(line(headers));
  for (const r of rows) out(line(r));
}

function positive(raw, fallback, name) {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`[brain:graph-scan] ${name} must be a positive integer, got: ${raw}\n`);
    process.exit(1);
  }
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// discovery + I/O (the only impure part)
// ---------------------------------------------------------------------------

async function discoverFiles(root) {
  const indexable = await listIndexableFiles({ root });
  const widened = gitSourceFiles(root) ?? (await globSourceFiles(root));
  return [...new Set([...indexable, ...widened])]
    .filter((f) => !IGNORE_DIR_RE.test(f))
    .sort();
}

/**
 * Tracked + untracked-but-not-ignored source files, straight from git. Returns
 * null when `root` is not itself a git work tree (temp fixtures, tarball
 * installs) so the caller can fall back.
 */
function gitSourceFiles(root) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.error || top.status !== 0) return null;
  if (path.resolve(top.stdout.trim()) !== path.resolve(root)) return null;
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter((f) => f && (SOURCE_EXT_RE.test(f) || MANIFEST_RE.test(f)));
}

/** Fallback for non-git roots. Bounded ignores keep it from walking node_modules. */
async function globSourceFiles(root) {
  try {
    const { default: fg } = await import('fast-glob');
    return await fg([SOURCE_GLOB, MANIFEST_GLOB], {
      cwd: root, dot: false, onlyFiles: true, followSymbolicLinks: false, ignore: IGNORE_GLOBS
    });
  } catch {
    return []; // fast-glob unavailable → indexer globs only; coverage stays honest.
  }
}

function makeReadFile(root) {
  return (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
}

function readPackageJson(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function coverageHeadline(graph) {
  const c = graph.coverage;
  return `scanned ${c.filesScanned} files, resolved ${c.resolvedEdges} edges, ` +
    `${c.unresolvedSpecs} specifier(s) unresolved (external/stdlib)`;
}

function provenanceLine(graph) {
  const c = graph.coverage;
  const resolved = c.totalSpecs - c.unresolvedSpecs;
  const ratio = c.totalSpecs ? resolved / c.totalSpecs : 0;
  return `— basis: ${graph.provenance.basis} · source: ${graph.provenance.source} · ` +
    `${resolved}/${c.totalSpecs} specifiers resolved (${(ratio * 100).toFixed(1)}%) → ` +
    `${c.resolvedEdges} unique edges`;
}

/** "Kein Score ohne Aktion": every run ends with a concrete next step. */
function nextActionFor(graph, views) {
  if (views.dependents) {
    const d = views.dependents;
    if (!d.dependents.length) {
      return `→ nothing statically imports ${d.file} — check it is not an entry point before assuming it is safe: ` +
        'project-brain x graph-scan --orphans';
    }
    return `→ ${d.dependents.length} file(s) transitively import ${d.file}; cross-check the history signal with: ` +
      `project-brain x intel risk --files ${d.file}`;
  }
  if (views.cycles && views.cycles.cycles.length) {
    const c = views.cycles.cycles[0];
    return `→ break the smallest cycle first (${c.join(' → ')} → ${c[0]}); inspect with: ` +
      `project-brain x graph-scan --file ${c[0]} --dependents`;
  }
  if (views.orphans && views.orphans.candidates.length) {
    return `→ ${views.orphans.candidates.length} unimported file(s) — verify each is not an entry point before deleting: ` +
      `project-brain x why ${views.orphans.candidates[0].file}`;
  }
  const top = fanIn(graph)[0];
  if (top && top.count) {
    return `→ ${top.file} is the most depended-upon file (${top.count} importers) — see its blast radius: ` +
      `project-brain x graph-scan --file ${top.file} --dependents`;
  }
  return '→ no resolved edges yet; widen discovery with BRAIN_INDEX_EXTRA_GLOBS, then re-run: ' +
    'project-brain x graph-scan';
}

function printHuman(graph, views, opts) {
  out(`Import graph — ${coverageHeadline(graph)}`);
  const langs = Object.entries(graph.coverage.byLang).map(([k, v]) => `${k} ${v}`).join(', ');
  out(`  by language: ${langs || '(none)'}` +
    (graph.coverage.skippedFiles ? ` · ${graph.coverage.skippedFiles} file(s) skipped (unreadable)` : ''));
  out('');

  if (views.dependents) {
    const d = views.dependents;
    out(`Blast radius — files that transitively import ${d.file}` +
      (d.maxDepth ? ` (max ${d.maxDepth} hop(s))` : ''));
    if (!d.dependents.length) out('  (none — no file in the scanned set statically imports it)');
    else table(d.dependents.map((e) => [e.depth, e.file]), ['HOPS', 'FILE']);
    out('');
  }

  const inbound = fanIn(graph).filter((e) => e.count).slice(0, opts.top);
  out(`Top fan-in (most depended-upon, top ${opts.top})`);
  if (!inbound.length) out('  (no resolved inbound edges)');
  else table(inbound.map((e, i) => [i + 1, e.count, e.file]), ['#', 'IMPORTED BY', 'FILE']);
  out('');

  const outbound = fanOut(graph).filter((e) => e.count).slice(0, opts.top);
  out(`Top fan-out (imports the most, top ${opts.top})`);
  if (!outbound.length) out('  (no resolved outbound edges)');
  else table(outbound.map((e, i) => [i + 1, e.count, e.file]), ['#', 'IMPORTS', 'FILE']);
  out('');

  if (views.cycles) {
    const c = views.cycles;
    out(`Import cycles (length ≤ ${c.params.maxLen}, cap ${c.params.maxCycles})` +
      (c.truncated ? ' — search hit a cap; longer/additional cycles may exist' : ''));
    if (!c.cycles.length) out('  (none found within the caps)');
    else for (const cycle of c.cycles) out(`  ${cycle.join(' → ')} → ${cycle[0]}`);
    out('');
  }

  if (views.orphans) {
    const o = views.orphans;
    out(`Orphan candidates (${o.candidates.length}) — nothing in the graph imports them`);
    if (!o.candidates.length) out('  (none)');
    else for (const c of o.candidates) out(`  ${c.file}  (${c.lang})`);
    out(`  ! ${o.caveat}`);
    out(`  entry points excluded: ${o.entryPoints.length} pattern(s)`);
    out('');
  }

  const ext = graph.external.slice(0, opts.external);
  out(`Unresolved specifiers (${graph.coverage.externalSpecs} distinct — external packages, stdlib, or scanner blind spots)`);
  if (!ext.length) out('  (none)');
  else table(ext.map((e) => [e.count, e.spec]), ['USES', 'SPECIFIER']);
  out('');

  out(provenanceLine(graph));
  out(`— NOTE: ${SCAN_NOTE}`);
  out(nextActionFor(graph, views));
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
  const wantCycles = takeFlag(args, '--cycles');
  const wantOrphans = takeFlag(args, '--orphans');
  const wantDependents = takeFlag(args, '--dependents');
  const file = takeOption(args, '--file').replace(/^\.\//, '');
  const top = positive(takeOption(args, '--top'), DEFAULT_TOP, '--top');
  const external = positive(takeOption(args, '--external'), DEFAULT_EXTERNAL, '--external');
  const maxLen = positive(takeOption(args, '--max-len'), DEFAULT_MAX_LEN, '--max-len');
  const maxCycles = positive(takeOption(args, '--max-cycles'), DEFAULT_MAX_CYCLES, '--max-cycles');
  const depthRaw = takeOption(args, '--depth');
  const depth = depthRaw ? positive(depthRaw, 0, '--depth') : undefined;

  if (wantDependents && !file) {
    process.stderr.write('[brain:graph-scan] --dependents needs --file <repo-relative path>.\n');
    process.exit(1);
  }

  const root = ROOT;
  const files = await discoverFiles(root);
  const graph = buildImportGraph({ files, readFile: makeReadFile(root) });

  const views = {};
  if (wantDependents) views.dependents = dependents(graph, file, depth ? { depth } : {});
  if (wantCycles) views.cycles = cycles(graph, { maxLen, maxCycles });
  if (wantOrphans) {
    views.orphans = orphans(graph, {
      entryPoints: defaultEntryPoints({ pkg: readPackageJson(root), files })
    });
  }

  if (json) {
    return printJson({
      ...graph,
      fanIn: fanIn(graph).slice(0, top),
      fanOut: fanOut(graph).slice(0, top),
      ...views,
      nextAction: nextActionFor(graph, views)
    });
  }
  printHuman(graph, views, { top, external });
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit (mirrors brain-intel.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:graph-scan] ${error.message || error}\n`);
    process.exit(1);
  });
}
