/**
 * serve/graph.mjs — the MEASURED half of the Control Room: the multi-language
 * import graph and the blast-radius blend built on top of it.
 *
 * Holds the per-HEAD import-graph cache (`importGraphFor`), the coverage
 * projection that reports what the scan actually saw, the reverse-import ⊕
 * co-change adjacency (`blastAdjacency`) and the pure ranking core
 * (`buildBlast`) that brain-mcp.mjs re-uses verbatim, so the MCP answer and
 * the Blast panel cannot drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { coChange } from '../git-intel.mjs';
import { buildImportGraph, SCAN_NOTE } from '../import-graph.mjs';
import { DEFAULT_COMMIT_WINDOW, gitHead } from './git.mjs';

// ---------------------------------------------------------------------------
// multi-language import graph — the MEASURED half of /api/blast, /api/risk and
// /api/graph, cached per HEAD.
//
// WHY IT REPLACED ts-graph: the compiler-backed path only ever produced edges
// for .ts/.tsx sources with the optional `typescript` dep installed. Every
// other repo — this .mjs one included — got graphAvailable:false and fell back
// to git history alone. import-graph.mjs resolves JS/TS/MJS/CJS/JSX, Python,
// Go, Ruby, PHP and Rust with a regex/line scanner, so the measured half now
// exists in the languages people actually ask about. It is NOT a parser and
// never claims to be: every edge carries a confidence (1.0 exact relative
// resolve / 0.8 extension-or-index inference / 0.6 alias-or-search) and every
// unresolved specifier is counted in `coverage.unresolvedSpecs` rather than
// dropped — which is why `coverage` is part of the response contract.
//
// Cost: one scan of the tracked source files (~1.2s cold on this repo), so it
// is memoized per HEAD exactly like intelCache/blastCache. Working-tree-only
// edits stay invisible until committed — acceptable staleness for a read-only
// dashboard, and the same trade the TS path made. Never throws: every failure
// becomes {graph:null, reason} and the endpoints degrade with an explanation.
// ---------------------------------------------------------------------------

/** Every source extension import-graph.mjs can scan (mirrors brain-graph-scan). */
const GRAPH_SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/i;
const GRAPH_SOURCE_GLOB = '**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,go,rb,php,rs}';

/** Directories never scanned — applied to the git listing too (a repo may track vendor/). */
const GRAPH_IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees)(\/|$)/;

/** Both forms per directory: fast-glob prunes reliably only when it can match the dir itself. */
const GRAPH_IGNORE_GLOBS = [
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.gocache', '__pycache__', '.venv', '.tox', 'target', '.worktrees'
].flatMap((d) => [`**/${d}`, `**/${d}/**`]).concat('**/.project-brain/vector-db/**');

/** A single file bigger than this is skipped (bundles/minified blobs, never sources). */
const GRAPH_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Tracked + untracked-but-not-ignored source files, straight from git — the
 * same discovery brain-graph-scan uses, and for the same reason: `git ls-files`
 * is instant and honours .gitignore, so a 780MB node_modules is never walked
 * (a naive glob walk stalled for 337s here once). Returns null when `root` is
 * not itself a git work tree, so the caller can fall back.
 */
function graphGitFiles(root) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.error || top.status !== 0) return null;
  if (path.resolve(top.stdout.trim()) !== path.resolve(root)) return null;
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter((f) => f && GRAPH_SOURCE_EXT_RE.test(f));
}

/** Fallback for non-git roots. Bounded ignores keep it from walking node_modules. */
async function graphGlobFiles(root) {
  try {
    const { default: fg } = await import('fast-glob');
    return await fg([GRAPH_SOURCE_GLOB], {
      cwd: root, dot: false, onlyFiles: true, followSymbolicLinks: false, ignore: GRAPH_IGNORE_GLOBS
    });
  } catch {
    return []; // fast-glob unavailable → no scan; coverage says so honestly.
  }
}

async function discoverGraphFiles(root) {
  const listed = graphGitFiles(root) ?? (await graphGlobFiles(root));
  return [...new Set(listed.map((f) => f.replace(/^\.\//, '')))]
    .filter((f) => !GRAPH_IGNORE_DIR_RE.test(f))
    .sort();
}

/** Injected reader for buildImportGraph: oversized/unreadable files → `skipped`. */
function graphReadFile(root) {
  return (rel) => {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    if (stat.size > GRAPH_MAX_FILE_BYTES) throw new Error(`too large (${stat.size} bytes)`);
    return fs.readFileSync(abs, 'utf8');
  };
}

const importGraphCache = { key: null, value: null, computes: 0 };

/** /api/graph caps — hard bounds, `truncated:true` is the honesty bit. */
export const GRAPH_MAX_CYCLES = 20;
export const GRAPH_MAX_CYCLE_LEN = 8;
export const GRAPH_MAX_LIST = 25;

/** Test hook: observe the import-graph cache without reaching into internals. */
export function graphStats() {
  return { key: importGraphCache.key, computes: importGraphCache.computes };
}

/**
 * Build (and cache per HEAD) the whole-repo import graph.
 * Never throws → {graph, files, reason}: `graph` is null when there is nothing
 * to scan or the scan failed, and `reason` always explains which it was.
 * BRAIN_IMPORT_GRAPH=0 (or the legacy BRAIN_TS_GRAPH=0) is the kill switch.
 */
export async function importGraphFor(root) {
  if (process.env.BRAIN_IMPORT_GRAPH === '0' || process.env.BRAIN_TS_GRAPH === '0') {
    return { graph: null, files: [], reason: 'static import graph disabled via BRAIN_IMPORT_GRAPH=0' };
  }
  const key = gitHead(root);
  if (importGraphCache.key === key && importGraphCache.value) return importGraphCache.value;
  let value;
  try {
    const files = await discoverGraphFiles(root);
    if (!files.length) {
      value = { graph: null, files: [], reason: 'no scannable source files found (js/ts/py/go/rb/php/rs) — import graph unavailable for this repo' };
    } else {
      const graph = buildImportGraph({ files, readFile: graphReadFile(root) });
      value = {
        graph,
        files,
        reason: graph.edges.length
          ? null
          : `no static import edge resolved among ${graph.coverage.filesScanned} scanned file(s) — ` +
            `${graph.coverage.unresolvedSpecs} specifier(s) pointed outside the repo (packages/stdlib)`
      };
    }
  } catch (error) {
    value = { graph: null, files: [], reason: `static import graph unavailable: ${error.message || error}` };
  }
  importGraphCache.key = key;
  importGraphCache.value = value;
  importGraphCache.computes += 1;
  return value;
}
/**
 * PURE. The scan's own numbers, response-shaped. These are the honest part of
 * the answer: how much was actually looked at, how much resolved, and in which
 * languages — never a bare boolean.
 */
export function graphCoverage(entry) {
  const c = (entry && entry.graph && entry.graph.coverage) || null;
  return {
    filesScanned: c ? c.filesScanned : 0,
    filesWithImports: c ? c.filesWithImports : 0,
    resolvedEdges: c ? c.resolvedEdges : 0,
    totalSpecs: c ? c.totalSpecs : 0,
    unresolvedSpecs: c ? c.unresolvedSpecs : 0,
    externalSpecs: c ? c.externalSpecs : 0,
    skippedFiles: c ? c.skippedFiles : 0,
    byLang: c ? c.byLang : {}
  };
}

/**
 * Direct dependents of the change set (one hop, measured) for /api/risk's
 * blast-radius factor. Null → the factor is omitted entirely rather than
 * scored as zero, which is what "we have no graph" honestly means.
 */
export async function blastRadiusFor(root, files) {
  try {
    const { graph } = await importGraphFor(root);
    if (!graph || !graph.edges.length) return null;
    const touched = new Set(files);
    const dependents = new Set();
    for (const e of graph.edges) {
      if (touched.has(e.to) && !touched.has(e.from)) dependents.add(e.from);
    }
    return { dependents: [...dependents].sort(), source: 'import-scan' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// blast radius — "what breaks if I change this?" (measured ⊕ inferred)
// ---------------------------------------------------------------------------

export const BLAST_DEFAULT_DEPTH = 2;
export const BLAST_MAX_DEPTH = 3;
export const BLAST_MAX_NODES = 60;
const BLAST_MAX_EDGES = 400;
// Fan-out cap per node and per edge kind: one file imported by 900 others must
// not turn a dashboard query into a 900-node dump (the cap is a cost bound,
// truncated:true is the honesty bit).
// Exported (with the two weights below) because brain-mcp.mjs renders the SAME
// blend and must not re-derive it — one ranking rule, one place.
export const BLAST_MAX_FANOUT = 25;
// Score decay per hop, and the discount applied to inferred (history) edges so
// a MEASURED import dependent always outranks an INFERRED co-change partner at
// equal depth and equal confidence.
export const BLAST_DEPTH_DECAY = 0.6;
export const BLAST_INFERRED_WEIGHT = 0.85;

/** Per-edge provenance contract the UI renders against (measured vs inferred). */
export const BLAST_PROVENANCE = Object.freeze({
  basis: 'mixed',
  source: 'import-scan static imports (measured) ⊕ git-log co-change (inferred)',
  edgeKinds: Object.freeze({
    imports: 'measured — statically resolved import/require/use (multi-language scan, not a compiler)',
    'co-change': 'inferred — files landed in the same commits, confidence = P(b|a)'
  }),
  note: SCAN_NOTE
});

// Adjacency (reverse import index + co-change partners) cached per HEAD like
// intelCache: it is identical for every ?files= query at the same commit, and
// rebuilding it per request would re-walk the whole TS program. `computes` is
// the exported test hook proving a second request reuses it.
const blastCache = { key: null, value: null, computes: 0 };

/** Test hook: observe the blast adjacency cache without touching internals. */
export function blastStats() {
  return { key: blastCache.key, computes: blastCache.computes };
}

/**
 * Build both adjacency maps once per HEAD:
 *   importers: file → [{file, confidence}] that statically import it (MEASURED)
 *   partners:  file → [{file, confidence}] co-change                 (INFERRED)
 * Co-change partners can name deleted files — history is reported as it
 * happened; the UI marks those edges inferred anyway.
 *
 * The measured half is the multi-language import scan, so a resolved edge
 * carries the scanner's own confidence (1.0 exact / 0.8 inferred extension /
 * 0.6 alias-or-search) instead of a flat 1 — a guessed edge should not rank
 * like an exact one.
 */
export async function blastAdjacency(root, commits) {
  const key = `${gitHead(root)}|${DEFAULT_COMMIT_WINDOW}`;
  if (blastCache.key === key && blastCache.value) return blastCache.value;
  const entry = await importGraphFor(root);
  const importers = new Map();
  for (const e of (entry.graph && entry.graph.edges) || []) {
    if (!importers.has(e.to)) importers.set(e.to, new Map());
    const seen = importers.get(e.to);
    // Two kinds (import + require) of the same pair collapse to the best edge.
    if (!seen.has(e.from) || seen.get(e.from) < e.confidence) seen.set(e.from, e.confidence);
  }
  for (const [file, seen] of importers) {
    importers.set(file, [...seen.entries()]
      .map(([f, confidence]) => ({ file: f, confidence }))
      .sort((x, y) => y.confidence - x.confidence || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)));
  }
  const cc = coChange(commits);
  const partners = new Map();
  for (const pair of cc.pairs) {
    if (!partners.has(pair.a)) partners.set(pair.a, []);
    partners.get(pair.a).push({ file: pair.b, confidence: pair.confidence });
  }
  for (const list of partners.values()) {
    list.sort((x, y) => y.confidence - x.confidence || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  }
  // "The scan produced edges" — an empty graph is honestly unavailable, not a
  // silent zero: with no measured edge the answer is history-only and says so.
  const graphAvailable = Boolean(entry.graph && entry.graph.edges.length);
  const value = {
    importers,
    partners,
    graphAvailable,
    coverage: graphCoverage(entry),
    reason: graphAvailable ? null : entry.reason,
    window: cc.window
  };
  blastCache.key = key;
  blastCache.value = value;
  blastCache.computes += 1;
  return value;
}

/**
 * PURE. Breadth-first blast radius over the two adjacency maps.
 *
 * Blend rule (documented, because the UI shows it): an 'imports' edge is
 * MEASURED — the scan resolved that specifier to a repo file, and the edge
 * carries the resolution's own confidence. A 'co-change' edge is INFERRED —
 * the two files landed in the same commits, confidence = P(b|a) from git
 * history. Node score is the best path product seen: parent_score ×
 * edge_confidence × kind_weight × depth_decay. Nodes reached by any measured
 * edge are 'dependent'; history-only nodes are 'co-change'.
 *
 * `importers` entries may be a bare path or {file, confidence} (a caller with
 * a flat graph passes strings; the import scan passes confidences).
 * Exported because brain-mcp.mjs renders the same ranking over the same maps —
 * duplicating it there would let the MCP answer and the Blast panel drift.
 *
 * @returns {{nodes, edges, truncated, reachedCount}} `nodes` are seeds + the
 *   highest-scoring kept nodes; `reachedCount` is how many were reached BEFORE
 *   the cap, so a caller can say "showing top N of M" honestly.
 */
export function buildBlast({ seeds, importers, partners, depth }) {
  const nodes = new Map();
  for (const file of seeds) nodes.set(file, { file, kind: 'seed', basis: 'seed', depth: 0, score: 1, confidence: 1 });
  const edges = [];
  const seenEdges = new Set();
  let overflow = false;

  const addEdge = (from, to, kind, confidence) => {
    if (to === from) return;
    const edgeKey = `${from}\x1f${to}\x1f${kind}`;
    if (seenEdges.has(edgeKey)) return;
    if (edges.length >= BLAST_MAX_EDGES) { overflow = true; return; }
    seenEdges.add(edgeKey);
    edges.push({
      from,
      to,
      kind,
      confidence: Math.round(confidence * 1000) / 1000,
      basis: kind === 'imports' ? 'measured' : 'inferred'
    });
  };

  let frontier = [...seeds];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const from of frontier) {
      const parent = nodes.get(from);
      if (!parent) continue;
      const expansions = [
        ...(importers.get(from) || []).slice(0, BLAST_MAX_FANOUT)
          .map((entry) => (typeof entry === 'string'
            ? { file: entry, kind: 'imports', confidence: 1, weight: 1 }
            : { file: entry.file, kind: 'imports', confidence: entry.confidence ?? 1, weight: 1 })),
        ...(partners.get(from) || []).slice(0, BLAST_MAX_FANOUT)
          .map((p) => ({ file: p.file, kind: 'co-change', confidence: p.confidence, weight: BLAST_INFERRED_WEIGHT }))
      ];
      for (const exp of expansions) {
        addEdge(from, exp.file, exp.kind, exp.confidence);
        if (exp.file === from) continue;
        const score = parent.score * exp.confidence * exp.weight * BLAST_DEPTH_DECAY;
        const existing = nodes.get(exp.file);
        const kind = exp.kind === 'imports' ? 'dependent' : 'co-change';
        const basis = exp.kind === 'imports' ? 'measured' : 'inferred';
        if (!existing) {
          nodes.set(exp.file, { file: exp.file, kind, basis, depth: d, score, confidence: exp.confidence });
          next.push(exp.file);
          continue;
        }
        if (existing.kind === 'seed') continue; // the question itself never demotes
        if (score > existing.score) {
          existing.score = score;
          existing.confidence = exp.confidence;
        }
        existing.depth = Math.min(existing.depth, d);
        if (kind === 'dependent') { existing.kind = 'dependent'; existing.basis = 'measured'; } // measured wins
      }
    }
    frontier = next;
  }

  const seedNodes = [...nodes.values()].filter((n) => n.kind === 'seed');
  const reached = [...nodes.values()]
    .filter((n) => n.kind !== 'seed')
    .sort((a, b) => b.score - a.score || a.depth - b.depth || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const budget = Math.max(0, BLAST_MAX_NODES - seedNodes.length);
  const kept = reached.slice(0, budget);
  const truncated = overflow || kept.length < reached.length;
  const keptFiles = new Set([...seedNodes, ...kept].map((n) => n.file));
  const keptEdges = edges
    .filter((e) => keptFiles.has(e.from) && keptFiles.has(e.to))
    .sort((a, b) => b.confidence - a.confidence || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return {
    nodes: [...seedNodes, ...kept].map((n) => ({
      ...n,
      score: Math.round(n.score * 1000) / 1000,
      confidence: Math.round((n.confidence ?? 1) * 1000) / 1000
    })),
    edges: keptEdges,
    truncated,
    reachedCount: reached.length
  };
}
