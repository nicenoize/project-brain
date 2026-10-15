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
import { BRAIN_DIR, takeFlag, takeOption, unknownFlags } from './common.mjs';
import { listRunners, stopRunner } from './runner-supervisor.mjs';
import { projectSlug, transcriptsRoot, listTranscripts } from './brain-tokens.mjs';
import { parseEtime, parsePs, descendantPids, listProcesses, memoryPressure } from './procs.mjs';

export { parseEtime, parsePs, descendantPids, listProcesses };

/** Helper kinds an agent spawns; these are the ones that can be orphaned. */
export const HELPER_KINDS = new Set(['mcp-server', 'headless-browser', 'dev-server']);

// --- pure core ---------------------------------------------------------------

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

/**
 * Resource rules (R3/R4), overridable per repo in `.project-brain/config.json`
 * under `"resources"`. The admission signal is the kernel's memory PRESSURE
 * and the free share — not swap: macOS keeps swapped pages allocated until
 * they are touched, so swap read 92 % full right after 3.4 GB were freed.
 */
export const RESOURCE_DEFAULTS = Object.freeze({
  sessionIdleHours: 4, // foreign agent session → suggest
  runnerIdleHours: 1, // brain-launched runner with a silent log → stop
  stackIdleHours: 12, // docker stack of a project nobody spoke in → suggest
  maxConcurrentAgents: 6,
  minFreePct: 10
});

/** Merge `config.resources` over the defaults; junk values fall back. PURE. */
export function resourceConfig(config = {}) {
  const r = (config && config.resources) || {};
  const out = { ...RESOURCE_DEFAULTS };
  for (const k of Object.keys(RESOURCE_DEFAULTS)) {
    const n = Number(r[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/** `docker ps --format '{{.Label …project}}|{{.Label …workdir}}|{{.Names}}'` → stacks. PURE. */
export function parseDockerPs(text) {
  const stacks = new Map();
  for (const line of String(text || '').split('\n')) {
    const [project, workdir, name] = line.split('|');
    if (!name) continue;
    const key = project || name;
    const st = stacks.get(key) || { project: key, compose: Boolean(project), workdir: workdir || null, containers: [] };
    if (!st.workdir && workdir) st.workdir = workdir;
    st.containers.push(name);
    stacks.set(key, st);
  }
  return [...stacks.values()];
}

/**
 * Which project a stack belongs to. `projects` are {slug, cwd}: the cwd is the
 * project's REAL path (read from its transcripts), because a slug cannot be
 * decoded — "-a-club-ops2" may be a/club-ops2 or a/club/ops2. Ownership is
 * path containment, or the slug as a whole path segment (an agent's
 * scratchpad: /tmp/claude-501/<slug>/…). Deepest match wins. PURE.
 */
export function stackOwner(workdir, projects) {
  if (!workdir) return null;
  let best = null;
  for (const p of projects) {
    const inside = p.cwd && (workdir === p.cwd || workdir.startsWith(p.cwd + '/'));
    const scratch = workdir.includes(`/${p.slug}/`) || workdir.endsWith(`/${p.slug}`);
    const depth = inside ? p.cwd.length : scratch ? p.slug.length : -1;
    if (depth >= 0 && (!best || depth > best.depth)) best = { slug: p.slug, depth };
  }
  return best ? best.slug : null;
}

/**
 * May another agent start? Refuses on kernel pressure warn/critical, on a
 * free share under `minFreePct`, or at `maxConcurrentAgents`; names what
 * could be reclaimed. PURE.
 */
export function admission(snap, cfg = RESOURCE_DEFAULTS, { starting = 1 } = {}) {
  const reasons = [];
  const s = snap.system || {};
  if (s.pressure === 'warn' || s.pressure === 'critical') reasons.push(`memory pressure is ${s.pressure}`);
  if (s.freePct != null && s.freePct < cfg.minFreePct) reasons.push(`only ${s.freePct}% memory free (minimum ${cfg.minFreePct}%)`);
  const running = (snap.sessions || []).length;
  if (running + starting > cfg.maxConcurrentAgents) reasons.push(`${running} agent sessions running, ${starting} more would exceed ${cfg.maxConcurrentAgents}`);
  const suggest = [];
  const idle = (snap.sessions || []).filter((x) => x.verdict === 'idle');
  if (idle.length) suggest.push(`${idle.length} idle session(s): kill -TERM ${idle.map((x) => x.pid).join(' ')}`);
  if ((snap.orphans || []).length) suggest.push(`${snap.orphans.length} orphaned helper(s): npm run brain:ps -- --apply --yes`);
  for (const st of (snap.stacks || []).filter((x) => x.verdict === 'idle')) suggest.push(`idle docker stack ${st.project}: ${st.stopCmd}`);
  return { ok: reasons.length === 0, reasons, suggest };
}

/**
 * MCP config hygiene (R6). Every agent session starts its own copy of every
 * configured server; `npx …@latest` adds an npm wrapper process and a
 * registry check per start, and browser servers configured for ALL projects
 * ride along in sessions that never open a browser. PURE.
 */
export function mcpAudit(servers) {
  const out = [];
  for (const sv of servers) {
    const args = (sv.args || []).join(' ');
    const line = `${sv.command || ''} ${args}`;
    if (/^(npx|bunx|pnpm dlx|yarn dlx)\b/.test(line.trim()) || /\b(npx|dlx)\b/.test(sv.command || '')) {
      const pkg = (sv.args || []).find((a) => /^@?[\w.-]+(\/[\w.-]+)?(@[\w.-]+)?$/.test(a) && !a.startsWith('-')) || '';
      const floating = /@latest$/.test(pkg) || !/@[\d^~]/.test(pkg.replace(/^@/, ''));
      if (floating) out.push({ server: sv.name, scope: sv.scope, kind: 'unpinned', fix: `pin it: npm i -g ${pkg.replace(/@latest$/, '')} and point "command" at the installed binary (no npm wrapper, no registry check per session)` });
    }
    if (sv.scope === 'user' && /playwright|chrome-devtools|puppeteer|browser/i.test(`${sv.name} ${line}`)) {
      out.push({ server: sv.name, scope: sv.scope, kind: 'heavy-global', fix: 'browser servers configured for every project start in every session — move it to the projects that need it (claude mcp add --scope project)' });
    }
  }
  return out;
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

/** Last real message ms in one transcript directory, reading only files touched in the window. */
function dirActivity(dir, { now, windowMs }) {
  let last = 0;
  for (const f of listTranscripts(dir)) {
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    // A file untouched for the whole window cannot hold recent activity;
    // its mtime still bounds how old its last message can be.
    if (now - mtime > windowMs) { last = Math.max(last, Math.min(mtime, now - windowMs)); continue; }
    last = Math.max(last, lastRealMessageMs(readTailRecords(f)));
  }
  return last;
}

/** cwd → last real message ms. */
function projectActivity(cwds, { now, windowMs }) {
  const root = transcriptsRoot();
  const map = new Map();
  for (const cwd of cwds) {
    const last = dirActivity(path.join(root, projectSlug(cwd)), { now, windowMs });
    if (last) map.set(cwd, last);
  }
  return map;
}

function readConfig(dir = BRAIN_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { return {}; }
}

/** A project's real path: the `cwd` its transcripts record (newest file, first 64 kB). */
function projectCwd(dir) {
  let newest = null;
  for (const f of listTranscripts(dir)) {
    if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
    try { const m = fs.statSync(f).mtimeMs; if (!newest || m > newest.m) newest = { f, m }; } catch { /* raced */ }
  }
  if (!newest) return null;
  let fd;
  try {
    fd = fs.openSync(newest.f, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try { const r = JSON.parse(line); if (r && typeof r.cwd === 'string') return r.cwd; } catch { /* partial */ }
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/** Running docker stacks with their owning project's activity (empty without docker). */
function dockerStacks({ now, windowMs }) {
  // `.Labels` is a joined string in `docker ps --format`; `.Label "k"` is the lookup.
  const fmt = '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}{{.Label "com.supabase.cli.workdir"}}|{{.Names}}';
  const text = sh('docker', ['ps', '--format', fmt]);
  if (!text) return [];
  const root = transcriptsRoot();
  let slugs = [];
  try { slugs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no transcripts */ }
  const projects = slugs.map((slug) => ({ slug, cwd: projectCwd(path.join(root, slug)) }));
  return parseDockerPs(text).map((st) => {
    const owner = stackOwner(st.workdir, projects);
    const last = owner ? dirActivity(path.join(root, owner), { now, windowMs }) : 0;
    const verdict = !owner || !last ? 'unknown' : now - last < windowMs ? 'active' : 'idle';
    const label = st.compose ? `label=com.docker.compose.project=${st.project}` : `name=${st.project}`;
    return { ...st, owner, lastActivityMs: last || null, verdict, stopCmd: `docker stop $(docker ps -q --filter ${label})` };
  });
}

/** MCP servers from the user's Claude config and this project's .mcp.json. */
function mcpServers(cwd = process.cwd()) {
  const out = [];
  const base = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  try {
    const d = JSON.parse(fs.readFileSync(path.join(base, '.claude.json'), 'utf8'));
    for (const [name, v] of Object.entries(d.mcpServers || {})) out.push({ name, scope: 'user', command: v.command, args: v.args || [] });
    const proj = (d.projects || {})[cwd];
    for (const [name, v] of Object.entries((proj && proj.mcpServers) || {})) out.push({ name, scope: 'local', command: v.command, args: v.args || [] });
  } catch { /* no user config */ }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
    for (const [name, v] of Object.entries(d.mcpServers || {})) out.push({ name, scope: 'project', command: v.command, args: v.args || [] });
  } catch { /* none */ }
  return out;
}

/** Brain-launched runners; a running one whose log has been silent is idle. */
function runnerStates({ now, idleMs }) {
  let runners = [];
  try { runners = listRunners().runners; } catch { return []; }
  return runners.map((r) => {
    let quietMs = null;
    try { quietMs = now - fs.statSync(r.logFile).mtimeMs; } catch { /* no log yet */ }
    const idle = r.status === 'running' && quietMs != null && quietMs > idleMs;
    return { id: r.id, pid: r.pid, status: r.status, leftovers: Boolean(r.leftovers), quietMs, verdict: idle || r.leftovers ? 'stop' : r.status };
  });
}

function systemMemory() {
  if (process.platform === 'darwin') {
    const swap = sh('sysctl', ['-n', 'vm.swapusage']).match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
    const free = sh('memory_pressure', []).match(/free percentage:\s*(\d+)%/);
    return {
      totalGb: Math.round(os.totalmem() / 2 ** 30),
      swapUsedGb: swap ? Number(swap[2]) / 1024 : null,
      swapTotalGb: swap ? Number(swap[1]) / 1024 : null,
      freePct: free ? Number(free[1]) : null,
      pressure: memoryPressure()
    };
  }
  const info = (() => { try { return fs.readFileSync('/proc/meminfo', 'utf8'); } catch { return ''; } })();
  const kb = (k) => Number((info.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
  return {
    totalGb: Math.round(os.totalmem() / 2 ** 30),
    swapUsedGb: (kb('SwapTotal') - kb('SwapFree')) / 2 ** 20,
    swapTotalGb: kb('SwapTotal') / 2 ** 20,
    freePct: info ? Math.round((kb('MemAvailable') / kb('MemTotal')) * 100) : null,
    pressure: null
  };
}

/**
 * The cheap reading for hooks and admission: memory, and agent sessions by
 * process table only — no footprint, no transcripts, no docker (~30 ms).
 */
export function collectQuick() {
  const rows = listProcesses();
  const self = new Set([process.pid, process.ppid]);
  return {
    system: systemMemory(),
    sessions: rows.filter((r) => !self.has(r.pid) && classify(r.command) === 'agent-session'),
    orphans: findOrphans(rows)
  };
}

export function collect({ idleHours, now = Date.now(), config = readConfig() } = {}) {
  const cfg = resourceConfig(config);
  if (idleHours) cfg.sessionIdleHours = idleHours;
  idleHours = cfg.sessionIdleHours;
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
  const devServers = (byKind['dev-server'] || []).map((r) => {
    const cwd = cwdOf(r.pid);
    return { ...r, cwd, deadCwd: Boolean(cwd) && !fs.existsSync(cwd) };
  });
  const snap = {
    system: systemMemory(),
    sessions: sessionVerdicts(sessions, activity, { now, idleMs }),
    helpers: Object.fromEntries([...HELPER_KINDS].map((k) => [k, k === 'dev-server' ? devServers : byKind[k] || []])),
    dockerMb: docker.reduce((s, r) => s + footprintMb(r), 0),
    stacks: dockerStacks({ now, windowMs: cfg.stackIdleHours * 3600_000 }),
    runners: runnerStates({ now, idleMs: cfg.runnerIdleHours * 3600_000 }),
    orphans: findOrphans(rows).map((r) => ({ ...r, kind: classify(r.command) || 'child' })),
    mcp: mcpAudit(mcpServers()),
    idleHours,
    config: cfg
  };
  snap.admission = admission(snap, cfg, { starting: 1 });
  return snap;
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
  L.push(`brain:ps — ${s.totalGb} GB RAM · ${s.freePct ?? '?'}% free${s.pressure ? ` · pressure ${s.pressure}` : ''} · ${swap}`);
  L.push('');
  const total = r.sessions.reduce((a, x) => a + x.mb, 0);
  L.push(`Agent sessions: ${r.sessions.length} · ${gb(total)}`);
  for (const x of [...r.sessions].sort((a, b) => b.ageSec - a.ageSec)) {
    const last = x.lastActivityMs ? `last message ${age((now - x.lastActivityMs) / 1000)} ago` : 'no transcript found';
    L.push(`  ${String(x.pid).padStart(6)}  ${x.verdict.padEnd(7)} ${mbs(x.mb).padStart(7)}  up ${age(x.ageSec).padEnd(7)} ${last.padEnd(30)} ${home(x.cwd)}`);
  }
  if ((r.runners || []).length) {
    L.push('');
    L.push(`Brain runners: ${r.runners.length}`);
    for (const x of r.runners) {
      const quiet = x.quietMs != null ? `log quiet ${age(x.quietMs / 1000)}` : 'no log';
      L.push(`  ${x.id.padEnd(24).slice(0, 24)} ${x.status.padEnd(9)} ${quiet}${x.leftovers ? ' · leader gone, group still running' : ''}${x.verdict === 'stop' ? '  → stop' : ''}`);
    }
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
    const dead = list.filter((x) => x.deadCwd).length;
    L.push(`${k}: ${list.length} processes · ${mbs(list.reduce((a, x) => a + x.rssKb / 1024, 0))} resident · ${top}${dead ? ` · ${dead} in a deleted directory` : ''}`);
  }
  if (r.dockerMb) {
    L.push(`docker: ${gb(r.dockerMb)} VM footprint`);
    for (const st of r.stacks || []) {
      const who = st.owner ? `project ${st.owner}` : 'owner unknown';
      const last = st.lastActivityMs ? `, last message ${age((now - st.lastActivityMs) / 1000)} ago` : '';
      L.push(`  ${st.project.padEnd(28).slice(0, 28)} ${String(st.containers.length).padStart(2)} containers · ${st.verdict.padEnd(7)} ${who}${last}`);
    }
  }
  if ((r.mcp || []).length) {
    L.push('');
    L.push(`MCP config: every agent session starts its own copy of each server`);
    for (const f of r.mcp) L.push(`  ${f.server} (${f.scope}, ${f.kind}) → ${f.fix}`);
  }
  L.push('');

  const own = [
    ...(r.runners || []).filter((x) => x.verdict === 'stop').map((x) => `runner ${x.id}`),
    ...r.orphans.map((x) => `orphan ${x.pid} (${x.kind})`),
    ...(r.helpers['dev-server'] || []).filter((x) => x.deadCwd).map((x) => `dev server ${x.pid} (directory deleted)`)
  ];
  if (own.length) {
    L.push(`Can go now — brain-owned or dead: ${own.join(', ')}`);
    L.push('  → npm run brain:ps -- --apply --yes');
  } else L.push('Can go now: nothing (no orphans, no idle brain runners)');
  const idle = r.sessions.filter((x) => x.verdict === 'idle');
  if (idle.length) {
    L.push(`Idle sessions (no message for > ${r.idleHours} h): ${idle.length} · ${gb(idle.reduce((a, x) => a + x.mb, 0))} — yours to close`);
    L.push(`  → kill -TERM ${idle.map((x) => x.pid).join(' ')}    (transcripts are kept: claude --resume)`);
  }
  for (const st of (r.stacks || []).filter((x) => x.verdict === 'idle')) {
    L.push(`Idle docker stack ${st.project} (no message in its project for > ${r.config.stackIdleHours} h) — yours to stop`);
    L.push(`  → ${st.stopCmd}`);
  }
  const unknown = r.sessions.filter((x) => x.verdict === 'unknown').length;
  if (unknown) L.push(`  ${unknown} session(s) without a readable transcript — left alone.`);
  if (r.admission) {
    L.push('');
    L.push(r.admission.ok ? 'New agents: ok to start' : `New agents: HELD — ${r.admission.reasons.join('; ')}`);
  }
  return L.join('\n');
}

/** One line for the SessionStart hook, or '' when memory is fine. PURE. */
export function hookLine(quick, cfg = RESOURCE_DEFAULTS) {
  const gate = admission(quick, cfg, { starting: 0 });
  if (gate.ok) return '';
  return `brain: ${gate.reasons.join('; ')} — \`npm run brain:ps\` shows idle sessions, orphans and stacks that can go.`;
}

/** Act on what the brain owns or what is dead. Dry run unless `yes`. */
export async function applyRules(r, { yes }) {
  const lines = [];
  const kill = (pid, what) => {
    if (!yes) return lines.push(`would SIGTERM ${pid} (${what})`);
    try { process.kill(pid, 'SIGTERM'); lines.push(`SIGTERM ${pid} (${what})`); }
    catch (e) { lines.push(`skip ${pid}: ${e.code || e.message}`); }
  };
  for (const x of (r.runners || []).filter((x) => x.verdict === 'stop')) {
    if (!yes) { lines.push(`would stop runner ${x.id}${x.leftovers ? ' (leftover group)' : ' (log quiet)'}`); continue; }
    const res = await stopRunner(x.id);
    lines.push(`runner ${x.id}: ${res.status}`);
  }
  for (const o of r.orphans) kill(o.pid, `orphan ${o.kind}`);
  for (const d of (r.helpers['dev-server'] || []).filter((x) => x.deadCwd)) kill(d.pid, 'dev server in a deleted directory');
  if (!lines.length) return 'brain:ps: nothing to apply — foreign sessions and docker stacks are only ever suggested.';
  if (!yes) lines.push('dry run — add --yes to act.');
  return lines.join('\n');
}

async function main(argv) {
  const args = [...argv];
  const json = takeFlag(args, '--json');
  const apply = takeFlag(args, '--apply') || takeFlag(args, '--reap-orphans');
  const yes = takeFlag(args, '--yes');
  const hook = takeFlag(args, '--hook');
  const idleHours = Number(takeOption(args, '--idle-hours') || 0) || undefined;
  if (unknownFlags(args, []).length) {
    process.stderr.write('Usage: npm run brain:ps -- [--idle-hours N] [--json] [--apply [--yes]] [--hook]\n');
    process.exit(1);
  }
  if (hook) {
    // SessionStart: speak only under memory pressure, to the user, not the context.
    try {
      const line = hookLine(collectQuick(), resourceConfig(readConfig()));
      if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
    } catch { /* a hook never blocks a session */ }
    return;
  }
  const r = collect({ idleHours });
  if (apply) { process.stdout.write((await applyRules(r, { yes })) + '\n'); return; }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(renderText(r) + '\n');
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`[brain:ps] ${e.message || e}\n`); process.exit(1); });
