#!/usr/bin/env node
/**
 * brain:warm — the WARM layer of a session's context (K3 + K4 in
 * docs/roadmap-next.md, "context efficiency" wave).
 *
 * Measured: at a median of 370k tokens per request, 54 % of a long session's
 * context is tool output older than 100 calls; only 5.5 % comes from the last
 * 20. Compacting earlier saves ≈ 2/3 of input — but only if what compaction
 * drops is not what the work still needs. This module is that guarantee:
 *
 *   snapshot   (PreCompact + Stop hook) fold the transcript into a small,
 *              deterministic session record — the user's goal in their own
 *              words, the latest asks, where the agent last stood, decisions
 *              and follow-ups, files edited/read with line ranges, the last
 *              checks and whether they passed, compactions so far.
 *              INCREMENTAL: it remembers a byte offset and reads only what
 *              was appended since, so running on every Stop costs a few ms,
 *              not a 50 MB parse.
 *   rehydrate  (SessionStart, matcher "compact") inject that record — under
 *              the host's 10,000-character cap — plus live git state and a
 *              pointer to the transcript, where every compacted detail still is.
 *   show       print what rehydrate would inject for the newest session.
 *
 * No LLM, no network. The transcript format is undocumented, so every read is
 * guarded: anything unparseable is skipped, and a hook never fails a session.
 * Tool output is never copied — transcripts can hold company code and
 * secrets; the record keeps paths, commands and the user's/agent's own words.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.mjs';
import { BRAIN_DIR, ensureLocalStateIgnored } from './common.mjs';
import { BUDGETS } from './footprint.mjs';

export const WARM_DIR = path.join(BRAIN_DIR, '.warm');
const RETAIN_MS = 14 * 86400_000;
const FIRST_READ_MAX = 32 * 2 ** 20; // a first snapshot of a huge session reads only its tail

const CAPS = { asks: 3, files: 40, checks: 8, tags: 12, text: 1200, ask: 600 };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// A check is a test/build/lint command at the START of a shell segment —
// after optional env assignments and an npx / dotenv wrapper. Matching
// anywhere caught heredocs and echo lines that merely mention "vitest".
const CHECK_CMD = /(?:^|&&|;|\|\|)\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:npx\s+(?:dotenv\s+(?:-e\s+\S+\s+)*--\s+)?)?(npm (?:run )?(?:test|build|lint|typecheck|check)\b|node --test|vitest|jest|pytest|tsc\b|go (?:test|vet)|cargo (?:test|check|build)|make (?:test|check)|eslint|ruff|mypy|playwright test)/;
const HEAD_READ = 2 ** 20; // where the session's first ask lives when the first read starts in the tail
const TAG_RE = /^##\s+(Decided|Memory|Followup):\s*(.+)$/gim;

// --- pure core ---------------------------------------------------------------

export function emptyState(sessionId = null) {
  return {
    v: 1,
    sessionId,
    offset: 0,
    calls: 0,
    goal: null,
    asks: [],
    lastAgent: null,
    files: {}, // path → { edits, reads, last, ranges: ["a-b"] }
    checks: [], // { cmd, ok, call }
    tags: { Decided: [], Memory: [], Followup: [] },
    compactions: [], // { trigger, preTokens, postTokens, ts }
    branch: null,
    cwd: null,
    pending: {} // tool_use_id → check command awaiting its result
  };
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function pushCapped(list, item, cap, same = (a, b) => a === b) {
  const i = list.findIndex((x) => same(x, item));
  if (i !== -1) list.splice(i, 1);
  list.push(item);
  while (list.length > cap) list.shift();
}

/** Text the USER typed — not tool results, not injected/meta/command records. */
function userText(r) {
  if (r.isMeta || r.isCompactSummary || r.toolUseResult) return null;
  const c = r.message && r.message.content;
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')
      ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
      : null;
  if (!text || !text.trim()) return null;
  const t = text.trim();
  // Slash-command echoes, hook/system injections and interrupts are not asks.
  if (/^<(command-|local-command|system-reminder|task-notification|bash-)/.test(t) || /^\[Request interrupted/.test(t)) return null;
  return t;
}

/** Fold parsed transcript records into `state` (mutates and returns it). */
export function foldRecords(state, records) {
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.gitBranch) state.branch = r.gitBranch;
    if (r.cwd) state.cwd = r.cwd;
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      const m = r.compactMetadata || {};
      state.compactions.push({ trigger: m.trigger || null, preTokens: m.preTokens || null, postTokens: m.postTokens || null, ts: r.timestamp || null });
      continue;
    }
    const content = r.message && r.message.content;
    if (r.type === 'user') {
      const t = userText(r);
      if (t) {
        if (!state.goal) state.goal = clip(t, CAPS.ask);
        pushCapped(state.asks, clip(t, CAPS.ask), CAPS.asks);
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (!b || b.type !== 'tool_result') continue;
        const cmd = state.pending[b.tool_use_id];
        if (!cmd) continue;
        delete state.pending[b.tool_use_id];
        const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        const ok = !b.is_error && !/^Exit code [1-9]/.test(out);
        pushCapped(state.checks, { cmd, ok, call: state.calls }, CAPS.checks, (a, c) => a.cmd === c.cmd);
      }
    } else if (r.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (!b) continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          state.lastAgent = clip(b.text, CAPS.text);
          TAG_RE.lastIndex = 0;
          let m;
          while ((m = TAG_RE.exec(b.text))) pushCapped(state.tags[m[1]], clip(m[2], 300), CAPS.tags);
        } else if (b.type === 'tool_use') {
          state.calls += 1;
          const input = b.input || {};
          const p = input.file_path || input.notebook_path;
          if (p && (EDIT_TOOLS.has(b.name) || b.name === 'Read')) {
            const f = state.files[p] || (state.files[p] = { edits: 0, reads: 0, last: 0, ranges: [] });
            f.last = state.calls;
            if (EDIT_TOOLS.has(b.name)) f.edits += 1;
            else {
              f.reads += 1;
              if (input.offset || input.limit) {
                const a = Number(input.offset || 1);
                pushCapped(f.ranges, `${a}-${a + Number(input.limit || 2000) - 1}`, 4);
              }
            }
          } else if (b.name === 'Bash' && typeof input.command === 'string') {
            const first = input.command.split('\n')[0];
            const m = first.match(CHECK_CMD);
            // Keep the check itself, not the `sed …&&` that happened to precede it.
            // Output plumbing (2>&1, | tail, > file) is not part of the check's identity.
            if (m) state.pending[b.id] = clip(first.slice(m.index).replace(/^\s*(&&|;|\|\|)\s*/, '').split(/\s+(?:\d?>|\|(?!\|))/)[0], 120);
          }
        }
      }
    }
  }
  // Keep the file map bounded: most recently touched win, edits never lose to reads.
  const entries = Object.entries(state.files);
  if (entries.length > CAPS.files) {
    entries.sort((a, b) => (b[1].edits > 0) - (a[1].edits > 0) || b[1].last - a[1].last);
    state.files = Object.fromEntries(entries.slice(0, CAPS.files));
  }
  // A tool_use whose result never came (interrupt) must not pin memory forever.
  const ids = Object.keys(state.pending);
  if (ids.length > 50) for (const id of ids.slice(0, ids.length - 50)) delete state.pending[id];
  return state;
}

/**
 * Split appended bytes into complete JSONL records. Returns the records and
 * how many bytes were consumed — a trailing partial line (the host is mid-
 * write) is left for the next read.
 */
export function parseChunk(text) {
  const end = text.lastIndexOf('\n');
  if (end === -1) return { records: [], consumed: 0 };
  const records = [];
  for (const line of text.slice(0, end).split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* torn or foreign line */ }
  }
  return { records, consumed: Buffer.byteLength(text.slice(0, end + 1), 'utf8') };
}

const rel = (p, cwd) => (cwd && p.startsWith(cwd + path.sep) ? p.slice(cwd.length + 1) : p);

/**
 * The text injected after compaction. Sections in order of value; a section
 * that would break the byte budget is dropped whole (never cut mid-line), and
 * the closing pointer always fits.
 */
export function renderWarm(state, { budgetBytes = BUDGETS.warmBytes, git = null, transcriptPath = null } = {}) {
  const cwd = state.cwd;
  const last = state.compactions[state.compactions.length - 1];
  const k = (n) => (n ? `${Math.round(n / 1000)}k` : '?');
  const head = `## Brain: session state after compaction${last ? ` #${state.compactions.length} (${k(last.preTokens)} → ${k(last.postTokens)})` : ''}`;
  const tail = 'Anything compacted away is still in the session transcript — fetch it instead of guessing or re-running: ' +
    `MCP \`brain_recall\` {"query": "<terms>"} or \`npm run brain:recall -- "<terms>"\`${transcriptPath ? ` (${path.basename(transcriptPath)})` : ''}.`;

  const sections = [];
  if (state.goal) sections.push(`**Goal (the user's words, first ask):** ${state.goal}`);
  const latest = state.asks.filter((a) => a !== state.goal);
  if (latest.length) sections.push(`**Latest asks:**\n${latest.map((a) => `- ${a}`).join('\n')}`);
  if (state.lastAgent) sections.push(`**Where the work stood (last agent message):**\n${state.lastAgent}`);
  if (state.tags.Followup.length) sections.push(`**Open:**\n${state.tags.Followup.map((t) => `- ${t}`).join('\n')}`);
  if (state.tags.Decided.length) sections.push(`**Decided:**\n${state.tags.Decided.map((t) => `- ${t}`).join('\n')}`);
  if (git) sections.push(`**Git:** ${git}`);
  const files = Object.entries(state.files).sort((a, b) => b[1].last - a[1].last);
  const edited = files.filter(([, f]) => f.edits);
  // Reads outside the project (plugin docs, scratch screenshots) are not work state.
  const inProject = (p) => !cwd || !path.isAbsolute(p) || p.startsWith(cwd + path.sep);
  const read = files.filter(([p, f]) => !f.edits && inProject(p) && !/\.(png|jpe?g|gif|webp|pdf)$/i.test(p));
  if (edited.length) sections.push(`**Files edited:** ${edited.map(([p, f]) => `${rel(p, cwd)} (${f.edits}×)`).join(', ')}`);
  if (state.checks.length) {
    sections.push(`**Last checks:**\n${[...state.checks].reverse().map((c) => `- ${c.ok ? '✓' : '✗'} \`${c.cmd}\``).join('\n')}`);
  }
  if (read.length) sections.push(`**Files read:** ${read.map(([p, f]) => `${rel(p, cwd)}${f.ranges.length ? ` [${f.ranges.join(', ')}]` : ''}`).join(', ')}`);
  if (state.tags.Memory.length) sections.push(`**Noted:**\n${state.tags.Memory.map((t) => `- ${t}`).join('\n')}`);

  const out = [head];
  let used = Buffer.byteLength(head + '\n\n' + tail, 'utf8');
  for (const s of sections) {
    const cost = Buffer.byteLength('\n\n' + s, 'utf8');
    if (used + cost > budgetBytes) continue;
    out.push(s);
    used += cost;
  }
  out.push(tail);
  return out.join('\n\n');
}

// --- K5: boundary nudges ------------------------------------------------------

// A finished unit of work: compacting HERE loses the least. Matched at the
// start of a shell segment, like CHECK_CMD, so a commit message that merely
// says "git push" does not count.
const BOUNDARY_CMD = /(?:^|&&|;)\s*(git commit\b|git push\b|gh pr (?:create|merge)\b|npm run brain:close\b|project-brain close\b)/;
export const NUDGE = Object.freeze({ minTokens: 150_000, regrowTokens: 50_000 });

/** Is this Bash command the end of a unit of work? */
export function isBoundary(command) {
  return BOUNDARY_CMD.test(String(command || '').split('\n')[0]);
}

/** Context size of the latest request in these records (input + cache), or 0. */
export function lastContextTokens(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const u = records[i] && records[i].type === 'assistant' && records[i].message && records[i].message.usage;
    if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return 0;
}

/**
 * Nudge once per boundary while the context is large; again only after it
 * has grown by `regrowTokens` (a compaction resets it). PURE.
 */
export function shouldNudge(ctx, lastNudgeCtx, { minTokens = NUDGE.minTokens, regrowTokens = NUDGE.regrowTokens } = {}) {
  if (!(ctx >= minTokens)) return false;
  if (!lastNudgeCtx || ctx < lastNudgeCtx) return true;
  return ctx - lastNudgeCtx >= regrowTokens;
}

export function nudgeText(ctx) {
  return `brain: good moment to /compact — this unit of work is done and the context is ≈ ${Math.round(ctx / 1000)}k tokens, all re-read on every request. The session state comes back after compaction; details stay recallable.`;
}

/** Context of the latest request, from the transcript's tail (the last ~256 kB). */
function tailContextTokens(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const len = Math.min(size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      const records = [];
      for (const l of lines) { try { records.push(JSON.parse(l)); } catch { /* partial */ } }
      return lastContextTokens(records);
    } finally { fs.closeSync(fd); }
  } catch { return 0; }
}

// --- I/O ---------------------------------------------------------------------

const safeId = (id) => String(id || 'unknown').replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';
export const statePath = (sessionId, dir = WARM_DIR) => path.join(dir, `${safeId(sessionId)}.json`);

function readState(sessionId, dir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(sessionId, dir), 'utf8'));
    if (s && s.v === 1) return s;
  } catch { /* first snapshot of this session */ }
  return emptyState(sessionId);
}

/** Fold everything appended to the transcript since the last snapshot. */
export function snapshot({ sessionId, transcriptPath, dir = WARM_DIR }) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const state = readState(sessionId, dir);
  const size = fs.statSync(transcriptPath).size;
  if (size < state.offset) Object.assign(state, emptyState(sessionId)); // rewritten: start over
  let start = state.offset;
  if (start === 0 && size > FIRST_READ_MAX) start = size - FIRST_READ_MAX;
  if (size > start) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      let skipped = 0;
      if (start > state.offset) { // tail-only first read: the goal lives at the head
        const head = Buffer.alloc(Math.min(HEAD_READ, start));
        fs.readSync(fd, head, 0, head.length, 0);
        const goalOnly = foldRecords(emptyState(), parseChunk(head.toString('utf8')).records.filter((r) => r.type === 'user'));
        state.goal = goalOnly.goal;
        // and the tail starts mid-line: drop that partial line
        const nl = text.indexOf('\n');
        skipped = Buffer.byteLength(text.slice(0, nl + 1), 'utf8');
        text = text.slice(nl + 1);
      }
      const { records, consumed } = parseChunk(text);
      foldRecords(state, records);
      state.offset = start + skipped + consumed;
    } finally {
      fs.closeSync(fd);
    }
  }
  state.updated = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  const file = statePath(sessionId, dir);
  fs.writeFileSync(file + '.tmp', JSON.stringify(state));
  fs.renameSync(file + '.tmp', file);
  return state;
}

/** Drop records of sessions untouched for two weeks. */
function prune(dir = WARM_DIR, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (now - fs.statSync(p).mtimeMs > RETAIN_MS) fs.unlinkSync(p); } catch { /* raced */ }
  }
}

/** Live git state, one line: branch, uncommitted files, ahead/behind. */
function gitLine(cwd) {
  try {
    const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    const status = execFileSync('git', ['status', '--porcelain=v1', '--branch'], opts).split('\n').filter(Boolean);
    const branch = (status.shift() || '').replace(/^## /, '');
    const changed = status.map((l) => l.slice(3));
    const shown = changed.slice(0, 12).join(', ');
    return `${branch} · ${changed.length ? `${changed.length} uncommitted: ${shown}${changed.length > 12 ? ', …' : ''}` : 'clean'}`;
  } catch { return null; }
}

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function newestState(dir = WARM_DIR) {
  let best = null;
  for (const n of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
    if (!n.endsWith('.json')) continue;
    const m = fs.statSync(path.join(dir, n)).mtimeMs;
    if (!best || m > best.m) best = { n, m };
  }
  return best ? best.n.replace(/\.json$/, '') : null;
}

function main(argv) {
  const mode = argv[0];
  if (mode === 'show') {
    const id = argv[1] || newestState();
    if (!id) { process.stderr.write('[brain:warm] no session snapshots yet\n'); process.exit(1); }
    const s = readState(id, WARM_DIR);
    process.stdout.write(renderWarm(s, { git: gitLine(s.cwd || process.cwd()) }) + '\n');
    return;
  }
  if (mode !== 'snapshot' && mode !== 'rehydrate' && mode !== 'boundary') {
    process.stderr.write('Usage: brain-warm.mjs snapshot|rehydrate|boundary (hook, JSON on stdin) | show [session-id]\n');
    process.exit(1);
  }
  // Hook path: never fail, never block the session.
  try {
    if (!fs.existsSync(BRAIN_DIR)) return;
    const payload = readStdinJson();
    const args = { sessionId: payload.session_id, transcriptPath: payload.transcript_path };
    if (mode === 'boundary') {
      const command = payload.tool_input && payload.tool_input.command;
      const resp = payload.tool_response || {};
      if (!isBoundary(command) || resp.interrupted || /^Exit code [1-9]/.test(String(resp.stderr || resp.output || ''))) return;
      const ctx = tailContextTokens(args.transcriptPath);
      const file = statePath(args.sessionId, WARM_DIR);
      const state = readState(args.sessionId, WARM_DIR);
      if (!shouldNudge(ctx, state.lastNudgeCtx, { minTokens: Number(process.env.BRAIN_NUDGE_MIN_TOKENS) || NUDGE.minTokens })) return;
      state.lastNudgeCtx = ctx;
      fs.mkdirSync(WARM_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
      process.stdout.write(JSON.stringify({ systemMessage: nudgeText(ctx) }));
      return;
    }
    if (mode === 'snapshot') {
      ensureLocalStateIgnored();
      snapshot(args);
      prune();
      return;
    }
    if (payload.source && payload.source !== 'compact') return;
    const state = snapshot(args) || readState(args.sessionId, WARM_DIR);
    if (!state.goal && !state.lastAgent && !Object.keys(state.files).length) return;
    const additionalContext = renderWarm(state, {
      git: gitLine(payload.cwd || state.cwd || process.cwd()),
      transcriptPath: args.transcriptPath
    });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  } catch (e) {
    process.stderr.write(`[brain:warm] ${mode} skipped: ${e.message || e}\n`);
  }
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
