/**
 * serve/git.mjs — the git plumbing behind every intel endpoint.
 *
 * The only impure part of the intel path: one `git log` per HEAD+window,
 * parsed once and cached (a dashboard load hits hotspots/co-change/ownership
 * back-to-back, and the daemon is single-threaded), plus the staged/unstaged
 * snapshot and the risk-calibration cache. Everything degrades rather than
 * throwing at the caller: not-a-repo yields empty lists or a caught error.
 */
import { spawnSync } from 'node:child_process';
import { gitLogArgs, parseLog, calibrateRisk } from '../git-intel.mjs';

/** Commit window for every intel endpoint: the default and the hard cap. */
export const DEFAULT_COMMIT_WINDOW = 500;
export const MAX_COMMIT_WINDOW = 5000;

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

/** The current commit-cache key — the per-HEAD stamp derived caches key off. */
export function commitCacheKey() {
  return intelCache.key;
}

export function gitHead(root) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return (head.stdout || '').trim() || 'no-head';
}

export function cachedCommits(root, { limit }) {
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
export function changedSnapshot(root) {
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

export function cachedCalibration(root, commits) {
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

/** Commits for the default window, or the reason there are none. Never throws. */
export function commitsSafe(root) {
  try { return { commits: cachedCommits(root, { limit: DEFAULT_COMMIT_WINDOW }), warning: null }; }
  catch (error) { return { commits: [], warning: `git history unavailable: ${error.message || error}` }; }
}

// ---------------------------------------------------------------------------
// the change set a request is asking about
// ---------------------------------------------------------------------------

// Cost cap on ?files= — beyond this the request is malformed, not degraded.
export const MAX_FILES_PARAM = 500;

/** ?files=a,b,c → cleaned array; param absent → null (caller senses git). */
export function filesParam(url) {
  const raw = url.searchParams.get('files');
  if (raw === null) return null;
  return raw.split(',').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);
}

/** Explicit ?files= when present, else staged ∪ unstaged (deduped, sorted). */
export function targetFiles(root, url) {
  const explicit = filesParam(url);
  if (explicit !== null) return [...new Set(explicit)].sort();
  const snapshot = changedSnapshot(root);
  return [...new Set([...snapshot.staged, ...snapshot.unstaged])].sort();
}
