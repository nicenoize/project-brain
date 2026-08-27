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
 *   (d) the ONLY write endpoints are POST /api/runners/start|stop and
 *       /api/leases/claim|release (lease targets validated against the
 *       canonical grammar; overlapping claims gated like the brief gate), and the
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
 *                          active-state read-only, blast radius from the
 *                          multi-language import scan — it fires in any
 *                          language now, not just TS) + calibrateRisk cached
 *                          per HEAD; default change-set staged ∪ unstaged,
 *                          empty → {score:null, reason:'no-changes'}
 *   /api/blast?files=a,b&depth=N
 *                          "What breaks if I change this?" — depth-limited
 *                          blast radius (default 2, cap 3) around the change
 *                          set. Blends TWO edge kinds and labels each one:
 *                          'imports' edges are MEASURED (import-graph.mjs
 *                          resolved static imports across JS/TS/Python/Go/
 *                          Ruby/PHP/Rust, edge confidence 1.0 exact / 0.8
 *                          inferred / 0.6 alias-or-search) and 'co-change'
 *                          edges are INFERRED (git history, confidence =
 *                          P(b|a)) — the UI shows provenance per edge
 *                          (Praktiken-Katalog: measured vs inferred). Nodes
 *                          are scored by graph proximity × edge confidence so
 *                          the list ranks "most likely to break"; measured
 *                          import edges outrank inferred history at equal
 *                          depth. `coverage` reports what the scan actually
 *                          saw (filesScanned/resolvedEdges/unresolvedSpecs/
 *                          byLang). No scannable file, or a scan that resolved
 *                          no edge at all → graphAvailable:false + `reason`,
 *                          and the co-change edges are STILL returned — the
 *                          honest degradation. Node cap 60 (→ truncated:true,
 *                          highest-scoring kept); the graph and the adjacency
 *                          are cached per HEAD like intelCache (blastStats()
 *                          and graphStats() are the test hooks)
 *   /api/graph             The graph's own answers, unanchored to any change
 *                          set: bounded import `cycles` (max 20, length ≤ 8),
 *                          dead-code `orphans` (CANDIDATES + caveat + the
 *                          entry-point patterns excluded), `fanIn`/`fanOut`
 *                          rankings (max 25 each) and the same `coverage`.
 *                          `truncated` says when a cap bit; a repo with no
 *                          scannable source is a degraded 200 with `reason`
 *   /api/security          Dependency advisories WITH REACHABILITY + secret
 *                          LOCATIONS (brain-security.mjs's pure core). Each
 *                          advisory is `reachable` (some scanned file imports
 *                          the vulnerable package), `transitive-only` (nothing
 *                          imports it) or `unknown` (no graph) — an advisory
 *                          nothing imports is not the same problem as one
 *                          imported by 12 files, and the response says which.
 *                          Every tool is optional: `provenance.tools` reports
 *                          which ran and which were absent, and a scanner that
 *                          did not run can never produce a clean bill of health
 *                          (`claims.cleanBillOfHealth`). NEVER contains a secret
 *                          VALUE — only {file, line, rule, severity}. npm audit
 *                          is slow (seconds), so the whole report is cached per
 *                          HEAD with a TTL and the response reports the cache
 *                          age in `state_age` + a `cache` block. Absent tools →
 *                          degraded 200 with reasons, never a 500
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
 *
 * MODULE MAP (this file is the router; the work lives in scripts/serve/):
 *   serve/security.mjs  token compare, Origin/Host checks, the method matrix,
 *                       the bounded JSON body reader, sendJson
 *   serve/records.mjs   freshness metadata + the .project-brain record/doc
 *                       vocabulary (frontmatter, module globs, ?file= resolve)
 *   serve/git.mjs       the per-HEAD commit cache, changed-file snapshot,
 *                       risk calibration cache, ?files= parsing
 *   serve/graph.mjs     the multi-language import graph + the blast blend
 *   serve/state.mjs     /api/state|events|changed|meta|next|brief
 *   serve/intel.mjs     /api/intel/*|risk|blast|graph|security
 *   serve/docs.mjs      /api/map|doc|why (Doc-Navigator)
 *   serve/runners.mjs   the write API: runners + leases (+ the audit lines)
 *   serve/fleet.mjs     /api/fleet
 *   serve/sse.mjs       /api/stream: fs watchers, debounce, heartbeat
 *   serve/static.mjs    ui/dist (or the inline status page), traversal-guarded
 * Endpoint modules receive an explicit context object (root, brainDir, the
 * live ctx, the provider memo) rather than closing over this file's scope.
 * Every name the old single-file module exported is re-exported below, so
 * brain-mcp.mjs / brain-answer.mjs / the tests import exactly as before.
 */
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, PACKAGE_DIR, takeFlag, takeOption } from './common.mjs';
import { checkHost, checkOrigin, checkToken, methodCheck, sendJson } from './serve/security.mjs';
import { apiRecords } from './serve/records.mjs';
import { apiBrief, apiChanged, apiEvents, apiMeta, apiNext, apiState, createProviderInfo } from './serve/state.mjs';
import { apiBlast, apiGraph, apiIntel, apiRisk, apiSecurity } from './serve/intel.mjs';
import { apiDoc, apiMap, apiWhy } from './serve/docs.mjs';
import { apiFleet } from './serve/fleet.mjs';
import { createSseHub } from './serve/sse.mjs';
import { serveStatic } from './serve/static.mjs';
import {
  apiLeaseClaim, apiLeaseRelease, apiRunnerLog, apiRunnerStart, apiRunnerStop, apiRunners
} from './serve/runners.mjs';

// ---------------------------------------------------------------------------
// public surface — every name the single-file version exported stays
// importable from here (brain-mcp.mjs, brain-answer.mjs and the tests import
// them by this path), so the split is invisible to every consumer.
// ---------------------------------------------------------------------------

export { tokenEquals, presentedToken, checkToken, checkOrigin, checkHost } from './serve/security.mjs';
export {
  freshness, frontmatterTitle, listRecords, DOC_DIRS, staleDocDays, normPath, parseFrontmatter,
  extractPaths, moduleGlobs, globMatchesFile, inferModuleFromPath, moduleForFile, moduleAliases,
  summarize, decisionExcerpt, resolveBrainDoc, wikiLinks
} from './serve/records.mjs';
export { CALIBRATION_WINDOW, riskCalibrationStats } from './serve/git.mjs';
export {
  GRAPH_MAX_CYCLES, graphStats, importGraphFor, blastStats, buildBlast,
  BLAST_DEFAULT_DEPTH, BLAST_MAX_DEPTH, BLAST_MAX_NODES, BLAST_MAX_FANOUT,
  BLAST_DEPTH_DECAY, BLAST_INFERRED_WEIGHT
} from './serve/graph.mjs';
export { SECURITY_CACHE_TTL_MS, securityStats } from './serve/intel.mjs';
export { resolveRunnerCmd, leaseAdvisories, appendEvent } from './serve/runners.mjs';
export {
  FLEET_MAX_PROJECTS, fleetTtlMs, FLEET_ATTENTION_WEIGHTS, FLEET_ATTENTION_THRESHOLDS,
  fleetAttention, parseGitStatusV2, isOpenWorkstream, fleetProjectState, fleetStats
} from './serve/fleet.mjs';

export const DEFAULT_PORT = 4100;
const PORT_FALLBACK_ATTEMPTS = 20;

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
// request router core (exported; testable without binding a port)
// ---------------------------------------------------------------------------

/**
 * The route table: pathname → handler(req, res, url). Method and token are
 * already checked by the time an entry runs (the method matrix in
 * serve/security.mjs decides which of these are POST); awaiting a synchronous
 * handler is a no-op, so the table stays uniform. Every entry is one line —
 * this table IS the API surface, and it should read like a list.
 */
function buildRoutes(api, sse) {
  return new Map([
    ['/api/state', (req, res) => apiState(api, res)],
    ['/api/events', (req, res, url) => apiEvents(api, res, url)],
    ['/api/intel/health', (req, res, url) => apiIntel(api, res, url, 'health')],
    ['/api/intel/hotspots', (req, res, url) => apiIntel(api, res, url, 'hotspots')],
    ['/api/intel/co-change', (req, res, url) => apiIntel(api, res, url, 'co-change')],
    ['/api/intel/ownership', (req, res, url) => apiIntel(api, res, url, 'ownership')],
    ['/api/records', (req, res, url) => apiRecords(api, res, url)],
    ['/api/changed', (req, res) => apiChanged(api, res)],
    ['/api/risk', (req, res, url) => apiRisk(api, res, url)],
    ['/api/blast', (req, res, url) => apiBlast(api, res, url)],
    ['/api/graph', (req, res) => apiGraph(api, res)],
    ['/api/security', (req, res) => apiSecurity(api, res)],
    ['/api/next', (req, res) => apiNext(api, res)],
    ['/api/brief', (req, res, url) => apiBrief(api, res, url)],
    ['/api/map', (req, res) => apiMap(api, res)],
    ['/api/doc', (req, res, url) => apiDoc(api, res, url)],
    ['/api/why', (req, res, url) => apiWhy(api, res, url)],
    ['/api/fleet', (req, res) => apiFleet(api, res)],
    ['/api/meta', (req, res) => apiMeta(api, res)],
    ['/api/runners', (req, res) => apiRunners(api, res)],
    ['/api/runners/log', (req, res, url) => apiRunnerLog(api, res, url)],
    ['/api/runners/start', (req, res) => apiRunnerStart(api, req, res)],
    ['/api/runners/stop', (req, res) => apiRunnerStop(api, req, res)],
    ['/api/leases/claim', (req, res) => apiLeaseClaim(api, req, res)],
    ['/api/leases/release', (req, res) => apiLeaseRelease(api, req, res)],
    ['/api/stream', (req, res) => sse.handleStream(req, res)]
  ]);
}

/**
 * One request: the security preamble (the M2.75 model, in order) and then one
 * table lookup. Nothing here knows what any endpoint does — that is the point.
 * Never throws: an escaping error becomes a 500, or a bare end() when the
 * response has already started.
 */
async function dispatch(req, res, { ctx, token, routes, uiDist }) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    // (c) DNS-rebinding defense on every request, page included.
    if (!checkHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'forbidden: non-local Host header' });
    }
    if (!checkOrigin(req.headers.origin, ctx.port ?? null)) {
      return sendJson(res, 403, { error: 'forbidden: cross-origin request' });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return serveStatic(res, url.pathname, uiDist);
    }
    // (d) writes are confined to the runner/lease POST endpoints; every
    // other /api path stays GET-only. The runner command itself is
    // config-only, so no request can inject a command either way.
    const method = methodCheck(url.pathname, req.method);
    if (!method.ok) {
      res.setHeader('Allow', method.allow);
      return sendJson(res, 405, { error: method.error });
    }
    // (b) session token on every API request, constant-time compare.
    if (!checkToken(req, url, token)) {
      return sendJson(res, 401, { error: 'unauthorized: missing or invalid session token' });
    }
    const route = routes.get(url.pathname);
    if (!route) return sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` });
    return await route(req, res, url);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: String(error.message || error) });
    else try { res.end(); } catch {}
  }
}

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
  const uiDist = ctx.uiDist || path.join(PACKAGE_DIR, 'ui', 'dist');
  const sse = createSseHub({ brainDir, runnersDir });

  /**
   * What every endpoint module receives instead of closing over createHandler:
   * the resolved directories, the LIVE `ctx` (its `port`/`cwd` are filled in
   * after listen(), so it must be passed by reference, never copied), the
   * per-daemon index-provider memo and the one watcher hook a write endpoint
   * needs after it may have created runners/.
   */
  const api = {
    root,
    brainDir,
    runnersDir,
    runnerLogDir: path.join(brainDir, 'runner-logs'),
    ctx,
    providerInfo: createProviderInfo(),
    ensureRunnersWatcher: sse.ensureRunnersWatcher
  };

  const routes = buildRoutes(api, sse);
  const handler = (req, res) => dispatch(req, res, { ctx, token, routes, uiDist });
  handler.close = sse.close;
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
