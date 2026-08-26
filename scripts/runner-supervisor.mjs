/**
 * Runner process supervision library (M2.75 process-supervision groundwork).
 *
 * NOT the same thing as brain-orchestrate.mjs's slot logic: orchestrate's
 * `orchestration-slot/<n>` leases (ADR 0006) guard *slot assignment* while a
 * worktree is being spawned, and are released once the workstream row exists.
 * This module supervises the *runner processes themselves* after they are
 * launched — PID records under `.project-brain/runners/`, liveness probing,
 * graceful stop, bounded log tailing. The serve daemon consumes these
 * functions; brain-orchestrate.mjs reuses only the detached-spawn primitive
 * (`spawnDetachedRunner`), which was extracted from its `launchRunners`.
 *
 * Contract: every exported function is total — missing directories, missing
 * or corrupt records, and already-dead processes yield status objects, never
 * exceptions. Supervision records are derived state and gitignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BRAIN_DIR, ensureDir } from './common.mjs';

export const DEFAULT_RUNNERS_DIR = path.join(BRAIN_DIR, 'runners');
export const DEFAULT_RUNNER_LOG_DIR = path.join(BRAIN_DIR, 'runner-logs');

/**
 * Spawn a detached, shell-interpreted runner command whose stdout+stderr are
 * appended to `logFile`. Extracted byte-for-byte from brain-orchestrate.mjs
 * `launchRunners` so orchestrate and the supervisor share one spawn path.
 * `env` entries are layered over `process.env`.
 *
 * @returns {{ pid: number, logFile: string }}
 */
export function spawnDetachedRunner({ command, cwd, logFile, env = {} }) {
  ensureDir(path.dirname(logFile));
  const out = fs.openSync(logFile, 'a');
  try {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...env }
    });
    child.unref();
    return { pid: child.pid, logFile };
  } finally {
    fs.closeSync(out);
  }
}

/**
 * Probe whether a PID is alive via `kill(pid, 0)`.
 * EPERM means "exists but not ours" → alive; ESRCH (or anything else) → dead.
 */
export function probePid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { alive: false, reason: 'invalid-pid' };
  try {
    process.kill(n, 0);
    return { alive: true, reason: 'signalled' };
  } catch (error) {
    if (error && error.code === 'EPERM') return { alive: true, reason: 'eperm' };
    return { alive: false, reason: (error && error.code) || 'esrch' };
  }
}

/**
 * Start a supervised runner: detached spawn + supervision record
 * `<runnersDir>/<id>.json` ({pid, workPackageId, startedAt, logFile,
 * status:'running', …}). Returns `{ok:false, error}` instead of throwing.
 */
export function startRunner({ workPackageId, runnerCmd, worktreeDir, logDir = DEFAULT_RUNNER_LOG_DIR, env = {}, runnersDir = DEFAULT_RUNNERS_DIR } = {}) {
  if (!workPackageId) return { ok: false, error: 'workPackageId is required' };
  if (!runnerCmd) return { ok: false, error: 'runnerCmd is required' };
  const id = recordId(workPackageId);
  try {
    ensureDir(runnersDir);
    ensureDir(logDir);
    const logFile = path.join(logDir, `${id}.log`);
    const { pid } = spawnDetachedRunner({ command: runnerCmd, cwd: worktreeDir || process.cwd(), logFile, env });
    const record = {
      pid,
      workPackageId,
      startedAt: new Date().toISOString(),
      logFile,
      status: 'running',
      worktreeDir: worktreeDir || '',
      runnerCmd
    };
    writeRecord(runnersDir, id, record);
    return { ok: true, id, pid, record };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/**
 * List supervision records with liveness reconciliation:
 * - PID alive                          → status 'running'
 * - PID dead, record said 'running'    → status 'orphaned' (died on us)
 * - PID dead, record said anything else → status 'exited'
 * Reconciled status is persisted back to the record (best effort).
 * Corrupt records are skipped with a `warnings` entry; a missing runnersDir
 * yields an empty listing. Never throws.
 */
export function listRunners({ runnersDir = DEFAULT_RUNNERS_DIR } = {}) {
  const runners = [];
  const warnings = [];
  let files = [];
  try {
    files = fs.readdirSync(runnersDir).filter(f => f.endsWith('.json')).sort();
  } catch {
    return { ok: true, runners, warnings };
  }
  for (const file of files) {
    const full = path.join(runnersDir, file);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record is not an object');
    } catch (error) {
      warnings.push({ file, warning: 'corrupt-record', detail: message(error) });
      continue;
    }
    const probe = probePid(record.pid);
    let status;
    if (probe.alive) status = 'running';
    else if (record.status === 'running') status = 'orphaned';
    else status = 'exited';
    if (status !== record.status) {
      record = { ...record, status };
      if (status !== 'running' && !record.endedAt) record.endedAt = new Date().toISOString();
      try { writeRecord(runnersDir, file.replace(/\.json$/, ''), record); } catch { /* listing stays best-effort */ }
    }
    runners.push({ id: file.replace(/\.json$/, ''), ...record });
  }
  return { ok: true, runners, warnings };
}

/**
 * Stop a supervised runner: SIGTERM (to the detached process group when
 * possible), poll up to `graceMs`, escalate to SIGKILL. Idempotent on
 * already-dead runners; total on missing records.
 */
export async function stopRunner(id, { graceMs = 5000, pollMs = 100, runnersDir = DEFAULT_RUNNERS_DIR } = {}) {
  const rid = recordId(id);
  const file = path.join(runnersDir, `${rid}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record is not an object');
  } catch (error) {
    return { ok: false, status: 'record-not-found', id: rid, error: message(error) };
  }
  const pid = Number(record.pid);
  const finish = (status, signal) => {
    const next = { ...record, status: 'exited' };
    if (!next.endedAt) next.endedAt = new Date().toISOString();
    if (signal) next.stopSignal = signal;
    try { writeRecord(runnersDir, rid, next); } catch { /* best effort */ }
    return { ok: true, status, id: rid, pid, signal: signal || null };
  };
  if (!probePid(pid).alive) return finish('already-exited', null);
  signalTree(pid, 'SIGTERM');
  const termDeadline = Date.now() + Math.max(0, Number(graceMs) || 0);
  while (Date.now() < termDeadline) {
    if (!probePid(pid).alive) return finish('stopped', 'SIGTERM');
    await sleep(pollMs);
  }
  if (!probePid(pid).alive) return finish('stopped', 'SIGTERM');
  signalTree(pid, 'SIGKILL');
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (!probePid(pid).alive) return finish('stopped', 'SIGKILL');
    await sleep(pollMs);
  }
  return { ok: false, status: 'still-running', id: rid, pid };
}

/**
 * Return the last `lines` lines of a runner's log with a bounded read:
 * at most `maxBytes` are read from the end of the file (no full-file load).
 * Missing log → empty lines; missing record → {ok:false}. Never throws.
 */
export function tailLog(id, { lines = 100, maxBytes = 64 * 1024 , runnersDir = DEFAULT_RUNNERS_DIR } = {}) {
  const rid = recordId(id);
  const file = path.join(runnersDir, `${rid}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, status: 'record-not-found', id: rid, error: message(error), lines: [] };
  }
  const logFile = String(record?.logFile || '');
  if (!logFile) return { ok: false, status: 'no-log-file', id: rid, lines: [] };
  let fd;
  try {
    fd = fs.openSync(logFile, 'r');
  } catch {
    return { ok: true, id: rid, logFile, lines: [], bytesRead: 0, truncated: false };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const cap = Math.max(1, Number(maxBytes) || 64 * 1024);
    const bytesRead = Math.min(size, cap);
    const start = size - bytesRead;
    const buffer = Buffer.alloc(bytesRead);
    fs.readSync(fd, buffer, 0, bytesRead, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      // Drop the (likely partial) first line when we started mid-file.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    const want = Math.max(0, Number(lines) || 0);
    return {
      ok: true,
      id: rid,
      logFile,
      lines: all.slice(-want),
      bytesRead,
      truncated: start > 0 || all.length > want
    };
  } catch (error) {
    return { ok: false, status: 'read-failed', id: rid, logFile, error: message(error), lines: [] };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** Filesystem-safe record/log id derived from a work-package id. */
export function recordId(workPackageId) {
  return String(workPackageId).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function writeRecord(runnersDir, id, record) {
  ensureDir(runnersDir);
  fs.writeFileSync(path.join(runnersDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

function signalTree(pid, signal) {
  // Detached runners are process-group leaders; prefer killing the group so
  // shell-wrapped commands take their children with them.
  try {
    process.kill(-pid, signal);
    return;
  } catch { /* fall through to single-pid kill */ }
  try {
    process.kill(pid, signal);
  } catch { /* already gone */ }
}

function message(error) {
  return (error && error.message) || String(error);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ms) || 1)));
}
