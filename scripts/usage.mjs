/**
 * Usage ledger (issue #32) — the QUANTITY/footprint instrument.
 *
 * Every `brain:*` invocation appends one JSONL line to
 * `.project-brain/.usage.jsonl`:
 *   { cmd, ts, exitCode, stdoutBytes, durationMs }
 *
 * This is deliberately distinct from #28's friction/quality events: the ledger
 * answers "how often is each command run, and how big is its output?" — the
 * denominator for before/after footprint claims (see docs/eval-methodology.md
 * consumer-baseline section). It never records relevance or correctness.
 *
 * This module holds the PURE, unit-testable logic (derive a command name,
 * build a record, parse the log, aggregate a window). The I/O + process
 * instrumentation (the single choke point) lives in common.mjs so every command
 * that routes through it is logged with zero per-script wiring.
 */
import path from 'node:path';

/** Derive a brain command name from a script path (brain-session-digest.mjs → "session-digest"). PURE. */
export function usageCmdFromScript(scriptPath) {
  if (!scriptPath) return '';
  const base = path.basename(String(scriptPath));
  const m = base.match(/^brain-([a-z0-9-]+)\.mjs$/i);
  return m ? m[1].toLowerCase() : '';
}

/** Build one usage-ledger record with coerced, defaulted fields. PURE. */
export function buildUsageRecord({ cmd, ts, exitCode, stdoutBytes, durationMs } = {}) {
  return {
    cmd: String(cmd || ''),
    ts: ts || new Date().toISOString(),
    exitCode: Number.isFinite(exitCode) ? exitCode : (Number.isFinite(Number(exitCode)) ? Number(exitCode) : 0),
    stdoutBytes: Number.isFinite(stdoutBytes) && stdoutBytes >= 0 ? Math.round(stdoutBytes) : 0,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0
  };
}

/** Parse a `.usage.jsonl` blob into records, skipping blank/malformed lines. PURE. */
export function parseUsageLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object' && rec.cmd) out.push(rec);
    } catch {
      // malformed line (e.g. a partial write) — skip, never throw
    }
  }
  return out;
}

/**
 * The universe of loggable brain commands, derived from the `brain:*` scripts in
 * package.json that dispatch a `brain-*.mjs` entry point. Deduped + sorted so the
 * "never used" list is stable. PURE. (brain:symbol → brain-search.mjs → "search",
 * so aliases collapse onto the single command they actually run.)
 */
export function commandUniverseFromPackageScripts(scripts = {}) {
  const set = new Set();
  for (const [key, value] of Object.entries(scripts || {})) {
    if (!key.startsWith('brain:')) continue;
    const m = String(value).match(/brain-([a-z0-9-]+)\.mjs/i);
    if (m) set.add(m[1].toLowerCase());
  }
  return [...set].sort();
}

/**
 * Aggregate usage records over a trailing window. PURE.
 *
 * @param {Array} records  parsed ledger records
 * @param {object} opts
 *   - now: reference time (ms or ISO); defaults to Date.now()
 *   - windowDays: trailing window in days (default 30)
 *   - commands: full command universe → drives the never-used list
 * @returns {{
 *   windowDays, totalInWindow, totalAllTime, perCommand:Array, neverUsed:Array, universeSize:number
 * }}
 */
export function summarizeUsage(records = [], opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : 30;
  const nowMs = opts.now == null ? Date.now() : (typeof opts.now === 'number' ? opts.now : Date.parse(opts.now));
  const cutoff = nowMs - windowDays * 86400000;
  const universe = Array.isArray(opts.commands) ? [...new Set(opts.commands.filter(Boolean))].sort() : null;

  const stats = new Map();
  let totalInWindow = 0;
  let totalAllTime = 0;

  for (const r of records) {
    if (!r || typeof r !== 'object' || !r.cmd) continue;
    totalAllTime++;
    const t = Date.parse(r.ts);
    // Undated records count as "in window" — a missing ts should never hide usage.
    const inWindow = Number.isFinite(t) ? t >= cutoff : true;
    if (!inWindow) continue;
    totalInWindow++;
    let s = stats.get(r.cmd);
    if (!s) {
      s = { cmd: r.cmd, count: 0, errors: 0, lastTs: null, totalStdoutBytes: 0, totalDurationMs: 0 };
      stats.set(r.cmd, s);
    }
    s.count++;
    if (Number(r.exitCode) !== 0) s.errors++;
    if (Number.isFinite(r.stdoutBytes)) s.totalStdoutBytes += r.stdoutBytes;
    if (Number.isFinite(r.durationMs)) s.totalDurationMs += r.durationMs;
    if (r.ts && (!s.lastTs || r.ts > s.lastTs)) s.lastTs = r.ts;
  }

  const perCommand = [...stats.values()]
    .map((s) => ({
      ...s,
      avgStdoutBytes: s.count ? Math.round(s.totalStdoutBytes / s.count) : 0,
      avgDurationMs: s.count ? Math.round(s.totalDurationMs / s.count) : 0
    }))
    .sort((a, b) => b.count - a.count || a.cmd.localeCompare(b.cmd));

  const used = new Set(stats.keys());
  const neverUsed = universe ? universe.filter((c) => !used.has(c)) : [];

  return {
    windowDays,
    totalInWindow,
    totalAllTime,
    perCommand,
    neverUsed,
    universeSize: universe ? universe.length : perCommand.length
  };
}
