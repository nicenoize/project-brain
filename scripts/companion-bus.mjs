/**
 * The companion's bus: plain files under ~/.project-brain/companion/ that the
 * engine, the hook, the CLI and the app share. No server, no socket — every
 * writer is short-lived and every reader tolerates a missing or torn file.
 *
 *   state.json            engine → app        what is running (brain-companion.mjs)
 *   inbox/<session>.jsonl app/CLI → hook      steer notes, delivered at the next tool call
 *   holds.json            app/CLI → hook      globs whose edits wait for your answer
 *   pending/<id>.json     hook → app          an edit waiting for approve/deny
 *   answers/<id>.json     app/CLI → hook      the answer to a held edit
 *   events.jsonl          hook → engine       what happened (delivered, held, approved…)
 *   seen/<session>        hook → engine       the hook ran for this session (control vs monitor)
 *
 * Kept free of common.mjs and friends on purpose: the hook imports this on
 * every tool call of every session, so its module graph is fs + path + os.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const HOLD_TIMEOUT_MS = 45_000;
export const ENGINE_FRESH_MS = 15_000;
export const EVENTS_MAX_BYTES = 256 * 1024;
export const SEEN_EVERY_MS = 30_000;

// --- paths -------------------------------------------------------------------

export function brainHome(env = process.env) {
  return env.BRAIN_HOME || path.join(os.homedir(), '.project-brain');
}

/** The bus directory; BRAIN_COMPANION_STATE moves it along with the state file. */
export function busDir(env = process.env) {
  return env.BRAIN_COMPANION_STATE ? path.dirname(env.BRAIN_COMPANION_STATE) : path.join(brainHome(env), 'companion');
}

export function statePath(env = process.env) {
  return env.BRAIN_COMPANION_STATE || path.join(busDir(env), 'state.json');
}

const SAFE_ID = /^[\w.-]{1,128}$/;
export function safeId(id) {
  const s = String(id || '');
  return SAFE_ID.test(s) && !s.includes('..') ? s : '';
}

/**
 * Six hex digits against collisions between local processes that share a
 * millisecond. Not a secret (everything here runs as one user on one
 * machine), so no node:crypto: loading it costs ~2 ms on every tool call.
 */
export function rand6() { return Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0'); }

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + rand6();
}

function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }

function writeAtomic(file, data) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${rand6()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Write a user's config file safely: through a symlink to its target (a
 * dotfiles setup keeps its link), with the target's mode, via a unique temp
 * file and a rename. Returns the path actually written.
 */
export function writeConfigFile(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {
    // a new file, or a link whose target does not exist yet (dotfiles): write where the link points, keep the link
    try { if (fs.lstatSync(file).isSymbolicLink()) target = path.resolve(path.dirname(file), fs.readlinkSync(file)); } catch { /* new file */ }
  }
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file */ }
  mkdirp(path.dirname(target));
  const tmp = `${target}.${process.pid}.${rand6()}.tmp`;
  fs.writeFileSync(tmp, text, mode != null ? { mode } : undefined);
  if (mode != null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
  return target;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// --- globs -------------------------------------------------------------------

/**
 * A glob as a RegExp over forward-slashed relative paths. `**` spans
 * directories, `*` and `?` stay inside one segment, `{a,b}` is either, a
 * trailing `/` means the whole directory, and a pattern without any wildcard
 * means that file or everything under it ("src/billing" = "src/billing/**").
 * PURE.
 */
export function globToRegExp(glob) {
  let g = String(glob || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!g || g === '**' || g === '**/*') return /^.*$/;
  if (g.endsWith('/')) g += '**';
  const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (!/[*?{]/.test(g)) return new RegExp(`^${[...g].map(esc).join('')}(?:/.*)?$`);
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; depth += 1; }
    else if (c === '}' && depth > 0) { re += ')'; depth -= 1; }
    else if (c === ',' && depth > 0) re += '|';
    else re += esc(c);
  }
  while (depth-- > 0) re += ')';
  return new RegExp(`^${re}$`);
}

/**
 * Does `hold` cover `file` (absolute) right now? A hold set in one checkout
 * covers every worktree of that repository: `roots` lists them all (the CLI
 * fills it, the engine keeps it current), `root` is the checkout it was set
 * in. No roots at all = every repository. PURE.
 */
export function holdMatches(hold, file, now = Date.now()) {
  if (!hold || !file) return false;
  if (hold.until && hold.until <= now) return false;
  const abs = path.resolve(String(file));
  const re = globToRegExp(hold.glob || '**');
  const roots = Array.isArray(hold.roots) && hold.roots.length ? hold.roots : hold.root ? [hold.root] : null;
  if (!roots) return re.test(abs.split(path.sep).join('/').replace(/^\//, ''));
  for (const root of roots) {
    const r = path.relative(path.resolve(root), abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) continue;
    if (re.test(r.split(path.sep).join('/'))) return true;
  }
  return false;
}

// --- holds -------------------------------------------------------------------

export function holdsFile(dir) { return path.join(dir, 'holds.json'); }

/**
 * A short exclusive lock around read-modify-write of holds.json (the CLI, the
 * app and the engine all write it). Waits up to ~1 s; a lock older than 5 s
 * belonged to a process that died and is taken over. Readers never lock.
 */
export function withHoldsLock(dir, fn) {
  mkdirp(dir);
  const lock = path.join(dir, 'holds.lock');
  const deadline = Date.now() + 1000;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock older than 5 s belonged to a process that died. If it cannot be taken over (a directory, no
      // permission), the deadline still ends the wait. (Two processes taking over the same stale lock at once
      // can both get in; with 5 s of staleness first that needs a crash and a race together.)
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 5000; } catch { continue; /* gone: try again at once */ }
      if (stale) { try { fs.unlinkSync(lock); continue; } catch { /* fall through to the deadline */ } }
      if (Date.now() > deadline) throw new Error('holds are being changed by another process — try again');
      const until = Date.now() + 15; while (Date.now() < until) { /* brief spin: no async in the hook path */ }
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(lock); } catch { /* gone */ } }
}

/** Active holds (expired ones are dropped on read). */
export function readHolds(dir, now = Date.now()) {
  const list = readJson(holdsFile(dir), []);
  return Array.isArray(list) ? list.filter((h) => h && h.id && (!h.until || h.until > now)) : [];
}

/** Add a hold; returns it. `root` null = every repo on this machine. */
export function addHold(dir, { glob = '**', root = null, repo = null, roots = null, minutes = 30, note = '', by = 'cli', now = Date.now() } = {}) {
  const hold = {
    id: newId('h'), glob: String(glob || '**'), root: root ? path.resolve(root) : null,
    repo: repo || null, roots: Array.isArray(roots) && roots.length ? roots.map((r) => path.resolve(r)) : null,
    until: minutes ? now + minutes * 60_000 : null, note: String(note || ''), by, at: now
  };
  withHoldsLock(dir, () => writeAtomic(holdsFile(dir), JSON.stringify([...readHolds(dir, now), hold], null, 2)));
  return hold;
}

/** Release one hold by id (or an unambiguous id prefix), or all with `'all'`. Returns how many went. */
export function releaseHolds(dir, which = 'all', now = Date.now()) {
  return withHoldsLock(dir, () => releaseHoldsLocked(dir, which, now));
}

function releaseHoldsLocked(dir, which, now) {
  const holds = readHolds(dir, now);
  let keep = [];
  if (which !== 'all') {
    const w = String(which);
    const exact = holds.filter((h) => h.id === w);
    const hit = exact.length ? exact : holds.filter((h) => h.id.startsWith(w));
    if (hit.length > 1) throw new Error(`"${w}" matches ${hit.length} holds — use the full id`);
    keep = holds.filter((h) => !hit.includes(h));
  }
  writeAtomic(holdsFile(dir), JSON.stringify(keep, null, 2));
  return holds.length - keep.length;
}

/** Replace the worktree lists of holds (engine refresh). Returns whether anything changed. */
export function updateHoldRoots(dir, rootsByRepo, now = Date.now()) {
  if (!Object.keys(rootsByRepo).length) return false;
  return withHoldsLock(dir, () => updateHoldRootsLocked(dir, rootsByRepo, now));
}

function updateHoldRootsLocked(dir, rootsByRepo, now) {
  const holds = readHolds(dir, now);
  let changed = false;
  for (const h of holds) {
    const next = h.repo && rootsByRepo[h.repo];
    if (!next) continue;
    const a = JSON.stringify([...(h.roots || [])].sort()), b = JSON.stringify([...next].sort());
    if (a !== b) { h.roots = next; changed = true; }
  }
  if (changed) writeAtomic(holdsFile(dir), JSON.stringify(holds, null, 2));
  return changed;
}

export function matchingHold(dir, file, now = Date.now()) {
  return readHolds(dir, now).find((h) => holdMatches(h, file, now)) || null;
}

// --- inbox -------------------------------------------------------------------

function inboxFile(dir, sessionId) {
  const sid = safeId(sessionId);
  return sid ? path.join(dir, 'inbox', `${sid}.jsonl`) : '';
}

/** Queue a steer note for a session. Returns the note. */
export function queueSteer(dir, sessionId, text, { from = 'cli', now = Date.now() } = {}) {
  const file = inboxFile(dir, sessionId);
  if (!file) throw new Error(`not a session id: ${sessionId}`);
  const body = String(text || '').trim();
  if (!body) throw new Error('empty note');
  const note = { id: newId('s'), kind: 'steer', session: safeId(sessionId), text: body.slice(0, 2000), from, at: now };
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(note) + '\n');
  return note;
}

/** Notes waiting for a session, without taking them. */
export function peekInbox(dir, sessionId) {
  const file = inboxFile(dir, sessionId);
  if (!file) return [];
  return parseLines(readText(file));
}

/**
 * Take every note queued for a session. The rename makes it a claim: two
 * hooks firing at once can never deliver the same note twice.
 */
export const NOTE_TTL_MS = 24 * 3600_000;
export const STALE_CLAIM_MS = 90_000; // longer than any hook may live (60 s timeout)

/**
 * Take every note queued for a session. The rename makes it a claim: two
 * hooks firing at once can never deliver the same note twice. A claim left
 * behind by a hook that was killed in the microseconds between claim and
 * output is picked up again once it is older than any hook can live.
 * Notes older than a day are returned as `expired`, never delivered.
 */
export function claimInbox(dir, sessionId, now = Date.now()) {
  const file = inboxFile(dir, sessionId);
  const out = { notes: [], expired: [] };
  if (!file) return out;
  const files = [];
  const claim = `${file}.${process.pid}.${rand6()}.claim`;
  try { fs.renameSync(file, claim); files.push(claim); } catch { /* nothing queued */ }
  try {
    const base = path.basename(file);
    for (const n of fs.readdirSync(path.dirname(file))) {
      if (!n.startsWith(base + '.') || !n.endsWith('.claim')) continue;
      const f = path.join(path.dirname(file), n);
      if (f === claim) continue;
      try { if (now - fs.statSync(f).mtimeMs > STALE_CLAIM_MS) files.push(f); } catch { /* raced */ }
    }
  } catch { /* no inbox dir */ }
  for (const f of files) {
    for (const note of parseLines(readText(f))) (now - (note.at || now) > NOTE_TTL_MS ? out.expired : out.notes).push(note);
    try { fs.unlinkSync(f); } catch { /* gone */ }
  }
  out.notes.sort((a, b) => (a.at || 0) - (b.at || 0));
  return out;
}

/** Take the deliverable notes (see claimInbox). */
export function drainInbox(dir, sessionId, now = Date.now()) {
  return claimInbox(dir, sessionId, now).notes;
}

/** Sessions with queued notes → count. */
export function inboxCounts(dir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'inbox')); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    out[n.slice(0, -6)] = parseLines(readText(path.join(dir, 'inbox', n))).length;
  }
  return out;
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* torn */ } }
  return out;
}

// --- events ------------------------------------------------------------------

/**
 * The change ledger: every settings file leanlamp writes outside its own
 * directory (the hook in Claude's settings, a compaction mark in a repo), so
 * `leanlamp init --undo` can put exactly that back. Never trimmed: it is
 * small, and it is the receipt for what was touched.
 */
export function changesFile(dir) { return path.join(dir, 'changes.jsonl'); }

export function recordChange(dir, change) {
  try { mkdirp(dir); fs.appendFileSync(changesFile(dir), JSON.stringify({ at: Date.now(), ...change }) + '\n'); } catch { /* the change itself happened; the ledger is best effort */ }
}

/** Changes since the last undo, oldest first. */
export function readChanges(dir) {
  const all = readText(changesFile(dir)).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let from = 0;
  all.forEach((c, i) => { if (c.kind === 'undo') from = i + 1; });
  return all.slice(from);
}

export function eventsFile(dir) { return path.join(dir, 'events.jsonl'); }

/** Append one event; past the cap the file keeps its newer half. Never throws. */
export function appendEvent(dir, event, { maxBytes = EVENTS_MAX_BYTES } = {}) {
  try {
    const file = eventsFile(dir);
    mkdirp(dir);
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n');
    if (fs.statSync(file).size > maxBytes) {
      const lines = readText(file).split('\n').filter(Boolean);
      writeAtomic(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
    return true;
  } catch { return false; }
}

/** The newest events (last 64 kB), oldest first, newer than `sinceMs`. */
export function readRecentEvents(dir, { sinceMs = 0, limit = 20 } = {}) {
  let fd;
  try {
    const file = eventsFile(dir);
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = parseLines(buf.toString('utf8'));
    return lines.filter((e) => e && e.at > sinceMs).slice(-limit);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// --- pending approvals -------------------------------------------------------

export function createPending(dir, p) {
  const id = newId('p');
  const rec = { id, ...p, at: p.at || Date.now() };
  writeAtomic(path.join(dir, 'pending', `${id}.json`), JSON.stringify(rec));
  return rec;
}

/** Held edits waiting for an answer. `sweep: false` for read-only callers (the setup check): leave expired files alone. */
export function readPending(dir, now = Date.now(), { sweep = true } = {}) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'pending')); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const p = readJson(path.join(dir, 'pending', n), null);
    if (!p || !p.id) continue;
    // a hook that died mid-wait leaves its file behind; past its deadline it is noise
    if (p.deadline && p.deadline + 5000 < now) { if (sweep) { try { fs.unlinkSync(path.join(dir, 'pending', n)); } catch { /* raced */ } } continue; }
    out.push(p);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Answer a pending edit. `decision` is 'allow' or 'deny'. */
export function decide(dir, id, decision, { reason = '', by = 'cli' } = {}) {
  const pid = safeId(id);
  if (!pid) throw new Error(`not a pending id: ${id}`);
  if (decision !== 'allow' && decision !== 'deny') throw new Error(`decision must be allow or deny, got ${decision}`);
  writeAtomic(path.join(dir, 'answers', `${pid}.json`), JSON.stringify({ id: pid, decision, reason: String(reason || ''), by, at: Date.now() }));
  return true;
}

/** Poll for the answer until `timeoutMs`. Resolves {decision, reason} or {decision: 'timeout'}. */
export async function awaitDecision(dir, id, { timeoutMs = HOLD_TIMEOUT_MS, pollMs = 150, now = Date.now } = {}) {
  const file = path.join(dir, 'answers', `${id}.json`);
  const deadline = now() + timeoutMs;
  for (;;) {
    const d = readJson(file, null);
    if (d && (d.decision === 'allow' || d.decision === 'deny')) {
      try { fs.unlinkSync(file); } catch { /* gone */ }
      return { decision: d.decision, reason: d.reason || '', by: d.by || '' };
    }
    if (now() >= deadline) return { decision: 'timeout', reason: '' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function clearPending(dir, id) {
  try { fs.unlinkSync(path.join(dir, 'pending', `${id}.json`)); } catch { /* gone */ }
}

// --- presence ----------------------------------------------------------------

/** Is an engine writing the state file (so someone can answer)? */
export function engineFresh(dir, now = Date.now(), maxAgeMs = ENGINE_FRESH_MS, stateFile = path.join(dir, 'state.json')) {
  try { return now - fs.statSync(stateFile).mtimeMs < maxAgeMs; } catch { return false; }
}

/** Mark that the hook runs for this session; cheap (one stat, a write at most every 30 s). */
export function markSeen(dir, sessionId, now = Date.now()) {
  const sid = safeId(sessionId);
  if (!sid) return;
  const file = path.join(dir, 'seen', sid);
  try {
    if (now - fs.statSync(file).mtimeMs < SEEN_EVERY_MS) return;
  } catch { /* first time */ }
  try { mkdirp(path.dirname(file)); fs.writeFileSync(file, String(now)); } catch { /* best effort */ }
}

/**
 * Housekeeping the engine runs now and then: answers nobody will read (their
 * hook timed out), presence marks of sessions gone for a week.
 */
export function sweepBus(dir, now = Date.now(), { answersMs = 10 * 60_000, seenMs = 7 * 86_400_000 } = {}) {
  let removed = 0;
  for (const [sub, maxAge] of [['answers', answersMs], ['seen', seenMs]]) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, sub, n);
      try { if (now - fs.statSync(f).mtimeMs > maxAge) { fs.unlinkSync(f); removed += 1; } } catch { /* raced */ }
    }
  }
  return removed;
}

/** session id → last time the hook ran for it (ms). */
export function readSeen(dir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'seen')); } catch { return out; }
  for (const n of names) {
    try { out[n] = fs.statSync(path.join(dir, 'seen', n)).mtimeMs; } catch { /* raced */ }
  }
  return out;
}
