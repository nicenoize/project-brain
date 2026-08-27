/**
 * serve/fleet.mjs — /api/fleet: "which of my repos needs attention right now?"
 *
 * The multi-repo view for the solo agent-manager. Discovery is projects.mjs's
 * contract; what this adds is per-repo WORK STATE (exactly two git calls) and
 * a ranking whose every reason carries its number. See the section header
 * below for the cost model and the weight rationale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Fleet discovery is a pure fs walk (no side effects at import time) — the same
// contract brain:projects/edges/handoff use, so /api/fleet cannot disagree with
// the CLI about what "the fleet" is.
import { discoverProjects, isFleetMode } from '../projects.mjs';
import { sendJson } from './security.mjs';
import { liveMeta } from './records.mjs';
import { readStateSafe } from './state.mjs';

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
// endpoint
// ---------------------------------------------------------------------------

// --- fleet view (/api/fleet) ---

/**
 * "Which of my repos needs attention right now?" — see the section header
 * above createHandler for the cost model and the weight rationale. Degrades,
 * never 500s: single repo → degraded:true + reason with the active repo
 * still reported; a broken sibling → that row's `error` only.
 */
export function apiFleet(api, res) {
  const { root, ctx } = api;
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
