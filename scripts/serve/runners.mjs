/**
 * serve/runners.mjs — the write half of the Control Room (M2.75; the security
 * model in docs/strategy-agent-ops.md): supervised runner start/stop/log and
 * the lease claim/release board.
 *
 * Two invariants live here, not in the router:
 *   · the runner command is NEVER read from a request — it resolves from
 *     BRAIN_RUNNER_CMD or .project-brain/config.json, so a body-supplied
 *     command is inert by construction;
 *   · every outcome is audited into events.jsonl (the audit IS the product),
 *     and both gates — the runner brief gate and the lease conflict gate —
 *     refuse first and act only on an explicit `acknowledged`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../common.mjs';
import { addLease, releaseLeases } from '../active-state.mjs';
import { validateTarget, targetsOverlap, UnsupportedPatternError } from '../lease-overlap.mjs';
import { startRunner, listRunners, stopRunner, tailLog } from '../runner-supervisor.mjs';
import { readJsonBody, sendJson } from './security.mjs';
import { freshness } from './records.mjs';
import { readStateSafe, readLeasesSafe } from './state.mjs';

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 2000;

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

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

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

export function apiRunners(api, res) {
  const { root, runnersDir } = api;
  const listed = listRunners({ runnersDir });
  sendJson(res, 200, {
    runners: listed.runners.map(runnerView),
    warnings: listed.warnings,
    runnerCmdConfigured: Boolean(resolveRunnerCmd(root)),
    ...freshness(runnersDir)
  });
}

export async function apiRunnerStart(api, req, res) {
  const { root, runnersDir, runnerLogDir, ensureRunnersWatcher } = api;
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

export async function apiRunnerStop(api, req, res) {
  const { root, runnersDir } = api;
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

/**
 * PURE (given the lease engine). The first target of `leaseTarget` that
 * overlaps `target`, else null. Lifted out of apiLeaseClaim so the handler
 * reads as "for each foreign lease, is there an overlap" instead of nesting a
 * try/catch inside two loops.
 */
function firstOverlap(target, leaseTarget) {
  for (const other of String(leaseTarget || '').split(/[,\s]+/).filter(Boolean)) {
    try {
      if (targetsOverlap(target, other)) return other;
    } catch (error) {
      if (!(error instanceof UnsupportedPatternError)) throw error;
    }
  }
  return null;
}

/**
 * POST /api/leases/claim {target, task, actor, until?, notes?}
 * The lease board is the product's core primitive, so it must be operable
 * from here — but claiming is exactly where wrong semantics do damage, so
 * the target is validated against the canonical grammar (lease-overlap) and
 * a claim that overlaps another actor's live lease is refused unless the
 * caller acknowledges it, mirroring the runner brief gate. Every outcome is
 * audited.
 */
export async function apiLeaseClaim(api, req, res) {
  const { root } = api;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, parsed.code, { error: parsed.error });
  const body = parsed.body || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const target = str(body.target);
  const task = str(body.task);
  const actor = str(body.actor);
  if (!target || !task || !actor) {
    return sendJson(res, 400, {
      error: 'bad-request',
      hint: 'body must be {"target","task","actor"[,"until","notes"]}'
    });
  }
  const check = validateTarget(target);
  if (!check.ok) {
    return sendJson(res, 400, { error: 'unsupported-target', reason: check.reason, target });
  }
  // Conflict = another actor's live lease whose target intersects this one.
  const conflicts = [];
  for (const lease of readLeasesSafe(Date.now()) || []) {
    const owner = (lease.lockedBy || '').trim();
    if (!owner || owner === actor) continue;
    const hit = firstOverlap(target, lease.target);
    if (hit) conflicts.push({ target: hit, lockedBy: owner, until: lease.until || '' });
  }
  if (conflicts.length && body.acknowledged !== true) {
    return sendJson(res, 409, {
      conflictGate: true,
      conflicts,
      hint: 'another actor holds an overlapping lease — resend with acknowledged:true to claim anyway'
    });
  }
  try {
    addLease({ target, project: str(body.project), lockedBy: actor, until: str(body.until), notes: str(body.notes) || task });
  } catch (error) {
    return sendJson(res, 500, { error: 'claim-failed', reason: String(error.message || error) });
  }
  appendEvent(root, {
    ts: new Date().toISOString(),
    verb: 'lease.claimed',
    target, task, actor,
    acknowledgedConflict: conflicts.length > 0,
    conflictCount: conflicts.length
  });
  sendJson(res, 200, { ok: true, target, actor, conflicts });
}

/** POST /api/leases/release {target?, task?, actor?} — at least one needed. */
export async function apiLeaseRelease(api, req, res) {
  const { root } = api;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return sendJson(res, parsed.code, { error: parsed.error });
  const body = parsed.body || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const target = str(body.target);
  const taskId = str(body.task);
  const lockedBy = str(body.actor);
  if (!target && !taskId && !lockedBy) {
    return sendJson(res, 400, {
      error: 'bad-request',
      hint: 'body must carry at least one of {"target","task","actor"}'
    });
  }
  let released = 0;
  try {
    const result = releaseLeases({ target, taskId, lockedBy, project: str(body.project) });
    released = typeof result === 'number' ? result : (result?.released ?? result?.count ?? 0);
  } catch (error) {
    return sendJson(res, 500, { error: 'release-failed', reason: String(error.message || error) });
  }
  appendEvent(root, {
    ts: new Date().toISOString(),
    verb: 'lease.released',
    target, task: taskId, actor: lockedBy || 'control-room',
    released
  });
  sendJson(res, 200, { ok: true, released, target, task: taskId, actor: lockedBy });
}

export function apiRunnerLog(api, res, url) {
  const { runnersDir } = api;
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return sendJson(res, 400, { error: 'bad-request', hint: '?id=<runner id> is required' });
  const rawLines = Number(url.searchParams.get('lines') || DEFAULT_LOG_LINES);
  const lines = Math.min(Math.max(Number.isFinite(rawLines) ? Math.floor(rawLines) : DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
  const tail = tailLog(id, { lines, runnersDir });
  if (!tail.ok && tail.status === 'record-not-found') return sendJson(res, 404, { error: 'not-found', id });
  if (!tail.ok) return sendJson(res, 500, { error: tail.status || 'log read failed', id });
  sendJson(res, 200, { id: tail.id, logFile: tail.logFile, lines: tail.lines, truncated: Boolean(tail.truncated) });
}
