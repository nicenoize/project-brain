/**
 * brain:serve — local Control-Room daemon (strategy doc §M2.75).
 *
 * A JSON API + SSE stream over the existing brain state
 * (active_state.md, events.jsonl, decisions/grills/findings, git-intel),
 * the M2.75 runner write API (start/stop/tail supervised runner processes
 * via runner-supervisor.mjs — a lib, not a command script), plus static
 * serving for the future `ui/dist` bundle. Node `http` only — no framework
 * (AGPL-client house rule, no new deps).
 *
 *   brain-serve.mjs [--port N] [--open]
 *
 * Security model (M2.75, mandatory — each point has its own test block):
 *   (a) binds STRICTLY to 127.0.0.1 (never 0.0.0.0);
 *   (b) per-session token from crypto.randomBytes, printed once as part of
 *       the opened URL fragment (#token=…) and required on every /api request
 *       via `Authorization: Bearer <t>` or `?token=<t>` — constant-time
 *       compare (sha256 + timingSafeEqual);
 *   (c) Origin/Host validation: a present Origin that is not
 *       http://127.0.0.1[:port] / http://localhost[:port] → 403; a Host
 *       header that is not a localhost variant → 403 (DNS-rebinding defense);
 *   (d) the ONLY write endpoints are POST /api/runners/start|stop, and the
 *       runner command is NEVER read from any request — it resolves from
 *       BRAIN_RUNNER_CMD env, else the `runnerCmd` key in
 *       .project-brain/config.json; the API references tasks/runner ids
 *       only. POSTs additionally require Content-Type application/json and
 *       cap bodies at 16KB (413; malformed JSON → 400). Every other method/
 *       path combination on /api is 405;
 *   (e) no CORS headers, ever.
 *
 * Endpoints (token-gated except the static page; GET unless noted):
 *   /api/state             workstreams+leases via activeStateJson() —
 *                          guarded read-only: never creates active_state.md
 *   /api/events?limit=N    tail of .project-brain/events.jsonl (absent → [])
 *   /api/intel/hotspots | /api/intel/co-change | /api/intel/ownership
 *                          pure git-intel.mjs cores over one spawnSync git
 *                          log (mirrors brain-intel.mjs's wiring; the command
 *                          script itself is never imported)
 *   /api/records?type=decision|grill|finding   record files + frontmatter title
 *   /api/meta              version, root, index-provider availability
 *   /api/changed           staged/unstaged file lists + current branch
 *                          (spawnSync git diff; not-a-repo → empty arrays)
 *   /api/risk?files=a,b    riskScore factors over cachedCommits (leases from
 *                          active-state read-only, blast radius only when the
 *                          repo has TS sources) + calibrateRisk cached per
 *                          HEAD; default change-set staged ∪ unstaged, empty →
 *                          {score:null, reason:'no-changes'}
 *   /api/blast?files=a,b&depth=N
 *                          "What breaks if I change this?" — depth-limited
 *                          blast radius (default 2, cap 3) around the change
 *                          set. Blends TWO edge kinds and labels each one:
 *                          'imports' edges are MEASURED (ts-graph resolved
 *                          static imports, confidence 1) and 'co-change'
 *                          edges are INFERRED (git history, confidence =
 *                          P(b|a)) — the UI shows provenance per edge
 *                          (Praktiken-Katalog: measured vs inferred). Nodes
 *                          are scored by graph proximity × edge confidence so
 *                          the list ranks "most likely to break"; measured
 *                          import edges outrank inferred history at equal
 *                          depth. Non-TS repo / missing optional `typescript`
 *                          → graphAvailable:false + `reason`, and the
 *                          co-change edges are STILL returned — the honest
 *                          degradation that works in every language. Node cap
 *                          60 (→ truncated:true, highest-scoring kept);
 *                          adjacency cached per HEAD like intelCache
 *                          (blastStats() is the test hook)
 *   /api/next              brain:route's exported PURE rule engine over
 *                          minimal read-only sensed signals — ranked next
 *                          actions (≤5, each tagged auto|human)
 *   /api/brief?files=a,b   brain-brief's exported pure core (leases +
 *                          governing ADRs) + a ~1200-token brain:pack
 *                          for-agent preview (provider 'none' or any throw →
 *                          packPreview null + packWarning, never a 500)
 *   /api/map               Doc-Navigator map: every .project-brain/modules/*
 *                          record with its derived fileGlobs, linked
 *                          decision/feature/finding counts, and a MEASURED
 *                          staleness flag (record older than
 *                          BRAIN_STALE_DOC_DAYS, default 60, OR older than the
 *                          newest commit touching its globs — "the docs are
 *                          drifting from the code", proven from git, not
 *                          guessed) + `orphans`: top-level code areas with no
 *                          module record at all — the honest gap. We do NOT
 *                          generate docs from code; we make the human/agent-
 *                          authored records navigable and connect them to files
 *   /api/doc?file=<p>      One .project-brain record: frontmatter + body
 *                          (capped 64KB) + outgoing links (decisions, modules,
 *                          files). `file` is repo-relative and validated: it
 *                          must resolve INSIDE .project-brain and end in .md —
 *                          traversal, absolute paths and non-.md → 400, and
 *                          nothing outside the brain dir is ever opened
 *   /api/fleet             "Which of my repos needs attention right now?" — the
 *                          multi-repo view for the solo agent-manager. Fleet
 *                          discovery is projects.mjs's contract (sibling dirs
 *                          one level under the fleet root, ≥2 → fleet mode);
 *                          this endpoint adds per-repo WORK STATE (dirty
 *                          counts, branch, ahead/behind, open workstreams,
 *                          active leases, lease conflicts, last commit /
 *                          staleness) and ranks it by an `attention` score
 *                          0-100 whose every contributing `reason` carries a
 *                          human message WITH the number in it. Weights are
 *                          reviewable defaults (FLEET_ATTENTION_WEIGHTS), not
 *                          a learned model; a quiet repo scores 0 with an
 *                          EMPTY reasons array — we never invent urgency.
 *                          Single repo → degraded:true + reason, active repo
 *                          still reported. Cost: exactly two git calls per
 *                          repo, hard cap 25 projects (truncated:true beyond),
 *                          memoized for a short TTL (fleetStats() is the test
 *                          hook) so a dashboard poll cannot spawn 2N git
 *                          processes a second. A repo that fails (not a git
 *                          repo, permission denied) yields `error` and never
 *                          breaks the fleet
 *   /api/why?file=<p>      "Why is this code file like this": its module, the
 *                          governing ADRs (module/glob match, mirroring
 *                          brain:radar's mapping), the open findings citing
 *                          it, and the last 5 commits touching it (read from
 *                          cachedCommits — no extra git call)
 *   /api/runners           supervised runner records (listRunners; the
 *                          record's workPackageId is exposed as `task`) +
 *                          runnerCmdConfigured
 *   POST /api/runners/start {task, acknowledged?}
 *                          brief gate: active leases held by a DIFFERENT
 *                          actor than the task's owner → 409 {briefGate,
 *                          advisories} unless acknowledged; then startRunner
 *                          + audit line runner.started → events.jsonl
 *   POST /api/runners/stop {id}   stopRunner (idempotent) + runner.stopped
 *   /api/runners/log?id=<id>&lines=N   bounded tailLog
 *   /api/stream            SSE: fs.watch on .project-brain/ (300ms debounce)
 *                          → {type:'state-changed', file}; heartbeat comment
 *                          every 25s; .project-brain/runners/ is watched
 *                          explicitly (fs.watch recursion is platform-
 *                          dependent) so runner record changes always emit
 *
 * Every JSON response carries `state_age`/`stale_warning` freshness metadata
 * (mtime-based; live-computed intel reports age 0) — Praktiken-Katalog:
 * freshness on every API/UI answer.
 *
 * Static: serves ui/dist/ (from the package) when built; else an inline,
 * deliberately unstyled status page (system font, default colors — the real
 * UI arrives later through docs/design-direction.md's pipeline). The page
 * itself is public and secret-free; it reads the token from location.hash.
 *
 * /api/state delegates to active-state.mjs, which resolves the brain root
 * via common.mjs findRoot (BRAIN_ROOT env override for tests). The pure
 * router core `createHandler({root, token})` and the checkToken/checkOrigin/
 * checkHost helpers are exported for unit tests; the isMain guard keeps
 * imports side-effect-free.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, PACKAGE_DIR, ensureDir, listIndexableFiles, takeFlag, takeOption } from './common.mjs';
import { ACTIVE_STATE, activeStateJson } from './active-state.mjs';
import { gitLogArgs, parseLog, hotspots, coChange, ownership, riskScore, calibrateRisk, fileHealth, calibrateFileHealth } from './git-intel.mjs';
// Both imports are verified side-effect-free: brain-route's isMain guard is
// asserted by tests/brain-route.test.mjs, brain-brief exports its pure core.
import { applyRules, scoreChange } from './brain-route.mjs';
import { buildBrief } from './brain-brief.mjs';
import { getIndexProvider } from './index-provider.mjs';
// Fleet discovery is a pure fs walk (no side effects at import time) — the same
// contract brain:projects/edges/handoff use, so /api/fleet cannot disagree with
// the CLI about what "the fleet" is.
import { discoverProjects, isFleetMode } from './projects.mjs';
// Canonical glob engine (same one brain:radar/brief/lease use) — the
// Doc-Navigator's module→file mapping must never disagree with lease overlap.
import { targetMatchesFile } from './lease-overlap.mjs';
import { startRunner, listRunners, stopRunner, tailLog } from './runner-supervisor.mjs';

export const DEFAULT_PORT = 4100;
const PORT_FALLBACK_ATTEMPTS = 20;
const DEFAULT_COMMIT_WINDOW = 500;
const MAX_COMMIT_WINDOW = 5000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1000;
const DEFAULT_ROW_LIMIT = 50;
const SSE_DEBOUNCE_MS = 300;
const SSE_HEARTBEAT_MS = 25_000;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 2000;
const STALE_AFTER_S = Number(process.env.BRAIN_SERVE_STALE_S || 24 * 3600);

const RECORD_DIRS = Object.freeze({
  decision: 'decisions',
  grill: 'grills',
  finding: 'findings'
});

function usage() {
  return [
    'Usage: brain-serve.mjs [--port N] [--open]',
    '',
    'Local Control Room daemon. Binds 127.0.0.1 only; the printed URL carries',
    'the per-session token — every API request must present it.',
    '',
    'Flags:',
    `  --port N   Listen port (default ${DEFAULT_PORT}; falls back to the next free port).`,
    '  --open     Open the browser (macOS `open` / linux `xdg-open`, best-effort).'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// security helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** PURE. Constant-time token equality: hash both sides, timingSafeEqual. */
export function tokenEquals(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** PURE. Extract the presented token: `Authorization: Bearer <t>` or ?token=. */
export function presentedToken(req, url) {
  const auth = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  return url.searchParams.get('token') || '';
}

/** PURE. True when the request carries the session token (constant-time). */
export function checkToken(req, url, token) {
  return tokenEquals(presentedToken(req, url), token);
}

/**
 * PURE. Origin validation: absent Origin is fine (curl, same-origin GET
 * navigations); a present Origin must be http://127.0.0.1 or http://localhost
 * — and, when the bound port is known, on exactly that port.
 */
export function checkOrigin(origin, port = null) {
  if (origin === undefined || origin === null || origin === '') return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:') return false;
  if (!LOCAL_HOSTNAMES.has(u.hostname)) return false;
  if (port !== null && port !== undefined) {
    const originPort = u.port ? Number(u.port) : 80;
    if (originPort !== Number(port)) return false;
  }
  return true;
}

/**
 * PURE. Host-header validation (DNS-rebinding defense): the Host must be a
 * localhost variant. Missing Host fails closed.
 */
export function checkHost(host) {
  if (!host) return false;
  let u;
  try { u = new URL(`http://${host}`); } catch { return false; }
  return LOCAL_HOSTNAMES.has(u.hostname);
}

// ---------------------------------------------------------------------------
// freshness + record helpers (pure-ish, exported for tests)
// ---------------------------------------------------------------------------

/** mtime-based freshness metadata for a state file (Praktiken-Katalog). */
export function freshness(file, nowMs = Date.now(), staleAfterS = STALE_AFTER_S) {
  try {
    const st = fs.statSync(file);
    const age = Math.max(0, Math.round((nowMs - st.mtimeMs) / 1000));
    const hours = Math.round(age / 360) / 10;
    return {
      state_age: age,
      stale_warning: age > staleAfterS
        ? `${path.basename(file)} last changed ${hours}h ago — data may be stale`
        : null
    };
  } catch {
    return { state_age: null, stale_warning: `${path.basename(file)} not found — empty state` };
  }
}

/** PURE. Frontmatter `title:`, else first `# ` heading, else ''. */
export function frontmatterTitle(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (fm) {
    const m = /^title:\s*(.+)\s*$/m.exec(fm[1]);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  const h = /^#\s+(.+)\s*$/m.exec(text || '');
  return h ? h[1].trim() : '';
}

/**
 * List record markdown files for a type (decision|grill|finding) with their
 * frontmatter titles. Read-only; unknown type → null (caller sends 400).
 */
export function listRecords(root, type) {
  const dirName = RECORD_DIRS[type];
  if (!dirName) return null;
  const dir = path.join(root, '.project-brain', dirName);
  const records = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) {
        let title = '';
        try { title = frontmatterTitle(fs.readFileSync(p, 'utf8').slice(0, 4096)); } catch {}
        records.push({ file: path.relative(root, p), title });
      }
    }
  };
  walk(dir);
  records.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return records;
}

// ---------------------------------------------------------------------------
// Doc-Navigator helpers (/api/map, /api/doc, /api/why) — pure, exported for
// tests. Deliberately NOT a doc generator: nothing here reads code to invent
// prose. It reads the human/agent-authored .project-brain records, derives the
// file globs they already name, and measures the drift between the two.
// ---------------------------------------------------------------------------

/** Record folders the map counts. Separate from RECORD_DIRS on purpose:
 *  /api/records' public type vocabulary must not shift underneath it. */
export const DOC_DIRS = Object.freeze({
  decisions: 'decisions',
  modules: 'modules',
  features: 'features',
  findings: 'findings',
  insights: 'insights'
});

const MAX_DOC_BYTES = 64 * 1024;
const MAX_MODULE_GLOBS = 40;
const MAX_WHY_HISTORY = 5;
const MAX_ORPHAN_DIRS = 40;
const ORPHAN_SCAN_DEPTH = 3;
const CODE_EXT_RE = /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|swift|php|cs|scala|sh|vue|svelte|c|h|cc|cpp|hpp)$/i;
// Extensions that make a slash-less backtick span a FILE rather than a dotted
// identifier — keeps `app.mjs` in and `record.symbols` out.
const KNOWN_FILE_EXT_RE = /\.(m?[jt]sx?|cjs|json|md|mdx|ya?ml|toml|sh|py|go|rs|rb|java|kt|swift|php|cs|css|scss|html|txt|lock|sql|proto|vue|svelte)$/i;
const SKIP_TOP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp', 'temp',
  'venv', '__pycache__', 'target', '.project-brain'
]);

/** Read at call time so tests (and users) can flip the threshold per process. */
export function staleDocDays() {
  const n = Number(process.env.BRAIN_STALE_DOC_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** PURE. Repo-relative normalization: strip `./`, unify separators. */
export function normPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * PURE. Frontmatter key/values + body — same shape as common.mjs parseDoc but
 * CRLF-tolerant and never throwing. Nested YAML (findings' `sources:` list)
 * is skipped by the key regex, which is exactly what callers want here.
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { data: {}, body: String(text || '') };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: m[2] || '' };
}

/**
 * PURE. Repo paths a record NAMES in backticks (`scripts/retrieval.mjs`,
 * `scripts/**`). This is the honest source for a module's fileGlobs: the
 * author already wrote which files the module owns — we just read them back
 * instead of inferring ownership from the code.
 */
export function extractPaths(text, { limit = MAX_MODULE_GLOBS } = {}) {
  const out = [];
  const seen = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = normPath(m[1]);
    if (!raw || raw.length > 200) continue;
    if (!/^[\w.@\-/*]+$/.test(raw)) continue;      // prose, commands, code → out
    if (raw.includes('/')) {
      // A path or glob: needs a star or a file extension, else it is a bare dir
      // reference like `scripts/` that would over-claim the whole tree.
      if (!raw.includes('*') && !/\.[A-Za-z0-9]{1,8}$/.test(raw)) continue;
    } else if (!KNOWN_FILE_EXT_RE.test(raw)) {
      // No slash: only a real filename counts (`app.mjs`), never an identifier
      // the prose happens to dot-qualify (`record.symbols`, `store.search`).
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * PURE. A module record's file globs: an explicit frontmatter list wins
 * (`globs:`/`fileGlobs:`/`files:`, comma-separated), else the paths its body
 * names. Explicit-first means a record can always override the derivation.
 */
export function moduleGlobs(data = {}, body = '') {
  const explicit = String(data.globs ?? data.fileGlobs ?? data.files ?? '').trim();
  if (explicit) {
    return [...new Set(explicit.split(',').map(normPath).filter(Boolean))].slice(0, MAX_MODULE_GLOBS);
  }
  return extractPaths(body);
}

/** PURE. Canonical glob/dir/exact match, delegated to the lease engine. */
export function globMatchesFile(glob, file) {
  const g = normPath(glob);
  const f = normPath(file);
  if (!g || !f) return false;
  if (g === f) return true;
  try { return targetMatchesFile(g, f); } catch { return false; }
}

/** PURE. Path heuristic mirroring brain-radar/infer's inferModule. */
export function inferModuleFromPath(file) {
  const f = normPath(file);
  if (!f) return '';
  if (f.includes('/modules/')) return path.basename(f, path.extname(f));
  const parts = f.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) {
    return parts.slice(0, 2).join('/');
  }
  return path.dirname(f) === '.' ? '' : path.dirname(f);
}

/**
 * PURE. The module owning a file: the first module record whose globs match,
 * else the path heuristic. `modules` is the loadDocRecords() shape.
 */
export function moduleForFile(file, modules = []) {
  const f = normPath(file);
  for (const rec of modules) {
    if ((rec.globs || []).some((g) => globMatchesFile(g, f))) return rec.module || rec.name;
  }
  return inferModuleFromPath(f);
}

/**
 * PURE. Module aliases used to match records by their `module:` frontmatter —
 * same widening brain:radar applies (ADRs curate short module names like
 * `retrieval` while a path infers `scripts/retrieval`).
 */
export function moduleAliases(module, file = '') {
  const last = String(module || '').split('/').filter(Boolean).pop() || '';
  const stem = file ? path.basename(normPath(file), path.extname(normPath(file))) : '';
  return new Set([module, last, stem].map((s) => String(s || '').trim()).filter(Boolean));
}

/** PURE. First real paragraph of a record body (headings/links skipped). */
export function summarize(body, max = 220) {
  for (const block of String(body || '').split(/\r?\n\s*\r?\n/)) {
    const t = block.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('|')) continue;
    const flat = t.replace(/\s+/g, ' ').replace(/^[-*]\s+/, '');
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }
  return '';
}

/**
 * PURE. The "why" excerpt of an ADR: the Decision section if the record has
 * one (that IS the answer), else Context, else the opening paragraph.
 */
export function decisionExcerpt(body, max = 280) {
  for (const heading of ['Decision', 'Context']) {
    // No `m` flag on purpose: `$` must mean end-of-record, not end-of-line,
    // or the lazy body capture stops after the section's first line.
    const re = new RegExp(`(?:^|\\n)#{1,6}[ \\t]+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}[ \\t]|$)`, 'i');
    const m = re.exec(String(body || ''));
    if (m && m[1].trim()) return summarize(m[1], max);
  }
  return summarize(body, max);
}

/**
 * Resolve a `?file=` doc parameter to an absolute path INSIDE
 * <root>/.project-brain, or null when it must be rejected (400). Rejects:
 * absolute paths (posix + windows drive), NUL bytes, non-.md, and anything
 * that escapes the brain dir after resolution — including via a symlink,
 * which is re-checked against the real path. A leading `.project-brain/` is
 * accepted (that is how every record is addressed elsewhere in the API).
 */
export function resolveBrainDoc(root, rel) {
  if (typeof rel !== 'string') return null;
  const raw = rel.trim();
  if (!raw || raw.length > 1024) return null;
  if (raw.includes('\0')) return null;
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const norm = normPath(raw);
  if (!/\.md$/i.test(norm)) return null;
  const brainDir = path.resolve(root, '.project-brain');
  const inner = norm.replace(/^\.project-brain\/+/, '');
  const resolved = path.resolve(brainDir, inner);
  const inside = (p) => p === brainDir || p.startsWith(brainDir + path.sep);
  if (!inside(resolved)) return null;
  try {
    // Symlink escape: a link inside the brain dir pointing out of it. Both
    // sides are realpath'd — on macOS the root itself is often reached through
    // a symlink (/var → /private/var), which would otherwise reject every doc.
    if (fs.existsSync(resolved)) {
      const realBrain = fs.realpathSync(brainDir);
      const realDoc = fs.realpathSync(resolved);
      if (realDoc !== realBrain && !realDoc.startsWith(realBrain + path.sep)) return null;
    }
  } catch { /* unreadable → let the caller 404 on read */ }
  return resolved;
}

/** PURE. `[[wiki-link]]` targets a record body names (deduped, bounded). */
export function wikiLinks(body, limit = 60) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    const id = m[1].trim().replace(/\.md$/i, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// runner write API helpers (security model point d — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the runner command — NEVER from any request (strategy doc security
 * model point d: a body-supplied command would be drive-by RCE). Resolution
 * order: BRAIN_RUNNER_CMD env, else the `runnerCmd` key in
 * .project-brain/config.json (file may be absent or malformed → unconfigured).
 */
export function resolveRunnerCmd(root, env = process.env) {
  if (env.BRAIN_RUNNER_CMD) return String(env.BRAIN_RUNNER_CMD);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.project-brain', 'config.json'), 'utf8'));
    if (cfg && typeof cfg.runnerCmd === 'string') return cfg.runnerCmd.trim();
  } catch { /* absent/malformed config → '' */ }
  return '';
}

/**
 * PURE. Brief-gate advisories for starting work as `owner`: every active
 * lease held by a DIFFERENT actor than the workstream's owner. Leases whose
 * `until` parses to a past timestamp are excluded; empty or unparseable
 * `until` keeps the lease visible (fail toward caution — mirrors
 * brain-intel's readLeasesSafe and state-digest's isExpiredLease).
 */
export function leaseAdvisories(leases, owner, now = Date.now()) {
  const advisories = [];
  const self = String(owner || '').trim();
  for (const lease of leases || []) {
    if (!lease || !lease.target) continue;
    const until = Date.parse(String(lease.until || '').trim());
    if (Number.isFinite(until) && until < now) continue; // expired → excluded
    const holder = String(lease.lockedBy || '').trim();
    if (holder === self) continue; // own lease → no advisory
    advisories.push({
      target: lease.target,
      lockedBy: holder,
      until: lease.until || '',
      message: `${lease.target} is leased by ${holder || 'an unknown actor'}` +
        `${lease.until ? ` until ${lease.until}` : ''}${lease.notes ? ` — ${lease.notes}` : ''}`
    });
  }
  return advisories;
}

/**
 * Append one audit line to .project-brain/events.jsonl — the audit IS the
 * product: every runner start/stop through the API leaves a durable trace.
 */
export function appendEvent(root, event) {
  const file = path.join(root, '.project-brain', 'events.jsonl');
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

/**
 * Read + parse a JSON POST body. Requires Content-Type application/json
 * (else 415); caps the body at `maxBytes` (else 413 — the remainder is
 * drained so the response can flush, with a hard cut against floods);
 * malformed JSON or a non-object top level → 400.
 * Resolves {ok:true, body} | {ok:false, code, error}; never rejects.
 */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const contentType = String(req.headers['content-type'] || '').trim();
    if (!/^application\/json\b/i.test(contentType)) {
      req.resume();
      return resolve({ ok: false, code: 415, error: 'unsupported media type: Content-Type must be application/json' });
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (settled) {
        if (size > maxBytes * 8) req.destroy(); // flood guard after the 413
        return;
      }
      if (size > maxBytes) return settle({ ok: false, code: 413, error: `payload too large (max ${maxBytes} bytes)` });
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return settle({ ok: false, code: 400, error: 'malformed JSON body' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return settle({ ok: false, code: 400, error: 'malformed JSON body: expected an object' });
      }
      settle({ ok: true, body });
    });
    req.on('error', () => settle({ ok: false, code: 400, error: 'request stream error' }));
  });
}

// ---------------------------------------------------------------------------
// git plumbing (the only impure part of the intel endpoints)
// ---------------------------------------------------------------------------

function runGitLog(root, { limit }) {
  const r = spawnSync('git', gitLogArgs({ limit }), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git log failed (status ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout || '';
}

// Parsed-commit cache keyed by HEAD + window: the three intel endpoints are
// pure functions over the same commit array, and a dashboard load hits all
// three back-to-back. Without this every request would block the single-
// threaded daemon on a fresh synchronous `git log` (1-5s on large repos).
const intelCache = { key: null, commits: null };
const healthCalCache = { key: null, value: null };

function gitHead(root) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return (head.stdout || '').trim() || 'no-head';
}

function cachedCommits(root, { limit }) {
  const key = `${gitHead(root)}|${limit}`;
  if (intelCache.key !== key) {
    intelCache.commits = parseLog(runGitLog(root, { limit }));
    intelCache.key = key;
  }
  return intelCache.commits;
}

/** One git list command (diff --name-only etc.); not-a-repo/failure → null. */
function gitList(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Staged/unstaged/branch snapshot; degrades to empty arrays outside a repo. */
function changedSnapshot(root) {
  const staged = gitList(root, ['diff', '--cached', '--name-only']);
  const unstaged = gitList(root, ['diff', '--name-only']);
  const branchOut = gitList(root, ['branch', '--show-current']);
  return {
    staged: staged || [],
    unstaged: unstaged || [],
    // `--show-current` prints nothing on a detached HEAD → null, like not-a-repo.
    branch: branchOut && branchOut.length ? branchOut[0] : null
  };
}

// Calibration cache — calibrateRisk replays history commit-by-commit (each one
// rebuilds hotspots/co-change from its strict prefix), which makes it the
// expensive part of /api/risk. Cached per HEAD like intelCache; the window is
// bounded so a huge repo cannot stall the single-threaded daemon. `computes`
// is the exported test hook proving a second request never re-runs it.
export const CALIBRATION_WINDOW = 200;
const calibrationCache = { key: null, value: null, computes: 0 };

/** Test hook: observe the calibration cache without reaching into internals. */
export function riskCalibrationStats() {
  return { key: calibrationCache.key, computes: calibrationCache.computes };
}

function cachedCalibration(root, commits) {
  const key = `${gitHead(root)}|${CALIBRATION_WINDOW}`;
  if (calibrationCache.key !== key) {
    const r = calibrateRisk(commits, { window: CALIBRATION_WINDOW });
    calibrationCache.value = {
      auc: r.auc,
      commits: r.evaluated,
      quartiles: r.quantiles.map((q) => ({ q: q.quantile, defectRate: q.defectRate })),
      verdictLine: r.verdict,
      note: 'in-repo self-calibration, not a cross-repo benchmark'
    };
    calibrationCache.key = key;
    calibrationCache.computes += 1;
  }
  return calibrationCache.value;
}

// TS import-graph for the blast-radius factor, cached per HEAD (graph builds
// can take seconds on large TS repos; working-tree-only edits stay invisible
// until committed — acceptable staleness for a read-only dashboard). Mirrors
// brain-intel.mjs#blastRadiusFor: null (factor omitted) for non-TS repos,
// a missing optional `typescript` dep, or any failure. Never throws.
const tsGraphCache = { key: null, ctx: null, indexable: null, tsFiles: 0, reason: null };

/**
 * Load (and cache per HEAD) the ts-graph semantic context. Unlike
 * blastRadiusFor this keeps the REASON a graph is missing, because /api/blast
 * has to explain the degradation instead of silently dropping the factor.
 * Never throws: every failure becomes {ctx:null, reason}.
 */
async function tsGraphFor(root) {
  if (process.env.BRAIN_TS_GRAPH === '0') {
    return { ctx: null, indexable: [], tsFiles: 0, reason: 'static import graph disabled via BRAIN_TS_GRAPH=0' };
  }
  const key = gitHead(root);
  if (tsGraphCache.key !== key) {
    let indexable = [];
    let tsFiles = 0;
    let ctx = null;
    let reason = null;
    try {
      indexable = await listIndexableFiles();
      tsFiles = indexable.filter((f) => /\.(ts|tsx)$/.test(f)).length;
      // Cheap guard first: without TS sources the loose program is empty
      // anyway, and loading the optional `typescript` package costs time.
      if (tsFiles > 0) {
        const { loadTsSemanticContext } = await import('./ts-graph.mjs');
        ctx = (await loadTsSemanticContext(root, new Set(indexable))) || null;
        if (!ctx) reason = 'no TypeScript program — install the optional `typescript` dependency (npm i -D typescript)';
      } else {
        reason = 'no .ts/.tsx sources indexed — static import graph unavailable for this repo';
      }
    } catch (error) {
      ctx = null;
      reason = `static import graph unavailable: ${error.message || error}`;
    }
    tsGraphCache.ctx = ctx;
    tsGraphCache.indexable = indexable;
    tsGraphCache.tsFiles = tsFiles;
    tsGraphCache.reason = reason;
    tsGraphCache.key = key;
  }
  return {
    ctx: tsGraphCache.ctx,
    indexable: tsGraphCache.indexable || [],
    tsFiles: tsGraphCache.tsFiles,
    reason: tsGraphCache.ctx ? null : tsGraphCache.reason
  };
}

async function blastRadiusFor(root, files) {
  try {
    const { ctx, indexable } = await tsGraphFor(root);
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
const BLAST_MAX_FANOUT = 25;
// Score decay per hop, and the discount applied to inferred (history) edges so
// a MEASURED import dependent always outranks an INFERRED co-change partner at
// equal depth and equal confidence.
const BLAST_DEPTH_DECAY = 0.6;
const BLAST_INFERRED_WEIGHT = 0.85;

/** Per-edge provenance contract the UI renders against (measured vs inferred). */
const BLAST_PROVENANCE = Object.freeze({
  basis: 'mixed',
  source: 'ts-graph static imports (measured) ⊕ git-log co-change (inferred)',
  edgeKinds: Object.freeze({
    imports: 'measured — compiler-resolved static import',
    'co-change': 'inferred — files landed in the same commits, confidence = P(b|a)'
  })
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
 *   importers: file → [files that statically import it]  (MEASURED, ts-graph)
 *   partners:  file → [{file, confidence}] co-change      (INFERRED, git log)
 * Co-change partners can name deleted files — history is reported as it
 * happened; the UI marks those edges inferred anyway.
 */
async function blastAdjacency(root, commits) {
  const key = `${gitHead(root)}|${DEFAULT_COMMIT_WINDOW}`;
  if (blastCache.key === key && blastCache.value) return blastCache.value;
  const { ctx, indexable, tsFiles, reason } = await tsGraphFor(root);
  const importers = new Map();
  if (ctx) {
    for (const rel of indexable) {
      const info = ctx.get(rel);
      for (const imported of info?.resolvedImports || []) {
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
  for (const list of partners.values()) {
    list.sort((x, y) => y.confidence - x.confidence || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  }
  const value = {
    importers,
    partners,
    graphAvailable: Boolean(ctx),
    tsFiles,
    reason: ctx ? null : reason,
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
 * MEASURED — the compiler resolved that module specifier, confidence 1. A
 * 'co-change' edge is INFERRED — the two files landed in the same commits,
 * confidence = P(b|a) from git history. Node score is the best path product
 * seen: parent_score × edge_confidence × kind_weight × depth_decay. Nodes
 * reached by any measured edge are 'dependent'; history-only nodes are
 * 'co-change'.
 */
function buildBlast({ seeds, importers, partners, depth }) {
  const nodes = new Map();
  for (const file of seeds) nodes.set(file, { file, kind: 'seed', depth: 0, score: 1 });
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
          .map((file) => ({ file, kind: 'imports', confidence: 1, weight: 1 })),
        ...(partners.get(from) || []).slice(0, BLAST_MAX_FANOUT)
          .map((p) => ({ file: p.file, kind: 'co-change', confidence: p.confidence, weight: BLAST_INFERRED_WEIGHT }))
      ];
      for (const exp of expansions) {
        addEdge(from, exp.file, exp.kind, exp.confidence);
        if (exp.file === from) continue;
        const score = parent.score * exp.confidence * exp.weight * BLAST_DEPTH_DECAY;
        const existing = nodes.get(exp.file);
        const kind = exp.kind === 'imports' ? 'dependent' : 'co-change';
        if (!existing) {
          nodes.set(exp.file, { file: exp.file, kind, depth: d, score });
          next.push(exp.file);
          continue;
        }
        if (existing.kind === 'seed') continue; // the question itself never demotes
        existing.score = Math.max(existing.score, score);
        existing.depth = Math.min(existing.depth, d);
        if (kind === 'dependent') existing.kind = 'dependent'; // measured wins
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
    nodes: [...seedNodes, ...kept].map((n) => ({ ...n, score: Math.round(n.score * 1000) / 1000 })),
    edges: keptEdges,
    truncated
  };
}

// ---------------------------------------------------------------------------
// fleet view — "which of my repos needs attention right now?" (/api/fleet)
//
// The multi-repo answer for the solo agent-manager: free tier, purely local,
// no server. Discovery is projects.mjs's contract (sibling projects one level
// under the fleet root; ≥2 auto-activates fleet mode; per-project tagging in
// active_state.md). What this adds is WORK STATE per repo and a ranking.
//
// Deliberately NOT code intel: fileHealth/hotspots are never run per repo. The
// question here is "where is work stuck", not "which file is dangerous", and N
// repos × a git-log walk would make a dashboard refresh unusable. /api/risk,
// /api/blast and /api/why answer the code-intel question for ONE repo.
//
// Cost per project: exactly TWO git calls —
//   git status --porcelain=v2 --branch   → dirty counts + branch + ahead/behind
//   git log -1                            → last commit hash/subject/date
// bounded by FLEET_MAX_PROJECTS and memoized for FLEET TTL ms (see fleetTtlMs)
// so a dashboard poll loop cannot spawn 2N git processes per second. The
// per-HEAD caching used elsewhere (intelCache/blastCache) is wrong here: there
// is no single HEAD across N repos, so a short wall-clock TTL is the honest
// bound. `fleetStats()` is the test hook, like blastStats/riskCalibrationStats.
// ---------------------------------------------------------------------------

/** Hard cap: beyond this the answer is truncated:true, never slower. */
export const FLEET_MAX_PROJECTS = 25;
const FLEET_DEFAULT_TTL_MS = 5_000;

/** Read at call time so a dashboard (or a test) can retune the poll window. */
export function fleetTtlMs() {
  const n = Number(process.env.BRAIN_FLEET_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : FLEET_DEFAULT_TTL_MS;
}

/**
 * Attention weights — REVIEWABLE DEFAULTS, not a learned model and not
 * calibrated against anything. They encode one opinion, stated plainly so a
 * reader can disagree with it:
 *
 *   leaseConflict        two actors hold work in the same repo → highest,
 *                        because it is the only failure that corrupts someone
 *                        else's work rather than just delaying yours
 *   dirtyStale           uncommitted work sitting on top of an old commit —
 *                        the classic "I forgot this repo" state
 *   abandonedWorkstream  a workstream was started and the repo went quiet
 *   unpushed             local commits nobody else can see yet
 *   staleWithWorkstream  the harder version of abandoned: quiet for a week+
 *                        while a workstream is still open (fires IN ADDITION
 *                        to abandonedWorkstream — deliberate escalation)
 *   behind               upstream moved; a rebase is owed (lowest: it costs
 *                        you time, not correctness)
 *
 * The score is the plain sum of the firing reasons, clamped to 100. A repo
 * with nothing to report scores 0 with an EMPTY reasons array — the endpoint
 * never invents urgency to fill a dashboard.
 */
export const FLEET_ATTENTION_WEIGHTS = Object.freeze({
  leaseConflict: 40,
  dirtyStale: 25,
  abandonedWorkstream: 20,
  unpushed: 15,
  staleWithWorkstream: 15,
  behind: 10
});

/** Day thresholds the weights fire at — reviewable defaults, same as above. */
export const FLEET_ATTENTION_THRESHOLDS = Object.freeze({
  dirtyStaleDays: 2,
  abandonedDays: 3,
  staleDays: 7
});

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
const whole = (days) => Math.max(0, Math.round(Number(days) || 0));

/**
 * PURE. Attention score + reasons for one project's measured work state.
 *
 * Every contributing reason carries a human message WITH its number in it —
 * a bare score is not an answer, and "3 files staged for 6 days" is what the
 * human actually acts on. Reasons come back weight-descending.
 */
export function fleetAttention(p, { weights = FLEET_ATTENTION_WEIGHTS, thresholds = FLEET_ATTENTION_THRESHOLDS } = {}) {
  const reasons = [];
  const staged = Number(p?.dirty?.staged || 0);
  const unstaged = Number(p?.dirty?.unstaged || 0);
  const dirty = staged + unstaged;
  const days = p?.staleDays === null || p?.staleDays === undefined ? null : Number(p.staleDays);
  const workstreams = Number(p?.workstreams || 0);
  const conflicts = Number(p?.conflicts || 0);
  const ahead = Number(p?.ahead || 0);
  const behind = Number(p?.behind || 0);
  const branch = p?.branch || 'HEAD';

  if (conflicts > 0) {
    const others = (p?.conflictActors || []).filter(Boolean);
    reasons.push({
      kind: 'lease-conflict',
      weight: weights.leaseConflict,
      message: `${plural(conflicts, 'active lease')} held by a different actor` +
        `${others.length ? ` (${others.join(', ')})` : ''} — two workers in one repo`
    });
  }
  if (dirty > 0 && days !== null && days >= thresholds.dirtyStaleDays) {
    reasons.push({
      kind: 'dirty-stale',
      weight: weights.dirtyStale,
      message: `${plural(staged, 'file')} staged and ${plural(unstaged, 'file')} unstaged, ` +
        `${plural(whole(days), 'day')} since the last commit`
    });
  }
  if (workstreams > 0 && days !== null && days >= thresholds.abandonedDays) {
    reasons.push({
      kind: 'abandoned-workstream',
      weight: weights.abandonedWorkstream,
      message: `${plural(workstreams, 'open workstream')} with no commit for ${plural(whole(days), 'day')}`
    });
  }
  if (ahead > 0) {
    reasons.push({
      kind: 'unpushed',
      weight: weights.unpushed,
      message: `${plural(ahead, 'commit')} unpushed on ${branch}`
    });
  }
  if (workstreams > 0 && days !== null && days >= thresholds.staleDays) {
    reasons.push({
      kind: 'stale',
      weight: weights.staleWithWorkstream,
      message: `no commit in ${plural(whole(days), 'day')} while ${plural(workstreams, 'workstream')} ${workstreams === 1 ? 'is' : 'are'} open`
    });
  }
  if (behind > 0) {
    reasons.push({
      kind: 'behind',
      weight: weights.behind,
      message: `${plural(behind, 'commit')} behind upstream on ${branch}`
    });
  }

  reasons.sort((a, b) => b.weight - a.weight || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const attention = Math.min(100, reasons.reduce((sum, r) => sum + r.weight, 0));
  return { attention, reasons };
}

/**
 * PURE. Parse `git status --porcelain=v2 --branch` — ONE call that carries the
 * dirty counts, the branch AND the ahead/behind pair, which is why it is the
 * only status call the fleet view makes.
 *
 *   `# branch.head <name>` → branch ('(detached)' → null)
 *   `# branch.ab +A -B`    → ahead/behind (absent when there is no upstream)
 *   `1`/`2` entries        → XY codes: X is the staged side, Y the worktree
 *   `u` entries            → unmerged paths, counted as unstaged work
 *   `?` entries            → untracked (git collapses whole dirs), unstaged
 */
export function parseGitStatusV2(text) {
  let branch = null;
  let ahead = null;
  let behind = null;
  let staged = 0;
  let unstaged = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      branch = value && value !== '(detached)' ? value : null;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      continue;
    }
    if (line.startsWith('# ')) continue;
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      const xy = line.split(' ')[1] || '..';
      if (xy[0] && xy[0] !== '.') staged += 1;
      if (xy[1] && xy[1] !== '.') unstaged += 1;
    } else if (kind === 'u' || kind === '?') {
      unstaged += 1;
    }
  }
  return { branch, ahead, behind, staged, unstaged };
}

const CLOSED_WORKSTREAM_RE = /^(done|closed|cancell?ed|abandoned|merged|complete[d]?)$/i;

/** PURE. A workstream counts as open unless its status says it finished. */
export function isOpenWorkstream(w) {
  return !CLOSED_WORKSTREAM_RE.test(String(w?.status || '').trim());
}

/**
 * PURE. Per-repo state facts from the fleet brain's active_state.md rows.
 *
 * Fleet mode filters by the `project` column (that is what per-project tagging
 * is for); single-repo mode passes everything through, exactly like
 * brain-handoff's collectProjectStatus — legacy rows have no project cell.
 *
 * Conflicts are DIFFERENT ACTORS, not "any lease": one actor holding leases in
 * their own repo is normal work. A conflict needs ≥2 distinct actors among the
 * repo's active leases, its open workstream owners and (when set) BRAIN_ACTOR;
 * the count is then the leases NOT held by the repo's home actor.
 */
export function fleetProjectState(name, state, { fleet = true, now = Date.now(), actor = '' } = {}) {
  const mine = (rows) => (rows || []).filter((r) => (fleet ? String(r?.project || '').trim() === name : true));
  const workstreams = mine(state?.workstreams).filter(isOpenWorkstream);
  const leases = mine(state?.leases).filter((l) => {
    if (!l?.target) return false;
    const until = Date.parse(String(l.until || '').trim());
    return !(Number.isFinite(until) && until < now); // unparseable → kept (caution)
  });

  const owners = workstreams.map((w) => String(w.owner || '').trim()).filter(Boolean);
  const holders = leases.map((l) => String(l.lockedBy || '').trim()).filter(Boolean);
  const me = String(actor || '').trim();
  const actors = new Set([...owners, ...holders, ...(me ? [me] : [])]);
  const home = owners[0] || me || holders[0] || '';
  const conflicting = actors.size >= 2 && home
    ? leases.filter((l) => String(l.lockedBy || '').trim() && String(l.lockedBy || '').trim() !== home)
    : [];

  return {
    workstreams: workstreams.length,
    leases: leases.length,
    conflicts: conflicting.length,
    conflictActors: [...new Set(conflicting.map((l) => String(l.lockedBy || '').trim()))].sort()
  };
}

/** ONE `git status --porcelain=v2 --branch`; failure → {error} (never throws). */
function gitWorkState(dir) {
  const r = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (r.error) return { error: String(r.error.message || r.error) };
  if (r.status !== 0) {
    const stderr = String(r.stderr || '').trim().split('\n')[0];
    return { error: stderr || `git status failed (status ${r.status})` };
  }
  return parseGitStatusV2(r.stdout || '');
}

/** ONE `git log -1`; an empty repo (or any failure) → null, never a throw. */
function gitLastCommit(dir) {
  const r = spawnSync('git', ['--no-optional-locks', 'log', '-1', '--pretty=format:%h\x1f%s\x1f%aI'], {
    cwd: dir,
    encoding: 'utf8'
  });
  if (r.error || r.status !== 0) return null;
  const [hash, subject, dateIso] = String(r.stdout || '').split('\x1f');
  if (!hash) return null;
  return { hash: hash.trim(), subject: (subject || '').trim(), dateIso: (dateIso || '').trim() };
}

/** One project row: two git calls + the brain's own state, ranked. */
function collectFleetProject({ name, absDir, isActive, state, fleet, now, actor }) {
  const row = {
    name,
    path: absDir,
    isActive,
    attention: 0,
    reasons: [],
    dirty: { staged: 0, unstaged: 0 },
    branch: null,
    ahead: null,
    behind: null,
    workstreams: 0,
    leases: 0,
    conflicts: 0,
    lastCommit: null,
    staleDays: null
  };
  const facts = fleetProjectState(name, state, { fleet, now, actor });
  row.workstreams = facts.workstreams;
  row.leases = facts.leases;
  row.conflicts = facts.conflicts;

  const work = gitWorkState(absDir);
  if (work.error) {
    // A broken project reports itself and drops out of the ranking; the fleet
    // answer must never fail because one sibling is not a git repo.
    row.error = work.error;
    return row;
  }
  row.dirty = { staged: work.staged, unstaged: work.unstaged };
  row.branch = work.branch;
  row.ahead = work.ahead;
  row.behind = work.behind;

  const last = gitLastCommit(absDir);
  if (last) {
    row.lastCommit = last;
    const t = Date.parse(last.dateIso);
    if (Number.isFinite(t)) row.staleDays = Math.round(((now - t) / 86_400_000) * 10) / 10;
  }

  const scored = fleetAttention({ ...row, conflictActors: facts.conflictActors });
  row.attention = scored.attention;
  row.reasons = scored.reasons;
  return row;
}

/** Which project (if any) holds the cwd the daemon was started in? */
function activeProjectFor(root, cwd, projects) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const here = real(cwd || root);
  for (const p of projects) {
    const abs = real(path.join(root, p.dir));
    if (here === abs || here.startsWith(abs + path.sep)) return p.name;
  }
  return null;
}

/**
 * Build the whole fleet answer. Degrades — never throws — in three ways:
 * discovery failure (duplicate project names) → degraded + reason; fewer than
 * two projects (or BRAIN_FLEET_MODE=0) → degraded, showing only the repo the
 * daemon was started in; a per-project git failure → that row's `error`.
 */
function buildFleet({ root, cwd, state, now = Date.now(), actor = '' }) {
  let discovered = [];
  let discoveryError = null;
  try { discovered = discoverProjects(root); }
  catch (error) { discoveryError = String(error.message || error); }

  // `discovered.length` guard: BRAIN_FLEET_MODE=1 forces fleet mode on, but an
  // empty fleet is still nothing to show — fall back to the active repo.
  const fleet = !discoveryError && discovered.length > 0 && isFleetMode(discovered);
  if (!fleet) {
    const name = path.basename(root) || root;
    const reason = discoveryError
      ? `fleet discovery failed: ${discoveryError} — showing the active repo only`
      : process.env.BRAIN_FLEET_MODE === '0'
        ? 'fleet mode disabled via BRAIN_FLEET_MODE=0 — showing the active repo only'
        : `fleet mode off: ${discovered.length} sibling project${discovered.length === 1 ? '' : 's'} discovered under ${root} ` +
          '(fleet mode needs ≥2) — showing the active repo only. See docs/solo-multi-repo-setup.md';
    return {
      fleetRoot: null,
      active: name,
      projects: [collectFleetProject({ name, absDir: root, isActive: true, state, fleet: false, now, actor })],
      degraded: true,
      reason,
      truncated: false,
      discovered: discovered.length
    };
  }

  const kept = discovered.slice(0, FLEET_MAX_PROJECTS);
  const activeName = activeProjectFor(root, cwd, kept);
  const projects = kept.map((p) => collectFleetProject({
    name: p.name,
    absDir: path.join(root, p.dir),
    isActive: p.name === activeName,
    state,
    fleet: true,
    now,
    actor
  }));
  projects.sort((a, b) => b.attention - a.attention || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    fleetRoot: root,
    active: activeName || path.basename(root) || root,
    projects,
    degraded: false,
    truncated: discovered.length > kept.length,
    discovered: discovered.length
  };
}

// Wall-clock TTL memo (see the section header for why per-HEAD caching cannot
// work across N repos). `computes` is the exported test hook.
const fleetCache = { key: null, value: null, at: 0, computes: 0 };

/** Test hook: observe the fleet TTL cache without reaching into internals. */
export function fleetStats() {
  return { key: fleetCache.key, computes: fleetCache.computes, ttlMs: fleetTtlMs() };
}

function cachedFleet({ root, cwd, state, actor }) {
  const key = `${root}|${cwd}`;
  const ttl = fleetTtlMs();
  const now = Date.now();
  if (fleetCache.key === key && fleetCache.value && now - fleetCache.at < ttl) return fleetCache.value;
  fleetCache.value = buildFleet({ root, cwd, state, now, actor });
  fleetCache.key = key;
  fleetCache.at = now;
  fleetCache.computes += 1;
  return fleetCache.value;
}

// ---------------------------------------------------------------------------
// built-in status page (deliberately unstyled beyond system-font basics —
// the real UI comes later through docs/design-direction.md's pipeline)
// ---------------------------------------------------------------------------

const STATUS_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>project-brain — Control Room (status)</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}table{border-collapse:collapse}td,th{border:1px solid #999;padding:2px 8px;text-align:left}</style>
</head>
<body>
<h1>project-brain serve — status</h1>
<p>Minimal status page (the Control Room UI is not built yet). It proves the API using the token from the URL fragment.</p>
<div id="out">loading…</div>
<script>
(function () {
  var out = document.getElementById('out');
  var m = /(?:^|[#&])token=([^&]+)/.exec(location.hash);
  if (!m) { out.textContent = 'No token in URL fragment. Start via "project-brain serve" and open the printed URL.'; return; }
  var headers = { Authorization: 'Bearer ' + decodeURIComponent(m[1]) };
  function fetchJson(p) {
    return fetch(p, { headers: headers }).then(function (r) {
      if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
      return r.json();
    });
  }
  Promise.all([fetchJson('/api/meta'), fetchJson('/api/state')]).then(function (res) {
    var meta = res[0], state = res[1];
    var html = '<h2>meta</h2><pre>' + JSON.stringify(meta, null, 2).replace(/</g, '&lt;') + '</pre>';
    function table(rows, cols) {
      if (!rows.length) return '<p>(none)</p>';
      var h = '<table><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
      rows.forEach(function (r) {
        h += '<tr>' + cols.map(function (c) { return '<td>' + String(r[c] || '').replace(/</g, '&lt;') + '</td>'; }).join('') + '</tr>';
      });
      return h + '</table>';
    }
    html += '<h2>workstreams</h2>' + table(state.workstreams || [], ['taskId', 'owner', 'tool', 'branch', 'status']);
    html += '<h2>leases</h2>' + table(state.leases || [], ['target', 'lockedBy', 'until', 'notes']);
    if (state.stale_warning) html += '<p>' + String(state.stale_warning).replace(/</g, '&lt;') + '</p>';
    out.innerHTML = html;
  }).catch(function (e) { out.textContent = 'API error: ' + e.message; });
})();
</script>
</body>
</html>
`;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

// ---------------------------------------------------------------------------
// request router core (exported; testable without binding a port)
// ---------------------------------------------------------------------------

/**
 * Build the node http handler. `ctx.port` may be filled in after listen()
 * (used to pin the Origin check to the bound port); until then any localhost
 * origin passes. `ctx.cwd` (optional) is the directory the daemon was started
 * in — /api/fleet uses it to mark which fleet project is the active one;
 * omitted → process.cwd(). `handler.close()` tears down SSE clients + the fs
 * watcher.
 */
export function createHandler(ctx) {
  const { root, token } = ctx;
  if (!root || !token) throw new Error('createHandler requires { root, token }');
  const brainDir = path.join(root, '.project-brain');
  const runnersDir = path.join(brainDir, 'runners');
  const runnerLogDir = path.join(brainDir, 'runner-logs');
  const uiDist = ctx.uiDist || path.join(PACKAGE_DIR, 'ui', 'dist');

  // --- SSE plumbing (shared watchers, per-connection response set) ---
  const sseClients = new Set();
  let watcher = null;
  let runnersWatcher = null;
  let pendingFiles = new Set();
  let flushTimer = null;

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(frame);
  }

  function queueChange(file) {
    pendingFiles.add(file || '');
    if (flushTimer) return; // debounce: one flush per quiet window
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const files = [...pendingFiles];
      pendingFiles = new Set();
      for (const f of files) broadcast({ type: 'state-changed', file: f });
    }, SSE_DEBOUNCE_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  // fs.watch recursion is platform-dependent (darwin: yes; elsewhere: maybe
  // not), so runner record changes get their own explicit watcher. Guarded:
  // the dir may not exist yet — retried on every brainDir event, stream
  // connection, and successful runner start.
  function ensureRunnersWatcher() {
    if (runnersWatcher || !fs.existsSync(runnersDir)) return;
    try {
      runnersWatcher = fs.watch(runnersDir, (_event, file) =>
        queueChange(file ? `runners/${file}` : 'runners'));
    } catch {
      runnersWatcher = null;
    }
  }

  function ensureWatcher() {
    ensureRunnersWatcher();
    if (watcher || !fs.existsSync(brainDir)) return;
    try {
      watcher = fs.watch(brainDir, { recursive: true }, (_event, file) => {
        ensureRunnersWatcher(); // runners/ may have appeared after connect
        // Normalize separators so an event seen by both watchers dedupes.
        queueChange(file ? String(file).split(path.sep).join('/') : '');
      });
    } catch {
      watcher = null; // watch unsupported → stream still serves heartbeats
    }
  }

  function sendJson(res, code, obj) {
    // No CORS headers — ever (security model point e).
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }

  // --- API endpoints (all read-only) ---

  function apiState(res) {
    // Read-only guard: activeStateJson() would CREATE the file via
    // ensureActiveState(); a dashboard query must never write brain state.
    if (!fs.existsSync(ACTIVE_STATE)) {
      return sendJson(res, 200, {
        workstreams: [], leases: [], blockers: [], overlaps: [],
        ...freshness(ACTIVE_STATE)
      });
    }
    sendJson(res, 200, { ...activeStateJson(), ...freshness(ACTIVE_STATE) });
  }

  function apiEvents(res, url) {
    const file = path.join(brainDir, 'events.jsonl');
    const raw = Number(url.searchParams.get('limit') || DEFAULT_EVENT_LIMIT);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);
    if (!fs.existsSync(file)) {
      return sendJson(res, 200, { events: [], ...freshness(file) });
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    // Tail AFTER parsing so malformed lines never eat into the limit.
    sendJson(res, 200, { events: parsed.slice(-limit), ...freshness(file) });
  }

  function apiIntel(res, url, kind) {
    const rawCommits = Number(url.searchParams.get('commits') || DEFAULT_COMMIT_WINDOW);
    const commitsCap = Math.min(Math.max(Number.isFinite(rawCommits) ? Math.floor(rawCommits) : DEFAULT_COMMIT_WINDOW, 1), MAX_COMMIT_WINDOW);
    const rawLimit = Number(url.searchParams.get('limit') || DEFAULT_ROW_LIMIT);
    const limit = Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_ROW_LIMIT, 1);
    // Live-computed from git at request time → age 0 by construction.
    const live = { state_age: 0, stale_warning: null, generated_at: new Date().toISOString() };
    let commits;
    try {
      commits = cachedCommits(root, { limit: commitsCap });
    } catch (error) {
      // Empty-state friendliness: not-a-repo is a degraded 200, not a 500.
      const empty = kind === 'hotspots' || kind === 'health' ? { files: [] } : kind === 'co-change' ? { pairs: [] } : { prefixes: [], files: [] };
      return sendJson(res, 200, { ...empty, warning: `git history unavailable: ${error.message || error}`, ...live });
    }
    if (kind === 'health') {
      // Per-file danger score + its per-HEAD-cached calibration receipt.
      const r = fileHealth(commits, { now: Date.now() });
      let calibration = null;
      try {
        if (healthCalCache.key !== intelCache.key) {
          const cal = calibrateFileHealth(commits, { window: Math.min(commits.length, 300) });
          healthCalCache.key = intelCache.key;
          healthCalCache.value = cal ? {
            auc: cal.auc ?? null,
            files: cal.evaluated ?? null,
            quartiles: (cal.quantiles || []).map((q) => ({
              q: q.q ?? q.label ?? '',
              defectRate: q.defectRate ?? q.rate ?? 0
            })),
            verdictLine: cal.verdict || '',
            note: 'in-repo self-calibration, not a cross-repo benchmark'
          } : null;
        }
        calibration = healthCalCache.value;
      } catch { calibration = null; }
      return sendJson(res, 200, { ...r, files: r.files.slice(0, limit), calibration, ...live });
    }
    if (kind === 'hotspots') {
      const r = hotspots(commits, { now: Date.now() }); // `now` is required by the pure core
      return sendJson(res, 200, { ...r, files: r.files.slice(0, limit), ...live });
    }
    if (kind === 'co-change') {
      const r = coChange(commits);
      return sendJson(res, 200, { ...r, pairs: r.pairs.slice(0, limit), ...live });
    }
    const r = ownership(commits);
    sendJson(res, 200, { ...r, prefixes: r.prefixes.slice(0, limit), files: r.files.slice(0, limit), ...live });
  }

  function apiRecords(res, url) {
    const type = url.searchParams.get('type') || '';
    const records = listRecords(root, type);
    if (records === null) {
      return sendJson(res, 400, { error: `unknown record type "${type}" — expected one of: ${Object.keys(RECORD_DIRS).join(', ')}` });
    }
    const dir = path.join(brainDir, RECORD_DIRS[type]);
    let newest = null;
    for (const r of records) {
      try {
        const m = fs.statSync(path.join(root, r.file)).mtimeMs;
        if (newest === null || m > newest) newest = m;
      } catch {}
    }
    if (newest === null) return sendJson(res, 200, { type, records, ...freshness(dir) });
    // Records are durable documents — age is informational, never a warning.
    const age = Math.max(0, Math.round((Date.now() - newest) / 1000));
    sendJson(res, 200, { type, records, state_age: age, stale_warning: null });
  }

  let providerPromise = null;
  function providerInfo() {
    if (!providerPromise) {
      providerPromise = getIndexProvider()
        .then((p) => ({ name: p.name, model: p.modelName || null, available: p.name !== 'none' }))
        .catch((error) => ({ name: 'unavailable', model: null, available: false, error: String(error.message || error) }));
    }
    return providerPromise;
  }

  async function apiMeta(res) {
    const provider = await providerInfo();
    let version = '0.0.0';
    try {
      version = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version || version;
    } catch {}
    sendJson(res, 200, {
      name: 'project-brain serve',
      version,
      root,
      node: process.version,
      port: ctx.port ?? null,
      provider,
      ...freshness(ACTIVE_STATE)
    });
  }

  // --- answer endpoints (read-only intelligence the CLI already computes) ---

  /** Live-computed responses report age 0 by construction (like apiIntel). */
  function liveMeta() {
    return { state_age: 0, stale_warning: null, generated_at: new Date().toISOString() };
  }

  // Cost cap on ?files= — beyond this the request is malformed, not degraded.
  const MAX_FILES_PARAM = 500;

  /** ?files=a,b,c → cleaned array; param absent → null (caller senses git). */
  function filesParam(url) {
    const raw = url.searchParams.get('files');
    if (raw === null) return null;
    return raw.split(',').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);
  }

  /** Explicit ?files= when present, else staged ∪ unstaged (deduped, sorted). */
  function targetFiles(url) {
    const explicit = filesParam(url);
    if (explicit !== null) return [...new Set(explicit)].sort();
    const snapshot = changedSnapshot(root);
    return [...new Set([...snapshot.staged, ...snapshot.unstaged])].sort();
  }

  /** Active (non-expired) leases, read-only — mirrors brain-intel#readLeasesSafe. */
  function readLeasesSafe(nowMs) {
    try {
      if (!fs.existsSync(ACTIVE_STATE)) return null;
      return activeStateJson().leases.filter((l) => {
        if (!l.target) return false;
        const until = Date.parse(l.until);
        return !(Number.isFinite(until) && until < nowMs);
      });
    } catch {
      return null;
    }
  }

  function apiChanged(res) {
    sendJson(res, 200, { ...changedSnapshot(root), ...liveMeta() });
  }

  async function apiRisk(res, url) {
    const explicit = filesParam(url);
    if (explicit && explicit.length > MAX_FILES_PARAM) {
      return sendJson(res, 400, { error: `too many files (max ${MAX_FILES_PARAM})` });
    }
    const files = targetFiles(url);
    if (!files.length) {
      // Empty-state friendliness: an empty change-set is a 200, not an error.
      return sendJson(res, 200, { score: null, reason: 'no-changes', files: [], factors: [], calibration: null, ...liveMeta() });
    }
    let commits;
    try {
      commits = cachedCommits(root, { limit: DEFAULT_COMMIT_WINDOW });
    } catch (error) {
      return sendJson(res, 200, {
        score: null,
        reason: `git history unavailable: ${error.message || error}`,
        files, factors: [], calibration: null, ...liveMeta()
      });
    }
    // Wired exactly like brain-intel's --score path: hotspots + co-change from
    // the shared commit window, leases read-only from active-state, blast
    // radius only when the repo makes it cheap/possible (TS sources present).
    const now = Date.now();
    const hs = hotspots(commits, { now });
    const cc = coChange(commits);
    const leases = readLeasesSafe(now);
    const blastRadius = await blastRadiusFor(root, files);
    const scored = riskScore(files, {
      hotspots: hs,
      coChange: cc,
      ...(blastRadius ? { blastRadius } : {}),
      ...(leases ? { leases } : {})
    });
    sendJson(res, 200, {
      files: scored.files,
      score: scored.score,
      ...(scored.reason ? { reason: scored.reason } : {}),
      // `data` (full partner/conflict/dependent lists) is dropped to bound the
      // payload — the evidence string already summarizes each factor.
      factors: scored.factors.map(({ data, ...f }) => f),
      provenance: { basis: scored.basis, source: scored.source, window: scored.window },
      calibration: cachedCalibration(root, commits),
      ...liveMeta()
    });
  }

  /**
   * "What breaks if I change this?" — see the file header for the blend rule.
   * Degradation ladder, never a 500: no seeds → empty answer with
   * reason 'no-changes'; no git history → co-change edges empty + warning; no
   * TS graph → graphAvailable:false + reason, co-change edges still returned.
   */
  async function apiBlast(res, url) {
    const explicit = filesParam(url);
    if (explicit && explicit.length > MAX_FILES_PARAM) {
      return sendJson(res, 400, { error: `too many files (max ${MAX_FILES_PARAM})` });
    }
    const rawDepth = Number(url.searchParams.get('depth') || BLAST_DEFAULT_DEPTH);
    const depth = Math.min(
      Math.max(Number.isFinite(rawDepth) ? Math.floor(rawDepth) : BLAST_DEFAULT_DEPTH, 1),
      BLAST_MAX_DEPTH
    );
    const files = targetFiles(url);
    if (!files.length) {
      // Empty change-set is a 200 like /api/risk — and costs nothing: neither
      // the TS program nor git log is touched when there is no question.
      return sendJson(res, 200, {
        files: [], nodes: [], edges: [], truncated: false,
        graphAvailable: false,
        coverage: { tsFiles: 0, totalSeeds: 0 },
        reason: 'no-changes',
        depth,
        provenance: BLAST_PROVENANCE,
        ...liveMeta()
      });
    }
    let commits = [];
    let warning;
    try {
      commits = cachedCommits(root, { limit: DEFAULT_COMMIT_WINDOW });
    } catch (error) {
      warning = `git history unavailable: ${error.message || error} — co-change edges omitted`;
    }
    const adjacency = await blastAdjacency(root, commits);
    const { nodes, edges, truncated } = buildBlast({
      seeds: files,
      importers: adjacency.importers,
      partners: adjacency.partners,
      depth
    });
    sendJson(res, 200, {
      files,
      nodes,
      edges,
      truncated,
      graphAvailable: adjacency.graphAvailable,
      coverage: { tsFiles: adjacency.tsFiles, totalSeeds: files.length },
      ...(adjacency.reason ? { reason: adjacency.reason } : {}),
      ...(warning ? { warning } : {}),
      depth,
      provenance: { ...BLAST_PROVENANCE, window: adjacency.window || null },
      ...liveMeta()
    });
  }

  /**
   * Minimal read-only sensing for the exported brain-route rule engine.
   * brain-route's own senseState() is not exported (and opens the index /
   * calls gh), so only the cheap, highest-value signals are sensed here:
   * dirty tree + change band, index presence, backlog counts, lease
   * conflicts. Unsensed signals stay null/0 — applyRules treats them as quiet.
   */
  async function senseSignals() {
    const snapshot = changedSnapshot(root);
    const changedFiles = [...new Set([...snapshot.staged, ...snapshot.unstaged])];
    const branch = snapshot.branch || '';
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
      branch,
      detachedHead: !branch,
      brainInitialized,
      indexed,
      changedFiles: changedFiles.length,
      stagedFiles: snapshot.staged.length,
      changeBand: band,
      riskKeyword,
      recommendedPackages,
      backlog,
      ungrilledPlanned,
      leaseConflicts,
      // Deliberately unsensed (needs the index / gh — too costly per request):
      commitsAhead: 0, commitsAheadNoPr: false, base: '',
      indexStale: null, gaps: null
    };
  }

  async function apiNext(res) {
    const signals = await senseSignals();
    const result = applyRules(signals, { top: 5 });
    const actions = result.recommendations.slice(0, 5).map((r) => ({
      command: `${r.command}${r.args && r.args.length ? ` ${r.args.join(' ')}` : ''}`,
      reason: r.reason,
      boundary: r.boundary
    }));
    sendJson(res, 200, {
      actions,
      provenance: { basis: 'sensed', source: 'brain-route rule engine over read-only signals', signals },
      ...liveMeta()
    });
  }

  /**
   * Governing ADRs for buildBrief — the loader inside brain-brief.mjs is not
   * exported, so this is the minimal read-only re-implementation: id/module/
   * title/body from frontmatter, body capped to bound cost. Fails soft to [].
   */
  function loadDecisionsSafe() {
    const dir = path.join(brainDir, 'decisions');
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 64 * 1024); } catch { continue; }
      if (!text) continue;
      const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let module = '';
      let body = text;
      if (fm) {
        body = fm[2] || '';
        const m = fm[1].match(/^module:\s*(.*)$/m);
        if (m) module = m[1].trim();
      }
      out.push({
        id: name.replace(/\.md$/, ''),
        module,
        title: frontmatterTitle(text),
        body,
        file: `.project-brain/decisions/${name}`
      });
    }
    return out;
  }

  const PACK_PREVIEW_TOKENS = 1200;

  /**
   * The copy-to-agent payload: brain:pack in for-agent mode over the target
   * files, ~1200-token budget. Guarded end to end — provider 'none' or any
   * throw degrades to packPreview null + packWarning, never a 500.
   */
  async function packPreviewFor(files) {
    try {
      const provider = await providerInfo();
      if (!provider.available) {
        return { packPreview: null, packWarning: `no index provider (${provider.name}) — pack preview skipped` };
      }
      const { packPrompt } = await import('./brain-pack.mjs');
      const packed = await packPrompt(files.join(' ') || 'project overview', {
        maxTokens: PACK_PREVIEW_TOKENS,
        mode: 'for-agent',
        forAgent: 'control-room'
      });
      return { packPreview: packed.prompt, ...(packed.warning ? { packWarning: packed.warning } : {}) };
    } catch (error) {
      return { packPreview: null, packWarning: `pack preview unavailable: ${error.message || error}` };
    }
  }

  async function apiBrief(res, url) {
    const explicit = filesParam(url);
    if (explicit && explicit.length > MAX_FILES_PARAM) {
      return sendJson(res, 400, { error: `too many files (max ${MAX_FILES_PARAM})` });
    }
    const files = targetFiles(url);
    let advisories = [];
    let briefWarning;
    try {
      const state = fs.existsSync(ACTIVE_STATE)
        ? activeStateJson()
        : { leases: [], workstreams: [] }; // read-only guard: never create it
      const brief = buildBrief({
        files,
        leases: state.leases || [],
        workstreams: state.workstreams || [],
        decisions: loadDecisionsSafe(),
        actor: process.env.BRAIN_ACTOR || ''
      });
      advisories = brief.advisories.map((a) => {
        const target = (a.files && a.files[0]) || a.decision || a.downstream || a.session;
        return { severity: a.severity, kind: a.kind, message: a.message, ...(target ? { target } : {}) };
      });
    } catch (error) {
      briefWarning = `advisories unavailable: ${error.message || error}`;
    }
    const { packPreview, packWarning } = await packPreviewFor(files);
    sendJson(res, 200, {
      files,
      advisories,
      ...(briefWarning ? { briefWarning } : {}),
      packPreview,
      ...(packWarning ? { packWarning } : {}),
      ...liveMeta()
    });
  }

  // --- Doc-Navigator (/api/map, /api/doc, /api/why) ---
  // Intent-first, NOT an auto-generated wiki: every word served here was
  // written by a human or an agent into .project-brain. What the code adds is
  // navigation (record → files, file → record) and one measured honesty
  // signal — where the docs have fallen behind the commits.

  /** Read one record folder (flat, .md only) into a working shape. Soft → []. */
  function docRecordsOf(kind) {
    const dir = path.join(brainDir, kind);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const abs = path.join(dir, e.name);
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8').slice(0, MAX_DOC_BYTES); } catch { continue; }
      const { data, body } = parseFrontmatter(text);
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* soft */ }
      const name = e.name.replace(/\.md$/i, '');
      out.push({
        file: normPath(path.relative(root, abs)),
        name,
        title: frontmatterTitle(text) || name,
        module: String(data.module || '').trim(),
        data,
        body,
        mtimeMs,
        globs: kind === 'modules' ? moduleGlobs(data, body) : [],
        sources: kind === 'findings' ? findingSources(text) : []
      });
    }
    out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return out;
  }

  /** Findings carry a nested `sources:` list the flat FM parser skips. */
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

  /**
   * Newest AUTHOR date among commits touching a matching file → epoch ms.
   * Scans the whole window and keeps the max rather than trusting log order:
   * git orders by committer date while `%aI` is the author date, and the two
   * disagree after any rebase/cherry-pick.
   */
  function newestCommitMs(commits, matches) {
    let newest = null;
    for (const c of commits) {
      const t = Date.parse(c.dateIso);
      if (!Number.isFinite(t) || (newest !== null && t <= newest)) continue;
      if (!(c.files || []).some(matches)) continue;
      newest = t;
    }
    return newest;
  }

  function commitsSafe() {
    try { return { commits: cachedCommits(root, { limit: DEFAULT_COMMIT_WINDOW }), warning: null }; }
    catch (error) { return { commits: [], warning: `git history unavailable: ${error.message || error}` }; }
  }

  /** Does a top-level dir hold source files at all? Bounded, never throws. */
  function containsCode(dir, depth = 0) {
    if (depth > ORPHAN_SCAN_DEPTH) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_TOP_DIRS.has(e.name)) continue;
      if (e.isFile() && CODE_EXT_RE.test(e.name)) return true;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_TOP_DIRS.has(e.name)) continue;
      if (e.isDirectory() && containsCode(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }

  function topLevelCodeDirs() {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_TOP_DIRS.has(e.name)) continue;
      if (containsCode(path.join(root, e.name))) dirs.push(e.name);
      if (dirs.length >= MAX_ORPHAN_DIRS) break;
    }
    return dirs.sort();
  }

  function apiMap(res) {
    const now = Date.now();
    const staleDays = staleDocDays();
    const moduleRecs = docRecordsOf('modules');
    const decisions = docRecordsOf('decisions');
    const features = docRecordsOf('features');
    const findings = docRecordsOf('findings');
    const insights = docRecordsOf('insights');
    const { commits, warning } = commitsSafe();

    const countIn = (recs, aliases) => recs.filter((r) => r.module && aliases.has(r.module)).length;

    const modules = moduleRecs.map((rec) => {
      const aliases = moduleAliases(rec.module || rec.name, rec.file);
      aliases.add(rec.name);
      if (rec.data.feature) aliases.add(String(rec.data.feature).trim());
      // The record's own last change: measured from git when the record is in
      // the commit window, else its mtime (a fresh clone has no history for it).
      const docMs = newestCommitMs(commits, (f) => normPath(f) === rec.file) ?? rec.mtimeMs;
      // The newest commit touching the code the record claims to describe.
      // Brain records are excluded so a doc edit can never mark itself stale.
      const codeMs = rec.globs.length
        ? newestCommitMs(commits, (f) => {
          const n = normPath(f);
          return !n.startsWith('.project-brain/') && rec.globs.some((g) => globMatchesFile(g, n));
        })
        : null;
      const ageDays = docMs == null ? null : Math.round(((now - docMs) / 86_400_000) * 10) / 10;
      const staleByAge = ageDays !== null && ageDays > staleDays;
      const staleByCode = docMs != null && codeMs != null && codeMs > docMs;
      return {
        name: rec.name,
        module: rec.module || rec.name,
        file: rec.file,
        title: rec.title,
        summary: summarize(rec.body),
        fileGlobs: rec.globs,
        decisionCount: countIn(decisions, aliases),
        featureCount: countIn(features, aliases),
        findingCount: countIn(findings, aliases),
        stale: Boolean(staleByAge || staleByCode),
        // Honest about WHICH signal fired — "drifting from code" and "nobody
        // has touched this in months" are different problems for the reader.
        staleReason: staleByCode ? 'code-newer-than-doc' : staleByAge ? `older-than-${staleDays}d` : null,
        ageDays,
        lastDocChange: docMs != null ? new Date(docMs).toISOString() : null,
        lastCodeChange: codeMs != null ? new Date(codeMs).toISOString() : null
      };
    });

    // Orphans: top-level code areas no module record claims. This is the gap a
    // generated wiki hides by inventing a page for everything.
    const claimedTops = new Set();
    for (const rec of moduleRecs) {
      for (const g of rec.globs) {
        const top = normPath(g).split('/')[0];
        if (top && !top.includes('*')) claimedTops.add(top);
      }
    }
    const codeDirs = topLevelCodeDirs().filter((d) => !claimedTops.has(d));

    sendJson(res, 200, {
      modules,
      orphans: {
        codeDirs,
        reason: codeDirs.length
          ? 'top-level code directories no .project-brain/modules/*.md record names — the brain has no authored intent for them'
          : 'every top-level code directory is named by at least one module record'
      },
      counts: {
        decisions: decisions.length,
        modules: moduleRecs.length,
        features: features.length,
        findings: findings.length,
        insights: insights.length
      },
      provenance: {
        basis: commits.length ? 'measured' : 'declared',
        source: '.project-brain records + git log',
        window: { commits: commits.length },
        staleDocDays: staleDays,
        note: 'records are authored, not generated; staleness is measured against commit history'
      },
      ...(warning ? { warning } : {}),
      ...freshness(path.join(brainDir, 'modules'))
    });
  }

  /** Outgoing links of one record: `[[wiki-links]]` + the paths it names. */
  function docLinks(body, data) {
    const decisions = docRecordsOf('decisions');
    const modules = docRecordsOf('modules');
    const dById = new Map(decisions.map((r) => [r.name, r]));
    const mById = new Map(modules.map((r) => [r.name, r]));
    const outD = [];
    const outM = [];
    const seen = new Set();
    for (const id of wikiLinks(body)) {
      const d = dById.get(id);
      if (d && !seen.has(d.file)) { seen.add(d.file); outD.push({ file: d.file, id: d.name, title: d.title }); continue; }
      const m = mById.get(id);
      if (m && !seen.has(m.file)) { seen.add(m.file); outM.push({ file: m.file, name: m.name, title: m.title }); }
    }
    const fmModule = String(data.module || '').trim();
    if (fmModule) {
      const m = modules.find((r) => r.module === fmModule || r.name === fmModule);
      if (m && !seen.has(m.file)) { seen.add(m.file); outM.push({ file: m.file, name: m.name, title: m.title }); }
    }
    return { decisions: outD, modules: outM, files: extractPaths(body, { limit: 60 }) };
  }

  function apiDoc(res, url) {
    const rel = url.searchParams.get('file');
    const resolved = resolveBrainDoc(root, rel === null ? '' : rel);
    if (!resolved) {
      // Rejected BEFORE any filesystem read — traversal never touches disk.
      return sendJson(res, 400, {
        error: 'bad-request',
        hint: '?file= must be a repo-relative .md path inside .project-brain/'
      });
    }
    let raw;
    try { raw = fs.readFileSync(resolved, 'utf8'); }
    catch { return sendJson(res, 404, { error: 'not-found', file: normPath(rel || '') }); }
    const truncated = raw.length > MAX_DOC_BYTES;
    const text = truncated ? raw.slice(0, MAX_DOC_BYTES) : raw;
    const { data, body } = parseFrontmatter(text);
    const file = normPath(path.relative(root, resolved));
    sendJson(res, 200, {
      file,
      title: frontmatterTitle(text) || path.basename(file, '.md'),
      frontmatter: data,
      body,
      truncated,
      links: docLinks(body, data),
      ...freshness(resolved)
    });
  }

  function apiWhy(res, url) {
    const file = normPath(url.searchParams.get('file') || '');
    if (!file || file.length > 512 || file.includes('\0')) {
      return sendJson(res, 400, { error: 'bad-request', hint: '?file=<repo-relative code file> is required' });
    }
    const moduleRecs = docRecordsOf('modules');
    const owner = moduleRecs.find((r) => (r.globs || []).some((g) => globMatchesFile(g, file))) || null;
    const module = owner ? (owner.module || owner.name) : inferModuleFromPath(file);
    // Same alias widening brain:radar uses so a curated ADR module (`retrieval`)
    // still matches a path-inferred one (`scripts/retrieval`).
    const aliases = moduleAliases(module, file);
    if (owner) {
      aliases.add(owner.name);
      if (owner.module) aliases.add(owner.module);
      if (owner.data.feature) aliases.add(String(owner.data.feature).trim());
    }
    const decisions = docRecordsOf('decisions')
      .filter((d) => d.module && aliases.has(d.module))
      .map((d) => ({
        file: d.file,
        id: d.name,
        title: d.title,
        module: d.module,
        excerpt: decisionExcerpt(d.body)
      }));
    const findings = docRecordsOf('findings')
      .filter((f) => (f.module && aliases.has(f.module)) || f.sources.includes(file))
      .map((f) => ({
        file: f.file,
        slug: f.name,
        title: f.title,
        status: String(f.data.status || 'open').trim(),
        category: String(f.data.category || '').trim(),
        impact: Number(f.data.impact) || 0
      }));
    const { commits, warning } = commitsSafe();
    const history = [];
    for (const c of commits) {
      if (!(c.files || []).some((f) => normPath(f) === file)) continue;
      history.push({ hash: c.hash, subject: c.subject, dateIso: c.dateIso, author: c.author });
      if (history.length >= MAX_WHY_HISTORY) break;
    }
    const reason = decisions.length || findings.length
      ? null
      : owner
        ? `module ${module} owns this file, but no ADR or finding references it`
        : 'no module record or governing ADR covers this file — the brain has no authored intent for it yet';
    sendJson(res, 200, {
      file,
      module,
      moduleRecord: owner ? owner.file : null,
      decisions,
      findings,
      history,
      ...(reason ? { reason } : {}),
      ...(warning ? { warning } : {}),
      provenance: {
        basis: 'measured',
        source: '.project-brain records + git log',
        window: { commits: commits.length },
        matchedBy: owner ? 'module-record-glob' : 'path-heuristic'
      },
      ...liveMeta()
    });
  }

  // --- fleet view (/api/fleet) ---

  /**
   * "Which of my repos needs attention right now?" — see the section header
   * above createHandler for the cost model and the weight rationale. Degrades,
   * never 500s: single repo → degraded:true + reason with the active repo
   * still reported; a broken sibling → that row's `error` only.
   */
  function apiFleet(res) {
    const answer = cachedFleet({
      root,
      cwd: ctx.cwd || process.cwd(),
      state: readStateSafe(),
      actor: process.env.BRAIN_ACTOR || ''
    });
    sendJson(res, 200, {
      ...answer,
      provenance: {
        basis: 'measured',
        source: 'projects.mjs fleet discovery + per-repo `git status --porcelain=v2 --branch` and `git log -1`, ' +
          'joined with active_state.md workstreams/leases',
        weights: FLEET_ATTENTION_WEIGHTS,
        thresholds: FLEET_ATTENTION_THRESHOLDS,
        maxProjects: FLEET_MAX_PROJECTS,
        cacheTtlMs: fleetTtlMs(),
        note: 'work state only — no per-repo code intel (hotspots/fileHealth) is run; ' +
          'weights are reviewable defaults, not a calibrated model'
      },
      ...liveMeta()
    });
  }

  // --- runner write API (M2.75; docs/strategy-agent-ops.md security model) ---

  /** Public projection of a supervision record: task/ids only, never the cmd. */
  function runnerView(r) {
    return {
      id: r.id,
      task: r.workPackageId,
      pid: r.pid,
      status: r.status,
      startedAt: r.startedAt,
      logFile: r.logFile
    };
  }

  /** Read-only state view, same guard as apiState: never creates the file. */
  function readStateSafe() {
    if (!fs.existsSync(ACTIVE_STATE)) return { workstreams: [], leases: [], blockers: [], overlaps: [] };
    return activeStateJson();
  }

  function apiRunners(res) {
    const listed = listRunners({ runnersDir });
    sendJson(res, 200, {
      runners: listed.runners.map(runnerView),
      warnings: listed.warnings,
      runnerCmdConfigured: Boolean(resolveRunnerCmd(root)),
      ...freshness(runnersDir)
    });
  }

  async function apiRunnerStart(req, res) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendJson(res, parsed.code, { error: parsed.error });
    // Security model (d): the runner command is NEVER read from the request —
    // a body-supplied `runnerCmd`/`command`/anything else is ignored by
    // construction; only `task` and `acknowledged` are ever consulted.
    const task = typeof parsed.body.task === 'string' ? parsed.body.task.trim() : '';
    const acknowledged = parsed.body.acknowledged === true;
    const runnerCmd = resolveRunnerCmd(root);
    if (!runnerCmd) {
      return sendJson(res, 400, {
        error: 'no-runner-cmd',
        hint: 'set BRAIN_RUNNER_CMD or a "runnerCmd" key in .project-brain/config.json — the runner command is never accepted via the API'
      });
    }
    const state = readStateSafe();
    const workstream = state.workstreams.find((w) => w.taskId === task);
    if (!task || !workstream) return sendJson(res, 400, { error: 'unknown-task' });
    const running = listRunners({ runnersDir }).runners
      .find((r) => r.workPackageId === task && r.status === 'running');
    if (running) return sendJson(res, 409, { error: 'already-running', runner: runnerView(running) });
    const advisories = leaseAdvisories(state.leases, workstream.owner);
    if (advisories.length && !acknowledged) {
      // Brief gate: surface the advisories, spawn NOTHING, record nothing.
      return sendJson(res, 409, { briefGate: true, advisories });
    }
    const started = startRunner({
      workPackageId: task,
      runnerCmd,
      worktreeDir: root,
      logDir: runnerLogDir,
      runnersDir,
      env: {}
    });
    if (!started.ok) return sendJson(res, 500, { error: started.error });
    appendEvent(root, {
      ts: new Date().toISOString(),
      verb: 'runner.started',
      task,
      actor: 'control-room',
      acknowledgedBriefGate: acknowledged,
      advisoryCount: advisories.length
    });
    ensureRunnersWatcher(); // the start may have just created runners/
    sendJson(res, 200, { runner: runnerView({ id: started.id, ...started.record }) });
  }

  async function apiRunnerStop(req, res) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendJson(res, parsed.code, { error: parsed.error });
    const id = typeof parsed.body.id === 'string' ? parsed.body.id.trim() : '';
    if (!id) return sendJson(res, 400, { error: 'bad-request', hint: 'body must be {"id": "<runner id>"}' });
    const stopped = await stopRunner(id, { runnersDir });
    if (stopped.status === 'record-not-found') return sendJson(res, 404, { error: 'not-found', id });
    appendEvent(root, {
      ts: new Date().toISOString(),
      verb: 'runner.stopped',
      id,
      actor: 'control-room',
      status: stopped.status
    });
    sendJson(res, 200, { ok: stopped.ok, status: stopped.status, id });
  }

  function apiRunnerLog(res, url) {
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return sendJson(res, 400, { error: 'bad-request', hint: '?id=<runner id> is required' });
    const rawLines = Number(url.searchParams.get('lines') || DEFAULT_LOG_LINES);
    const lines = Math.min(Math.max(Number.isFinite(rawLines) ? Math.floor(rawLines) : DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
    const tail = tailLog(id, { lines, runnersDir });
    if (!tail.ok && tail.status === 'record-not-found') return sendJson(res, 404, { error: 'not-found', id });
    if (!tail.ok) return sendJson(res, 500, { error: tail.status || 'log read failed', id });
    sendJson(res, 200, { id: tail.id, logFile: tail.logFile, lines: tail.lines, truncated: Boolean(tail.truncated) });
  }

  function apiStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write(': connected\n\n');
    ensureWatcher();
    sseClients.add(res);
    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  // --- static serving (public page; the API stays token-gated) ---

  function serveStatic(res, pathname) {
    if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
      // No built UI bundle: inline status page for every non-API path.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(STATUS_PAGE);
    }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
    if (rel === '/' || rel === '') rel = '/index.html';
    // Path-traversal guard: resolve inside uiDist or 404.
    const resolved = path.resolve(uiDist, '.' + path.posix.normalize(rel));
    if (resolved !== uiDist && !resolved.startsWith(uiDist + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    let body;
    try {
      body = fs.readFileSync(resolved);
    } catch {
      // SPA fallback to index.html for client-side routes.
      body = fs.readFileSync(path.join(uiDist, 'index.html'));
      rel = '/index.html';
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }

  // --- router ---

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      // (c) DNS-rebinding defense on every request, page included.
      if (!checkHost(req.headers.host)) {
        return sendJson(res, 403, { error: 'forbidden: non-local Host header' });
      }
      if (!checkOrigin(req.headers.origin, ctx.port ?? null)) {
        return sendJson(res, 403, { error: 'forbidden: cross-origin request' });
      }
      if (url.pathname.startsWith('/api/')) {
        // (d) writes are confined to the two runner POST endpoints; every
        // other /api path stays GET-only. The runner command itself is
        // config-only, so no request can inject a command either way.
        const isRunnerPostPath = url.pathname === '/api/runners/start' || url.pathname === '/api/runners/stop';
        const methodOk = isRunnerPostPath ? req.method === 'POST' : req.method === 'GET';
        if (!methodOk) {
          res.setHeader('Allow', isRunnerPostPath ? 'POST' : 'GET');
          return sendJson(res, 405, {
            error: isRunnerPostPath ? 'method not allowed: use POST' : 'method not allowed: read-only endpoint (GET)'
          });
        }
        // (b) session token on every API request, constant-time compare.
        if (!checkToken(req, url, token)) {
          return sendJson(res, 401, { error: 'unauthorized: missing or invalid session token' });
        }
        if (url.pathname === '/api/state') return apiState(res);
        if (url.pathname === '/api/events') return apiEvents(res, url);
        if (url.pathname === '/api/intel/health') return apiIntel(res, url, 'health');
        if (url.pathname === '/api/intel/hotspots') return apiIntel(res, url, 'hotspots');
        if (url.pathname === '/api/intel/co-change') return apiIntel(res, url, 'co-change');
        if (url.pathname === '/api/intel/ownership') return apiIntel(res, url, 'ownership');
        if (url.pathname === '/api/records') return apiRecords(res, url);
        if (url.pathname === '/api/changed') return apiChanged(res);
        if (url.pathname === '/api/risk') return await apiRisk(res, url);
        if (url.pathname === '/api/blast') return await apiBlast(res, url);
        if (url.pathname === '/api/next') return await apiNext(res);
        if (url.pathname === '/api/brief') return await apiBrief(res, url);
        if (url.pathname === '/api/map') return apiMap(res);
        if (url.pathname === '/api/doc') return apiDoc(res, url);
        if (url.pathname === '/api/why') return apiWhy(res, url);
        if (url.pathname === '/api/fleet') return apiFleet(res);
        if (url.pathname === '/api/meta') return apiMeta(res);
        if (url.pathname === '/api/runners') return apiRunners(res);
        if (url.pathname === '/api/runners/log') return apiRunnerLog(res, url);
        if (url.pathname === '/api/runners/start') return await apiRunnerStart(req, res);
        if (url.pathname === '/api/runners/stop') return await apiRunnerStop(req, res);
        if (url.pathname === '/api/stream') return apiStream(req, res);
        return sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return serveStatic(res, url.pathname);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: String(error.message || error) });
      else try { res.end(); } catch {}
    }
  };

  handler.close = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (runnersWatcher) { try { runnersWatcher.close(); } catch {} runnersWatcher = null; }
    for (const res of sseClients) { try { res.end(); } catch {} }
    sseClients.clear();
  };

  return handler;
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

/**
 * Bind 127.0.0.1 on `port`, falling back to the next free port (with a
 * printed notice) up to PORT_FALLBACK_ATTEMPTS times. Resolves to
 * { server, handler, port, token, url, close }.
 */
export async function startServer({ root = ROOT, port = DEFAULT_PORT, token, cwd, notice = () => {} } = {}) {
  const sessionToken = token || crypto.randomBytes(32).toString('hex');
  // `cwd` only affects /api/fleet's isActive resolution (which repo the daemon
  // was started in); omitted → process.cwd(), read per request.
  const ctx = { root, token: sessionToken, port: null, ...(cwd ? { cwd } : {}) };
  const handler = createHandler(ctx);
  const server = http.createServer(handler);

  const tryListen = (p) => new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    // (a) STRICTLY loopback — never 0.0.0.0.
    server.listen({ host: '127.0.0.1', port: p, exclusive: true });
  });

  let bound = null;
  for (let attempt = 0; attempt <= PORT_FALLBACK_ATTEMPTS; attempt++) {
    const candidate = port === 0 ? 0 : port + attempt;
    try {
      await tryListen(candidate);
      bound = server.address().port;
      if (candidate !== port) notice(`using free port ${bound} instead of busy ${port}`);
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port === 0 || attempt === PORT_FALLBACK_ATTEMPTS) throw error;
      notice(`port ${candidate} is busy, trying ${candidate + 1}…`);
    }
  }
  ctx.port = bound;
  const close = () => new Promise((resolve) => {
    handler.close();
    server.close(() => resolve());
  });
  return {
    server,
    handler,
    port: bound,
    token: sessionToken,
    url: `http://127.0.0.1:${bound}/#token=${sessionToken}`,
    close
  };
}

function openBrowser(url) {
  // Best-effort; never fatal. The URL fragment (token) stays out of argv logs
  // on failure because we swallow errors silently.
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'linux' ? 'xdg-open'
    : null;
  if (!cmd) return;
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    process.stdout.write(usage() + '\n');
    process.exit(0);
  }
  const open = takeFlag(args, '--open');
  const portRaw = takeOption(args, '--port');
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`[brain:serve] --port must be an integer 0-65535, got: ${portRaw}\n`);
    process.exit(1);
  }

  const { server, handler, url, port: boundPort } = await startServer({
    root: ROOT,
    port,
    notice: (msg) => process.stderr.write(`[brain:serve] ${msg}\n`)
  });

  process.stdout.write(`project-brain Control Room (read-only API) on 127.0.0.1:${boundPort}\n`);
  process.stdout.write(`Open: ${url}\n`);
  process.stdout.write('The token above is this session\'s API key — the URL is printed once, treat it like a secret.\n');
  if (open) openBrowser(url);

  const shutdown = (signal) => {
    process.stdout.write(`\n[brain:serve] ${signal} — shutting down\n`);
    handler.close();
    server.close(() => process.exit(0));
    // Hard exit if close() hangs on lingering connections.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only run when invoked directly; importing for tests must not bind a port
// (mirrors brain-intel.mjs's isMain guard).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:serve] ${error.message || error}\n`);
    process.exit(1);
  });
}
