/**
 * brain:serve — local Control-Room daemon (strategy doc §M2.75).
 *
 * A read-only JSON API + SSE stream over the existing brain state
 * (active_state.md, events.jsonl, decisions/grills/findings, git-intel),
 * plus static serving for the future `ui/dist` bundle. Node `http` only —
 * no framework (AGPL-client house rule, no new deps).
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
 *   (d) the API is READ-ONLY in this milestone — there is no endpoint that
 *       accepts commands or paths to execute, and non-GET methods are 405;
 *   (e) no CORS headers, ever.
 *
 * Endpoints (all GET, all token-gated except the static page):
 *   /api/state             workstreams+leases via activeStateJson() —
 *                          guarded read-only: never creates active_state.md
 *   /api/events?limit=N    tail of .project-brain/events.jsonl (absent → [])
 *   /api/intel/hotspots | /api/intel/co-change | /api/intel/ownership
 *                          pure git-intel.mjs cores over one spawnSync git
 *                          log (mirrors brain-intel.mjs's wiring; the command
 *                          script itself is never imported)
 *   /api/records?type=decision|grill|finding   record files + frontmatter title
 *   /api/meta              version, root, index-provider availability
 *   /api/stream            SSE: fs.watch on .project-brain/ (300ms debounce)
 *                          → {type:'state-changed', file}; heartbeat comment
 *                          every 25s
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
import { ROOT, PACKAGE_DIR, takeFlag, takeOption } from './common.mjs';
import { ACTIVE_STATE, activeStateJson } from './active-state.mjs';
import { gitLogArgs, parseLog, hotspots, coChange, ownership } from './git-intel.mjs';
import { getIndexProvider } from './index-provider.mjs';

export const DEFAULT_PORT = 4100;
const PORT_FALLBACK_ATTEMPTS = 20;
const DEFAULT_COMMIT_WINDOW = 500;
const MAX_COMMIT_WINDOW = 5000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1000;
const DEFAULT_ROW_LIMIT = 50;
const SSE_DEBOUNCE_MS = 300;
const SSE_HEARTBEAT_MS = 25_000;
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

function cachedCommits(root, { limit }) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const key = `${(head.stdout || '').trim() || 'no-head'}|${limit}`;
  if (intelCache.key !== key) {
    intelCache.commits = parseLog(runGitLog(root, { limit }));
    intelCache.key = key;
  }
  return intelCache.commits;
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
  const uiDist = ctx.uiDist || path.join(PACKAGE_DIR, 'ui', 'dist');

  // --- SSE plumbing (shared watcher, per-connection response set) ---
  const sseClients = new Set();
  let watcher = null;
  let pendingFiles = new Set();
  let flushTimer = null;

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(frame);
  }

  function ensureWatcher() {
    if (watcher || !fs.existsSync(brainDir)) return;
    try {
      watcher = fs.watch(brainDir, { recursive: true }, (_event, file) => {
        pendingFiles.add(file || '');
        if (flushTimer) return; // debounce: one flush per quiet window
        flushTimer = setTimeout(() => {
          flushTimer = null;
          const files = [...pendingFiles];
          pendingFiles = new Set();
          for (const f of files) broadcast({ type: 'state-changed', file: f });
        }, SSE_DEBOUNCE_MS);
        if (typeof flushTimer.unref === 'function') flushTimer.unref();
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
  async function apiMeta(res) {
    if (!providerPromise) {
      providerPromise = getIndexProvider()
        .then((p) => ({ name: p.name, model: p.modelName || null, available: p.name !== 'none' }))
        .catch((error) => ({ name: 'unavailable', model: null, available: false, error: String(error.message || error) }));
    }
    const provider = await providerPromise;
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
        // (d) read-only milestone: the API accepts GET only.
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return sendJson(res, 405, { error: 'method not allowed: API is read-only (GET)' });
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
        if (url.pathname === '/api/meta') return apiMeta(res);
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
