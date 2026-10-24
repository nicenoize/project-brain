/**
 * The companion's receipt: what the last N days cost and what the companion
 * did, from the user's own transcripts and the bus — nothing estimated.
 *
 *   TRIM     context per request (median, p90), the share of all input spent
 *            in requests above 500k, compactions and how many were prepared in
 *            advance, the wait for the others; per project, next to the
 *            compaction mark its settings set.
 *   GUARD    edits held, approved, declined, handed back to the terminal.
 *   STEER    notes delivered and how long they waited for a tool call.
 *
 * Streaming and frugal on purpose: 14 days are gigabytes of JSONL on a busy
 * machine, so lines are only parsed when they can carry usage or a
 * compaction, and no transcript is held in memory. Written to
 * <bus>/receipt.json by `brain:companion receipt --write`; the engine puts it
 * into the state and refreshes it hourly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createInjectionTracker, mergeInjectionSummaries } from './companion-injections.mjs';
import { repoName } from './repo-name.mjs';

export const RECEIPT_VERSION = 1;
const CHUNK = 8 * 1024 * 1024;

/** Call `fn(line)` for every line of a file, streamed. */
export function forEachLine(file, fn) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(CHUNK);
    let rest = '';
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      for (const line of parts) if (line) fn(line);
    }
    if (rest) fn(rest);
  } catch { /* unreadable: skipped */ } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A fresh accumulator for one scope (a project, or everything). */
export function emptyTrim() {
  return { requests: 0, contexts: [], inputTotal: 0, inputAbove500k: 0, compactions: 0, precomputed: 0, waitMs: 0, waited: 0, waits: [], sessions: 0 };
}

/**
 * A streaming fold over one transcript: feed it lines, then `finish()`.
 * Lines are only parsed when they can carry usage or a compaction. Sidechain
 * usage is skipped (subagents have their own contexts); streamed duplicates
 * of one request count once.
 */
export function createTrimFold({ sinceMs = 0, into = new Map(), projectOf = (cwd) => repoName(cwd) || 'unknown' } = {}) {
  const seen = new Set();
  let cwd = null;
  let counted = false;
  const tracker = createInjectionTracker({ keepLast: 0, sinceMs });
  const scope = () => {
    const key = projectOf(cwd);
    if (!into.has(key)) into.set(key, { ...emptyTrim(), cwd });
    return into.get(key);
  };
  function line(text) {
    const maybeInjection = text.includes('hook_additional_context');
    const usage = text.includes('"usage"');
    const boundary = !usage && text.includes('compact_boundary');
    if (!usage && !boundary && !maybeInjection) {
      if (!cwd) { const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (m) { try { cwd = JSON.parse(`"${m[1]}"`); } catch { /* odd escape */ } } }
      return;
    }
    let r;
    try { r = JSON.parse(text); } catch { return; }
    // the record type decides, not a word in the text: an assistant turn may quote "hook_additional_context"
    if (r && r.type === 'attachment') { tracker.record(r); return; }
    if (!usage && !boundary) return;
    if (r.cwd) cwd = r.cwd;
    tracker.record(r);
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (sinceMs && !(ts >= sinceMs)) return;
    if (boundary && r.type === 'system' && r.subtype === 'compact_boundary') {
      if (r.isSidechain) return; // a subagent's compaction: its own context, like its requests
      const m = r.compactMetadata || {};
      const s = scope();
      s.compactions += 1;
      if (m.precomputed) s.precomputed += 1;
      else if (Number.isFinite(m.durationMs)) { s.waitMs += m.durationMs; s.waited += 1; s.waits.push(m.durationMs); }
      counted = true;
      return;
    }
    if (r.type !== 'assistant' || r.isSidechain) return;
    const msg = r.message || {};
    const u = msg.usage;
    const key = r.requestId || msg.id;
    if (!u || !key || seen.has(key)) return;
    seen.add(key);
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const s = scope();
    s.requests += 1;
    s.contexts.push(ctx);
    s.inputTotal += ctx;
    if (ctx > 500_000) s.inputAbove500k += ctx;
    counted = true;
  }
  function finish() {
    const inj = tracker.summary();
    if (counted || inj.count) {
      const sc = scope();
      if (counted) sc.sessions += 1;
      if (inj.count) (sc.injections ||= []).push(inj);
    }
    return into;
  }
  return { line, finish };
}

/** The same fold over an array of lines (tests, small inputs). */
export function foldTranscript(lines, opts = {}) {
  const f = createTrimFold(opts);
  for (const l of lines) f.line(l);
  return f.finish();
}

const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Accumulator → the figures a receipt prints. PURE. */
export function summarizeTrim(acc) {
  const c = [...acc.contexts].sort((a, b) => a - b);
  return {
    sessions: acc.sessions,
    requests: acc.requests,
    contextP50: q(c, 0.5),
    contextP90: q(c, 0.9),
    contextMax: c.length ? c[c.length - 1] : 0,
    shareAbove500k: acc.inputTotal ? r3(acc.inputAbove500k / acc.inputTotal) : 0,
    compactions: acc.compactions,
    precomputedShare: acc.compactions ? r3(acc.precomputed / acc.compactions) : 0,
    avgWaitSeconds: acc.waited ? Math.round(acc.waitMs / acc.waited / 100) / 10 : null,
    // the median, what the receipt shows: one 10-minute compaction does not move it
    medianWaitSeconds: (acc.waits || []).length ? Math.round(q([...acc.waits].sort((a, b) => a - b), 0.5) / 100) / 10 : null
  };
}

export function mergeTrim(accs) {
  const out = emptyTrim();
  for (const a of accs) {
    out.requests += a.requests; out.inputTotal += a.inputTotal; out.inputAbove500k += a.inputAbove500k;
    out.compactions += a.compactions; out.precomputed += a.precomputed; out.waitMs += a.waitMs; out.waited += a.waited;
    out.sessions += a.sessions;
    for (const x of a.contexts) out.contexts.push(x);
    for (const x of a.waits || []) out.waits.push(x);
  }
  return out;
}

/** GUARD and STEER from bus events. PURE. */
export function summarizeBus(events, { sinceMs = 0 } = {}) {
  const ev = events.filter((e) => e && (!sinceMs || e.at >= sinceMs));
  const count = (k, f = () => true) => ev.filter((e) => e.kind === k && f(e)).length;
  const waits = ev.filter((e) => e.kind === 'steer-delivered' && e.queuedAt).map((e) => e.at - e.queuedAt).sort((a, b) => a - b);
  return {
    guard: {
      held: count('held'),
      approved: count('approved'),
      approvedFromNotch: count('approved', (e) => e.by === 'app'),
      denied: count('denied'),
      handedBack: count('held-ask')
    },
    steer: {
      delivered: count('steer-delivered'),
      medianWaitSeconds: waits.length ? Math.round(q(waits, 0.5) / 100) / 10 : null
    }
  };
}

/** Transcripts (main and subagent) touched since `sinceMs`. */
export function transcriptsSince(roots, sinceMs) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* raced */ }
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * The whole receipt. `windowFor(cwd)` names each project's compaction mark
 * (injected so this module stays free of settings logic).
 */
export function computeReceipt({ roots, days = 14, now = Date.now(), events = [], windowFor = () => null }) {
  const sinceMs = now - days * 86_400_000;
  const t0 = Date.now();
  const byProject = new Map();
  const files = transcriptsSince(roots, sinceMs);
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(f).size; } catch { /* raced */ }
    const fold = createTrimFold({ sinceMs, into: byProject });
    forEachLine(f, fold.line);
    fold.finish();
  }
  const projects = [...byProject.entries()]
    .map(([name, acc]) => {
      const w = acc.cwd ? windowFor(acc.cwd) : null;
      const inj = mergeInjectionSummaries(acc.injections || []);
      const brain = inj.bySource.brain || null;
      const hint = inj.byKind.hint || null;
      return { project: name, cwd: acc.cwd || null, window: w ? w.limit : null, windowSource: w ? w.source : null, ...summarizeTrim(acc), injections: { count: inj.count, estTokens: inj.estTokens, brain: brain ? { count: brain.count, estTokens: brain.estTokens, actionable: brain.actionable, followed: brain.followed } : null, hints: hint ? { count: hint.count, estTokens: hint.estTokens, actionable: hint.actionable, followed: hint.followed } : null } };
    })
    .filter((p) => p.requests > 0 || p.injections.count > 0)
    .sort((a, b) => b.requests - a.requests);
  return {
    v: RECEIPT_VERSION,
    at: new Date(now).toISOString(),
    atMs: now,
    days,
    sinceMs,
    source: { transcripts: files.length, bytes, ms: Date.now() - t0 },
    trim: summarizeTrim(mergeTrim([...byProject.values()])),
    got: (() => { const m = mergeInjectionSummaries([...byProject.values()].flatMap((a) => a.injections || [])); delete m.last; return m; })(),
    projects,
    ...summarizeBus(events, { sinceMs })
  };
}

export function receiptPath(dir) { return path.join(dir, 'receipt.json'); }

export function readReceipt(dir) {
  try { return JSON.parse(fs.readFileSync(receiptPath(dir), 'utf8')); } catch { return null; }
}
