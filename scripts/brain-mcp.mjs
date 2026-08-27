/**
 * brain:mcp — MCP (Model Context Protocol) server over stdio.
 *
 * The *pull* half of the agent surface. Ambient hooks (ADR 0023/0026) push the
 * brain's answers into Claude Code at prompt/tool time; this is the socket for
 * every host that expects to pull them instead (Claude Code `mcp add`, Codex,
 * Cursor, VS Code, Zed…). Same answers, same provenance, second doorway —
 * not a replacement for the hooks.
 *
 * Wire format: JSON-RPC 2.0, newline-delimited, over stdin/stdout — the MCP
 * stdio transport. `JSON.stringify` escapes every embedded newline, so one
 * message is always exactly one line. Implemented methods:
 *
 *   initialize            → {protocolVersion, capabilities:{tools:{}}, serverInfo, instructions}
 *   notifications/*       → swallowed (a notification MUST never get a response)
 *   tools/list            → the eight tools below, with JSON Schema inputs
 *   tools/call            → {content:[{type:'text',…}]} (isError:true on failure)
 *   ping                  → {}
 *   anything else         → -32601; malformed JSON → -32700; batch → -32600
 *
 * TRANSPORT DISCIPLINE: stdout carries protocol frames and NOTHING else. Every
 * log, warning and error goes to stderr — a single stray `console.log` from any
 * imported module would corrupt the stream, so `console.log/info/debug` are
 * re-pointed at stderr for the lifetime of the process (belt and braces; the
 * imported libs are already quiet).
 *
 * ANSWER DISCIPLINE: each tool returns the same intelligence the Control Room
 * UI renders (the pure cores are imported directly — git-intel, brain-route,
 * brain-brief, index-provider, and brain-serve's exported pure helpers — never
 * over HTTP), shaped as a TASK ANSWER rather than an entity dump: prose lines,
 * capped arrays, no giant blobs. Every result ends with the freshness /
 * provenance line the UI shows (basis · source · window · state age · index) —
 * that line is a product rule: it is what lets an agent trust or discount the
 * answer instead of guessing.
 *
 * Install into an MCP host:
 *
 *   node scripts/brain-mcp.mjs --print-config
 *
 * prints exactly the snippet to paste (stdout is pure JSON, hints go to
 * stderr), e.g.
 *
 *   {
 *     "mcpServers": {
 *       "project-brain": { "command": "node", "args": ["/abs/scripts/brain-mcp.mjs"] }
 *     }
 *   }
 *
 * Claude Code one-liner:
 *   claude mcp add project-brain -- node /abs/path/scripts/brain-mcp.mjs
 * or, with the package installed: `project-brain mcp`.
 *
 * Read-only by construction: no tool writes brain state, spawns a runner or
 * mutates a lease. The write surface stays in the CLI and the Control Room's
 * token-gated POST endpoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, PACKAGE_DIR, listIndexableFiles, takeFlag } from './common.mjs';
import { ACTIVE_STATE, activeStateJson } from './active-state.mjs';
import {
  gitLogArgs, parseLog, hotspots, coChange, riskScore, calibrateRisk,
  fileHealth, calibrateFileHealth
} from './git-intel.mjs';
// Both verified side-effect-free at import (isMain guards asserted by their own
// tests) — the same contract brain-serve.mjs relies on.
import { applyRules, scoreChange } from './brain-route.mjs';
import { buildBrief } from './brain-brief.mjs';
import { getIndexProvider } from './index-provider.mjs';
import { staleBanner } from './retrieval.mjs';
import { discoverProjects, isFleetMode } from './projects.mjs';
// The Control Room's exported pure helpers. Importing them (rather than
// re-deriving) is what guarantees `brain_why` here and the Why drawer there can
// never disagree about which ADR governs a file.
import {
  freshness, frontmatterTitle, parseFrontmatter, decisionExcerpt, moduleGlobs,
  globMatchesFile, inferModuleFromPath, moduleAliases, normPath,
  isOpenWorkstream, CALIBRATION_WINDOW,
  BLAST_DEFAULT_DEPTH, BLAST_MAX_DEPTH, BLAST_MAX_NODES
} from './brain-serve.mjs';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'project-brain';
/** Protocol revisions we can speak; an unknown request falls back to LATEST. */
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];
/** A single JSON-RPC frame above this is treated as a parse error, not buffered. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

const DEFAULT_COMMIT_WINDOW = 500;
const MAX_FILES_ARG = 200;

// Token budget per answer (decisions/0024: context footprint is a feature).
const CAP = Object.freeze({
  workstreams: 5,
  leases: 12,
  dirtyExamples: 6,
  riskFiles: 8,
  blastNodes: 20,
  whyDecisions: 3,
  whyFindings: 5,
  whyHistory: 5,
  dangerDefault: 10,
  dangerMax: 25,
  searchDefault: 5,
  searchMax: 15,
  snippet: 200,
  conflicts: 8,
  actions: 5
});

// Blast blend constants. brain-serve exports the depth/node caps but keeps the
// decay/fan-out weights module-private; they are mirrored here (and only here)
// so the ranking matches the Blast panel. If brain-serve ever exports them,
// delete these three lines and import instead.
const BLAST_DEPTH_DECAY = 0.6;
const BLAST_INFERRED_WEIGHT = 0.85;
const BLAST_MAX_FANOUT = 25;

// ---------------------------------------------------------------------------
// transport discipline: stdout is protocol-only
// ---------------------------------------------------------------------------

/** All logging goes here. Never `console.log` in this process. */
function logErr(message) {
  try { process.stderr.write(`[brain:mcp] ${message}\n`); } catch { /* stderr closed */ }
}

function silenceStdoutLogging() {
  const toErr = (...args) => {
    try {
      process.stderr.write(args.map((a) => (typeof a === 'string' ? a : inspectish(a))).join(' ') + '\n');
    } catch { /* ignore */ }
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

function inspectish(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ---------------------------------------------------------------------------
// git plumbing + per-HEAD caches (the daemon pattern: a long-lived process must
// not re-run `git log` per tool call)
// ---------------------------------------------------------------------------

const caches = {
  head: null,
  commits: null,
  riskCal: { key: null, value: null },
  healthCal: { key: null, value: null },
  blast: { key: null, value: null },
  tsGraph: { key: null, value: null },
  provider: null
};

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').trim() || 'no-head';
}

/** Parsed commit window, memoized per HEAD. Throws only when git itself does. */
function cachedCommits() {
  const key = `${gitHead()}|${DEFAULT_COMMIT_WINDOW}`;
  if (caches.head !== key) {
    const r = spawnSync('git', gitLogArgs({ limit: DEFAULT_COMMIT_WINDOW }), {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`git log failed (status ${r.status}): ${(r.stderr || '').trim()}`);
    caches.commits = parseLog(r.stdout || '');
    caches.head = key;
  }
  return caches.commits;
}

/** Commits or a degraded empty window + warning — the tools never 500. */
function commitsSafe() {
  try { return { commits: cachedCommits(), warning: null }; }
  catch (error) { return { commits: [], warning: `git history unavailable: ${error.message || error}` }; }
}

function gitList(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Staged/unstaged/branch snapshot; not-a-repo degrades to empty arrays. */
function changedSnapshot() {
  const staged = gitList(['diff', '--cached', '--name-only']);
  const unstaged = gitList(['diff', '--name-only']);
  const branch = gitList(['branch', '--show-current']);
  return {
    staged: staged || [],
    unstaged: unstaged || [],
    branch: branch && branch.length ? branch[0] : null
  };
}

/** Explicit files (cleaned, capped) else staged ∪ unstaged. */
function targetFiles(files) {
  if (Array.isArray(files) && files.length) {
    const cleaned = files
      .map((f) => normPath(String(f || '')))
      .filter(Boolean)
      .slice(0, MAX_FILES_ARG);
    return [...new Set(cleaned)].sort();
  }
  const snap = changedSnapshot();
  return [...new Set([...snap.staged, ...snap.unstaged])].sort();
}

/**
 * Active (non-expired) leases, read-only: never creates active_state.md.
 * `null` (not `[]`) when there is no lease state at all — riskScore omits the
 * lease-conflict factor entirely in that case rather than scoring a zero,
 * exactly like /api/risk.
 */
function readLeasesSafe(nowMs = Date.now()) {
  try {
    if (!fs.existsSync(ACTIVE_STATE)) return null;
    return activeStateJson().leases.filter((l) => {
      if (!l.target) return false;
      const until = Date.parse(l.until);
      return !(Number.isFinite(until) && until < nowMs);
    });
  } catch { return null; }
}

/** Whole state, read-only guarded (same rule as /api/state). */
function readStateSafe() {
  try {
    if (!fs.existsSync(ACTIVE_STATE)) return { workstreams: [], leases: [], blockers: [], overlaps: [] };
    return activeStateJson();
  } catch { return { workstreams: [], leases: [], blockers: [], overlaps: [] }; }
}

async function providerInfo() {
  if (!caches.provider) {
    caches.provider = getIndexProvider()
      .then((p) => ({ provider: p, name: p.name, model: p.modelName || null, available: p.name !== 'none' }))
      .catch((error) => ({ provider: null, name: 'unavailable', model: null, available: false, error: String(error.message || error) }));
  }
  return caches.provider;
}

// ---------------------------------------------------------------------------
// the provenance line (product rule — every answer carries it)
// ---------------------------------------------------------------------------

function ageHuman(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 90) return `${seconds}s old`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m old`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h old`;
  return `${Math.round(seconds / 86400)}d old`;
}

/**
 * The one line every tool result ends with: what the answer is made of
 * (basis/source), how much history it saw (window), how old the coordination
 * state is, and — when the index was consulted — which provider answered.
 * Mirrors the UI's <Provenance> footer plus the freshness metadata every
 * /api/* response carries.
 */
function provenanceLine({ basis = 'measured', source, window = null, index = null } = {}) {
  const parts = [`basis ${basis}`];
  if (source) parts.push(`source ${source}`);
  if (window) {
    const since = window.since ? ` since ${String(window.since).slice(0, 10)}` : '';
    parts.push(`window ${window.commits} commit${window.commits === 1 ? '' : 's'}${since}`);
  }
  const fresh = freshness(ACTIVE_STATE);
  parts.push(fresh.state_age === null
    ? 'active_state.md absent (no coordination state)'
    : `active_state.md ${ageHuman(fresh.state_age)}`);
  if (index) parts.push(`index ${index}`);
  const line = `provenance: ${parts.join(' · ')}`;
  return fresh.stale_warning ? `${line}\n⚠ ${fresh.stale_warning}` : line;
}

// ---------------------------------------------------------------------------
// record loading (.project-brain), read-only and fail-soft
// ---------------------------------------------------------------------------

const BRAIN_DIR_ABS = () => path.join(ROOT, '.project-brain');
const MAX_DOC_BYTES = 64 * 1024;

/** One record folder (flat, .md only) in brain-serve's docRecordsOf shape. */
function docRecordsOf(kind) {
  const dir = path.join(BRAIN_DIR_ABS(), kind);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const abs = path.join(dir, e.name);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8').slice(0, MAX_DOC_BYTES); } catch { continue; }
    const { data, body } = parseFrontmatter(text);
    const name = e.name.replace(/\.md$/i, '');
    out.push({
      file: normPath(path.relative(ROOT, abs)),
      name,
      title: frontmatterTitle(text) || name,
      module: String(data.module || '').trim(),
      data,
      body,
      globs: kind === 'modules' ? moduleGlobs(data, body) : [],
      sources: kind === 'findings' ? findingSources(text) : []
    });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

/** Findings carry a nested `sources:` list the flat frontmatter parser skips. */
function findingSources(text) {
  const out = [];
  const re = /^\s*-\s*path:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const p = normPath(m[1].trim().replace(/^["']|["']$/g, ''));
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// calibration receipts (cached per HEAD — calibrateRisk replays history)
// ---------------------------------------------------------------------------

function riskReceipt(commits) {
  if (!commits.length) return null;
  if (caches.riskCal.key !== caches.head) {
    try {
      const r = calibrateRisk(commits, { window: CALIBRATION_WINDOW });
      caches.riskCal.value = r && r.auc !== null ? {
        auc: r.auc,
        commits: r.evaluated,
        top: r.quantiles?.[r.quantiles.length - 1]?.defectRate ?? null,
        bottom: r.quantiles?.[0]?.defectRate ?? null
      } : null;
    } catch { caches.riskCal.value = null; }
    caches.riskCal.key = caches.head;
  }
  const c = caches.riskCal.value;
  if (!c) return 'receipt: not enough of this repo\'s own history to validate the score yet — treat it as a hint.';
  const pct = (v) => (v === null ? '?' : `${Math.round(v * 100)}%`);
  return `receipt: top risk quartile carried ${pct(c.top)} defect rate vs ${pct(c.bottom)} in the lowest — ` +
    `AUC ${c.auc.toFixed(2)} over ${c.commits} commits of this repo's own history ` +
    '(in-repo self-calibration, not a cross-repo benchmark).';
}

function healthReceipt(commits) {
  if (!commits.length) return null;
  if (caches.healthCal.key !== caches.head) {
    try {
      const cal = calibrateFileHealth(commits, { window: Math.min(commits.length, 300) });
      caches.healthCal.value = cal && cal.auc !== null ? { auc: cal.auc, files: cal.evaluated } : null;
    } catch { caches.healthCal.value = null; }
    caches.healthCal.key = caches.head;
  }
  const c = caches.healthCal.value;
  if (!c) return 'receipt: not enough fix history in this repo to validate the danger ranking yet — treat it as a hint.';
  return `receipt: AUC ${c.auc.toFixed(2)} over ${c.files} files of this repo's own fix history ` +
    '(in-repo self-calibration, not a cross-repo benchmark).';
}

// ---------------------------------------------------------------------------
// blast adjacency: measured (ts-graph imports) ⊕ inferred (git co-change)
// ---------------------------------------------------------------------------

/**
 * Load the TS import graph, keeping the REASON it is missing — a blast answer
 * has to explain its degradation, not silently drop the measured half. Never
 * throws.
 */
async function tsGraphFor() {
  if (process.env.BRAIN_TS_GRAPH === '0') {
    return { ctx: null, indexable: [], tsFiles: 0, reason: 'static import graph disabled via BRAIN_TS_GRAPH=0' };
  }
  const key = caches.head || 'no-history';
  if (caches.tsGraph.key === key && caches.tsGraph.value) return caches.tsGraph.value;
  const value = await loadTsGraph();
  caches.tsGraph = { key, value };
  return value;
}

async function loadTsGraph() {
  let indexable = [];
  let tsFiles = 0;
  try {
    indexable = await listIndexableFiles();
    tsFiles = indexable.filter((f) => /\.(ts|tsx)$/.test(f)).length;
    if (!tsFiles) {
      return { ctx: null, indexable, tsFiles, reason: 'no .ts/.tsx sources indexed — static import graph unavailable for this repo' };
    }
    const { loadTsSemanticContext } = await import('./ts-graph.mjs');
    const ctx = (await loadTsSemanticContext(ROOT, new Set(indexable))) || null;
    return {
      ctx, indexable, tsFiles,
      reason: ctx ? null : 'no TypeScript program — install the optional `typescript` dependency (npm i -D typescript)'
    };
  } catch (error) {
    return { ctx: null, indexable, tsFiles, reason: `static import graph unavailable: ${error.message || error}` };
  }
}

/** importers (measured) + co-change partners (inferred), memoized per HEAD. */
async function blastAdjacency(commits) {
  const key = caches.head || 'no-history';
  if (caches.blast.key === key && caches.blast.value) return caches.blast.value;
  const { ctx, indexable, tsFiles, reason } = await tsGraphFor();
  const importers = new Map();
  if (ctx) {
    for (const rel of indexable) {
      for (const imported of ctx.get(rel)?.resolvedImports || []) {
        if (!importers.has(imported)) importers.set(imported, []);
        importers.get(imported).push(rel);
      }
    }
    for (const list of importers.values()) list.sort();
  }
  const cc = coChange(commits);
  const partners = new Map();
  for (const pair of cc.pairs) {
    if (!partners.has(pair.a)) partners.set(pair.a, []);
    partners.get(pair.a).push({ file: pair.b, confidence: pair.confidence });
  }
  for (const list of partners.values()) list.sort((x, y) => y.confidence - x.confidence);
  const value = { importers, partners, graphAvailable: Boolean(ctx), tsFiles, reason: ctx ? null : reason, window: cc.window };
  caches.blast = { key, value };
  return value;
}

/**
 * PURE. Breadth-first blast radius. Node score = parent × edge confidence ×
 * kind weight × depth decay, so a MEASURED import dependent always outranks an
 * INFERRED co-change partner at equal depth — the same blend rule the Blast
 * panel documents.
 */
function buildBlast({ seeds, importers, partners, depth }) {
  const nodes = new Map();
  for (const file of seeds) nodes.set(file, { file, kind: 'seed', depth: 0, score: 1, basis: 'seed' });
  let frontier = [...seeds];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const from of frontier) {
      const parent = nodes.get(from);
      if (!parent) continue;
      const expansions = [
        ...(importers.get(from) || []).slice(0, BLAST_MAX_FANOUT)
          .map((file) => ({ file, kind: 'dependent', basis: 'measured', confidence: 1, weight: 1 })),
        ...(partners.get(from) || []).slice(0, BLAST_MAX_FANOUT)
          .map((p) => ({ file: p.file, kind: 'co-change', basis: 'inferred', confidence: p.confidence, weight: BLAST_INFERRED_WEIGHT }))
      ];
      for (const exp of expansions) {
        if (exp.file === from) continue;
        const score = parent.score * exp.confidence * exp.weight * BLAST_DEPTH_DECAY;
        const existing = nodes.get(exp.file);
        if (!existing) {
          nodes.set(exp.file, { file: exp.file, kind: exp.kind, basis: exp.basis, depth: d, score, confidence: exp.confidence });
          next.push(exp.file);
          continue;
        }
        if (existing.kind === 'seed') continue; // the question itself never demotes
        if (score > existing.score) { existing.score = score; existing.confidence = exp.confidence; }
        existing.depth = Math.min(existing.depth, d);
        if (exp.basis === 'measured') { existing.kind = 'dependent'; existing.basis = 'measured'; }
      }
    }
    frontier = next;
  }
  const reached = [...nodes.values()]
    .filter((n) => n.kind !== 'seed')
    .sort((a, b) => b.score - a.score || a.depth - b.depth || (a.file < b.file ? -1 : 1));
  const kept = reached.slice(0, Math.max(0, BLAST_MAX_NODES - seeds.length));
  return { reached, kept, truncated: kept.length < reached.length };
}

// ---------------------------------------------------------------------------
// sensing for brain-route's pure rule engine (mirrors /api/next)
// ---------------------------------------------------------------------------

async function senseSignals() {
  const snapshot = changedSnapshot();
  const changedFiles = [...new Set([...snapshot.staged, ...snapshot.unstaged])];
  const branch = snapshot.branch || '';
  const brainDir = BRAIN_DIR_ABS();
  const brainInitialized = fs.existsSync(brainDir) && fs.existsSync(path.join(brainDir, 'context_index.md'));
  const indexed = fs.existsSync(path.join(brainDir, 'search_index.json')) ||
    fs.existsSync(path.join(brainDir, 'index_manifest.json'));
  const { band, riskKeyword, recommendedPackages } = scoreChange(changedFiles, branch);
  let backlog = { open: 0, planned: 0, plans: 0 };
  let ungrilledPlanned = 0;
  try {
    const { loadFindings, loadPlans, loadGrills } = await import('./findings.mjs');
    const findings = loadFindings();
    backlog = {
      open: findings.filter((f) => f.status === 'open').length,
      planned: findings.filter((f) => f.status === 'planned').length,
      plans: loadPlans().length
    };
    const proceeded = new Set(loadGrills().filter((g) => g.verdict === 'proceed').map((g) => g.target));
    ungrilledPlanned = findings.filter((f) => f.status === 'planned' && !proceeded.has(f.slug)).length;
  } catch { /* soft — no findings dirs yet */ }
  let leaseConflicts = 0;
  try {
    if (changedFiles.length && fs.existsSync(ACTIVE_STATE)) {
      const state = activeStateJson();
      leaseConflicts = buildBrief({
        files: changedFiles,
        leases: state.leases || [],
        workstreams: state.workstreams || [],
        actor: process.env.BRAIN_ACTOR || ''
      }).conflicts.length;
    }
  } catch { /* soft */ }
  return {
    branch, detachedHead: !branch, brainInitialized, indexed,
    changedFiles: changedFiles.length, stagedFiles: snapshot.staged.length,
    changeBand: band, riskKeyword, recommendedPackages,
    backlog, ungrilledPlanned, leaseConflicts,
    // Deliberately unsensed (needs the index / gh — too costly per tool call):
    commitsAhead: 0, commitsAheadNoPr: false, base: '', indexStale: null, gaps: null
  };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const FILES_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description: 'Repo-relative paths. Omit to use the working tree change set (staged ∪ unstaged).'
};

/**
 * One text block. `null`/`false` lines are dropped so callers can inline
 * conditionals; the empty string is KEPT (it is a deliberate separator).
 */
function say(lines) {
  return { content: [{ type: 'text', text: lines.filter((l) => typeof l === 'string').join('\n') }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function listPreview(items, cap) {
  const shown = items.slice(0, cap);
  const rest = items.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, +${rest} more` : '');
}

const TOOLS = [
  {
    name: 'brain_status',
    description:
      'Repo overview before you start work: fleet mode, open workstreams, active file leases, ' +
      'working-tree dirt, and the single highest-ranked next action. Call this first in a new session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolStatus
  },
  {
    name: 'brain_risk',
    description:
      'Is this change dangerous? Deterministic 0-10 change-risk score with its weighted factors ' +
      '(hotspot overlap, missing co-change partners, blast radius, lease conflicts) and the ' +
      'calibration receipt from this repo\'s own history. No LLM, no network.',
    inputSchema: { type: 'object', properties: { files: FILES_SCHEMA }, additionalProperties: false },
    handler: toolRisk
  },
  {
    name: 'brain_blast',
    description:
      'What breaks if I change this? Ranked likely-affected files, each labelled measured ' +
      '(compiler-resolved static import) or inferred (git co-change, confidence = P(b|a)).',
    inputSchema: {
      type: 'object',
      properties: {
        files: FILES_SCHEMA,
        depth: { type: 'integer', minimum: 1, maximum: BLAST_MAX_DEPTH, description: `Hops to expand (default ${BLAST_DEFAULT_DEPTH}, max ${BLAST_MAX_DEPTH}).` }
      },
      additionalProperties: false
    },
    handler: toolBlast
  },
  {
    name: 'brain_why',
    description:
      'Why is this file the way it is? Its module record, the ADRs that govern it (with the ' +
      'Decision excerpt), open findings citing it, and its recent commit history. Read this ' +
      'before refactoring code you did not write.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Repo-relative path of a code file.' } },
      required: ['file'],
      additionalProperties: false
    },
    handler: toolWhy
  },
  {
    name: 'brain_danger',
    description:
      'Which files in this repo are most dangerous to touch? Per-file 0-10 danger ranking from ' +
      'git history (churn, co-change scatter, bus factor, fix density) with the top factor per ' +
      'file and the calibration receipt.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: CAP.dangerMax, description: `Rows to return (default ${CAP.dangerDefault}).` } },
      additionalProperties: false
    },
    handler: toolDanger
  },
  {
    name: 'brain_leases',
    description:
      'Who is already working on this? Active file leases with holder and remaining TTL, plus ' +
      'the conflicts against a given actor for a set of files. Check before editing shared paths.',
    inputSchema: {
      type: 'object',
      properties: {
        files: FILES_SCHEMA,
        actor: { type: 'string', description: 'Actor to test conflicts against (default: BRAIN_ACTOR).' }
      },
      additionalProperties: false
    },
    handler: toolLeases
  },
  {
    name: 'brain_search',
    description:
      'Semantic + keyword search over the indexed repo and its brain records. Degrades to a ' +
      'lexical pass with an explicit warning when no embedding index is available.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        limit: { type: 'integer', minimum: 1, maximum: CAP.searchMax, description: `Hits to return (default ${CAP.searchDefault}).` }
      },
      required: ['query'],
      additionalProperties: false
    },
    handler: toolSearch
  },
  {
    name: 'brain_next',
    description:
      'What should happen next in this repo? Ranked next actions from the deterministic routing ' +
      'rules over sensed state, each tagged auto (safe to run) or human (ask first).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolNext
  }
];

// --- brain_status -----------------------------------------------------------

async function toolStatus() {
  const now = Date.now();
  const state = readStateSafe();
  const snap = changedSnapshot();
  const lines = [];

  const repo = path.basename(ROOT);
  lines.push(`${repo}${snap.branch ? ` on ${snap.branch}` : ' (detached HEAD)'} — ${ROOT}`);

  // Fleet: the honest degraded flag, no per-repo git calls (that is brain:serve's
  // /api/fleet — N repos × 2 git calls is too expensive for a status ping).
  let discovered = [];
  let discoveryError = null;
  try { discovered = discoverProjects(ROOT); } catch (error) { discoveryError = String(error.message || error); }
  const fleetOn = !discoveryError && discovered.length > 0 && isFleetMode(discovered);
  lines.push(discoveryError
    ? `fleet: degraded — discovery failed: ${discoveryError}`
    : fleetOn
      ? `fleet: on — ${discovered.length} project(s) discovered under this root`
      : `fleet: degraded (single-repo mode) — ${discovered.length} project(s) discovered under this root, fleet mode needs ≥2`);

  const workstreams = (state.workstreams || []).filter(isOpenWorkstream);
  if (!workstreams.length) lines.push('workstreams: none open');
  else {
    lines.push(`workstreams: ${workstreams.length} open`);
    for (const w of workstreams.slice(0, CAP.workstreams)) {
      lines.push(`- ${w.taskId || '(untitled)'} — ${w.owner || 'unowned'}${w.branch ? ` on ${w.branch}` : ''}${w.scope ? ` · ${w.scope}` : ''}`);
    }
    if (workstreams.length > CAP.workstreams) lines.push(`- …+${workstreams.length - CAP.workstreams} more`);
  }

  const leases = readLeasesSafe(now) || [];
  if (!leases.length) lines.push('leases: none active');
  else {
    lines.push(`leases: ${leases.length} active`);
    for (const l of leases.slice(0, CAP.workstreams)) lines.push(`- ${leaseLine(l, now)}`);
    if (leases.length > CAP.workstreams) lines.push(`- …+${leases.length - CAP.workstreams} more`);
  }

  const dirty = [...new Set([...snap.staged, ...snap.unstaged])];
  lines.push(dirty.length
    ? `dirty: ${snap.staged.length} staged / ${snap.unstaged.length} unstaged — ${listPreview(dirty, CAP.dirtyExamples)}`
    : 'dirty: working tree clean');

  const top = (applyRules(await senseSignals(), { top: 1 }).recommendations || [])[0];
  lines.push(top
    ? `next: ${commandOf(top)} [${top.boundary}] — ${top.reason}`
    : 'next: nothing pending — the brain has no ranked action for this state');

  lines.push('');
  lines.push(provenanceLine({
    basis: 'measured',
    source: 'active_state.md + `git status` + brain-route rules'
  }));
  return say(lines);
}

function commandOf(rec) {
  return `${rec.command}${rec.args && rec.args.length ? ` ${rec.args.join(' ')}` : ''}`;
}

function leaseLine(lease, now = Date.now()) {
  const until = Date.parse(lease.until);
  let ttl = '';
  if (Number.isFinite(until)) {
    const ms = until - now;
    ttl = ms <= 0
      ? ' (expired)'
      : ` (${ms > 86_400_000 ? `${Math.round(ms / 86_400_000)}d` : ms > 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`} left)`;
  } else if (lease.until) {
    ttl = ' (TTL unparseable — treat as held)';
  }
  return `${lease.target} — ${lease.lockedBy || 'unowned'}${lease.until ? ` until ${lease.until}` : ''}${ttl}` +
    (lease.notes ? ` · ${lease.notes}` : '');
}

// --- brain_risk -------------------------------------------------------------

async function toolRisk(args = {}) {
  const files = targetFiles(args.files);
  if (!files.length) {
    return say([
      'change risk: no change set — the working tree is clean and no files were given.',
      'Pass files: ["path/a", "path/b"] to score a hypothetical change.',
      '',
      provenanceLine({ basis: 'measured', source: 'git-log' })
    ]);
  }
  const { commits, warning } = commitsSafe();
  const now = Date.now();
  const hs = hotspots(commits, { now });
  const cc = coChange(commits);
  const leases = readLeasesSafe(now);
  let blastRadius = null;
  try {
    const { ctx, indexable } = await tsGraphFor();
    if (ctx) {
      const touched = new Set(files);
      const dependents = indexable.filter((rel) =>
        !touched.has(rel) && (ctx.get(rel)?.resolvedImports || []).some((imp) => touched.has(imp)));
      blastRadius = { dependents: dependents.sort(), source: 'ts-graph' };
    }
  } catch { blastRadius = null; }

  const scored = riskScore(files, {
    hotspots: hs, coChange: cc,
    ...(blastRadius ? { blastRadius } : {}),
    ...(leases ? { leases } : {})
  });

  const band = scored.score >= 6.5 ? 'HIGH' : scored.score >= 3.5 ? 'ELEVATED' : 'LOW';
  const lines = [
    `change risk ${scored.score.toFixed(1)}/10 (${band}) over ${files.length} file(s): ${listPreview(files, CAP.riskFiles)}`,
    scored.reason ? `note: ${scored.reason}` : null,
    warning ? `⚠ ${warning}` : null,
    'factors (weight × raw = contribution):'
  ];
  const factors = [...scored.factors].sort((a, b) => b.contribution - a.contribution);
  for (const f of factors) lines.push(`- ${f.name} (${f.contribution.toFixed(2)}): ${f.evidence}`);
  const receipt = riskReceipt(commits);
  if (receipt) { lines.push(''); lines.push(receipt); }
  lines.push('');
  lines.push(provenanceLine({
    basis: scored.basis,
    source: blastRadius ? 'git-log ⊕ ts-graph static imports' : 'git-log',
    window: scored.window
  }));
  return say(lines);
}

// --- brain_blast ------------------------------------------------------------

async function toolBlast(args = {}) {
  const rawDepth = Number(args.depth ?? BLAST_DEFAULT_DEPTH);
  const depth = Math.min(Math.max(Number.isFinite(rawDepth) ? Math.floor(rawDepth) : BLAST_DEFAULT_DEPTH, 1), BLAST_MAX_DEPTH);
  const files = targetFiles(args.files);
  if (!files.length) {
    return say([
      'blast radius: no seeds — the working tree is clean and no files were given.',
      'Pass files: ["path/a"] to ask what would break.',
      '',
      provenanceLine({ basis: 'mixed', source: 'ts-graph static imports (measured) ⊕ git-log co-change (inferred)' })
    ]);
  }
  const { commits, warning } = commitsSafe();
  const adjacency = await blastAdjacency(commits);
  const { reached, kept, truncated } = buildBlast({
    seeds: files, importers: adjacency.importers, partners: adjacency.partners, depth
  });

  const lines = [
    `blast radius depth ${depth} from ${files.length} seed(s): ${listPreview(files, CAP.riskFiles)}`,
    warning ? `⚠ ${warning} — co-change edges omitted` : null,
    adjacency.graphAvailable
      ? `import graph: available (${adjacency.tsFiles} TS file(s)) — measured edges outrank inferred history`
      : `import graph: unavailable — ${adjacency.reason}; co-change (inferred) edges are still reported`
  ];
  if (!reached.length) {
    lines.push('likely affected: nothing — no importer and no recurring co-change partner in the window.');
  } else {
    lines.push(`likely affected: ${reached.length} file(s)${truncated ? ` (showing top ${Math.min(kept.length, CAP.blastNodes)})` : ''}`);
    for (const n of kept.slice(0, CAP.blastNodes)) {
      const how = n.basis === 'measured'
        ? 'imports it (measured)'
        : `co-changes ${Math.round((n.confidence || 0) * 100)}% (inferred)`;
      lines.push(`- ${n.file} — ${how}, depth ${n.depth}, score ${n.score.toFixed(2)}`);
    }
    if (kept.length > CAP.blastNodes) lines.push(`- …+${kept.length - CAP.blastNodes} more`);
  }
  lines.push('');
  lines.push(provenanceLine({
    basis: 'mixed',
    source: 'ts-graph static imports (measured) ⊕ git-log co-change (inferred)',
    window: adjacency.window || null
  }));
  return say(lines);
}

// --- brain_why --------------------------------------------------------------

function toolWhy(args = {}) {
  const file = normPath(String(args.file || ''));
  if (!file || file.length > 512 || file.includes('\0')) {
    return fail('brain_why needs `file`: a repo-relative path of a code file, e.g. "scripts/brain-serve.mjs".');
  }
  const moduleRecs = docRecordsOf('modules');
  const owner = moduleRecs.find((r) => (r.globs || []).some((g) => globMatchesFile(g, file))) || null;
  const module = owner ? (owner.module || owner.name) : inferModuleFromPath(file);
  const aliases = moduleAliases(module, file);
  if (owner) {
    aliases.add(owner.name);
    if (owner.module) aliases.add(owner.module);
    if (owner.data.feature) aliases.add(String(owner.data.feature).trim());
  }
  const decisions = docRecordsOf('decisions').filter((d) => d.module && aliases.has(d.module));
  const findings = docRecordsOf('findings')
    .filter((f) => (f.module && aliases.has(f.module)) || f.sources.includes(file));

  const { commits, warning } = commitsSafe();
  const history = [];
  for (const c of commits) {
    if (!(c.files || []).some((f) => normPath(f) === file)) continue;
    history.push(c);
    if (history.length >= CAP.whyHistory) break;
  }

  const lines = [`why ${file}`];
  lines.push(`module: ${module || '(none inferred)'} — ${owner ? `owned by ${owner.file}` : 'path heuristic, no module record claims this file'}`);

  if (!decisions.length) lines.push('governing decisions: none — the brain has no authored intent for this file yet');
  else {
    lines.push(`governing decisions: ${decisions.length}`);
    for (const d of decisions.slice(0, CAP.whyDecisions)) {
      lines.push(`- ${d.name} — ${d.title}`);
      const excerpt = decisionExcerpt(d.body);
      if (excerpt) lines.push(`  ${excerpt}`);
    }
    if (decisions.length > CAP.whyDecisions) lines.push(`- …+${decisions.length - CAP.whyDecisions} more`);
  }

  if (findings.length) {
    lines.push(`open findings: ${findings.length}`);
    for (const f of findings.slice(0, CAP.whyFindings)) {
      lines.push(`- ${f.name} — ${f.title} [${String(f.data.status || 'open').trim()}${f.data.impact ? `, impact ${f.data.impact}` : ''}]`);
    }
  }

  if (warning) lines.push(`⚠ ${warning}`);
  if (!history.length) lines.push('recent history: no commit in the window touches this file');
  else {
    lines.push(`recent history: ${history.length} of the last ${commits.length} commits`);
    for (const c of history) {
      lines.push(`- ${c.hash.slice(0, 8)} ${String(c.dateIso).slice(0, 10)} ${c.subject} (${c.author})`);
    }
  }

  lines.push('');
  lines.push(provenanceLine({
    basis: 'measured',
    source: `.project-brain records + git log (matched by ${owner ? 'module-record glob' : 'path heuristic'})`,
    window: { commits: commits.length }
  }));
  return say(lines);
}

// --- brain_danger -----------------------------------------------------------

function toolDanger(args = {}) {
  const raw = Number(args.limit ?? CAP.dangerDefault);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : CAP.dangerDefault, 1), CAP.dangerMax);
  const { commits, warning } = commitsSafe();
  if (!commits.length) {
    return say([
      `most dangerous files: unavailable — ${warning || 'no git history in this repo'}`,
      '',
      provenanceLine({ basis: 'measured', source: 'git-log', window: { commits: 0 } })
    ]);
  }
  const health = fileHealth(commits, { now: Date.now() });
  const rows = health.files.slice(0, limit);
  const lines = [`most dangerous files to touch (0-10, 10 = worst), top ${rows.length} of ${health.files.length}:`];
  for (const f of rows) {
    const top = [...(f.factors || [])].sort((a, b) => b.contribution - a.contribution)[0];
    lines.push(`- ${f.score.toFixed(1)} ${f.file}${f.lowConfidence ? ' *' : ''} — ${top ? top.evidence : 'no factors'}`);
  }
  if (rows.some((f) => f.lowConfidence)) lines.push('* fewer than 3 commits — a hint, not a score.');
  const receipt = healthReceipt(commits);
  if (receipt) { lines.push(''); lines.push(receipt); }
  lines.push('');
  lines.push(provenanceLine({ basis: health.basis, source: health.source, window: health.window }));
  return say(lines);
}

// --- brain_leases -----------------------------------------------------------

function toolLeases(args = {}) {
  const now = Date.now();
  const actor = String(args.actor || process.env.BRAIN_ACTOR || '').trim();
  const state = readStateSafe();
  const leases = readLeasesSafe(now) || [];
  const lines = [];

  if (!leases.length) lines.push('leases: none active — nothing in this repo is claimed right now.');
  else {
    lines.push(`leases: ${leases.length} active`);
    for (const l of leases.slice(0, CAP.leases)) lines.push(`- ${leaseLine(l, now)}`);
    if (leases.length > CAP.leases) lines.push(`- …+${leases.length - CAP.leases} more`);
  }

  const files = targetFiles(args.files);
  if (files.length) {
    let brief;
    try {
      brief = buildBrief({
        files,
        leases: state.leases || [],
        workstreams: state.workstreams || [],
        actor
      });
    } catch (error) {
      lines.push(`⚠ conflict check unavailable: ${error.message || error}`);
    }
    if (brief) {
      const conflicts = brief.conflicts || [];
      lines.push(`conflicts for ${files.length} file(s)${actor ? ` against actor "${actor}"` : ' (no actor set — every foreign lease counts)'}: ${conflicts.length}`);
      for (const c of conflicts.slice(0, CAP.conflicts)) lines.push(`- 🚨 ${c.message}`);
      const selfHeld = (brief.advisories || []).filter((a) => a.kind === 'lease' && a.severity === 'warn');
      for (const a of selfHeld.slice(0, CAP.conflicts)) lines.push(`- ${a.message}`);
      if (!conflicts.length && !selfHeld.length) lines.push('- clear: no active lease overlaps those files.');
    }
  } else {
    lines.push('conflicts: no files given and the working tree is clean — pass files: [...] to test a change set.');
  }

  lines.push('');
  lines.push(provenanceLine({ basis: 'measured', source: 'active_state.md leases via the canonical lease-overlap grammar' }));
  return say(lines);
}

// --- brain_search -----------------------------------------------------------

async function toolSearch(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) return fail('brain_search needs a non-empty `query`.');
  const raw = Number(args.limit ?? CAP.searchDefault);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : CAP.searchDefault, 1), CAP.searchMax);

  const info = await providerInfo();
  const label = `${info.name}${info.model ? ` (${info.model})` : ''}`;
  if (!info.provider) {
    return say([
      `search "${query}": no index provider — ${info.error || 'provider unavailable'}`,
      '',
      provenanceLine({ basis: 'measured', source: 'index-provider', index: `${info.name} — unusable` })
    ]);
  }

  let results = [];
  let warning = '';
  try {
    ({ results = [], warning = '' } = await info.provider.search(query, { topK: limit }) || {});
  } catch (error) {
    return say([
      `search "${query}": failed — ${error.message || error}`,
      'The brain degrades rather than guesses: read the files directly or run `project-brain x index`.',
      '',
      provenanceLine({ basis: 'measured', source: 'index-provider', index: label })
    ]);
  }

  const lines = [`search "${query}" — ${results.length} hit(s) via ${label}`];
  for (const r of results.slice(0, limit)) {
    const heading = String(r.heading || r.title || '').replace(/\s+/g, ' ').trim();
    lines.push(`- ${Number(r.score || 0).toFixed(3)} ${r.file}#chunk-${r.chunk}${heading ? ` — ${heading}` : ''}`);
    const snippet = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, CAP.snippet);
    if (snippet) lines.push(`  ${snippet}${String(r.text || '').length > CAP.snippet ? '…' : ''}`);
  }
  if (!results.length) lines.push('- nothing matched. The brain reports an empty result rather than inventing one.');
  if (warning) lines.push(`⚠ ${warning}`);
  // ADR 0025: a hit whose file drifted from the index is flagged at query time.
  try {
    const banner = staleBanner(results, { root: ROOT });
    if (banner) lines.push(banner);
  } catch { /* soft */ }

  lines.push('');
  lines.push(provenanceLine({
    basis: info.available ? 'measured' : 'inferred',
    source: info.available ? 'embedding index + BM25 hybrid' : 'BM25 lexical fallback (no embedding index)',
    index: label
  }));
  return say(lines);
}

// --- brain_next -------------------------------------------------------------

async function toolNext() {
  const signals = await senseSignals();
  const result = applyRules(signals, { top: CAP.actions });
  const actions = (result.recommendations || []).slice(0, CAP.actions);
  const lines = [];
  if (!actions.length) lines.push('next actions: none — the sensed state has nothing pending.');
  else {
    lines.push(`next actions (${actions.length}, ranked):`);
    actions.forEach((r, i) => lines.push(`${i + 1}. [${r.boundary}] ${commandOf(r)} — ${r.reason}`));
    lines.push('boundary: auto = read-only/idempotent, safe to run unattended; human = it writes, ask first.');
    lines.push('run these as `project-brain <verb>` (or `npm run brain:<verb>`).');
  }
  lines.push('');
  lines.push(provenanceLine({
    basis: 'sensed',
    source: `brain-route rule engine over read-only signals (branch ${signals.branch || 'detached'}, ` +
      `${signals.changedFiles} changed / ${signals.stagedFiles} staged, ${signals.backlog.open} open finding(s))`
  }));
  return say(lines);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing
// ---------------------------------------------------------------------------

function writeFrame(message) {
  // JSON.stringify escapes embedded newlines, so one message is one line.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyResult(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  writeFrame({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

const INSTRUCTIONS =
  'project-brain answers coordination and code-history questions about THIS repo, deterministically ' +
  '(git history + human-authored .project-brain records; no LLM, no network). Start a session with ' +
  'brain_status. Before editing shared paths call brain_leases; before a risky edit call brain_risk ' +
  'and brain_blast; before refactoring unfamiliar code call brain_why. Every answer ends with a ' +
  'provenance line — trust it in proportion to the window and freshness it reports.';

const handlers = {
  initialize(params) {
    const requested = String(params?.protocolVersion || '');
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: 'Project Brain', version: readVersion() },
      instructions: INSTRUCTIONS
    };
  },
  ping() { return {}; },
  'tools/list'() {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  },
  async 'tools/call'(params) {
    const name = String(params?.name || '');
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      const err = new Error(`unknown tool "${name}" — available: ${TOOLS.map((t) => t.name).join(', ')}`);
      err.rpcCode = -32602;
      throw err;
    }
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      return await tool.handler(args);
    } catch (error) {
      // A tool failure is an ANSWER ("I could not find out"), not a protocol
      // fault: the agent should see it in-band and keep going.
      logErr(`${name} failed: ${error.stack || error}`);
      return fail(`${name} failed: ${error.message || error}`);
    }
  }
};

async function dispatch(message) {
  const isRequest = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;
  const method = typeof message.method === 'string' ? message.method : '';

  if (!method) {
    // A response frame (result/error) — nothing to do; we never send requests.
    if (isRequest) replyError(message.id, -32600, 'Invalid Request: missing "method"');
    return;
  }
  if (!isRequest) {
    // Notification: MUST NOT be answered, not even with an error.
    if (method !== 'notifications/initialized' && !method.startsWith('notifications/')) {
      logErr(`ignoring unknown notification: ${method}`);
    }
    return;
  }
  const handler = handlers[method];
  if (!handler) {
    return replyError(message.id, -32601, `Method not found: ${method}`);
  }
  try {
    replyResult(message.id, await handler(message.params));
  } catch (error) {
    replyError(message.id, error.rpcCode || -32603, error.message || String(error));
  }
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    // Never crash the transport on garbage: answer, stay alive.
    return replyError(null, -32700, `Parse error: ${error.message || error}`);
  }
  if (Array.isArray(message)) {
    return replyError(null, -32600, 'Invalid Request: JSON-RPC batches are not supported');
  }
  if (!message || typeof message !== 'object') {
    return replyError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  // In-flight accounting: stdin can close while a tool is still computing, and
  // an MCP host that piped a script in must still get its answers.
  inFlight += 1;
  dispatch(message)
    .catch((error) => {
      logErr(`dispatch failed: ${error.stack || error}`);
      replyError(message.id ?? null, -32603, `Internal error: ${error.message || error}`);
    })
    .finally(() => {
      inFlight -= 1;
      if (!inFlight && drainResolve) drainResolve();
    });
}

let inFlight = 0;
let drainResolve = null;

/** Resolve once every in-flight request has been answered (or after `ms`). */
function drain(ms = 30_000) {
  if (!inFlight) return Promise.resolve();
  return new Promise((resolve) => {
    drainResolve = resolve;
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function serve() {
  silenceStdoutLogging();
  // A crash in an imported lib must not take the transport down.
  process.on('uncaughtException', (error) => logErr(`uncaught: ${error.stack || error}`));
  process.on('unhandledRejection', (error) => logErr(`unhandled rejection: ${error?.stack || error}`));
  // EPIPE when the host goes away first: exit quietly rather than throwing.
  process.stdout.on('error', () => process.exit(0));

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES && !buffer.includes('\n')) {
      replyError(null, -32700, `Parse error: frame exceeds ${MAX_LINE_BYTES} bytes without a newline`);
      buffer = '';
      return;
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  });
  // stdin closed → the host is gone. Answer whatever is still in flight (a
  // piped script closes stdin immediately), then exit 0.
  let finishing = false;
  const finish = () => {
    if (finishing) return;
    finishing = true;
    if (buffer.trim()) handleLine(buffer);
    buffer = '';
    drain().then(() => process.exit(0));
  };
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.resume();
  logErr(`serving ${TOOLS.length} tools over stdio for ${ROOT}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: brain-mcp.mjs [--print-config] [--help]',
    '',
    'MCP (Model Context Protocol) server over stdio: JSON-RPC 2.0, newline-delimited.',
    'Started with no flags it speaks the protocol on stdin/stdout — run it from an',
    'MCP host, not by hand. stdout carries protocol frames only; logs go to stderr.',
    '',
    'Flags:',
    '  --print-config   Print the JSON snippet to add to your MCP host config (stdout)',
    '  --help, -h       This text',
    '',
    `Tools: ${TOOLS.map((t) => t.name).join(', ')}`
  ].join('\n');
}

function printConfig() {
  const scriptPath = fileURLToPath(import.meta.url);
  const config = {
    mcpServers: {
      [SERVER_NAME]: { command: 'node', args: [scriptPath] }
    }
  };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  process.stderr.write(
    '\nAdd the block above to your MCP host config:\n' +
    '  Claude Code   ~/.claude.json or .mcp.json (project scope), or:\n' +
    `                claude mcp add ${SERVER_NAME} -- node ${scriptPath}\n` +
    '  Codex/Cursor/VS Code   the "mcpServers" object of their MCP settings file\n' +
    `With the package installed, \`project-brain mcp\` is an equivalent command.\n` +
    'The server is read-only and runs entirely locally.\n'
  );
}

function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (takeFlag(args, '--print-config')) {
    printConfig();
    process.exit(0);
  }
  serve();
}

// Only run when invoked directly; importing for tests must not touch stdio
// (mirrors brain-serve.mjs's isMain guard).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

// Exported for unit tests / reuse — the tool table and the pure-ish helpers.
export { TOOLS, provenanceLine, buildBlast, leaseLine, ageHuman, SUPPORTED_PROTOCOLS, LATEST_PROTOCOL };
