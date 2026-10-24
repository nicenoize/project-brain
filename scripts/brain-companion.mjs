#!/usr/bin/env node
/**
 * brain:companion — the engine behind the companion app (notch island, menu
 * bar glyph, full window). It tails every live Claude Code transcript on this
 * machine and keeps ONE state file current:
 *
 *   ~/.project-brain/companion/state.json     (BRAIN_HOME moves the directory,
 *                                               BRAIN_COMPANION_STATE the file)
 *
 * The app only reads that file. It never parses a transcript, never runs ps,
 * never touches an agent's process — everything it shows is derived here,
 * once, in Node, where the transcript knowledge already lives (brain-tokens,
 * brain-ps, brain-warm). One engine, any number of shells (ADR 0036).
 *
 * What a session's numbers mean:
 *   ctx        context of the LAST request: input + cache read + cache write
 *              tokens of the newest assistant record (same sum the status
 *              line shows); requestId de-duplicates streamed lines.
 *   limit      where Claude Code will compact: CLAUDE_CODE_AUTO_COMPACT_WINDOW
 *              from the project's or user's settings; else the largest
 *              compaction seen; else the model's window.
 *   state      thinking (a prompt or tool result went in, no answer yet),
 *              tool (a tool_use without its result — running, or waiting for
 *              permission), waiting (the turn ended, it is your move), quiet
 *              (no reply for a while), idle (nothing for 10 min).
 *   burnPerMin context growth over the last two minutes.
 *
 * Liveness is judged from the transcript, not from the process table: a
 * transcript belongs to a PID only where the command line names the session
 * (--session-id, --resume); a plain `claude` is matched by cwd when it is the
 * only live session there, else left without a PID. Idle sessions are never
 * touched (brain:ps rule).
 *
 *   npm run brain:companion                  # the state once, as text
 *   npm run brain:companion -- --json        # the same as JSON
 *   npm run brain:companion -- --watch       # keep state.json current, 1 s
 *   npm run brain:companion -- --roots <dir>[,<dir>]  # transcript roots (tests, odd setups)
 */
import { createContextMap } from './context-map.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import { atomicWrite, ensureDir, takeFlag, takeOption, unknownFlags } from './common.mjs';
import { transcriptsRoot } from './brain-tokens.mjs';
import { classify, findOrphans } from './brain-ps.mjs';
import { listProcesses, memoryPressure } from './procs.mjs';
import {
  brainHome, statePath, busDir, readHolds, addHold, releaseHolds, readPending, decide, queueSteer, updateHoldRoots,
  inboxCounts, readRecentEvents, readSeen, eventsFile, appendEvent, writeConfigFile, sweepBus, engineFresh, recordChange, readChanges
} from './companion-bus.mjs';
import { computeReceipt, readReceipt, receiptPath } from './companion-receipt.mjs';
import { repoName } from './repo-name.mjs';
import { createInjectionTracker, mergeInjectionSummaries } from './companion-injections.mjs';
import { spawn } from 'node:child_process';

/** 1: sessions + machine. Additive since: holds, pending, events, per-session control/inbox. */
export const STATE_VERSION = 1;

export const DEFAULTS = Object.freeze({
  intervalMs: 1000,       // tick
  slowEveryMs: 5000,      // rescan transcripts, processes, machine
  heartbeatMs: 5000,      // write the state file even when nothing changed
  liveMinutes: 240,       // a transcript untouched this long leaves the wall
  idleMinutes: 10,        // no message this long → idle
  thinkingSeconds: 180,   // a prompt/tool result older than this without a reply → quiet
  toolMinutes: 15,        // a tool_use without result older than this → not "running" any more
  historyMs: 5 * 60_000,  // ctx samples kept for the burn rate
  burnWindowMs: 120_000,
  tailBytes: 1024 * 1024,               // first read per transcript: its last 1 MB
  backfillBytesPerTick: 32 * 1024 * 1024, // then the rest, this much per tick, for exact totals
  busyEveryMs: 2000,                     // tick while an agent works (changes wake it sooner)
  quietEveryMs: 5000,                    // tick when all agents are quiet (≤ heartbeatMs)
  minGapMs: 500,                         // at most two passes a second while transcripts stream
  receiptEveryMs: 3600_000,              // the receipt is recomputed hourly, in a niced child
  refreshReceipt: false                  // only the watching engine spawns that child
});

// --- paths (the bus owns them) -------------------------------------------------

export { brainHome, statePath, busDir };

// --- pure core: one transcript → one session ---------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A short, honest description of a tool call for the wall. PURE. */
export function describeInput(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const first = (s) => String(s || '').split('\n')[0].trim();
  switch (name) {
    case 'Bash': return first(i.command);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return String(i.file_path || i.notebook_path || '');
    case 'Grep': return first(i.pattern);
    case 'Glob': return first(i.pattern);
    case 'Agent': case 'Task': return first(i.description || i.prompt);
    case 'WebFetch': return first(i.url);
    case 'WebSearch': return first(i.query);
    case 'Skill': return first(i.skill);
    default: {
      const v = Object.values(i).find((x) => typeof x === 'string' && x.trim());
      return first(v);
    }
  }
}

/** Shorten a path for display: relative to cwd when inside it, home as ~. PURE. */
export function shortPath(text, cwd) {
  let t = String(text || '');
  if (cwd && t.startsWith(cwd + '/')) t = t.slice(cwd.length + 1);
  const home = os.homedir();
  if (home && t.startsWith(home + '/')) t = '~/' + t.slice(home.length + 1);
  return t;
}

/** The model's own window when nothing closer is known. PURE. */
export function modelWindow(model) {
  const m = String(model || '');
  if (/claude-[a-z]+-5(-|$)/.test(m) || /-1m\b/.test(m)) return 1_000_000;
  return 200_000;
}

/**
 * The fold: feed transcript records in file order, take a snapshot any time.
 * Pure in the sense that it never reads anything itself; the tailer feeds it.
 */
export function createSessionFold({ transcript = null } = {}) {
  const s = {
    transcript, id: null, title: null, summaryTitle: null, firstPrompt: null,
    cwd: null, gitBranch: null, model: null, version: null,
    startedMs: 0, lastActivityMs: 0, lastKind: null, lastText: '', lastTool: null,
    ctx: 0, ctxHistory: [], lastRequestMs: 0, requests: 0, outputTokens: 0, seen: new Set(),
    compactions: 0, lastCompaction: null, maxPreTokens: 0, compactionLog: [],
    format: { assistant: 0, withUsage: 0, boundaries: 0, boundariesWithMeta: 0 },
    pending: new Map(),
    tracker: createInjectionTracker({ keepLast: 8 }),
    map: createContextMap()
  };
  const activity = (ms) => {
    if (!Number.isFinite(ms)) return;
    if (ms > s.lastActivityMs) s.lastActivityMs = ms;
    if (!s.startedMs || ms < s.startedMs) s.startedMs = ms;
  };
  function feed(r) {
    if (!r || typeof r !== 'object') return;
    if (!s.id && typeof r.sessionId === 'string') s.id = r.sessionId;
    s.map.feed(r);
    if (r.type === 'attachment' || r.type === 'assistant') s.tracker.record(r);
    if (r.type === 'ai-title' && r.aiTitle) { s.title = String(r.aiTitle); return; }
    if (r.type === 'summary' && r.summary) { s.summaryTitle = String(r.summary); return; }
    if (typeof r.cwd === 'string' && r.cwd) s.cwd = r.cwd;
    if (typeof r.gitBranch === 'string' && r.gitBranch) s.gitBranch = r.gitBranch;
    if (typeof r.version === 'string' && r.version) s.version = r.version;
    const ms = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (r.type === 'system') {
      if (r.subtype === 'compact_boundary') {
        s.format.boundaries += 1;
        if (r.compactMetadata) s.format.boundariesWithMeta += 1;
        const m = r.compactMetadata || {};
        s.compactions += 1;
        s.lastCompaction = {
          trigger: m.trigger || null,
          preTokens: m.preTokens || null,
          postTokens: m.postTokens || null,
          durationMs: m.durationMs ?? null,
          precomputed: Boolean(m.precomputed),
          atMs: Number.isFinite(ms) ? ms : null
        };
        // the receipt counts the main session's compactions only; so do the live numbers
        if (!r.isSidechain) s.compactionLog.push({ atMs: s.lastCompaction.atMs, precomputed: s.lastCompaction.precomputed, durationMs: s.lastCompaction.durationMs });
        if (s.compactionLog.length > 16) s.compactionLog.shift();
        if (m.preTokens > s.maxPreTokens) s.maxPreTokens = m.preTokens;
        if (m.postTokens) s.ctx = m.postTokens;
        s.pending.clear();
        s.lastKind = 'compaction';
        s.lastText = 'compacted';
        activity(ms);
      }
      return;
    }
    if (r.type === 'user') {
      const content = r.message && r.message.content;
      if (Array.isArray(content)) {
        let prompt = null;
        for (const c of content) {
          if (!c) continue;
          if (c.type === 'tool_result') { s.pending.delete(c.tool_use_id); s.lastKind = 'tool_result'; }
          else if (c.type === 'text' && !r.isMeta && typeof c.text === 'string' && c.text.trim()) prompt = c.text;
        }
        if (prompt != null && !r.isSidechain) { s.lastKind = 'prompt'; s.lastText = prompt.slice(0, 160); if (!s.firstPrompt) s.firstPrompt = prompt.slice(0, 160); }
      } else if (typeof content === 'string' && content.trim() && !r.isMeta && !r.isSidechain) {
        s.lastKind = 'prompt';
        s.lastText = content.slice(0, 160);
        if (!s.firstPrompt) s.firstPrompt = content.slice(0, 160);
      }
      activity(ms);
      return;
    }
    if (r.type === 'assistant') {
      const msg = r.message || {};
      if (msg.model) s.model = msg.model;
      let sawTool = false;
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (!c) continue;
        if (c.type === 'tool_use') {
          sawTool = true;
          const tool = { name: c.name || 'tool', text: describeInput(c.name, c.input), ms: Number.isFinite(ms) ? ms : 0 };
          s.pending.set(c.id, tool);
          s.lastTool = tool;
          s.lastKind = 'tool_use';
        } else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim() && !sawTool) {
          s.lastText = c.text.trim().slice(0, 160);
          s.lastKind = 'text';
        }
      }
      if (msg.stop_reason === 'end_turn' && !sawTool) s.lastKind = 'end_turn';
      const key = r.requestId || msg.id;
      const u = msg.usage;
      if (!r.isSidechain) { s.format.assistant += 1; if (u) s.format.withUsage += 1; }
      if (u && key && !r.isSidechain && !s.seen.has(key)) {
        s.seen.add(key);
        s.requests += 1;
        s.outputTokens += u.output_tokens || 0;
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        s.ctx = ctx;
        if (Number.isFinite(ms)) {
          s.lastRequestMs = ms;
          s.ctxHistory.push([ms, ctx]);
          while (s.ctxHistory.length > 2 && ms - s.ctxHistory[0][0] > DEFAULTS.historyMs) s.ctxHistory.shift();
        }
      }
      activity(ms);
    }
  }
  function burnPerMin(now) {
    const h = s.ctxHistory;
    if (h.length < 2) return 0;
    const latest = h[h.length - 1];
    let base = h[0];
    for (let i = h.length - 2; i >= 0; i--) { base = h[i]; if (latest[0] - h[i][0] >= DEFAULTS.burnWindowMs) break; }
    const minutes = (latest[0] - base[0]) / 60_000;
    if (minutes < 1 / 3) return 0;
    if (now - latest[0] > DEFAULTS.historyMs) return 0;
    return Math.max(0, Math.round((latest[1] - base[1]) / minutes));
  }
  function snapshot({ now = Date.now(), limit = null, limitSource = null, opts = DEFAULTS } = {}) {
    const snap = snapshotPlain({ now, limit, limitSource, opts });
    Object.defineProperty(snap, '_seen', { value: s.seen, enumerable: false, configurable: true }); // for mergeHead, never serialised
    return snap;
  }
  function snapshotPlain({ now = Date.now(), limit = null, limitSource = null, opts = DEFAULTS } = {}) {
    const ageMs = s.lastActivityMs ? now - s.lastActivityMs : Infinity;
    const pending = [...s.pending.values()];
    const oldest = pending.length ? pending[0] : null;
    let state, label;
    const age = (ms) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
    if (ageMs > opts.idleMinutes * 60_000) { state = 'idle'; label = `idle for ${age(ageMs)}`; }
    else if (oldest && now - oldest.ms < opts.toolMinutes * 60_000) { state = 'tool'; label = `${oldest.name} · ${shortPath(oldest.text, s.cwd)}`.trim(); }
    else if (s.lastKind === 'end_turn' || s.lastKind === 'text') { state = 'waiting'; label = 'waiting for you'; }
    else if (ageMs < opts.thinkingSeconds * 1000) { state = 'thinking'; label = 'thinking'; }
    else { state = 'quiet'; label = `no reply for ${age(ageMs)}`; }
    let lim = limit, src = limitSource;
    if (!lim && s.maxPreTokens) { lim = Math.ceil(s.maxPreTokens / 50_000) * 50_000; src = 'compaction'; }
    if (!lim) { lim = modelWindow(s.model); src = 'model'; }
    const title = s.title || s.summaryTitle || (s.firstPrompt ? s.firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 60) : null) || (s.id ? s.id.slice(0, 8) : 'session');
    return {
      id: s.id,
      title,
      project: repoName(s.cwd),
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      model: s.model,
      version: s.version,
      ctx: s.ctx,
      limit: lim,
      limitSource: src,
      ratio: lim ? Math.round((s.ctx / lim) * 1000) / 1000 : null,
      burnPerMin: burnPerMin(now),
      requests: s.requests,
      outputTokens: s.outputTokens,
      compactions: s.compactions,
      lastCompaction: s.lastCompaction,
      compactionLog: s.compactionLog.slice(),
      contextMap: s.map.snapshot(s.ctx),
      state,
      label,
      last: { kind: s.lastKind, tool: s.lastTool ? { name: s.lastTool.name, text: shortPath(s.lastTool.text, s.cwd) } : null, text: s.lastText, atMs: s.lastActivityMs || null },
      lastActivityMs: s.lastActivityMs || null,
      startedMs: s.startedMs || null,
      pid: null,
      rssMb: null,
      transcript: s.transcript,
      injections: slimInjections(s.tracker.summary()),
      format: formatVerdict(s.format, s.version)
    };
  }
  return { feed, snapshot, state: s };
}

// --- transcript format drift ---------------------------------------------------

/**
 * The Claude Code versions this engine was checked against (fixtures and live
 * transcripts, 2026-10). A newer version is not an error, only a note; the
 * checks below are what would actually break the numbers.
 */
export const TESTED_VERSIONS = Object.freeze({ min: '2.1.296', max: '2.1.308' }); // 2.1.308: hook decisions + transcript usage verified headless, 2026-10-22

export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

/**
 * Does this transcript still look like what the engine understands? PURE.
 * Breakage that would make the numbers wrong without an error: assistant
 * records without usage (context unknown), compactions without metadata.
 */
export function formatVerdict(f, version) {
  const issues = [];
  if (f.assistant >= 20 && f.withUsage / f.assistant < 0.5) issues.push('assistant records carry no usage: context cannot be read');
  if (f.boundaries >= 1 && f.boundariesWithMeta === 0) issues.push('compactions carry no metadata: sizes and waits are unknown');
  const newer = version && compareVersions(version, TESTED_VERSIONS.max) > 0;
  return { ok: issues.length === 0, issues, version: version || null, newerThanTested: Boolean(newer), counts: { ...f } };
}

/** One line for the machine view: every live session's format, folded. PURE. */
export function formatSummary(sessions) {
  const versions = [...new Set(sessions.map((s) => s.format && s.format.version).filter(Boolean))].sort(compareVersions);
  const broken = sessions.filter((s) => s.format && !s.format.ok);
  return {
    ok: broken.length === 0,
    versions,
    newestTested: TESTED_VERSIONS.max,
    newerThanTested: versions.some((v) => compareVersions(v, TESTED_VERSIONS.max) > 0),
    issues: broken.slice(0, 3).map((s) => ({ session: s.id, title: s.title, issues: s.format.issues }))
  };
}

// --- the compaction mark ------------------------------------------------------

function readEnvWindow(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = Number(j && j.env && j.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    return v > 0 ? v : 0;
  } catch { return 0; }
}

/**
 * Where Claude Code will compact a session in `cwd`: the project's settings
 * (local first), then the user's, then this process's environment. Null when
 * nothing says. PURE apart from the reads.
 */
export function windowFor(cwd, { env = process.env, configDir = null } = {}) {
  const user = configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [];
  if (cwd) files.push(['settings.local', path.join(cwd, '.claude', 'settings.local.json')], ['settings', path.join(cwd, '.claude', 'settings.json')]);
  files.push(['user settings', path.join(user, 'settings.json')]);
  for (const [name, f] of files) {
    const v = readEnvWindow(f);
    if (v) return { limit: v, source: name };
  }
  const v = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (v > 0) return { limit: v, source: 'env' };
  return null;
}

// --- tailing a transcript -----------------------------------------------------

const MAX_CHUNK = 1024 * 1024;
// One read buffer for every tailer and range reader: reads are synchronous,
// so sharing is safe, and the engine's footprint stays flat instead of
// growing with every chunk of a 300 MB backfill.
const SHARED = Buffer.allocUnsafe(MAX_CHUNK);
const PROBE = Buffer.allocUnsafe(256 * 1024);
export const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The first line start at or after `pos`, so a reader never begins mid-line.
 * Scans forward: a single line can be megabytes (a screenshot as base64).
 * Returns the file size when no line starts after `pos`.
 */
function lineStartAfter(fd, pos) {
  if (pos <= 0) return 0;
  const size = fs.fstatSync(fd).size;
  const probe = PROBE;
  for (let at = pos - 1; at < size; at += probe.length) {
    const n = fs.readSync(fd, probe, 0, probe.length, at);
    if (n <= 0) break;
    const i = probe.subarray(0, n).indexOf(0x0a);
    if (i >= 0) return at + i + 1;
  }
  return size;
}

/**
 * Reads a growing JSONL file incrementally; a torn last line waits for its
 * rest. With `tailBytes`, the first read starts that far from the end, at a
 * line start, so the first state of a 300 MB transcript costs milliseconds;
 * `headEnd` is where the skipped part ends (see createRangeReader).
 */
export function createTailer(file, { tailBytes = 0 } = {}) {
  let offset = 0;
  let headEnd = 0;
  let started = false;
  let rest = '';
  let decoder = new StringDecoder('utf8');
  const reset = () => { offset = 0; headEnd = 0; rest = ''; decoder = new StringDecoder('utf8'); };
  function read(feed) {
    let fd;
    let lines = 0;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < offset) reset();
      if (!started) {
        started = true;
        if (tailBytes && size > tailBytes) { offset = lineStartAfter(fd, size - tailBytes); headEnd = offset; }
      }
      while (offset < size) {
        const len = Math.min(size - offset, MAX_CHUNK);
        const buf = SHARED;
        const n = fs.readSync(fd, buf, 0, len, offset);
        if (n <= 0) break;
        offset += n;
        const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
        rest = parts.pop();
        for (const line of parts) {
          if (!line) continue;
          try { const r = parseLine(line); if (r) { feed(r); lines += 1; } } catch { /* a corrupt line is skipped, never fatal */ }
        }
      }
    } catch { /* unreadable this tick; the next one retries */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    return lines;
  }
  return { file, read, get offset() { return offset; }, get headEnd() { return headEnd; } };
}

/**
 * Reads bytes [0, end) of a file in budgeted steps — the part a tailer
 * skipped, read in the background so totals (compactions, requests) become
 * exact without holding up the first state. `end` is a line start.
 */
export const HUGE_LINE = 1024 * 1024;

/**
 * A record from a line too big to parse whole (a screenshot as base64, a
 * giant tool result): only what the fold needs — type, time, ids, and which
 * tool calls it answers. Never the payload. PURE.
 */
export function lightRecord(line) {
  const head = line.slice(0, 4000);
  const pick = (re, from = head) => { const m = from.match(re); return m ? m[1] : undefined; };
  const type = pick(/"type":"(user|assistant|system|attachment)"/);
  if (!type) return null;
  const r = { type, timestamp: pick(/"timestamp":"([^"]+)"/), sessionId: pick(/"sessionId":"([^"]+)"/), cwd: pick(/"cwd":"([^"]+)"/), isSidechain: /"isSidechain":true/.test(head), isMeta: true };
  if (type === 'user') {
    const ids = [...line.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1]);
    r.message = { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '' })) };
  }
  if (type === 'assistant') {
    const tail = line.slice(-6000);
    const num = (k) => { const m = tail.match(new RegExp(`"${k}":(\\d+)`)); return m ? Number(m[1]) : 0; };
    r.requestId = pick(/"requestId":"([^"]+)"/, tail) || pick(/"requestId":"([^"]+)"/);
    const calls = [...head.matchAll(/"type":"tool_use","id":"([^"]+)","name":"([^"]+)"/g)].map((m) => ({ type: 'tool_use', id: m[1], name: m[2], input: {} }));
    r.message = {
      id: pick(/"id":"(msg_[^"]+)"/), model: pick(/"model":"([^"]+)"/), role: 'assistant', content: calls,
      stop_reason: pick(/"stop_reason":"([^"]+)"/, tail),
      usage: /"usage":/.test(tail) ? { input_tokens: num('input_tokens'), cache_creation_input_tokens: num('cache_creation_input_tokens'), cache_read_input_tokens: num('cache_read_input_tokens'), output_tokens: num('output_tokens') } : undefined
    };
    r.isMeta = false;
  }
  return r;
}

/** Parse a transcript line; huge lines become light records. */
export function parseLine(line) {
  if (line.length > HUGE_LINE) return lightRecord(line);
  return JSON.parse(line);
}

/**
 * Lines a head fold can use: usage, compactions, injections, titles, and
 * small user records (the first prompt). Everything else — tool results,
 * screenshots as base64, megabytes per line — is skipped unparsed.
 */
export function headLineWanted(line) {
  return line.includes('"usage"') || line.includes('compact_boundary') || line.includes('hook_additional_context') ||
    line.includes('"ai-title"') || line.includes('"type":"summary"') || (line.length < 20_000 && line.includes('"type":"user"'));
}

export function createRangeReader(file, end, { filter = null } = {}) {
  let offset = 0;
  let rest = '';
  const decoder = new StringDecoder('utf8');
  function step(feed, budget = Infinity) {
    let fd;
    let read = 0;
    try {
      fd = fs.openSync(file, 'r');
      while (offset < end && read < budget) {
        const len = Math.min(end - offset, MAX_CHUNK, Math.max(1, budget - read));
        const buf = SHARED;
        const n = fs.readSync(fd, buf, 0, len, offset);
        if (n <= 0) { offset = end; break; }
        offset += n;
        read += n;
        const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
        rest = parts.pop();
        for (const line of parts) {
          if (!line || (filter && !filter(line))) continue;
          try { const r = parseLine(line); if (r) feed(r); } catch { /* skipped */ }
        }
      }
    } catch { offset = end; /* unreadable: give up on totals, never on the session */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    return read;
  }
  return { step, get done() { return offset >= end; }, get offset() { return offset; }, end };
}

/** What the state carries per session: totals by source and the last few, short. PURE. */
export function slimInjections(sum) {
  if (!sum || !sum.count) return null;
  return {
    count: sum.count,
    estTokens: sum.estTokens,
    bySource: sum.bySource,
    byKind: sum.byKind,
    last: (sum.last || []).slice(-6).map((i) => ({ at: i.at, source: i.source, kind: i.kind || null, event: i.event, chars: i.chars, text: i.text.slice(0, 280), commands: i.commands, followed: i.followed }))
  };
}

/**
 * A session snapshot from the tail, corrected by what the head holds. PURE.
 * Only totals come from the head; everything "current" is the tail's.
 */
export function mergeHead(snap, head, { done = true } = {}) {
  if (!head) return snap;
  const out = { ...snap };
  // a tail without a single request (one huge tool result) borrows the head's last one
  if (!snap.ctx && head.ctx) out.ctx = head.ctx;
  if (!snap.model && head.model) out.model = head.model;
  out.compactions = (snap.compactions || 0) + (head.compactions || 0);
  if (head.format && snap.format && snap.format.counts) {
    const c = {};
    for (const k of Object.keys(snap.format.counts)) c[k] = (snap.format.counts[k] || 0) + (head.format[k] || 0);
    out.format = formatVerdict(c, snap.format.version || head.version);
  }
  // a request streamed across the head/tail border appears in both folds: count it once
  let overlap = 0;
  if (head.seen && snap._seen) for (const k of head.seen) if (snap._seen.has(k)) overlap += 1;
  out.requests = (snap.requests || 0) + (head.requests || 0) - overlap;
  out.outputTokens = (snap.outputTokens || 0) + (head.outputTokens || 0);
  if (head.startedMs && (!snap.startedMs || head.startedMs < snap.startedMs)) out.startedMs = head.startedMs;
  if (!snap.lastCompaction && head.lastCompaction) out.lastCompaction = head.lastCompaction;
  if (head.tracker) {
    const h = head.tracker.summary();
    if (h.count) {
      const merged = mergeInjectionSummaries([h, snap.injections || null]);
      out.injections = { count: merged.count, estTokens: merged.estTokens, bySource: merged.bySource, byKind: merged.byKind, last: (snap.injections && snap.injections.last && snap.injections.last.length ? snap.injections.last : slimInjections(h).last) };
    }
  }
  if (out.limitSource === 'compaction' || out.limitSource === 'model') {
    const maxPre = head.maxPreTokens || 0;
    if (maxPre && out.limitSource === 'model') { out.limit = Math.ceil(maxPre / 50_000) * 50_000; out.limitSource = 'compaction'; }
    else if (maxPre && out.limitSource === 'compaction') out.limit = Math.max(out.limit, Math.ceil(maxPre / 50_000) * 50_000);
    out.ratio = out.limit ? Math.round((out.ctx / out.limit) * 1000) / 1000 : null;
  }
  if (snap.title === (snap.id ? snap.id.slice(0, 8) : 'session') && head.firstPrompt) out.title = head.firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 60);
  out.ratio = out.limit ? Math.round((out.ctx / out.limit) * 1000) / 1000 : null; // ctx may have come from the head
  delete out._seen;
  if (!done) out.partial = true;
  return out;
}

// --- discovery ---------------------------------------------------------------

/** Transcript roots worth watching: the configured one, the default, any a running session uses. PURE. */
export function discoverRoots({ env = process.env, processEnvDirs = [] } = {}) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  for (const r of String(env.BRAIN_TRANSCRIPT_ROOTS || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) add(path.resolve(r));
  add(transcriptsRoot(env));
  add(path.join(os.homedir(), '.claude', 'projects'));
  for (const d of processEnvDirs) add(path.join(d, 'projects'));
  return out;
}

/** Main-session transcripts (root/<project>/<id>.jsonl) touched within `liveMs`. */
export function liveTranscripts(roots, { now = Date.now(), liveMs = DEFAULTS.liveMinutes * 60_000 } = {}) {
  const out = [];
  for (const root of roots) {
    let projects = [];
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const p of projects) {
      const dir = path.join(root, p.name);
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, e.name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (now - st.mtimeMs <= liveMs) out.push({ file, mtimeMs: st.mtimeMs, size: st.size, root, project: p.name });
      }
    }
  }
  return out;
}

// --- processes ---------------------------------------------------------------

const INFRA_RE = /\bdaemon run\b|bg-pty-host|bg-spare|--bg-/;

/** Session id a claude command line names, if any. PURE. */
export function sessionIdFromCommand(command) {
  const c = String(command || '');
  let m = c.match(/--session-id[=\s]+([0-9a-f-]{36})/i);
  if (m) return m[1].toLowerCase();
  m = c.match(/--resume[=\s]+(\S+)/);
  if (m) { const u = m[1].match(UUID_RE); if (u) return u[0].toLowerCase(); }
  return null;
}

/** Interactive agent sessions from the process table (no daemons, no spares). PURE given rows. */
export function agentSessionRows(rows, self = new Set([process.pid, process.ppid])) {
  return rows.filter((r) => !self.has(r.pid) && classify(r.command) === 'agent-session' && !INFRA_RE.test(r.command));
}

function sh(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); }
  catch { return ''; }
}

/** CLAUDE_CONFIG_DIR per pid, from the processes' own environment (macOS/BSD ps -E). */
export function configDirsOf(pids) {
  const out = new Map();
  if (!pids.length || process.platform === 'linux') {
    if (process.platform === 'linux') for (const pid of pids) {
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const v = env.find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
        if (v) out.set(pid, v.slice('CLAUDE_CONFIG_DIR='.length));
      } catch { /* not ours */ }
    }
    return out;
  }
  const text = sh('ps', ['-E', '-o', 'pid=,command=', '-p', pids.join(',')]);
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s(.*)$/);
    if (!m) continue;
    const v = m[2].match(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/);
    if (v) out.set(Number(m[1]), v[1]);
  }
  return out;
}

/**
 * cwd per pid in ONE lsof call. lsof is slow per process on macOS (18
 * sessions, one call each, held the first state back for over ten seconds
 * under memory pressure); one call for all of them is a single table scan.
 */
export function cwdsOf(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (process.platform === 'linux') {
    for (const pid of pids) { try { out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone or not ours */ } }
    return out;
  }
  let pid = 0;
  for (const line of sh('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/**
 * Attach PIDs to sessions. By session id where the command line names one;
 * else by cwd when exactly one live session runs there. PURE.
 */
export function attachProcesses(sessions, rows, cwdByPid = new Map()) {
  const byId = new Map(sessions.filter((s) => s.id).map((s) => [s.id, s]));
  const byCwd = new Map();
  for (const s of sessions) if (s.cwd) (byCwd.get(s.cwd) || byCwd.set(s.cwd, []).get(s.cwd)).push(s);
  const taken = new Set();
  const unmatched = [];
  for (const r of rows) {
    const id = sessionIdFromCommand(r.command);
    const s = id ? byId.get(id) : null;
    if (s && !taken.has(s)) { s.pid = r.pid; s.rssMb = Math.round(r.rssKb / 1024); taken.add(s); }
    else unmatched.push(r);
  }
  for (const r of unmatched) {
    const cwd = cwdByPid.get(r.pid);
    const list = cwd ? (byCwd.get(cwd) || []).filter((s) => !taken.has(s)) : [];
    if (list.length === 1) { list[0].pid = r.pid; list[0].rssMb = Math.round(r.rssKb / 1024); taken.add(list[0]); }
  }
  return sessions;
}

// --- the state ---------------------------------------------------------------

/** The machine line from brain:ps's quick reading. PURE given the reading. */
export function machineFrom(quick, agentRows = [], { scanned = true } = {}) {
  // Not scanned yet (the first pass skips the process table): unknown, never 0.
  if (!scanned) return { totalGb: null, freePct: null, pressure: null, swapUsedGb: null, agentProcesses: null, agentRssGb: null, orphans: null, orphanMb: null };
  const sys = (quick && quick.system) || {};
  return {
    totalGb: sys.totalGb ?? null,
    freePct: sys.freePct ?? null,
    pressure: sys.pressure ?? null,
    swapUsedGb: sys.swapUsedGb == null ? null : Math.round(sys.swapUsedGb * 10) / 10,
    agentProcesses: agentRows.length,
    agentRssGb: Math.round(agentRows.reduce((a, r) => a + r.rssKb, 0) / 2 ** 20 * 10) / 10,
    orphans: ((quick && quick.orphans) || []).length,
    orphanMb: Math.round(((quick && quick.orphans) || []).reduce((a, r) => a + (r.rssKb || 0), 0) / 1024)
  };
}

export const EVENT_WINDOW_MS = 15 * 60_000;
export const CONTROL_WINDOW_MS = 24 * 3600_000;

/**
 * Fold the bus into the state: active holds, edits waiting for an answer,
 * recent events, and per session whether the companion can reach it
 * (`control`: the hook ran for it) and how many notes wait for it. PURE.
 */
export function busView(sessions, { holds = [], pending = [], events = [], inbox = {}, seen = {}, now = Date.now() } = {}) {
  const title = new Map(sessions.filter((s) => s.id).map((s) => [s.id, s.title]));
  for (const s of sessions) {
    const at = s.id ? seen[s.id] : 0;
    s.control = Boolean(at && now - at < CONTROL_WINDOW_MS);
    s.inbox = (s.id && inbox[s.id]) || 0;
    s.held = pending.filter((p) => p.session === s.id).length;
  }
  const short = (f, root) => (root && f && f.startsWith(root + path.sep) ? f.slice(root.length + 1) : f ? f.replace(os.homedir(), '~') : '');
  return {
    holds: holds.map((h) => ({ id: h.id, glob: h.glob, root: h.root, project: h.root ? path.basename(h.root) : null, worktrees: Array.isArray(h.roots) ? h.roots.length : h.root ? 1 : null, until: h.until || null, minutesLeft: h.until ? Math.max(0, Math.ceil((h.until - now) / 60_000)) : null, note: h.note || '' })),
    pending: pending.map((p) => ({
      id: p.id, session: p.session || null, title: title.get(p.session) || null, tool: p.tool || null,
      file: p.file || null, shortFile: short(p.file, p.cwd), glob: p.glob || null, project: repoName(p.cwd),
      at: p.at, deadline: p.deadline || null, secondsLeft: p.deadline ? Math.max(0, Math.round((p.deadline - now) / 1000)) : null
    })),
    events: events.filter((e) => now - e.at < EVENT_WINDOW_MS).map((e) => ({ ...e, title: title.get(e.session) || null, shortFile: e.file ? short(e.file, null) : undefined }))
  };
}

export function readBus(dir, now = Date.now(), { sweep = true } = {}) {
  return {
    holds: readHolds(dir, now),
    pending: readPending(dir, now, { sweep }),
    events: readRecentEvents(dir, { sinceMs: now - EVENT_WINDOW_MS, limit: 20 }),
    dayEvents: readRecentEvents(dir, { sinceMs: startOfDay(now), limit: 2000 }),
    inbox: inboxCounts(dir),
    seen: readSeen(dir)
  };
}

/** Local midnight before `now`. PURE. */
export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * What leanlamp did today (since local midnight), for the live numbers in the
 * wall: compactions and how many were prepared, the seconds the others made
 * you wait, held edits and their answers, notes delivered, memory reclaimed.
 * Compactions come from the transcripts (main sessions), the rest from the
 * event log. A held edit counts once, whatever became of it. PURE.
 */
export function todayStats({ sessions = [], events = [], now = Date.now() } = {}) {
  const t0 = startOfDay(now);
  const comps = sessions.flatMap((s) => s.compactionLog || []).filter((c) => c && c.atMs >= t0 && c.atMs <= now);
  const ev = events.filter((e) => e && e.at >= t0 && e.at <= now);
  const n = (pred) => ev.filter(pred).length;
  const waits = comps.filter((c) => !c.precomputed && Number.isFinite(c.durationMs)).map((c) => c.durationMs);
  return {
    sinceMs: t0,
    compactions: comps.length,
    prepared: comps.filter((c) => c.precomputed).length,
    waitedSeconds: Math.round(waits.reduce((a, b) => a + b, 0) / 1000),
    held: n((e) => e.kind === 'held' || (e.kind === 'held-ask' && e.why === 'no engine')),
    approved: n((e) => e.kind === 'approved'),
    denied: n((e) => e.kind === 'denied'),
    steered: n((e) => e.kind === 'steer-delivered'),
    reclaimedMb: Math.round(ev.filter((e) => e.kind === 'reclaimed').reduce((a, e) => a + (Number(e.mb) || 0), 0))
  };
}

export function buildState({ sessions, machine, now = Date.now(), engine = {}, roots = [], bus = null }) {
  const sorted = [...sessions].sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
  const { dayEvents, ...rest } = bus || {};
  const view = busView(sorted, { ...rest, now });
  return {
    v: STATE_VERSION,
    format: formatSummary(sorted.filter((x) => x.state !== 'idle')),
    at: new Date(now).toISOString(),
    atMs: now,
    engine: { pid: process.pid, intervalMs: DEFAULTS.intervalMs, roots, ...engine },
    machine,
    sessions: sorted,
    ...view,
    today: todayStats({ sessions: sorted, events: dayEvents || [], now })
  };
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

/** `s` in exactly `n` columns: padded, or cut with an ellipsis. PURE. */
function fit(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t.padEnd(n) : `${t.slice(0, n - 1)}…`;
}

/**
 * The state as one screen of text. `cli` names the commands it suggests:
 * 'leanlamp' for `leanlamp status`, else the npm script. PURE.
 */
export function renderText(state, { now = Date.now(), cli = process.env.LEANLAMP_CLI ? 'leanlamp' : 'npm' } = {}) {
  const L = [];
  const m = state.machine || {};
  const live = state.sessions.filter((s) => s.state !== 'idle').length;
  const name = cli === 'leanlamp' ? 'leanlamp' : 'brain:companion';
  const cmd = (leanlamp, npm) => (cli === 'leanlamp' ? `leanlamp ${leanlamp}` : `npm run brain:companion -- ${npm}`);
  const memory = [m.pressure ? `pressure ${m.pressure}` : '', m.freePct != null ? `${m.freePct} % free` : '', m.orphans ? `${m.orphans} orphan${m.orphans === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  L.push(`${name} · ${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'} (${live} live)${memory ? ` · memory: ${memory}` : ''}`);
  L.push('');
  if (state.sessions.length) L.push(`  ${'CONTEXT'.padEnd(15)} ${'STATE'.padEnd(9)} ${'SESSION'.padEnd(34)} ${'PROJECT'.padEnd(34)} DETAIL`);
  for (const s of state.sessions) {
    const ctx = `${k(s.ctx)}/${k(s.limit)}`.padEnd(10);
    const pct = `${Math.round((s.limit ? s.ctx / s.limit : 0) * 100)}%`.padStart(4);
    // the branch matters more than the end of a long project name: keep it whole when it fits
    const branch = s.gitBranch ? ` · ${s.gitBranch}` : '';
    const proj = s.project || '?';
    const where = proj.length + branch.length <= 34 ? proj + branch : branch.length < 24 ? `${fit(proj, 34 - branch.length).trimEnd()}${branch}` : proj + branch;
    // the label only when it says more than the state ("thinking" twice says nothing)
    const said = String(s.label || '').toLowerCase();
    const label = said && said !== String(s.state).toLowerCase() && said !== 'waiting for you' ? s.label : '';
    const extra = [label, s.burnPerMin ? `+${k(s.burnPerMin)}/min` : '', s.compactions ? `${s.compactions}× compacted` : '', s.control ? 'steerable' : '', s.pid ? `pid ${s.pid}` : ''].filter(Boolean).join(' · ');
    L.push(`  ${ctx} ${pct} ${fit(s.state, 9)} ${fit(s.title, 34)} ${fit(where, 34)} ${extra}`.trimEnd());
  }
  if (!state.sessions.length) L.push('  no live transcript — start a Claude Code session, or pass --roots');
  const f = state.format;
  if (f) L.push('', f.ok ? `format: ok · Claude Code ${f.versions.join(', ') || '?'}${f.newerThanTested ? ` (newer than tested ${f.newestTested})` : ''}` : `FORMAT DRIFT: ${f.issues.map((i) => `${i.title}: ${i.issues.join('; ')}`).join(' · ')}`);
  const reachable = state.sessions.filter((s) => s.control).length;
  L.push(reachable ? `control: ${reachable} of ${state.sessions.length} session(s) run the companion hook (steer, hold)` : `control: no session runs the companion hook yet — monitor only (${cmd('init', 'install-hooks')})`);
  for (const h of state.holds || []) L.push(`hold ${h.id}  ${h.glob}${h.project ? ` in ${h.project}${h.worktrees > 1 ? ` (${h.worktrees} worktrees)` : ''}` : ' everywhere'}${h.minutesLeft != null ? ` · ${h.minutesLeft} min left` : ''}`);
  for (const p of state.pending || []) L.push(`WAITING ${p.id}  ${p.title || p.session} wants to ${p.tool} ${p.shortFile} · ${p.secondsLeft ?? '?'} s · ${cmd(`approve ${p.id}`, `approve ${p.id}`)} (or deny)`);
  L.push('');
  L.push(`state → ${(state.engine.statePath || statePath()).replace(os.homedir(), '~')} · roots: ${(state.engine.roots || []).map((r) => r.replace(os.homedir(), '~')).join(', ')}`);
  return L.join('\n');
}

// --- machine memory ------------------------------------------------------------

/**
 * Total, free share, swap and the kernel's pressure verdict. The pressure
 * level is one sysctl and is read on every machine scan; free share and swap
 * cost a `memory_pressure` run and are refreshed every 30 s by the caller.
 */
export function machineMemory({ full = true } = {}) {
  const out = { totalGb: Math.round(os.totalmem() / 2 ** 30), pressure: memoryPressure() };
  if (!full) return out;
  if (process.platform === 'darwin') {
    const swap = sh('sysctl', ['-n', 'vm.swapusage']).match(/used = ([\d.]+)M/);
    const free = sh('memory_pressure', []).match(/free percentage:\s*(\d+)%/);
    out.swapUsedGb = swap ? Number(swap[1]) / 1024 : null;
    out.freePct = free ? Number(free[1]) : null;
  } else {
    out.freePct = Math.round((os.freemem() / os.totalmem()) * 100);
    out.swapUsedGb = null;
  }
  return out;
}

/** Everything the machine line needs from one process table. PURE given its inputs. */
export function machineReading(allRows, memory) {
  return { system: memory || {}, orphans: findOrphans(allRows) };
}

// --- the engine --------------------------------------------------------------

/**
 * Holds the folds and tailers across ticks. `collect()` does one tick's work
 * and returns the state; `watch()` loops it and writes the file.
 *
 * Two slow passes run every `slowEveryMs`: the transcript scan (readdir +
 * stat, cheap) and the machine scan (ps, one lsof, memory pressure — up to a
 * second). The very first tick skips the machine scan so the first state is
 * on disk as soon as the transcripts are read; `collect({ machine: true })`
 * forces it (the one-shot CLI).
 */
export function createEngine({ roots = null, env = process.env, opts = DEFAULTS, now = Date.now, io = {}, dir = busDir(env) } = {}) {
  const tails = new Map(); // file → { tailer, fold }
  const windowCache = new Map(); // cwd → { at, value }
  const cwdCache = new Map(); // pid → cwd
  const cfgCache = new Map(); // pid → CLAUDE_CONFIG_DIR (or null): a process's environment never changes
  let memory = null, lastMemory = 0;
  const sys = { listProcesses, machineMemory, configDirsOf, cwdsOf, worktreesOf, ...io }; // tests stub these
  let lastScan = 0, lastMachine = 0;
  let slow = { rows: [], configDirs: new Map(), quick: null, roots: roots || discoverRoots({ env }) };

  function windowCached(cwd, configDir) {
    const key = `${cwd}|${configDir || ''}`;
    const hit = windowCache.get(key);
    const t = now();
    if (hit && t - hit.at < 30_000) return hit.value;
    const value = windowFor(cwd, { env, configDir });
    windowCache.set(key, { at: t, value });
    return value;
  }

  function scanTranscripts(t) {
    const live = liveTranscripts(slow.roots, { now: t, liveMs: opts.liveMinutes * 60_000 });
    const keep = new Set(live.map((x) => x.file));
    for (const x of live) if (!tails.has(x.file)) tails.set(x.file, { tailer: createTailer(x.file, { tailBytes: opts.tailBytes || 0 }), fold: createSessionFold({ transcript: x.file }), root: x.root, head: null });
    for (const f of [...tails.keys()]) if (!keep.has(f)) tails.delete(f);
    lastScan = t;
  }

  let receipt = null;
  let refreshing = null;
  let lastRoots = 0;
  /** New worktrees join an existing hold within 30 s. */
  function refreshHoldRoots(t) {
    if (t - lastRoots < (opts.holdRootsEveryMs ?? 30_000)) return;
    lastRoots = t;
    const holds = readHolds(dir, t).filter((h) => h.repo);
    if (!holds.length) return;
    const byRepo = {};
    for (const repo of new Set(holds.map((h) => h.repo))) {
      const anyRoot = holds.find((h) => h.repo === repo && (h.roots || [h.root]).some(Boolean));
      const from = anyRoot && ((anyRoot.roots || []).find((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } }) || anyRoot.root);
      const wt = from ? sys.worktreesOf(from) : null;
      if (wt && wt.repo === repo) byRepo[repo] = wt.roots;
    }
    try { updateHoldRoots(dir, byRepo, t); } catch { /* next round */ }
  }
  /** Read the receipt (cheap) and start a refresh in a child when it is older than an hour. */
  function scanReceipt(t) {
    receipt = readReceipt(dir);
    const stale = !receipt || t - (receipt.atMs || 0) > (opts.receiptEveryMs ?? 3600_000);
    const busy = refreshing && refreshing.exitCode === null;
    if (!stale || busy || opts.receiptEveryMs === 0 || !opts.refreshReceipt) return;
    try {
      const script = fileURLToPath(import.meta.url);
      refreshing = spawn('nice', ['-n', '10', process.execPath, script, 'receipt', '--write', '--state', path.join(dir, 'state.json')], { stdio: 'ignore', detached: false, env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
      refreshing.on('error', () => { refreshing = null; });
    } catch { refreshing = null; }
  }

  /**
   * One process table for everything (sessions, orphans), config dirs and
   * cwds only for processes not seen before, memory in full every 30 s.
   */
  function scanMachine(t) {
    const all = sys.listProcesses();
    const rows = agentSessionRows(all);
    const fresh = rows.filter((r) => !cfgCache.has(r.pid)).map((r) => r.pid);
    if (fresh.length) {
      const found = sys.configDirsOf(fresh);
      for (const pid of fresh) cfgCache.set(pid, found.get(pid) || null);
    }
    const unknown = rows.filter((r) => !cwdCache.has(r.pid) && !sessionIdFromCommand(r.command)).map((r) => r.pid);
    if (unknown.length) for (const [pid, cwd] of sys.cwdsOf(unknown)) cwdCache.set(pid, cwd);
    const alive = new Set(rows.map((r) => r.pid));
    for (const pid of [...cwdCache.keys()]) if (!alive.has(pid)) cwdCache.delete(pid);
    for (const pid of [...cfgCache.keys()]) if (!alive.has(pid)) cfgCache.delete(pid);
    const configDirs = new Map([...cfgCache].filter(([, d]) => d));
    let quick = null;
    try {
      const full = !memory || t - lastMemory >= (opts.memoryEveryMs ?? 30_000);
      const m = sys.machineMemory({ full });
      memory = full ? m : { ...memory, ...m };
      if (full) lastMemory = t;
      quick = machineReading(all, memory);
    } catch { /* the machine line is optional */ }
    const discovered = roots || discoverRoots({ env, processEnvDirs: [...new Set(configDirs.values())] });
    const rootsChanged = discovered.join('\n') !== slow.roots.join('\n');
    slow = { rows, configDirs, quick, roots: discovered };
    lastMachine = t;
    scanReceipt(t);
    refreshHoldRoots(t);
    try { sweepBus(dir, t); } catch { /* housekeeping */ }
    if (rootsChanged) scanTranscripts(t);
  }

  /**
   * `full`: read every head to the end now (the one-shot CLI wants exact
   * totals). Otherwise heads are read `backfillBytesPerTick` at a time, live
   * sessions first, so a watch tick stays short.
   */
  function collect({ machine = false, full = false, sweep = true } = {}) {
    const t = now();
    const first = !lastScan;
    if (first || t - lastScan >= opts.slowEveryMs) scanTranscripts(t);
    if (first) receipt = readReceipt(dir); // cheap; the refresh decision waits for the machine scan
    // the machine is scanned from the second pass on (the first one is for the first state)
    if (machine || (!first && (!lastMachine || t - lastMachine >= opts.slowEveryMs))) scanMachine(t);
    const sessions = [];
    const liveMs = opts.liveMinutes * 60_000;
    // The very first tick reads tails only: the first state is what the user waits for.
    let budget = full ? Infinity : first ? 0 : opts.backfillBytesPerTick || Infinity;
    const entries = [...tails.values()].sort((a, b) => (b.fold.state.lastActivityMs || 0) - (a.fold.state.lastActivityMs || 0));
    for (const entry of entries) {
      const { tailer, fold, root } = entry;
      tailer.read(fold.feed);
      if (!entry.head && tailer.headEnd > 0) entry.head = { reader: createRangeReader(tailer.file, tailer.headEnd, { filter: headLineWanted }), fold: createSessionFold() };
      if (!fold.state.lastActivityMs) continue; // nothing readable yet
      // mtime is not activity (idle sessions rewrite metadata in bursts): only
      // a real message inside the window puts a session on the wall.
      if (t - fold.state.lastActivityMs > liveMs) continue;
      if (entry.head && !entry.head.reader.done && budget > 0) budget -= entry.head.reader.step(entry.head.fold.feed, budget);
      const configDir = root.endsWith(`${path.sep}projects`) ? path.dirname(root) : null;
      const w = windowCached(fold.state.cwd, configDir);
      const snap = fold.snapshot({ now: t, limit: w ? w.limit : null, limitSource: w ? w.source : null, opts });
      sessions.push(entry.head ? mergeHead(snap, entry.head.fold.state, { done: entry.head.reader.done }) : snap);
    }
    attachProcesses(sessions, slow.rows, cwdCache);
    const state = buildState({ sessions, machine: machineFrom(slow.quick, slow.rows, { scanned: Boolean(lastMachine) }), now: t, roots: slow.roots, bus: readBus(dir, t, { sweep }) });
    if (receipt) state.receipt = { ...receipt, projects: (receipt.projects || []).slice(0, 14) }; // the full list stays in receipt.json
    return state;
  }

  return {
    collect,
    /** The hourly receipt runs in a child; it goes when the engine goes. */
    stopChildren() { if (refreshing && refreshing.exitCode === null) { try { refreshing.kill('SIGTERM'); } catch { /* gone */ } } },
    get tails() { return tails; },
    /** Folders holding live transcripts: where a change means "look again". */
    liveDirs() { return [...new Set([...tails.keys()].map((f) => path.dirname(f)))]; },
    /** Some live session's head is still being read for exact totals (stale transcripts are never backfilled). */
    get backfilling() {
      const t = now();
      return [...tails.values()].some((e) => e.head && !e.head.reader.done && e.fold.state.lastActivityMs && t - e.fold.state.lastActivityMs <= opts.liveMinutes * 60_000);
    }
  };
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

/** Is `pid` a running companion engine? A stale pid file may name an unrelated process now. */
export function isEngineProcess(pid) {
  if (!pidAlive(pid)) return false;
  try { return /brain-companion\.mjs/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return false; }
}

/** Keep the state file current until killed. Resolves never; rejects never. */
export async function watch({ roots = null, file = statePath(), opts = DEFAULTS, parent = 0, log = (s) => process.stderr.write(s + '\n') } = {}) {
  ensureDir(path.dirname(file));
  const pidFile = path.join(path.dirname(file), 'engine.pid');
  try {
    const other = Number(fs.readFileSync(pidFile, 'utf8'));
    if (other && other !== process.pid && isEngineProcess(other)) { log(`[brain:companion] already running (pid ${other}) — nothing to do`); return; }
  } catch { /* no pid file */ }
  fs.writeFileSync(pidFile, String(process.pid));
  const engine = createEngine({ roots, opts, dir: path.dirname(file) });
  let lastWrite = 0, lastBody = '';
  const stop = () => {
    try { engine.stopChildren(); } catch { /* none */ }
    try { if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.unlinkSync(pidFile); } catch { /* gone */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(`[brain:companion] watching → ${file.replace(os.homedir(), '~')}`);
  const t0 = Date.now();
  let writes = 0;
  // The first pass over the transcripts takes seconds. Say at once that an
  // engine is here and show the bus, so a held edit can be answered from the
  // first second on (the hook only waits when the state file is fresh).
  try {
    const early = buildState({ sessions: [], machine: machineFrom(null, [], { scanned: false }), now: t0, roots: [], bus: readBus(path.dirname(file), t0), engine: { starting: true, statePath: file } });
    atomicWrite(file, JSON.stringify(early));
  } catch (e) { log(`[brain:companion] could not write the first state: ${e && e.message ? e.message : e}`); }
  // Event-driven. A change in a live transcript's folder or on the bus wakes
  // the engine within ~0.1 s (at most four passes a second while an agent
  // streams); otherwise it ticks every 2 s while an agent works and every 5 s
  // when all are quiet, because labels ("idle for 3 min") and burn rates move
  // with time. Same state as a 1 s loop, a fraction of the CPU.
  const dir = path.dirname(file);
  const stateName = path.basename(file);
  const own = (name) => name === stateName || /^(state\.json|receipt\.json|engine\.pid|holds\.lock)$|\.tmp$/.test(name);
  const watchers = new Map();
  let wakeTimer = null, sleepTimer = null, running = false, again = false, lastRunAt = 0;
  const wake = (delay = 100) => {
    if (running) { again = true; return; }
    if (wakeTimer) return;
    clearTimeout(sleepTimer);
    wakeTimer = setTimeout(run, Math.max(delay, (opts.minGapMs ?? 250) - (Date.now() - lastRunAt)));
  };
  const watchDir = (d) => {
    if (watchers.has(d)) return;
    try {
      const w = fs.watch(d, { persistent: true }, (_event, name) => { if (!name || !own(String(name))) wake(); });
      w.on('error', () => { try { w.close(); } catch { /* gone */ } watchers.delete(d); });
      watchers.set(d, w);
    } catch { /* not there (yet) */ }
  };
  const syncWatchers = (dirs) => {
    for (const d of dirs) watchDir(d);
    for (const [d, w] of watchers) if (!dirs.has(d)) { try { w.close(); } catch { /* gone */ } watchers.delete(d); }
  };
  for (const sub of ['pending', 'inbox']) { try { fs.mkdirSync(path.join(dir, sub), { recursive: true }); } catch { /* best effort */ } }

  function run() {
    wakeTimer = null;
    running = true;
    lastRunAt = Date.now();
    // Started by the app: leave with it, even when it died without saying goodbye.
    if (parent && !pidAlive(parent)) { log(`[brain:companion] parent ${parent} is gone — stopping`); stop(); }
    let busy = false;
    try {
      const state = engine.collect();
      state.engine.statePath = file;
      const body = JSON.stringify(state);
      const changedBody = body.replace(/"at":"[^"]*","atMs":\d+/, '');
      if (changedBody !== lastBody || lastRunAt - lastWrite >= opts.heartbeatMs) {
        atomicWrite(file, body);
        lastBody = changedBody;
        lastWrite = lastRunAt;
        writes += 1;
        if (writes === 1) log(`[brain:companion] first state after ${Date.now() - t0} ms · ${state.sessions.length} session(s) · roots ${state.engine.roots.length}`);
      }
      busy = engine.backfilling || state.sessions.some((x) => x.state === 'tool' || x.state === 'thinking') || (state.pending || []).length > 0;
      const dirs = new Set([dir, path.join(dir, 'pending'), path.join(dir, 'inbox'), ...engine.liveDirs(), ...(state.engine.roots || [])]);
      syncWatchers(dirs);
    } catch (e) {
      log(`[brain:companion] tick failed: ${e && e.message ? e.message : e}`);
    }
    running = false;
    if (again) { again = false; wake(50); return; }
    const next = engine.backfilling ? opts.intervalMs : busy ? (opts.busyEveryMs ?? 2000) : (opts.quietEveryMs ?? 5000);
    sleepTimer = setTimeout(() => wake(0), next);
  }
  run();
  setTimeout(() => wake(0), 150); // second pass at once: the machine scan and the first backfill
  await new Promise(() => {}); // runs until killed
}

// --- acting on sessions --------------------------------------------------------

/**
 * Which session a CLI target means: an id or id prefix (≥ 4 chars), else a
 * case-insensitive piece of the title or project — live sessions first.
 * Returns { session } or { error }. PURE.
 */
export function resolveSession(target, sessions) {
  const t = String(target || '').trim().toLowerCase();
  if (!t) return { error: 'name a session: an id prefix, or a word from its title or project' };
  const byId = sessions.filter((s) => s.id && (s.id === t || (t.length >= 4 && s.id.startsWith(t))));
  if (byId.length === 1) return { session: byId[0] };
  const hit = (s) => String(s.title || '').toLowerCase().includes(t) || String(s.project || '').toLowerCase() === t;
  for (const pool of [sessions.filter((s) => s.state !== 'idle'), sessions]) {
    const m = pool.filter(hit);
    if (m.length === 1) return { session: m[0] };
    if (m.length > 1) return { error: `"${target}" matches ${m.length} sessions: ${m.slice(0, 5).map((s) => `${s.id.slice(0, 8)} ${s.title}`).join(' · ')} — use an id prefix` };
  }
  const known = [...sessions].sort((x, y) => (x.state === 'idle') - (y.state === 'idle')).slice(0, 6).map((s) => `${String(s.id || '').slice(0, 8)} ${s.title}`);
  return { error: `no session matches "${target}"${known.length ? ` — there are: ${known.join(' · ')}` : ' — no session is known (is the engine running?)'}` };
}

/** "30m", "2h", "45" (minutes), "0"/"forever" (until released) → minutes. PURE. */
export function parseMinutes(s, fallback = 30) {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (v === '0' || v === 'forever' || v === 'off') return 0;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/);
  if (!m) throw new Error(`not a duration: ${s} (try 30m, 2h)`);
  const n = Number(m[1]);
  const minutes = m[2] === 'h' ? n * 60 : m[2] === 'd' ? n * 1440 : n;
  return minutes > 0 ? Math.max(1, Math.round(minutes)) : 0; // "0.4" is a short hold, never "forever"
}

/** The sessions as the engine sees them: the fresh state file, else one pass. */
function currentSessions(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - st.atMs < 15_000) return st.sessions;
  } catch { /* none */ }
  return createEngine().collect().sessions;
}

function gitRoot(dir) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/** `git worktree list --porcelain` → existing worktree paths. PURE. */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), prunable: false }; out.push(cur); }
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
  }
  return out.filter((w) => !w.prunable).map((w) => w.path);
}

/**
 * The repository a directory belongs to (its git common dir, absolute) and
 * every live worktree of it. Null outside git.
 */
export function worktreesOf(dir) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const list = execFileSync('git', ['--git-dir', common, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const roots = parseWorktrees(list).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    return { repo: common, roots };
  } catch { return null; }
}

// --- installing the hook -------------------------------------------------------

export const HOOK_SCRIPT = 'brain-companion-hook.mjs';
const HOOK_EVENTS = Object.freeze([['PreToolUse', '*'], ['UserPromptSubmit', null]]);

export function hookCommand(scriptPath) { return `node "${scriptPath}"`; }

/**
 * Add the companion hook to a settings object (idempotent). An entry that
 * points at another copy of the script (a removed worktree, an old checkout)
 * is repointed, not counted as installed. PURE: returns { settings, added, updated }.
 */
export function mergeHook(settings, command, { timeout = 60 } = {}) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  s.hooks ||= {};
  let added = 0, updated = 0;
  for (const [event, matcher] of HOOK_EVENTS) {
    const groups = (s.hooks[event] ||= []);
    const ours = groups.flatMap((g) => (g.hooks || []).filter((h) => String(h.command || '').includes(HOOK_SCRIPT)));
    if (ours.some((h) => h.command === command)) continue;
    if (ours.length) { for (const h of ours) { h.command = command; h.timeout = timeout; } updated += 1; continue; }
    const group = { hooks: [{ type: 'command', command, timeout }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
    added += 1;
  }
  return { settings: s, added, updated };
}

/** Remove every companion hook entry. PURE: returns { settings, removed }. */
export function removeHook(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  let removed = 0;
  for (const [event, groups] of Object.entries(s.hooks || {})) {
    const kept = [];
    for (const g of groups) {
      const hooks = (g.hooks || []).filter((h) => { const hit = String(h.command || '').includes(HOOK_SCRIPT); if (hit) removed += 1; return !hit; });
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return { settings: s, removed };
}

/**
 * The Claude config dirs in use: this shell's CLAUDE_CONFIG_DIR and every one
 * a running session was started with (an alias like
 * `CLAUDE_CONFIG_DIR=~/.claude-personal claude` is invisible to a plain
 * terminal otherwise); ~/.claude when there is nothing else.
 */
export function configDirsInUse({ env = process.env, procs = null } = {}) {
  const dirs = new Set();
  if (env.CLAUDE_CONFIG_DIR) dirs.add(path.resolve(env.CLAUDE_CONFIG_DIR));
  const rows = agentSessionRows(procs || listProcesses());
  for (const d of configDirsOf(rows.map((r) => r.pid)).values()) dirs.add(path.resolve(d));
  if (!dirs.size) dirs.add(path.join(os.homedir(), '.claude'));
  return [...dirs];
}

/** The compaction mark a repo's sessions get, per config dir in use. */
export function windowsFor(cwd, dirs = configDirsInUse()) {
  return dirs.map((configDir) => ({ configDir, window: windowFor(cwd, { configDir }) }));
}

/** One line for windowsFor: the same mark everywhere, or per config dir. PURE. */
export function describeWindows(list) {
  const one = (w) => (w ? `${Math.round(w.limit / 1000)}k (${w.source})` : "the model's default (≈ 967k on 1M models)");
  const texts = [...new Set(list.map((x) => one(x.window)))];
  if (texts.length <= 1) return texts[0] || one(null);
  return list.map((x) => `${one(x.window)} for sessions on ${x.configDir.replace(os.homedir(), '~')}`).join('; ');
}

/** User settings files to install into: every config dir a running session uses, else the env's. */
function settingsTargets(explicit) {
  if (explicit) return [path.resolve(explicit)];
  return configDirsInUse().map((d) => path.join(d, 'settings.json'));
}

/**
 * Add or remove the hook in every target settings file. Returns per file
 * what was (or would be) done: state is installed | added | missing (dry
 * run) | removed | absent | invalid.
 */
function installHooks({ explicit, dryRun, uninstall, dir = busDir() }) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), HOOK_SCRIPT);
  const targets = [];
  for (const file of settingsTargets(explicit)) {
    const where = file.replace(os.homedir(), '~');
    let current = {};
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { targets.push({ file: where, state: 'invalid', entries: 0 }); continue; } }
    const r = uninstall ? removeHook(current) : mergeHook(current, hookCommand(script));
    const n = uninstall ? r.removed : r.added + r.updated;
    if (!n) { targets.push({ file: where, state: uninstall ? 'absent' : 'installed', entries: 0 }); continue; }
    if (dryRun) { targets.push({ file: where, state: uninstall ? 'installed' : r.updated && !r.added ? 'stale' : 'missing', entries: n }); continue; }
    const existed = fs.existsSync(file);
    if (existed) {
      // backups live with leanlamp's own files, not next to the user's settings
      const backups = path.join(brainHome(), 'backups');
      ensureDir(backups);
      const which = path.resolve(file).replace(os.homedir(), 'home').replace(/[\\/]+/g, '_').replace(/[^\w.-]/g, '');
      fs.copyFileSync(file, path.join(backups, `hooks-${which}-${Date.now()}-${process.pid}`));
    }
    writeConfigFile(file, JSON.stringify(r.settings, null, 2) + '\n');
    recordChange(dir, { kind: 'hook', action: uninstall ? 'removed' : r.updated && !r.added ? 'updated' : 'added', file, created: !existed || undefined, by: process.env.BRAIN_COMPANION_FROM || 'cli' });
    targets.push({ file: where, state: uninstall ? 'removed' : r.updated && !r.added ? 'updated' : 'added', entries: n });
  }
  const verb = (t) => {
    if (t.state === 'invalid') return 'skipped, not valid JSON';
    if (uninstall) return dryRun ? (t.entries ? 'would remove' : 'no companion hook') : (t.entries ? 'removed' : 'no companion hook');
    if (t.state === 'updated') return 'repointed (it pointed at another copy)';
    if (t.state === 'stale') return 'would repoint (it points at another copy)';
    return dryRun ? (t.entries ? 'would add' : 'already installed') : (t.entries ? 'added' : 'already installed');
  };
  const lines = targets.map((t) => `${t.file}: ${verb(t)}${t.entries ? ` ${t.entries} hook entr${t.entries === 1 ? 'y' : 'ies'}` : ''}${!dryRun && t.entries ? ` (backup in ${path.join(brainHome(), 'backups').replace(os.homedir(), '~')})` : ''}`);
  if (!uninstall && !dryRun && targets.some((t) => t.entries)) lines.push('Undo: leanlamp init --undo');
  if (!uninstall && !dryRun && targets.some((t) => t.state === 'added')) lines.push('Sessions pick the hook up at their next start (or after /hooks). Until then they are monitor only.');
  return { targets, script, text: lines.join('\n'), installed: targets.length > 0 && targets.every((t) => t.state === 'installed' || t.state === 'added' || t.state === 'updated') };
}

// --- the setup check ---------------------------------------------------------------

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

/**
 * Time the hook on this machine, against a scratch bus (no real note is
 * claimed, no presence is marked): the logic in-process, and a whole call as
 * Claude Code makes it (node start included).
 */
export async function timeHook({ runs = 200, spawns = 31 } = {}) {
  const hookFile = path.join(path.dirname(fileURLToPath(import.meta.url)), HOOK_SCRIPT);
  const { handle } = await import(hookFile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-check-'));
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, '{}');
    const inputs = [
      { hook_event_name: 'UserPromptSubmit', session_id: 'leanlamp-check', cwd: tmp, prompt: 'hi' },
      { hook_event_name: 'PreToolUse', session_id: 'leanlamp-check', cwd: tmp, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'a.txt') } }
    ];
    const logic = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      await handle(inputs[i % 2], { dir: tmp, stateFile });
      logic.push(performance.now() - t);
    }
    const env = { ...process.env, BRAIN_HOME: tmp, BRAIN_COMPANION_STATE: stateFile };
    const spawnMs = (args, input) => { const t = performance.now(); spawnSync(process.execPath, args, { input, env, stdio: ['pipe', 'ignore', 'ignore'] }); return performance.now() - t; };
    // The fair baseline is an empty ES module: `node -e 0` skips the ESM loader every .mjs hook pays for.
    const empty = path.join(tmp, 'empty.mjs');
    fs.writeFileSync(empty, '');
    const call = [], bare = [];
    for (let i = 0; i < spawns; i++) {
      bare.push(spawnMs([empty], ''));
      call.push(spawnMs([hookFile], JSON.stringify(inputs[i % 2])));
    }
    // Descheduling shows up as spread: the repo's own guard decides whether these numbers are evidence.
    const { calibrateMachine, calibrationVerdict } = await import('./bench.mjs');
    const load = calibrationVerdict(calibrateMachine());
    return { logicMs: median(logic), callMs: median(call), nodeStartMs: median(bare), loaded: load.loaded, loadReason: load.reason };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Is the companion app running? (bundle or a `swift run` build) */
function appRunning(procs) {
  return procs.some((p) => /Leanlamp\.app\/Contents\/MacOS\/leanlamp(\s|$)|\.build\/[^ ]*\/leanlamp(\s|$)/.test(p.command || ''));
}

/**
 * Everything `leanlamp init` sets up, and whether it works, read-only: node,
 * the engine, the hook in each settings file, which live sessions it reaches,
 * transcript formats, this repo's compaction mark, the hook's cost here, the app.
 * Each check: { id, status: ok | warn | fail, text, fix? }.
 */
export async function checkSetup({ file = statePath(), cwd = process.cwd(), explicit = null, roots = null, now = Date.now(), timing = true } = {}) {
  const dir = path.dirname(file);
  const checks = [];
  const add = (id, status, text, fix) => checks.push(fix ? { id, status, text, fix } : { id, status, text });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'ok' : 'fail', `node ${process.versions.node}${major >= 20 ? '' : ' — needs 20 or newer'}`, major >= 20 ? null : 'install node 20+');

  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(dir, 'engine.pid'), 'utf8')) || null; } catch { /* none */ }
  const fresh = engineFresh(dir, now, undefined, file);
  let age = null;
  try { age = Math.round((now - fs.statSync(file).mtimeMs) / 1000); } catch { /* no state */ }
  if (fresh) add('engine', 'ok', `running${pid && isEngineProcess(pid) ? ` (pid ${pid})` : ''}, state ${age} s old`);
  else add('engine', 'fail', age === null ? 'not running, no state yet' : `not running — state is ${age} s old`, 'leanlamp open (or: npm run brain:companion -- --watch)');

  const hooks = installHooks({ explicit, dryRun: true, dir });
  for (const t of hooks.targets) {
    if (t.state === 'installed') add('hook', 'ok', `in ${t.file}`);
    else if (t.state === 'stale') add('hook', 'fail', `${t.file} points at another copy of the hook`, 'leanlamp init');
    else if (t.state === 'invalid') add('hook', 'fail', `${t.file} is not valid JSON`, 'fix the file by hand');
    else add('hook', 'fail', `not in ${t.file} — steer and hold cannot reach sessions`, 'leanlamp init');
  }

  // The running engine's state, unless it is missing or from a build that predates format checks.
  let state = null;
  if (fresh) { try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being written */ } }
  // without the engine, read the transcripts of every config dir a running session uses (not only ~/.claude)
  if (!state || !state.format) { try { state = createEngine({ roots: roots || discoverRoots({ processEnvDirs: configDirsInUse() }), dir }).collect({ machine: false, sweep: false }); } catch { /* no transcripts */ } }
  const live = ((state && state.sessions) || []).filter((x) => x.state !== 'idle');
  if (live.length) {
    const reach = live.filter((x) => x.control).length;
    const installed = hooks.installed;
    add('reach', reach === live.length ? 'ok' : 'warn',
      `${reach} of ${live.length} live session${live.length === 1 ? '' : 's'} can be steered${reach < live.length && installed ? ' — the others pick the hook up at their next start (or /hooks)' : ''}`);
    const f = state.format || formatSummary(live);
    const range = f.versions.length ? (f.versions.length > 1 ? `${f.versions[0]}–${f.versions.at(-1)}` : f.versions[0]) : 'unknown';
    if (!f.ok) add('format', 'fail', `Claude Code ${range}: ${f.issues.map((i) => `${i.title}: ${i.issues.join(', ')}`).join('; ')}`, 'update leanlamp, or report the version');
    else add('format', f.newerThanTested ? 'warn' : 'ok', `Claude Code ${range}, transcripts readable${f.newerThanTested ? ` — newer than the newest tested (${f.newestTested})` : ''}`);
  } else add('reach', 'warn', 'no live session right now — start one to see it on the island');

  const repo = gitRoot(cwd);
  if (repo) {
    const marks = windowsFor(repo);
    const unset = marks.every((m) => !m.window);
    add('mark', unset ? 'warn' : 'ok', `${path.basename(repo)} compacts at ${describeWindows(marks)}`, unset ? 'leanlamp compact --at 300k' : null);
  }

  if (timing) {
    const t = await timeHook();
    const share = Math.max(0, t.callMs - t.nodeStartMs);
    const r1 = (x) => (x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : String(Math.round(x)));
    const text = `${r1(t.callMs)} ms per tool call, ${r1(t.nodeStartMs)} ms of it Node starting (an empty script); leanlamp's share ${r1(share)} ms, the decision ${r1(t.logicMs)} ms — budget 5 ms on top of Node`;
    if (t.loaded) add('speed', 'warn', `${text} — but the machine is too busy for this to be evidence (${t.loadReason.split(' — ')[0]})`, 'run it again when the machine is quieter');
    else add('speed', share <= 5 ? 'ok' : 'warn', text);
  }

  const changes = readChanges(dir).filter((c) => c.kind === 'hook' || c.kind === 'mark');
  if (changes.length) {
    const files = [...new Set(changes.map((c) => c.file))];
    add('changes', 'ok', `leanlamp changed ${files.length} settings file${files.length === 1 ? '' : 's'}: ${files.map((f) => f.replace(os.homedir(), '~')).join(', ')} — leanlamp init --undo puts them back`);
  }

  const procs = listProcesses();
  const home = process.env.BRAIN_HOME ? path.resolve(process.env.BRAIN_HOME) : path.join(os.homedir(), '.project-brain');
  const bundles = [path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'companion', 'build', 'Leanlamp.app'), path.join(home, 'app', 'Leanlamp.app')];
  const running = appRunning(procs);
  const built = bundles.some((b) => fs.existsSync(b));
  add('app', running ? 'ok' : 'warn', running ? 'running' : built ? 'built, not running' : 'not built yet', running ? null : built ? 'leanlamp open' : 'leanlamp open (builds it once, about a minute)');

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

export function renderCheck(r) {
  const mark = { ok: '✓', warn: '·', fail: '✗' };
  const w = Math.max(...r.checks.map((c) => c.id.length)) + 2;
  const lines = r.checks.map((c) => `  ${mark[c.status]} ${c.id.padEnd(w)}${c.text}${c.fix ? `\n    ${' '.repeat(w)}→ ${c.fix}` : ''}`);
  return [...lines, '', r.ok ? 'everything leanlamp needs is in place' : 'fix the ✗ lines, then run this again'].join('\n');
}

// --- the receipt as text ---------------------------------------------------------

function readAllEvents(dir) {
  try {
    return fs.readFileSync(eventsFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const pctS = (x) => (x > 0 && x < 0.01 ? `${(x * 100).toFixed(1)} %` : `${Math.round((x || 0) * 100)} %`);

export function renderReceipt(r) {
  const L = [];
  const t = r.trim;
  L.push(`receipt — last ${r.days} days · ${r.source.transcripts} transcripts, ${(r.source.bytes / 1e9).toFixed(1)} GB read in ${(r.source.ms / 1000).toFixed(1)} s`);
  L.push('');
  L.push(`TRIM     context per request  median ${k(t.contextP50)} · p90 ${k(t.contextP90)} · max ${k(t.contextMax)}`);
  L.push(`         input spent above 500k  ${pctS(t.shareAbove500k)} of ${t.requests} requests`);
  const wait = t.medianWaitSeconds ?? t.avgWaitSeconds;
  L.push(`         compactions  ${t.compactions} in the main sessions · ${pctS(t.precomputedShare)} prepared in advance${wait != null ? ` · the others waited ${wait} s (${t.medianWaitSeconds != null ? 'median' : 'average'})` : ''}`);
  L.push('');
  L.push(`         ${'project'.padEnd(26)} ${'requests'.padStart(8)} ${'median'.padStart(7)} ${'p90'.padStart(6)} ${'>500k'.padStart(6)}  compacts at`);
  for (const p of r.projects.slice(0, 12)) {
    L.push(`         ${p.project.slice(0, 26).padEnd(26)} ${String(p.requests).padStart(8)} ${k(p.contextP50).padStart(7)} ${k(p.contextP90).padStart(6)} ${pctS(p.shareAbove500k).padStart(6)}  ${p.window ? k(p.window) : 'model default'}`);
  }
  L.push('');
  const got = r.got && r.got.bySource && r.got.bySource.brain;
  if (got) {
    const kinds = r.got.byKind || null;
    const hint = kinds ? kinds.hint : got;
    const tok = (x) => (x ? `${x.count} (≈ ${k(x.estTokens)} tokens)` : '0');
    if (hint) L.push(`GOT      brain command hints ${tok(hint)} · followed within 5 calls: ${hint.followed}${hint.followedShare != null ? ` (${pctS(hint.followedShare)})` : ''}`);
    if (kinds) L.push(`         answers before edits ${tok(kinds.answer)} · session state after compaction ${tok(kinds.state)} — not hints, not scored`);
    // the receipt names the switch only where the numbers make the case
    if (hint && hint.actionable >= 50 && hint.followedShare != null && hint.followedShare < 0.05) L.push('         hints are off by default now; something sets BRAIN_HINTS=1 — remove it from that settings file\'s "env"');
    const other = r.got.bySource.other;
    if (other) L.push(`         other hooks and plugins: ${other.count} snippets (≈ ${k(other.estTokens)} tokens)`);
    L.push('');
  }
  const g = r.guard;
  L.push(`GUARD    held ${g.held} · approved ${g.approved}${g.approvedFromNotch ? ` (${g.approvedFromNotch} from the notch)` : ''} · declined ${g.denied} · handed back to the terminal ${g.handedBack}`);
  L.push(`STEER    notes delivered ${r.steer.delivered}${r.steer.medianWaitSeconds != null ? ` · median wait for a tool call ${r.steer.medianWaitSeconds} s` : ''}`);
  L.push('');
  L.push('all numbers from your own transcripts and the companion bus · nothing left this machine');
  return L.join('\n');
}

// --- CLI ---------------------------------------------------------------------

const USAGE = `Usage: npm run brain:companion -- [command] [options]

  (none)                    the state once, as text (--json: as JSON)
  --watch                   keep the state file current (1 s) until killed; --parent <pid> stops with it
  steer <session> <note…>   a note the agent reads at its next tool call
  hold <glob> [--for 30m]   edits under <glob> in this repo wait for your answer (--all: every edit, every repo)
  release [<id>|--all]      lift holds
  approve <id>              let a held edit through        deny <id> [reason]   refuse it
  receipt [--days 14] [--write]   what the last days cost and what the companion did (--write: for the app)
  reclaim [--dry-run]       stop orphaned helpers (their agent is gone); nothing else
  install-hooks [--dry-run] [--settings <file>]   reach running agents (user settings: every session)
  check                     is everything in place? node, engine, hook, reach, formats, mark, hook time, app
  uninstall-hooks [--settings <file>]

  <session> is an id prefix or a word from the title or project. --roots <dir>[,<dir>] and
  --state <file> point the engine elsewhere. State and bus: ${busDir().replace(os.homedir(), '~')}`;

function main() {
  // Everything after the first `--` is literal (a steer note may say "--no-verify").
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const args = dd === -1 ? argv : argv.slice(0, dd);
  const literal = dd === -1 ? [] : argv.slice(dd + 1);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const json = takeFlag(args, '--json');
  const doWatch = takeFlag(args, '--watch');
  const once = takeFlag(args, '--once');
  const all = takeFlag(args, '--all');
  const dryRun = takeFlag(args, '--dry-run');
  const rootsOpt = takeOption(args, '--roots');
  const fileOpt = takeOption(args, '--state');
  const forOpt = takeOption(args, '--for');
  const settingsOpt = takeOption(args, '--settings');
  const parent = Number(takeOption(args, '--parent')) || 0;
  const daysOpt = takeOption(args, '--days');
  const write = takeFlag(args, '--write');
  const unknown = unknownFlags(args, ['--help', '-h', '--json', '--watch', '--once', '--all', '--dry-run', '--write', '--roots=', '--state=', '--for=', '--settings=', '--parent=', '--days=', '--']);
  if (unknown.length) { process.stderr.write(`[brain:companion] unknown flag(s): ${unknown.join(', ')}\n`); process.exit(2); }
  if (help) { console.log(USAGE); process.exit(0); }
  const roots = rootsOpt ? rootsOpt.split(',').map((s) => path.resolve(s.trim())).filter(Boolean) : null;
  const file = fileOpt ? path.resolve(fileOpt) : statePath();
  const dir = path.dirname(file);
  const [cmd, ...rest] = [...args, ...literal];
  const say = (text, obj) => process.stdout.write((json ? JSON.stringify(obj ?? { ok: true, text }) : text) + '\n');

  switch (cmd) {
    case undefined: {
      if (doWatch && !once) { watch({ roots, file, parent, opts: { ...DEFAULTS, refreshReceipt: true } }); return; }
      const state = createEngine({ roots, dir }).collect({ machine: true, full: true });
      state.engine.statePath = file;
      process.stdout.write((json ? JSON.stringify(state, null, 2) : renderText(state)) + '\n');
      return;
    }
    case 'steer': {
      const [target, ...words] = rest;
      const r = resolveSession(target, currentSessions(file));
      if (r.error) throw new Error(r.error);
      const note = queueSteer(dir, r.session.id, words.join(' '), { from: process.env.BRAIN_COMPANION_FROM || 'cli' });
      const reach = r.session.control ? 'it reads it at its next tool call' : `queued — this session does not run the companion hook yet. After ${process.env.LEANLAMP_CLI ? 'leanlamp init' : 'install-hooks'} it reads the note once it restarts; a note keeps 24 h`;
      say(`steer → ${r.session.title} (${r.session.id.slice(0, 8)}): ${reach}`, { ok: true, note, session: r.session.id, control: Boolean(r.session.control) });
      return;
    }
    case 'hold': {
      const raw = all ? '**' : rest[0];
      if (!raw) throw new Error('hold what? a glob like "src/billing/**", or --all');
      const root = all ? null : gitRoot(process.cwd()) || process.cwd();
      // relative to where you stand, like any path you type; a leading / means the repository root
      const here = root ? path.relative(root, process.cwd()).split(path.sep).join('/') : '';
      const glob = all || raw.startsWith('/') || !here || here.startsWith('..') ? raw.replace(/^\/+/, '') || '**' : `${here}/${raw}`;
      const wt = all ? null : worktreesOf(process.cwd());
      const hold = addHold(dir, { glob, root, repo: wt && wt.repo, roots: wt && wt.roots, minutes: parseMinutes(forOpt, 30), by: process.env.BRAIN_COMPANION_FROM || 'cli' });
      const others = wt ? wt.roots.filter((r) => path.resolve(r) !== path.resolve(root)).length : 0;
      const where = root ? `${glob} in ${path.basename(root)}${others ? ` and its ${others} other worktree${others === 1 ? '' : 's'}` : ''}` : 'every edit, every repo';
      say(`hold ${hold.id}: ${where}${hold.until ? ` until ${new Date(hold.until).toTimeString().slice(0, 5)}` : ' until released'} — edits wait up to 45 s for approve/deny, then Claude Code asks`, { ok: true, hold });
      return;
    }
    case 'release': {
      const n = releaseHolds(dir, all || !rest[0] ? 'all' : rest[0]);
      say(`released ${n} hold${n === 1 ? '' : 's'}`, { ok: true, released: n });
      return;
    }
    case 'approve':
    case 'deny': {
      const id = rest[0];
      if (!id) throw new Error(`${cmd} which edit? its id is on the WAITING line of ${process.env.LEANLAMP_CLI ? 'leanlamp status' : 'npm run brain:companion'}`);
      const waiting = readPending(dir);
      const exact = waiting.filter((p) => p.id === id);
      const hits = exact.length ? exact : waiting.filter((p) => p.id.startsWith(id));
      if (hits.length > 1) throw new Error(`"${id}" matches ${hits.length} held edits — use the full id`);
      const pending = hits[0];
      if (!pending) throw new Error(`nothing waits under ${id}`);
      decide(dir, pending.id, cmd === 'approve' ? 'allow' : 'deny', { reason: rest.slice(1).join(' '), by: process.env.BRAIN_COMPANION_FROM || 'cli' });
      say(`${cmd === 'approve' ? 'approved' : 'denied'}: ${pending.tool} ${pending.file}`, { ok: true, id: pending.id, decision: cmd === 'approve' ? 'allow' : 'deny' });
      return;
    }
    case 'receipt': {
      // takeOption gives '' for an absent option: only a given value is checked (the app and the hourly refresh pass none)
      if (daysOpt !== '' && !(Number.isInteger(Number(daysOpt)) && Number(daysOpt) > 0)) throw new Error(`--days takes a whole number of days, like 14 (got "${daysOpt}")`);
      const days = Number(daysOpt) || 14;
      const rec = computeReceipt({ roots: roots || discoverRoots({ env: process.env, processEnvDirs: [...new Set(configDirsOf(agentSessionRows(listProcesses()).map((r) => r.pid)).values())] }), days, events: readAllEvents(dir), windowFor: (cwd) => windowFor(cwd) });
      if (write) atomicWrite(receiptPath(dir), JSON.stringify(rec));
      process.stdout.write((json ? JSON.stringify(rec, null, 2) : renderReceipt(rec)) + '\n');
      return;
    }
    case 'reclaim': {
      // Only what is provably ours and dead: helpers whose agent is gone
      // (re-parented to PID 1) and their children. Sessions, docker stacks
      // and dev servers stay the user's call (brain:ps lists them).
      const orphans = findOrphans(listProcesses());
      const mb = Math.round(orphans.reduce((a, r) => a + (r.rssKb || 0), 0) / 1024);
      const done = [];
      for (const o of orphans) {
        if (dryRun) { done.push({ pid: o.pid, ok: true, dry: true }); continue; }
        try { process.kill(o.pid, 'SIGTERM'); done.push({ pid: o.pid, ok: true }); } catch (e) { done.push({ pid: o.pid, ok: false, error: e.code || e.message }); }
      }
      const n = done.filter((d) => d.ok).length;
      say(orphans.length ? `${dryRun ? 'would stop' : 'stopped'} ${n} orphaned helper${n === 1 ? '' : 's'} · ${mb} MB${dryRun ? '' : ' back'}` : 'nothing to reclaim: no orphaned helpers', { ok: true, stopped: dryRun ? 0 : n, mb, pids: done });
      if (!dryRun && n) appendEvent(dir, { kind: 'reclaimed', count: n, mb, by: process.env.BRAIN_COMPANION_FROM || 'cli' });
      return;
    }
    case 'check':
      checkSetup({ file, explicit: settingsOpt, roots }).then((r) => {
        process.stdout.write((json ? JSON.stringify(r) : renderCheck(r)) + '\n');
        process.exitCode = r.ok ? 0 : 1;
      }, (e) => { process.stderr.write(`${process.env.LEANLAMP_CLI ? "leanlamp:" : "[brain:companion]"} ${e.message}\n`); process.exitCode = 1; });
      return;
    case 'install-hooks':
    case 'uninstall-hooks':
      { const r = installHooks({ explicit: settingsOpt, dryRun, uninstall: cmd === 'uninstall-hooks', dir }); say(r.text, { ok: true, ...r }); }
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`${process.env.LEANLAMP_CLI ? 'leanlamp:' : '[brain:companion]'} ${error && error.message ? error.message : error}\n`);
    process.exit(1);
  }
}
