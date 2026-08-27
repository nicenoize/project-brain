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
 *   /api/next              brain:route's exported PURE rule engine over
 *                          minimal read-only sensed signals — ranked next
 *                          actions (≤5, each tagged auto|human)
 *   /api/brief?files=a,b   brain-brief's exported pure core (leases +
 *                          governing ADRs) + a ~1200-token brain:pack
 *                          for-agent preview (provider 'none' or any throw →
 *                          packPreview null + packWarning, never a 500)
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
import { gitLogArgs, parseLog, hotspots, coChange, ownership, riskScore, calibrateRisk } from './git-intel.mjs';
// Both imports are verified side-effect-free: brain-route's isMain guard is
// asserted by tests/brain-route.test.mjs, brain-brief exports its pure core.
import { applyRules, scoreChange } from './brain-route.mjs';
import { buildBrief } from './brain-brief.mjs';
import { getIndexProvider } from './index-provider.mjs';
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
const tsGraphCache = { key: null, ctx: null, indexable: null };

async function blastRadiusFor(root, files) {
  if (process.env.BRAIN_TS_GRAPH === '0') return null;
  try {
    const key = gitHead(root);
    if (tsGraphCache.key !== key) {
      const indexable = await listIndexableFiles();
      let ctx = null;
      // Cheap guard first: without TS sources the loose program is empty
      // anyway, and loading the optional `typescript` package costs time.
      if (indexable.some((f) => /\.(ts|tsx)$/.test(f))) {
        const { loadTsSemanticContext } = await import('./ts-graph.mjs');
        ctx = (await loadTsSemanticContext(root, new Set(indexable))) || null;
      }
      tsGraphCache.ctx = ctx;
      tsGraphCache.indexable = indexable;
      tsGraphCache.key = key;
    }
    if (!tsGraphCache.ctx) return null;
    const touched = new Set(files);
    const dependents = [];
    for (const rel of tsGraphCache.indexable) {
      if (touched.has(rel)) continue;
      const info = tsGraphCache.ctx.get(rel);
      if (info?.resolvedImports?.some((imp) => touched.has(imp))) dependents.push(rel);
    }
    dependents.sort();
    return { dependents, source: 'ts-graph' };
  } catch {
    return null;
  }
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
 * origin passes. `handler.close()` tears down SSE clients + the fs watcher.
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
      const empty = kind === 'hotspots' ? { files: [] } : kind === 'co-change' ? { pairs: [] } : { prefixes: [], files: [] };
      return sendJson(res, 200, { ...empty, warning: `git history unavailable: ${error.message || error}`, ...live });
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
        if (url.pathname === '/api/intel/hotspots') return apiIntel(res, url, 'hotspots');
        if (url.pathname === '/api/intel/co-change') return apiIntel(res, url, 'co-change');
        if (url.pathname === '/api/intel/ownership') return apiIntel(res, url, 'ownership');
        if (url.pathname === '/api/records') return apiRecords(res, url);
        if (url.pathname === '/api/changed') return apiChanged(res);
        if (url.pathname === '/api/risk') return await apiRisk(res, url);
        if (url.pathname === '/api/next') return await apiNext(res);
        if (url.pathname === '/api/brief') return await apiBrief(res, url);
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
export async function startServer({ root = ROOT, port = DEFAULT_PORT, token, notice = () => {} } = {}) {
  const sessionToken = token || crypto.randomBytes(32).toString('hex');
  const ctx = { root, token: sessionToken, port: null };
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
