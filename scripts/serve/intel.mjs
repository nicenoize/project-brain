/**
 * serve/intel.mjs — the code-intel endpoints: /api/intel/*, /api/risk,
 * /api/blast, /api/graph and /api/security.
 *
 * Every one of them is a thin wiring of pure cores (git-intel, code-structure,
 * import-graph, brain-security) over the shared per-HEAD caches in
 * serve/git.mjs and serve/graph.mjs — the command scripts themselves are never
 * imported (house rule: libraries only). The degradation ladder is the
 * contract: no git history, no scannable source or an absent scanner is a
 * degraded 200 with a `reason`, never a 500 and never a silent zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hotspots, coChange, ownership, riskScore, fileHealth, calibrateFileHealth } from '../git-intel.mjs';
import { measureFiles, refactorPlan } from '../code-structure.mjs';
import {
  cycles as graphCycles, fanIn as graphFanIn, fanOut as graphFanOut,
  orphans as graphOrphans, defaultEntryPoints, SCAN_NOTE, ORPHAN_CAVEAT
} from '../import-graph.mjs';
// Security report (advisories × reachability, secret LOCATIONS only). Its pure
// core has no clocks/fs/processes and its CLI is isMain-guarded, so importing
// it here spawns nothing — /api/security drives the I/O wrapper explicitly.
import { securityReport as buildSecurityReport } from '../brain-security.mjs';
import { sendJson } from './security.mjs';
import { liveMeta } from './records.mjs';
import { readLeasesSafe } from './state.mjs';
import {
  DEFAULT_COMMIT_WINDOW, MAX_COMMIT_WINDOW, MAX_FILES_PARAM,
  cachedCommits, cachedCalibration, commitCacheKey, filesParam, targetFiles, gitHead
} from './git.mjs';
import {
  BLAST_DEFAULT_DEPTH, BLAST_MAX_DEPTH, BLAST_PROVENANCE,
  GRAPH_MAX_CYCLES, GRAPH_MAX_CYCLE_LEN, GRAPH_MAX_LIST,
  importGraphFor, graphCoverage, blastAdjacency, blastRadiusFor, buildBlast
} from './graph.mjs';

const DEFAULT_ROW_LIMIT = 50;

const healthCalCache = { key: null, value: null };
// Shape metrics are opt-in (?structure=1): the calibration does not yet
// establish that they add signal (decisions: see git-intel's caveat), and the
// scan costs a full read of every source file. Cached per HEAD like the rest.
const structureCache = { key: null, value: null };

// ---------------------------------------------------------------------------
// security report cache (/api/security)
//
// `npm audit` shells out to npm and hits the registry (1-10s), and the
// reachability half re-scans every JS/TS source. That is far too expensive for
// a dashboard poll, so the WHOLE report is memoized per HEAD — with a wall-
// clock TTL on top, because advisories change when the registry learns about a
// new CVE, not when you commit. The response reports the cache age instead of
// pretending the answer is live (`state_age` + the `cache` block).
// ---------------------------------------------------------------------------

export const SECURITY_CACHE_TTL_MS = 15 * 60 * 1000;
/** Age past which the cached report ships a stale_warning. */
const SECURITY_STALE_S = 10 * 60;
const securityCache = { key: null, value: null, at: 0, computes: 0 };

/** Test hook: observe the security cache without reaching into internals. */
export function securityStats() {
  return { key: securityCache.key, computes: securityCache.computes };
}

/**
 * Build (and cache) the security report for `root`. Never throws: a failure in
 * the report itself becomes a degraded value with a reason, exactly like an
 * absent scanner, so the endpoint stays a 200.
 */
async function cachedSecurityReport(root, now = Date.now()) {
  const key = gitHead(root);
  const fresh = securityCache.key === key &&
    securityCache.value &&
    now - securityCache.at < SECURITY_CACHE_TTL_MS;
  if (!fresh) {
    let value;
    try {
      value = await buildSecurityReport({ root, now });
    } catch (error) {
      // Defense in depth — securityReport is total, but a 500 here would be a
      // security answer that says nothing at all.
      value = {
        vulnerabilities: {
          reachable: [], transitiveOnly: [], unknown: [],
          counts: { critical: 0, high: 0, moderate: 0, low: 0 }, total: 0,
          degraded: true, scanned: false,
          reason: `security scan failed: ${error.message || error}`,
          statement: `security scan failed (${error.message || error}) — dependencies NOT scanned. This is not a clean bill of health.`,
          reachability: { available: false, degraded: true, reason: 'scan failed', filesScanned: 0, importedPackages: 0, maxImportersListed: 0, skipped: null, note: '' }
        },
        secrets: {
          findings: [], total: 0, truncated: false, degraded: true, scanned: false,
          reason: `security scan failed: ${error.message || error}`,
          statement: 'secrets NOT scanned. This is not a clean bill of health.',
          note: ''
        },
        claims: { dependenciesScanned: false, reachabilityDetermined: false, secretsScanned: false, cleanBillOfHealth: false, caveat: '' },
        provenance: { basis: 'measured', source: 'scan failed', tools: [], notes: {} },
        scannedAt: new Date(now).toISOString()
      };
    }
    securityCache.key = key;
    securityCache.value = value;
    securityCache.at = now;
    securityCache.computes += 1;
    return { report: value, ageMs: 0, cached: false };
  }
  return { report: securityCache.value, ageMs: now - securityCache.at, cached: true };
}

/** Top author's share of the window — gates the vacuous add-owner move. */
function topAuthorShare(commits) {
  const counts = new Map();
  let total = 0;
  for (const c of commits || []) {
    const a = (c && c.author || '').trim();
    if (!a) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
    total += 1;
  }
  return total ? Math.max(...counts.values()) / total : null;
}

/** Shape metrics for every scanned file, cached per HEAD. Null on failure. */
async function structureFor(root) {
  const entry = await importGraphFor(root);
  const key = `${commitCacheKey() || 'no-head'}|structure`;
  if (structureCache.key === key) return structureCache.value;
  let value = null;
  try {
    const files = entry?.files || (entry?.graph?.nodes || []).map((n) => n.file);
    if (files && files.length) {
      const readFile = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
      const measured = measureFiles({ files, readFile });
      value = {
        measured,
        byFile: new Map(measured.files.map((m) => [m.file, m])),
        graph: entry?.graph || null,
        degreeByFile: new Map(((entry?.graph?.nodes) || []).map((n) => [n.file, { fanIn: n.importedBy, fanOut: n.imports }]))
      };
    }
  } catch { value = null; }
  structureCache.key = key;
  structureCache.value = value;
  return value;
}

/**
 * The per-HEAD-cached calibration receipt for fileHealth. Fails soft to null:
 * a missing receipt must never cost the caller the scores themselves.
 */
function healthCalibration(commits) {
  try {
    if (healthCalCache.key !== commitCacheKey()) {
      const cal = calibrateFileHealth(commits, { window: Math.min(commits.length, 300) });
      healthCalCache.key = commitCacheKey();
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
    return healthCalCache.value;
  } catch {
    return null;
  }
}

/** One health row augmented with its shape metrics + the concrete moves. */
function healthRowWithShape(f, st, share) {
  const degree = st.degreeByFile.get(f.file) || null;
  const cyclesFor = (st.graph && Array.isArray(st.graph.cycles)) ? st.graph.cycles : [];
  const plans = refactorPlan(
    st.byFile.get(f.file) || null,
    { ...(degree || {}), cycles: cyclesFor },
    f.factors,
    { topAuthorShare: share }
  );
  const shape = st.byFile.get(f.file) || null;
  return {
    ...f,
    plans,
    shape: shape ? {
      codeLines: shape.codeLines,
      maxNestingDepth: shape.maxNestingDepth,
      functionCount: shape.functionCount,
      fanIn: degree?.fanIn ?? null,
      fanOut: degree?.fanOut ?? null
    } : null
  };
}

/**
 * /api/intel/health: per-file danger score + its calibration receipt.
 * ?structure=1 additionally folds in shape metrics and returns the concrete
 * refactor moves — opt-in, because the structural weights are not yet shown to
 * add signal (see git-intel's calibration caveat).
 */
async function apiIntelHealth(root, res, url, { commits, limit, live }) {
  const wantStructure = url.searchParams.get('structure') === '1';
  const r = fileHealth(commits, { now: Date.now() });
  const calibration = healthCalibration(commits);
  if (!wantStructure) {
    return sendJson(res, 200, { ...r, files: r.files.slice(0, limit), calibration, structure: null, ...live });
  }
  // Structure-augmented: rescore with shape+graph, attach the concrete moves.
  const st = await structureFor(root);
  if (!st) {
    return sendJson(res, 200, {
      ...r, files: r.files.slice(0, limit), calibration, structure: null,
      structureWarning: 'no scannable sources — shape metrics unavailable', ...live
    });
  }
  const scored = fileHealth(commits, {
    now: Date.now(),
    structure: st.measured,
    graph: st.graph
  });
  const share = topAuthorShare(commits);
  const files = scored.files.slice(0, limit).map((f) => healthRowWithShape(f, st, share));
  return sendJson(res, 200, {
    ...scored, files, calibration,
    structure: {
      filesMeasured: st.measured?.files?.length ?? 0,
      note: st.measured?.note || 'shape metrics, not semantics — no parser, no AST',
      caveat: 'structural weights are uncalibrated defaults — validate with: project-brain x intel health-calibrate --structure'
    },
    ...live
  });
}

export async function apiIntel(api, res, url, kind) {
  const { root } = api;
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
  if (kind === 'health') return await apiIntelHealth(root, res, url, { commits, limit, live });
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

export async function apiRisk(api, res, url) {
  const { root } = api;
  const explicit = filesParam(url);
  if (explicit && explicit.length > MAX_FILES_PARAM) {
    return sendJson(res, 400, { error: `too many files (max ${MAX_FILES_PARAM})` });
  }
  const files = targetFiles(root, url);
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
    provenance: {
      basis: scored.basis,
      // riskScore only knows it read git; when the measured graph contributed
      // a factor the answer must name that second source too, or the reader
      // cannot tell which half produced the blast-radius evidence.
      source: blastRadius ? `${scored.source} ⊕ ${blastRadius.source} static imports` : scored.source,
      window: scored.window
    },
    calibration: cachedCalibration(root, commits),
    ...liveMeta()
  });
}

/**
 * "What breaks if I change this?" — see the file header for the blend rule.
 * Degradation ladder, never a 500: no seeds → empty answer with
 * reason 'no-changes'; no git history → co-change edges empty + warning; no
 * resolved import edge → graphAvailable:false + reason, co-change edges
 * still returned.
 */
export async function apiBlast(api, res, url) {
  const { root } = api;
  const explicit = filesParam(url);
  if (explicit && explicit.length > MAX_FILES_PARAM) {
    return sendJson(res, 400, { error: `too many files (max ${MAX_FILES_PARAM})` });
  }
  const rawDepth = Number(url.searchParams.get('depth') || BLAST_DEFAULT_DEPTH);
  const depth = Math.min(
    Math.max(Number.isFinite(rawDepth) ? Math.floor(rawDepth) : BLAST_DEFAULT_DEPTH, 1),
    BLAST_MAX_DEPTH
  );
  const files = targetFiles(root, url);
  if (!files.length) {
    // Empty change-set is a 200 like /api/risk — and costs nothing: neither
    // the TS program nor git log is touched when there is no question.
    return sendJson(res, 200, {
      files: [], nodes: [], edges: [], truncated: false,
      graphAvailable: false,
      coverage: { ...graphCoverage(null), totalSeeds: 0 },
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
    // The scan's real numbers, not a single boolean: how many files were read,
    // how many edges resolved, how many specifiers pointed outside the repo.
    coverage: { ...adjacency.coverage, totalSeeds: files.length },
    ...(adjacency.reason ? { reason: adjacency.reason } : {}),
    ...(warning ? { warning } : {}),
    depth,
    provenance: { ...BLAST_PROVENANCE, window: adjacency.window || null },
    ...liveMeta()
  });
}

/**
 * The import graph's OWN answers — the questions /api/blast cannot ask
 * because it is always anchored to a change set: which files import each
 * other in a circle, which files nothing imports at all, and which files
 * everything depends on.
 *
 * Everything is capped (cycles 20, every list 25) so a 5000-file repo cannot
 * turn one dashboard poll into a megabyte, and `truncated` says when a cap
 * bit. Orphans ship with their caveat and the entry-point patterns that were
 * excluded — a file nothing imports is a CANDIDATE, never a deletion order.
 * No scannable files → a degraded 200 with `reason`, never a 500.
 */
export async function apiGraph(api, res) {
  const { root } = api;
  const entry = await importGraphFor(root);
  const coverage = graphCoverage(entry);
  const provenance = {
    ...(entry.graph ? entry.graph.provenance : { basis: 'measured', source: 'import-scan', note: SCAN_NOTE }),
    caps: { cycles: GRAPH_MAX_CYCLES, cycleLength: GRAPH_MAX_CYCLE_LEN, lists: GRAPH_MAX_LIST }
  };
  if (!entry.graph) {
    return sendJson(res, 200, {
      cycles: [],
      orphans: { candidates: [], total: 0, caveat: ORPHAN_CAVEAT, entryPoints: [], entryPointsTotal: 0 },
      fanIn: [], fanOut: [],
      coverage,
      truncated: false,
      degraded: true,
      reason: entry.reason,
      provenance,
      ...liveMeta()
    });
  }
  const graph = entry.graph;
  const found = graphCycles(graph, { maxLen: GRAPH_MAX_CYCLE_LEN, maxCycles: GRAPH_MAX_CYCLES });
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  const orphanView = graphOrphans(graph, {
    entryPoints: defaultEntryPoints({ pkg, files: entry.files })
  });
  const inbound = graphFanIn(graph).filter((e) => e.count);
  const outbound = graphFanOut(graph).filter((e) => e.count);
  const capped = [
    found.truncated,
    found.cycles.length > GRAPH_MAX_CYCLES,
    orphanView.candidates.length > GRAPH_MAX_LIST,
    orphanView.entryPoints.length > GRAPH_MAX_LIST,
    inbound.length > GRAPH_MAX_LIST,
    outbound.length > GRAPH_MAX_LIST
  ].some(Boolean);
  sendJson(res, 200, {
    cycles: found.cycles.slice(0, GRAPH_MAX_CYCLES).map((files) => ({ files, length: files.length })),
    orphans: {
      candidates: orphanView.candidates.slice(0, GRAPH_MAX_LIST),
      total: orphanView.candidates.length,
      caveat: orphanView.caveat,
      // The exclusions are evidence, not decoration — but a repo with 50 npm
      // scripts would otherwise ship 50 paths on every poll, so they are
      // capped like every other list and counted honestly.
      entryPoints: orphanView.entryPoints.slice(0, GRAPH_MAX_LIST),
      entryPointsTotal: orphanView.entryPoints.length
    },
    fanIn: inbound.slice(0, GRAPH_MAX_LIST),
    fanOut: outbound.slice(0, GRAPH_MAX_LIST),
    coverage,
    truncated: capped,
    degraded: false,
    provenance,
    ...liveMeta()
  });
}

/**
 * "Which of these advisories can actually reach my code?" — the one security
 * question the import graph lets us answer honestly and for free.
 *
 * Read-only, GET-only, token-gated like every other endpoint, and a degraded
 * 200 whenever a scanner is absent: the response NEVER implies a clean bill
 * of health for a tool that did not run (`provenance.tools[].ran`,
 * `claims.cleanBillOfHealth`, and a per-section `statement` that says
 * "NOT scanned" in words).
 *
 * SECURITY: the response can never contain a secret VALUE — brain-security's
 * normalizer builds each finding from a whitelist of {file, line, rule,
 * severity, entropyNote}, so nothing that carries the match ever reaches the
 * browser. That property is asserted by tests/brain-security.test.mjs.
 *
 * COST: npm audit + a full source re-scan, so the report is cached per HEAD
 * with a TTL and the answer states its own age rather than pretending to be
 * live.
 */
export async function apiSecurity(api, res) {
  const { root } = api;
  const now = Date.now();
  const { report, ageMs, cached } = await cachedSecurityReport(root, now);
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  sendJson(res, 200, {
    ...report,
    cache: {
      cached,
      ageSeconds,
      computedAt: report.scannedAt,
      ttlSeconds: Math.round(SECURITY_CACHE_TTL_MS / 1000),
      note: 'npm audit is slow, so this report is cached per commit with a TTL — the age above is real'
    },
    state_age: ageSeconds,
    stale_warning: ageSeconds > SECURITY_STALE_S
      ? `security report was computed ${Math.round(ageSeconds / 60)}m ago (cached) — advisories may have changed since`
      : null,
    generated_at: new Date(now).toISOString()
  });
}
