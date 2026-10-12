#!/usr/bin/env node
/**
 * brain:ps — what agent machinery is running on this machine, what it costs,
 * and what can go. Step R1 of the resource-hygiene wave (docs/roadmap-next.md).
 *
 * Why it exists: a 24 GB machine was swapping at 19.4 / 20 GB. Nine Claude
 * sessions had been idle for 3-10 days, each still holding its own MCP
 * servers; a Supabase Docker VM held 8 GB. Nothing told anyone.
 *
 * Two lessons from cleaning that up by hand are built in:
 *
 *   1. PROCESS AGE IS NOT IDLENESS. A 14-day-old session was mid-run with
 *      live subagents. And transcript mtime is not activity either — idle
 *      sessions rewrite metadata in synchronized bursts. Only the timestamp
 *      of the last real user/assistant message counts.
 *   2. ONE TRANSCRIPT CANNOT BE TIED TO ONE PID. So activity is judged per
 *      project directory, conservatively: if anything in that project spoke
 *      recently, every session there counts as active.
 *
 * What it will and will not do:
 *   - report: always, read-only.
 *   - --reap-orphans: SIGTERM helper processes (MCP servers, headless
 *     browsers, dev servers) whose agent parent is gone (re-parented to
 *     PID 1), plus their descendants. Dry run unless --yes.
 *   - idle sessions are NEVER killed here — they belong to someone's
 *     terminal. The report prints the command; transcripts survive, so
 *     `claude --resume` picks them up again.
 *
 *   npm run brain:ps -- [--idle-hours 4] [--json] [--reap-orphans [--yes]]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.mjs';
import { takeFlag, takeOption, unknownFlags } from './common.mjs';
import { projectSlug, transcriptsRoot, listTranscripts } from './brain-tokens.mjs';

/** Helper kinds an agent spawns; these are the ones that can be orphaned. */
export const HELPER_KINDS = new Set(['mcp-server', 'headless-browser', 'dev-server']);

// --- pure core ---------------------------------------------------------------

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

/** Which kind of agent machinery a command line is, or null if none of ours. */
export function classify(command) {
  const c = String(command || '');
  if (/(^|\/)(claude|codex)(\s|$)/.test(c) && !/Claude\.app|Helper/.test(c)) return 'agent-session';
  if (/chrome-headless|ms-playwright\/|--headless(=|\s|$)/.test(c)) return 'headless-browser';
  if (/(^|[\s/@_-])mcp([\s/@._-]|$)|context7|modelcontextprotocol/i.test(c)) return 'mcp-server';
  if (/next-server|next dev|(^|\/)vite(\s|$)|webpack(-dev-server)?\s|nodemon|tsx watch|turbo (dev|run)/.test(c)) return 'dev-server';
  if (/com\.docker\.|Virtualization\.VirtualMachine/.test(c)) return 'docker';
  return null;
}

/**
 * Orphans: helper processes re-parented to PID 1 (their agent died without
 * taking them along), plus every descendant of such a helper.
 */
export function findOrphans(rows) {
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r);
  }
  const out = new Map();
  const take = (r) => {
    if (out.has(r.pid)) return;
    out.set(r.pid, r);
    for (const c of children.get(r.pid) || []) take(c);
  };
  for (const r of rows) {
    if (r.ppid === 1 && HELPER_KINDS.has(classify(r.command))) take(r);
  }
  return [...out.values()];
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

/** Latest real user/assistant timestamp (ms) among parsed transcript records. */
export function lastRealMessageMs(records) {
  let last = 0;
  for (const r of records) {
    if (!r || (r.type !== 'user' && r.type !== 'assistant')) continue;
    const t = Date.parse(r.timestamp);
    if (t > last) last = t;
  }
  return last;
}

/**
 * Verdict per agent session. `activityByCwd` maps cwd → last real message ms
 * for that project. Unknown activity is never called idle.
 */
export function sessionVerdicts(sessions, activityByCwd, { now = Date.now(), idleMs = 4 * 3600_000 } = {}) {
  return sessions.map((s) => {
    const last = s.cwd ? activityByCwd.get(s.cwd) : undefined;
    let verdict;
    if (!last) verdict = 'unknown';
    else if (now - last < idleMs || s.ageSec * 1000 < idleMs) verdict = 'active';
    else verdict = 'idle';
    return { ...s, lastActivityMs: last || null, verdict };
  });
}

// --- I/O ---------------------------------------------------------------------

function sh(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); }
  catch { return ''; }
}

function cwdOf(pid) {
  if (process.platform === 'linux') {
    try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  const out = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** Physical footprint incl. compressed/swapped pages (macOS); RSS elsewhere. */
function footprintMb(row) {
  if (process.platform === 'darwin') {
    const m = sh('footprint', ['-p', String(row.pid)]).match(/phys_footprint:\s*([\d.]+)\s*([KMG])B/);
    if (m) return Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 }[m[2]]);
  }
  return row.rssKb / 1024;
}

const TAIL_BYTES = 512 * 1024;
function readTailRecords(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
      try { out.push(JSON.parse(line)); } catch { /* first line of a tail is partial */ }
    }
    return out;
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** cwd → last real message ms, reading only transcripts touched in the window. */
function projectActivity(cwds, { now, windowMs }) {
  const root = transcriptsRoot();
  const map = new Map();
  for (const cwd of cwds) {
    let last = 0;
    for (const f of listTranscripts(path.join(root, projectSlug(cwd)))) {
      let mtime = 0;
      try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      // A file untouched for the whole window cannot hold recent activity;
      // its mtime still bounds how old its last message can be.
      if (now - mtime > windowMs) { last = Math.max(last, Math.min(mtime, now - windowMs)); continue; }
      last = Math.max(last, lastRealMessageMs(readTailRecords(f)));
    }
    if (last) map.set(cwd, last);
  }
  return map;
}

function systemMemory() {
  if (process.platform === 'darwin') {
    const swap = sh('sysctl', ['-n', 'vm.swapusage']).match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
    const free = sh('memory_pressure', []).match(/free percentage:\s*(\d+)%/);
    return {
      totalGb: Math.round(os.totalmem() / 2 ** 30),
      swapUsedGb: swap ? Number(swap[2]) / 1024 : null,
      swapTotalGb: swap ? Number(swap[1]) / 1024 : null,
      freePct: free ? Number(free[1]) : null
    };
  }
  const info = (() => { try { return fs.readFileSync('/proc/meminfo', 'utf8'); } catch { return ''; } })();
  const kb = (k) => Number((info.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
  return {
    totalGb: Math.round(os.totalmem() / 2 ** 30),
    swapUsedGb: (kb('SwapTotal') - kb('SwapFree')) / 2 ** 20,
    swapTotalGb: kb('SwapTotal') / 2 ** 20,
    freePct: info ? Math.round((kb('MemAvailable') / kb('MemTotal')) * 100) : null
  };
}

/** The live process table. */
export function listProcesses() {
  return parsePs(sh('ps', ['-axo', 'pid=,ppid=,rss=,etime=,command=']));
}

export function collect({ idleHours = 4, now = Date.now() } = {}) {
  const rows = listProcesses();
  const self = new Set([process.pid, process.ppid]);
  const byKind = {};
  for (const r of rows) {
    const k = classify(r.command);
    if (!k || self.has(r.pid)) continue;
    (byKind[k] ||= []).push(r);
  }
  const sessions = (byKind['agent-session'] || []).map((r) => ({ ...r, cwd: cwdOf(r.pid), mb: footprintMb(r) }));
  const idleMs = idleHours * 3600_000;
  const activity = projectActivity(new Set(sessions.map((s) => s.cwd).filter(Boolean)), { now, windowMs: idleMs });
  const docker = byKind.docker || [];
  return {
    system: systemMemory(),
    sessions: sessionVerdicts(sessions, activity, { now, idleMs }),
    helpers: Object.fromEntries([...HELPER_KINDS].map((k) => [k, byKind[k] || []])),
    dockerMb: docker.reduce((s, r) => s + footprintMb(r), 0),
    orphans: findOrphans(rows).map((r) => ({ ...r, kind: classify(r.command) || 'child' })),
    idleHours
  };
}

// --- render ------------------------------------------------------------------

const gb = (mb) => (mb / 1024).toFixed(1) + ' GB';
const mbs = (mb) => (mb >= 1024 ? gb(mb) : Math.round(mb) + ' MB');
function age(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const home = (p) => (p ? p.replace(os.homedir(), '~') : '?');

export function renderText(r, { now = Date.now() } = {}) {
  const L = [];
  const s = r.system;
  const swap = s.swapUsedGb != null ? `swap ${s.swapUsedGb.toFixed(1)} / ${s.swapTotalGb.toFixed(1)} GB` : 'swap ?';
  L.push(`brain:ps — ${s.totalGb} GB RAM · ${swap} · ${s.freePct ?? '?'}% free`);
  L.push('');
  const total = r.sessions.reduce((a, x) => a + x.mb, 0);
  L.push(`Agent sessions: ${r.sessions.length} · ${gb(total)}`);
  for (const x of [...r.sessions].sort((a, b) => b.ageSec - a.ageSec)) {
    const last = x.lastActivityMs ? `last message ${age((now - x.lastActivityMs) / 1000)} ago` : 'no transcript found';
    L.push(`  ${String(x.pid).padStart(6)}  ${x.verdict.padEnd(7)} ${mbs(x.mb).padStart(7)}  up ${age(x.ageSec).padEnd(7)} ${last.padEnd(30)} ${home(x.cwd)}`);
  }
  L.push('');
  for (const [k, list] of Object.entries(r.helpers)) {
    if (!list.length) continue;
    const names = new Map();
    for (const h of list) {
      const n = (h.command.match(/(@?[\w.-]+\/)?[\w.-]*(mcp|context7|chrome-headless-shell|next-server|vite|nodemon)[\w.@-]*/i) || [h.command.split(/\s+/)[0]])[0];
      names.set(n, (names.get(n) || 0) + 1);
    }
    const top = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${c}× ${path.basename(n)}`).join(', ');
    L.push(`${k}: ${list.length} processes · ${mbs(list.reduce((a, x) => a + x.rssKb / 1024, 0))} resident · ${top}`);
  }
  if (r.dockerMb) L.push(`docker: ${gb(r.dockerMb)} (VM footprint — stop stacks you are not using)`);
  L.push('');

  const idle = r.sessions.filter((x) => x.verdict === 'idle');
  if (r.orphans.length) {
    L.push(`Orphans: ${r.orphans.length} helper processes whose agent is gone · ${mbs(r.orphans.reduce((a, x) => a + x.rssKb / 1024, 0))}`);
    L.push('  → npm run brain:ps -- --reap-orphans --yes');
  } else L.push('Orphans: none');
  if (idle.length) {
    L.push(`Idle sessions (no message for > ${r.idleHours} h): ${idle.length} · ${gb(idle.reduce((a, x) => a + x.mb, 0))}`);
    L.push(`  → kill -TERM ${idle.map((x) => x.pid).join(' ')}    (transcripts are kept: claude --resume)`);
  }
  const unknown = r.sessions.filter((x) => x.verdict === 'unknown').length;
  if (unknown) L.push(`  ${unknown} session(s) without a readable transcript — left alone.`);
  return L.join('\n');
}

function reap(orphans, { yes }) {
  if (!orphans.length) return 'brain:ps: no orphans to reap.';
  const lines = [];
  for (const o of orphans) {
    if (!yes) { lines.push(`would SIGTERM ${o.pid} (${o.kind}) ${o.command.slice(0, 90)}`); continue; }
    try { process.kill(o.pid, 'SIGTERM'); lines.push(`SIGTERM ${o.pid} (${o.kind})`); }
    catch (e) { lines.push(`skip ${o.pid}: ${e.code || e.message}`); }
  }
  if (!yes) lines.push('dry run — add --yes to send SIGTERM.');
  return lines.join('\n');
}

function main(argv) {
  const args = [...argv];
  const json = takeFlag(args, '--json');
  const doReap = takeFlag(args, '--reap-orphans');
  const yes = takeFlag(args, '--yes');
  const idleHours = Number(takeOption(args, '--idle-hours') || 4);
  if (unknownFlags(args, []).length || !(idleHours > 0)) {
    process.stderr.write('Usage: npm run brain:ps -- [--idle-hours 4] [--json] [--reap-orphans [--yes]]\n');
    process.exit(1);
  }
  const r = collect({ idleHours });
  if (doReap) { process.stdout.write(reap(r.orphans, { yes }) + '\n'); return; }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(renderText(r) + '\n');
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
