/**
 * The process table, shared by brain:ps (inventory, orphan reap) and the
 * runner supervisor (collect a runner's whole tree on stop). Kept apart so
 * neither imports the other.
 */
import { execFileSync } from 'node:child_process';

/** `ps` etime ([[dd-]hh:]mm:ss) → seconds. */
export function parseEtime(s) {
  const m = String(s || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d = 0, h = 0, mi, se] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(se);
}

/** Rows of `ps -axo pid=,ppid=,rss=,etime=,command=`. */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), ageSec: parseEtime(m[4]), command: m[5] });
  }
  return rows;
}

/** Every process below `rootPid` in the parent tree (not including it). PURE. */
export function descendantPids(rows, rootPid) {
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r.pid);
  }
  const out = [];
  const stack = [...(children.get(rootPid) || [])];
  while (stack.length) {
    const pid = stack.pop();
    if (out.includes(pid)) continue;
    out.push(pid);
    stack.push(...(children.get(pid) || []));
  }
  return out;
}

/** The live process table. */
export function listProcesses() {
  return parsePs(psText());
}

function psText() {
  try { return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); }
  catch { return ''; }
}

/**
 * The kernel's memory-pressure verdict: 'normal' | 'warn' | 'critical', or
 * null where there is none (Linux, sysctl failure). macOS only; swap is not a
 * signal there (ADR 0035), this is.
 */
export const PRESSURE_LEVELS = Object.freeze({ 1: 'normal', 2: 'warn', 4: 'critical' });
export function memoryPressure() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    return PRESSURE_LEVELS[raw.trim()] || null;
  } catch { return null; }
}
