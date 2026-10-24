/**
 * Sessions — park an open Claude Code session to free its RAM, keep what it
 * was about. People leave sessions open for days only to keep their context
 * and to see what they were working on; each one holds 100–600 MB plus its own
 * copy of every MCP server. Parking writes a card (the first ask, the latest
 * asks, where the work stood, files edited, branch) and the exact resume
 * command, then ends the process. The transcript stays where Claude Code keeps
 * it, so `claude --resume <id>` brings the whole session back.
 *
 * Identity comes from Claude Code's own registry, `<config dir>/sessions/
 * <pid>.json` (pid, sessionId, cwd, name, status idle|busy), so activity is
 * per SESSION from its own transcript — not per project folder, where one busy
 * session made every other session in that repo look active.
 *
 * A busy session, this session's own ancestors and anything that is not an
 * interactive session are never parked. PURE core on top, I/O below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listProcesses, descendantPids } from './procs.mjs';
import { projectSlug } from './brain-tokens.mjs';
import { emptyState, foldRecords, parseChunk } from './brain-warm.mjs';

export const PARK_DEFAULTS = Object.freeze({ idleHours: 2 });
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;

// --- pure core ---------------------------------------------------------------

/** One registry file → a session row, or null when it is not an interactive session. PURE. */
export function parseRegistry(json, configDir) {
  const s = json && typeof json === 'object' ? json : null;
  if (!s || !Number.isFinite(s.pid) || !s.sessionId || !s.cwd) return null;
  if (s.kind && s.kind !== 'interactive') return null;
  return {
    pid: s.pid,
    sessionId: String(s.sessionId),
    cwd: String(s.cwd),
    name: s.name ? String(s.name) : null,
    status: s.status || 'unknown',
    statusAt: Number(s.statusUpdatedAt || s.updatedAt || 0) || null,
    startedAt: Number(s.startedAt || 0) || null,
    procStart: s.procStart || null,
    configDir
  };
}

/** Process tree RAM (MB) per root pid, from ps rows. PURE. */
export function treeMb(rows, pid, ownMb = null) {
  const rss = new Map(rows.map((r) => [r.pid, r.rssKb || 0]));
  const kids = descendantPids(rows, pid);
  const own = Number.isFinite(ownMb) ? ownMb : (rss.get(pid) || 0) / 1024;
  const children = kids.reduce((s, k) => s + (rss.get(k) || 0), 0) / 1024;
  return { own: Math.round(own), children: Math.round(children), total: Math.round(own + children), helpers: kids.length };
}

/**
 * Should this session be parked? Never when busy, never our own ancestor,
 * never without a known last message. PURE.
 */
export function parkVerdict(s, { now = Date.now(), idleMs = PARK_DEFAULTS.idleHours * 3600_000, ancestors = new Set() } = {}) {
  if (ancestors.has(s.pid)) return { park: false, why: 'this session' };
  if (s.status !== 'idle') return { park: false, why: 'working' }; // busy, shell, or a status we do not know
  if (!s.lastMessageMs) return { park: false, why: 'no transcript' };
  const quiet = now - s.lastMessageMs;
  if (quiet < idleMs) return { park: false, why: 'recent' };
  return { park: true, why: 'idle', quietMs: quiet };
}

/** The resume command for a card; names the config dir when it is not the default. PURE. */
export function resumeCommand(card, { home = os.homedir() } = {}) {
  const q = (p) => (/^[\w@%+=:,./~-]+$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`);
  const cwd = card.cwd.startsWith(home + path.sep) ? '~' + card.cwd.slice(home.length) : card.cwd;
  const dflt = path.join(home, '.claude');
  const env = card.configDir && path.resolve(card.configDir) !== dflt ? `CLAUDE_CONFIG_DIR=${q(card.configDir.replace(home, '~'))} ` : '';
  return `cd ${q(cwd)} && ${env}claude --resume ${card.sessionId}`;
}

/** Build the park card from a session row and its folded transcript state. PURE. */
export function buildCard(s, state, { now = Date.now(), mb = null } = {}) {
  const edited = Object.entries(state.files || {})
    .filter(([, f]) => f.edits)
    .sort((a, b) => b[1].last - a[1].last)
    .map(([p]) => (p.startsWith(s.cwd + path.sep) ? p.slice(s.cwd.length + 1) : p))
    .slice(0, 12);
  return {
    v: 1,
    sessionId: s.sessionId,
    name: s.name,
    cwd: s.cwd,
    project: path.basename(s.cwd),
    configDir: s.configDir,
    branch: state.branch || null,
    goal: state.goal || null,
    asks: (state.asks || []).filter((a) => a !== state.goal).slice(-3),
    lastAgent: state.lastAgent || null,
    edited,
    checks: (state.checks || []).slice(-3).map((c) => ({ cmd: c.cmd, ok: c.ok })),
    compactions: (state.compactions || []).length,
    lastMessageMs: s.lastMessageMs || null,
    startedAt: s.startedAt || null,
    parkedAt: now,
    freedMb: mb
  };
}

/** A card as a few lines for the terminal. PURE. */
export function renderCard(card, { now = Date.now(), width = 100 } = {}) {
  const cut = (t, n = width) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  const lines = [`${card.name || card.project}  ·  ${card.project}${card.branch ? ` @ ${card.branch}` : ''}  ·  ${ago(now - (card.lastMessageMs || card.parkedAt))}`];
  if (card.goal) lines.push(`  asked: ${cut(card.goal)}`);
  const last = card.asks && card.asks[card.asks.length - 1];
  if (last) lines.push(`  last ask: ${cut(last)}`);
  if (card.lastAgent) lines.push(`  stood: ${cut(card.lastAgent)}`);
  if (card.edited && card.edited.length) lines.push(`  edited: ${cut(card.edited.join(', '))}`);
  lines.push(`  resume: ${resumeCommand(card)}`);
  return lines.join('\n');
}

export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Match a session or card by pid, id prefix, or a word from its name or project. PURE. */
export function pick(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  if (/^\d+$/.test(q)) { const byPid = list.filter((s) => String(s.pid) === q); if (byPid.length) return byPid; }
  const byId = list.filter((s) => s.sessionId.toLowerCase().startsWith(q));
  if (byId.length) return byId;
  return list.filter((s) => `${s.name || ''} ${path.basename(s.cwd)}`.toLowerCase().includes(q));
}

// --- I/O ---------------------------------------------------------------------

/** Claude config dirs on this machine: the env one, ~/.claude, and every ~/.claude-* with a sessions/ folder. */
export function configDirs({ env = process.env, home = os.homedir() } = {}) {
  const out = [];
  const add = (d) => { if (d && !out.includes(d) && fs.existsSync(path.join(d, 'sessions'))) out.push(d); };
  add(env.CLAUDE_CONFIG_DIR && path.resolve(env.CLAUDE_CONFIG_DIR));
  add(path.join(home, '.claude'));
  try { for (const e of fs.readdirSync(home)) if (/^\.claude-/.test(e)) add(path.join(home, e)); } catch { /* unreadable home */ }
  return out;
}

export const parkedDir = (env = process.env) => path.join(env.BRAIN_HOME || path.join(os.homedir(), '.project-brain'), 'companion', 'parked');

/** What the session itself holds, swapped and compressed pages included (macOS); RSS misses those. */
function footprintMb(pid) {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const m = out.match(/phys_footprint:\s*([\d.]+)\s*([KMG])B/);
    return m ? Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 })[m[2]] : null;
  } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * A registry file whose pid now belongs to another process: the process is
 * younger than the session it claims (ps elapsed time vs the recorded start;
 * `procStart` is written in UTC, ps prints local time, so the ms are compared).
 */
export function pidReused(s, rows, now = Date.now()) {
  const row = rows.find((r) => r.pid === s.pid);
  if (!row || !s.startedAt || !Number.isFinite(row.ageSec)) return false;
  return now - row.ageSec * 1000 > s.startedAt + 10 * 60_000;
}

function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, start); return buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}

/** Fold the head (first ask) and the tail (where it stood) of a transcript. */
export function foldTranscript(file) {
  const state = emptyState(null);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { state, lastMessageMs: null }; }
  const records = [];
  const head = parseChunk(readSlice(file, 0, Math.min(size, HEAD_BYTES))).records;
  if (size <= HEAD_BYTES) records.push(...head);
  else {
    foldRecords(state, head.filter((r) => r.type === 'user')); // only the goal comes from the head
    const start = Math.max(HEAD_BYTES, size - TAIL_BYTES);
    const text = readSlice(file, start, size - start);
    records.push(...parseChunk(text.slice(text.indexOf('\n') + 1)).records);
  }
  foldRecords(state, records);
  let last = 0;
  for (const r of records) if (r && (r.type === 'user' || r.type === 'assistant') && !r.isMeta) { const t = Date.parse(r.timestamp); if (t > last) last = t; }
  return { state, lastMessageMs: last || null };
}

const foldCache = new Map(); // file → { size, mtimeMs, result }: a quiet session's transcript is read once
export function foldTranscriptCached(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { state: null, lastMessageMs: null }; }
  const hit = foldCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  const result = foldTranscript(file);
  foldCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  if (foldCache.size > 200) foldCache.delete(foldCache.keys().next().value);
  return result;
}

export function transcriptOf(s) {
  return path.join(s.configDir, 'projects', projectSlug(s.cwd), `${s.sessionId}.jsonl`);
}

/** Every live interactive session on this machine, with RAM and its own last message. */
export function listSessions({ env = process.env, rows = listProcesses(), withCards = false } = {}) {
  const out = [];
  for (const dir of configDirs({ env })) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, 'sessions')).filter((f) => /^\d+\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      let s;
      try { s = parseRegistry(JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f), 'utf8')), dir); } catch { continue; }
      if (!s || !alive(s.pid)) continue;
      if (pidReused(s, rows)) continue;
      const t = transcriptOf(s);
      const folded = fs.existsSync(t) ? foldTranscriptCached(t) : { state: null, lastMessageMs: null };
      const row = { ...s, transcript: fs.existsSync(t) ? t : null, lastMessageMs: folded.lastMessageMs, mb: treeMb(rows, s.pid, footprintMb(s.pid)) };
      if (withCards && folded.state) row.card = buildCard(row, folded.state, { mb: row.mb.total });
      out.push(row);
    }
  }
  return out.sort((a, b) => (a.lastMessageMs || 0) - (b.lastMessageMs || 0));
}

export function ancestorPids(rows = listProcesses(), pid = process.pid) {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const out = new Set();
  for (let p = pid; p && p > 1 && !out.has(p); p = parent.get(p)) out.add(p);
  return out;
}

/** Write the card, end the session, wait for its helpers. Returns what was freed. */
export async function park(s, { env = process.env, waitMs = 4000, rows = listProcesses() } = {}) {
  const dir = parkedDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const folded = s.transcript ? foldTranscript(s.transcript) : { state: emptyState(null) };
  const card = buildCard(s, folded.state, { mb: s.mb.total });
  const file = path.join(dir, `${s.sessionId}.json`);
  fs.writeFileSync(file + '.tmp', JSON.stringify(card, null, 2));
  fs.renameSync(file + '.tmp', file); // the card exists before the process ends
  const tree = [s.pid, ...descendantPids(rows, s.pid)];
  try { process.kill(s.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  const settle = async (ms) => { const until = Date.now() + ms; while (Date.now() < until && tree.some(alive)) await new Promise((r) => setTimeout(r, 200)); };
  await settle(waitMs);
  // Helpers it started (MCP servers, browsers) that outlived it are orphans now: end them too.
  if (!alive(s.pid)) for (const pid of tree.slice(1).filter(alive)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  await settle(1500);
  const left = tree.filter(alive);
  return { card, file, ended: !alive(s.pid), leftovers: left };
}

export function listParked({ env = process.env } = {}) {
  const dir = parkedDir(env);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) { try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* torn card */ } }
  return out.sort((a, b) => (b.parkedAt || 0) - (a.parkedAt || 0));
}

/** A resumed session is no longer parked: drop its card. */
export function unpark(sessionId, { env = process.env } = {}) {
  try { fs.unlinkSync(path.join(parkedDir(env), `${sessionId}.json`)); return true; } catch { return false; }
}

/** A card short enough for the state file the app reads. PURE. */
export function slimCard(c) {
  const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x || null; };
  return {
    sessionId: c.sessionId, title: c.name || c.project, project: c.project, cwd: c.cwd, branch: c.branch || null,
    goal: clip(c.goal, 280), lastAsk: clip(c.asks && c.asks[c.asks.length - 1], 280), lastAgent: clip(c.lastAgent, 400),
    edited: (c.edited || []).slice(0, 6), lastMessageMs: c.lastMessageMs || null, parkedAt: c.parkedAt || null,
    freedMb: c.freedMb || null, resume: resumeCommand(c)
  };
}

/** What the app shows under "park": open sessions with their RAM, and the parked cards. */
export function parkingView({ env = process.env, rows = listProcesses(), now = Date.now(), idleMs = PARK_DEFAULTS.idleHours * 3600_000 } = {}) {
  const open = listSessions({ env, rows }).map((s) => {
    const v = parkVerdict(s, { now, idleMs });
    return { pid: s.pid, sessionId: s.sessionId, title: s.name || path.basename(s.cwd), project: path.basename(s.cwd), cwd: s.cwd, mb: s.mb.total, helpers: s.mb.helpers, status: s.status, lastMessageMs: s.lastMessageMs, park: v.park, why: v.why };
  }).sort((a, b) => (b.lastMessageMs || 0) - (a.lastMessageMs || 0));
  const idle = open.filter((s) => s.park);
  return {
    at: now,
    idleHours: idleMs / 3600_000,
    openMb: open.reduce((a, s) => a + s.mb, 0),
    idleMb: idle.reduce((a, s) => a + s.mb, 0),
    open,
    parked: listParked({ env }).slice(0, 30).map(slimCard)
  };
}
