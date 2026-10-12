#!/usr/bin/env node
/**
 * brain:tokens — where do this project's agent tokens actually go?
 *
 * Phase 0 of the context-efficiency wave (docs/roadmap-next.md). Before
 * installing a compression proxy (Headroom & co.) or reshaping our own MCP
 * payloads, measure. Reads the Claude Code session transcripts for this
 * project — read-only, no network, no LLM — and reports:
 *
 *   - per-request usage, deduplicated: one API response is written as several
 *     assistant records (one per content block) that all repeat the SAME usage
 *     object. Summing records instead of requests double-counts by 2-4×.
 *   - fresh input (input + cache writes) vs cache reads vs output, and the
 *     cache-hit ratio — a compressor only pays where tokens are fresh or resent.
 *   - tool-output volume per tool, classified json / log / html / code / prose.
 *     json, log and html are what compression proxies shrink by 70-90 %;
 *     code and prose barely move. Their share of tool output is the honest
 *     upper bound on what such a proxy could save here.
 *
 * Tool output is measured in characters and converted at ~4 chars/token —
 * an estimate, labelled as one. Usage numbers are exact (from the API).
 *
 *   npm run brain:tokens -- [--days 7] [--all-projects] [--root DIR] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main.mjs';
import { ROOT, takeFlag, takeOption, unknownFlags } from './common.mjs';

const CHARS_PER_TOKEN = 4;
export const KINDS = ['json', 'log', 'search', 'html', 'diff', 'code', 'prose'];
/**
 * Content kinds that compression proxies shrink substantially (Headroom's own
 * table: code search 92 %, logs 92 %, JSON 73 %+). Code and diffs compress
 * far less and prose barely — they stay out of the upper bound on purpose.
 */
export const COMPRESSIBLE = new Set(['json', 'log', 'search', 'html']);

// --- pure core ---------------------------------------------------------------

/** Claude Code's project directory name for a cwd: every non-alphanumeric → '-'. */
export function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Timestamps, levels, stack frames, and test-runner lines (node:test, jest,
// vitest, pytest, TAP) — the bulk of what a Bash call returns while working.
const LOG_LINE = /^\s*(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2}|\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|npm (WARN|ERR)|at .+:\d+:\d+\)?$|[✓✔✗✖✘○●▶ℹ√×]\s|(not )?ok \d+ |PASS |FAIL |# (tests|pass|fail|suites)\b|\S+\.py::\S+ (PASSED|FAILED))/;
// grep -n / rg output: `path/file.ext:line:` or `…-line-` (context lines).
// The extension is required so ISO timestamps (`2026-10-12T10:00:`) stay logs.
const SEARCH_LINE = /^(?:[\w@.~-]+\/)*[\w@~-][\w@.~-]*\.\w+[:-]\d+[:-]/;
const DIFF_LINE = /^(diff --git |index [0-9a-f]+\.\.|@@ .* @@|\+\+\+ |--- |[+-](?![+-]))/;
// Read's line-number gutter ("    12\t" / "12→") is stripped before shape tests.
const GUTTER = /^\s*\d+[\t→]/;
const CODE_MARK = /[(){};=<>[\]]|=>|^\s*(\/\/|\/\*|\*|--|#)\s|^\s{2,}\S/;

/**
 * Classify one tool output. Deterministic heuristics, ordered by how cheaply
 * each is confirmed: parseable JSON, HTML tags, then line shapes. Code is
 * recognised by punctuation and indentation density rather than keywords,
 * because keyword lists miss SQL, YAML, JSX and test bodies alike.
 */
export function classifyContent(text) {
  const t = String(text || '').trim();
  if (!t) return 'prose';
  if ((t[0] === '{' || t[0] === '[') && (t.endsWith('}') || t.endsWith(']'))) {
    try { JSON.parse(t); return 'json'; } catch { /* fall through to line shapes */ }
  }
  if (/<(html|body|div|span|head|script|table|p)[\s>]/i.test(t.slice(0, 4000))) return 'html';
  const lines = t.split('\n').filter((l) => l.trim()).map((l) => l.replace(GUTTER, ''));
  if (!lines.length) return 'prose';
  const share = (re) => lines.filter((l) => re.test(l)).length / lines.length;
  if (share(SEARCH_LINE) >= 0.5) return 'search';
  if (share(DIFF_LINE) >= 0.5 && /^(diff --git|@@|--- )/m.test(t)) return 'diff';
  if (share(LOG_LINE) >= 0.3) return 'log';
  // Truncated or pretty-printed JSON: many `"key":` lines. Bracket-led lines
  // alone are not evidence — JS/TS bodies are full of them.
  if (share(/^\s*"[^"]*"\s*:/) >= 0.4) return 'json';
  if (share(CODE_MARK) >= 0.5) return 'code';
  return 'prose';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === 'text' ? c.text || '' : '')).join('\n');
  }
  return '';
}

/** Fresh accumulator; `addTranscript` folds sessions into it. */
export function emptyReport() {
  return {
    sessions: 0,
    requests: 0,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    tools: {}, // name → { calls, chars, kinds: { json: chars, … } }
    contexts: [], // total input tokens of each request — the context size it paid for
    // What each request RE-READ, by kind: the live tool output (and the rest)
    // since the last compaction, summed per request. Tool output enters the
    // context once but rides along on every later request, so this — not the
    // once-counted volume — is what a compression proxy acts on.
    reread: {},
    // Loss guards (ADR 0035): what compaction and compression may cost.
    loss: { compactions: 0, droppedTokens: 0, rereadCalls: 0, rereadChars: 0 },
    edits: { total: 0, failed: 0, reasons: {} },
    firstTs: null,
    lastTs: null
  };
}

// A file read through the shell: cat / head / tail / nl / bat / sed -n '…p' FILE.
// 87 % of tool output in a real repo came from Bash, much of it exactly this.
const SHELL_READ = /(?:^|[;&|]\s*)(?:cat|head|tail|nl|bat|less|sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+))\s+(?:-[\w-]+(?:\s+\d+)?\s+)*['"]?([\w@~./-]+\.\w+)/;
export const REREAD_WINDOW_CALLS = 50;

/** The file a tool call reads, or null. PURE. */
export function readTarget(name, input = {}) {
  if (name === 'Read') return input.file_path || null;
  if (name === 'Bash' && typeof input.command === 'string') {
    const m = input.command.split('\n')[0].match(SHELL_READ);
    return m ? m[1] : null;
  }
  return null;
}

/** Why an edit failed, from its error text. PURE. */
export function editFailureReason(text) {
  const t = String(text || '');
  if (/classifier|permission|denied|doesn't want to proceed|user rejected|should return findings as text/i.test(t)) return 'blocked';
  if (/InputValidationError|required parameter|unexpected parameter/i.test(t)) return 'invalid-input';
  if (/string to replace not found|old_string.*not found|not found in file/i.test(t)) return 'no-match';
  if (/has not been read|read it first|must read/i.test(t)) return 'not-read';
  if (/modified since|has been modified|changed since/i.test(t)) return 'stale';
  if (/found \d+ matches|multiple|more than one|not unique/i.test(t)) return 'ambiguous';
  return 'other';
}

/** Failures that point at a stale or compressed view of the file — the ones compression could cause. */
export const CONTENT_FAILURES = Object.freeze(['no-match', 'stale', 'not-read', 'ambiguous']);

/**
 * Loss guards, folded per transcript. Reads are tracked from the session's
 * start so "read before the compaction" is known even when the compaction
 * itself falls inside the --days window and the first read does not.
 *  - re-reads: in the REREAD_WINDOW_CALLS tool calls after a compaction,
 *    reads of a file that was already read before it — what the compaction
 *    made the agent fetch again, against what it dropped.
 *  - failed edits: Edit/Write calls answered with an error, by reason —
 *    "no-match" is what a stale or compressed view of a file produces.
 */
export function foldLoss(report, records, { sinceMs = 0 } = {}) {
  const read = new Set();
  let known = null; // files read before the open compaction window
  let left = 0;
  const pendingReread = new Set();
  const pendingEdit = new Set();
  for (const r of records) {
    if (!r) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    const inWindow = !sinceMs || ts >= sinceMs;
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      if (!inWindow) continue;
      const m = r.compactMetadata || {};
      report.loss.compactions += 1;
      report.loss.droppedTokens += Math.max(0, (m.preTokens || 0) - (m.postTokens || 0));
      known = new Set(read);
      left = REREAD_WINDOW_CALLS;
      continue;
    }
    const content = r.message && r.message.content;
    if (!Array.isArray(content)) continue;
    if (r.type === 'assistant') {
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        if (left > 0) left -= 1; else known = null;
        const target = readTarget(c.name, c.input || {});
        if (target) {
          if (known && known.has(target)) pendingReread.add(c.id);
          read.add(target);
        }
        if (inWindow && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(c.name)) pendingEdit.add(c.id);
      }
    } else if (r.type === 'user') {
      for (const c of content) {
        if (!c || c.type !== 'tool_result') continue;
        if (pendingReread.delete(c.tool_use_id)) {
          report.loss.rereadCalls += 1;
          report.loss.rereadChars += resultText(c.content).length;
        }
        if (pendingEdit.delete(c.tool_use_id)) {
          report.edits.total += 1;
          if (c.is_error) {
            report.edits.failed += 1;
            const why = editFailureReason(resultText(c.content));
            report.edits.reasons[why] = (report.edits.reasons[why] || 0) + 1;
          }
        }
      }
    }
  }
  return report;
}

/**
 * Fold one transcript (array of parsed JSONL records) into `report`.
 * Records older than `sinceMs` are ignored.
 */
export function addTranscript(report, records, { sinceMs = 0 } = {}) {
  foldLoss(report, records, { sinceMs });
  const seenRequests = new Set();
  const toolNames = new Map(); // tool_use_id → tool name
  const live = {}; // kind → chars in the live context
  let counted = false;
  for (const r of records) {
    if (r && r.type === 'system' && r.subtype === 'compact_boundary') { for (const k in live) live[k] = 0; continue; }
    const ts = r && r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (sinceMs && !(ts >= sinceMs)) continue;
    const msg = r && r.message;
    if (!msg) continue;
    if (r.type === 'assistant') {
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c && c.type === 'tool_use') {
          toolNames.set(c.id, c.name);
          live.other = (live.other || 0) + JSON.stringify(c.input || {}).length;
        } else if (c && c.type === 'text') live.other = (live.other || 0) + (c.text || '').length;
      }
      const key = r.requestId || msg.id;
      const u = msg.usage;
      if (u && key && !seenRequests.has(key)) {
        seenRequests.add(key);
        report.requests += 1;
        report.usage.input += u.input_tokens || 0;
        report.usage.cacheWrite += u.cache_creation_input_tokens || 0;
        report.usage.cacheRead += u.cache_read_input_tokens || 0;
        report.usage.output += u.output_tokens || 0;
        report.contexts.push((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
        report.reread ||= {};
        for (const k in live) report.reread[k] = (report.reread[k] || 0) + live[k];
        counted = true;
      }
    } else if (r.type === 'user' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (!c || c.type !== 'tool_result') continue;
        const text = resultText(c.content);
        const name = toolNames.get(c.tool_use_id) || 'unknown';
        const kind = classifyContent(text);
        const slot = report.tools[name] || (report.tools[name] = { calls: 0, chars: 0, kinds: {} });
        slot.calls += 1;
        slot.chars += text.length;
        slot.kinds[kind] = (slot.kinds[kind] || 0) + text.length;
        live[kind] = (live[kind] || 0) + text.length;
        counted = true;
      }
    }
    if (counted && Number.isFinite(ts)) {
      if (!report.firstTs || ts < report.firstTs) report.firstTs = ts;
      if (!report.lastTs || ts > report.lastTs) report.lastTs = ts;
    }
  }
  if (counted) report.sessions += 1;
  return report;
}

/** Derived figures: totals, cache-hit ratio, compressible share, top tools. */
export function summarize(report) {
  const u = report.usage;
  const fresh = u.input + u.cacheWrite;
  const totalIn = fresh + u.cacheRead;
  const kindChars = Object.fromEntries(KINDS.map((k) => [k, 0]));
  let toolChars = 0;
  for (const t of Object.values(report.tools)) {
    toolChars += t.chars;
    for (const [k, v] of Object.entries(t.kinds)) kindChars[k] = (kindChars[k] || 0) + v;
  }
  const compressibleChars = [...COMPRESSIBLE].reduce((s, k) => s + (kindChars[k] || 0), 0);
  const tools = Object.entries(report.tools)
    .map(([name, t]) => ({
      name,
      calls: t.calls,
      estTokens: Math.round(t.chars / CHARS_PER_TOKEN),
      compressibleShare: t.chars ? round([...COMPRESSIBLE].reduce((s, k) => s + (t.kinds[k] || 0), 0) / t.chars) : 0,
      dominantKind: Object.entries(t.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] || 'prose'
    }))
    .sort((a, b) => b.estTokens - a.estTokens);
  const ctx = [...report.contexts].sort((a, b) => a - b);
  const q = (p) => (ctx.length ? ctx[Math.min(ctx.length - 1, Math.floor(p * ctx.length))] : 0);
  const ctxSum = ctx.reduce((a, b) => a + b, 0);
  const above = (n) => (ctxSum ? round(ctx.filter((c) => c > n).reduce((a, b) => a + b, 0) / ctxSum) : 0);
  return {
    sessions: report.sessions,
    requests: report.requests,
    window: { from: iso(report.firstTs), to: iso(report.lastTs) },
    usage: { ...u, freshInput: fresh, totalInput: totalIn },
    cacheHitRatio: totalIn ? round(u.cacheRead / totalIn) : 0,
    context: {
      p50: q(0.5), p90: q(0.9), max: ctx.length ? ctx[ctx.length - 1] : 0,
      // Share of ALL input tokens spent in requests whose context exceeded the mark.
      inputShareAbove200k: above(200_000),
      inputShareAbove500k: above(500_000)
    },
    toolOutput: {
      estTokens: Math.round(toolChars / CHARS_PER_TOKEN),
      byKind: Object.fromEntries(KINDS.map((k) => [k, Math.round((kindChars[k] || 0) / CHARS_PER_TOKEN)])),
      compressibleShare: toolChars ? round(compressibleChars / toolChars) : 0
    },
    tools,
    loss: (() => {
      const l = report.loss || { compactions: 0, droppedTokens: 0, rereadCalls: 0, rereadChars: 0 };
      const rereadTokens = Math.round(l.rereadChars / CHARS_PER_TOKEN);
      return {
        compactions: l.compactions,
        droppedTokens: l.droppedTokens,
        rereadCalls: l.rereadCalls,
        rereadTokens,
        rereadPerCompaction: l.compactions ? Math.round(rereadTokens / l.compactions) : 0,
        // Re-read tokens enter once; the dropped tokens are saved on EVERY later
        // request. This ratio is therefore the strict side of ADR 0035's ⅓ line.
        rereadVsDropped: l.droppedTokens ? round(rereadTokens / l.droppedTokens) : 0
      };
    })(),
    edits: (() => {
      const e = report.edits || { total: 0, failed: 0, reasons: {} };
      const content = CONTENT_FAILURES.reduce((a, k) => a + (e.reasons[k] || 0), 0);
      return {
        total: e.total,
        failed: e.failed,
        failRate: e.total ? round(e.failed / e.total) : 0,
        contentFailed: content,
        contentFailRate: e.total ? round(content / e.total) : 0,
        reasons: e.reasons
      };
    })(),
    reread: (() => {
      const rr = report.reread || {};
      const tot = Object.values(rr).reduce((a, b) => a + b, 0);
      return Object.fromEntries([...KINDS, 'other'].map((k) => [k, tot ? round((rr[k] || 0) / tot) : 0]));
    })()
  };
}

/**
 * H1 (docs/roadmap-next.md): what would a compression proxy (Headroom & co.)
 * cut HERE? Measured on what requests RE-READ, by kind — tool output rides
 * along on every request after it arrives. Ratios from Headroom's own
 * benchmarks: json/log/search/html ≈ 85 %; prose ≈ 30 %; code is the open
 * question (0–50 %): an agent EDITS code it read, and a compressed view risks
 * edits that do not match the file. So the answer is a range, and the
 * recommendation is an A/B, not a switch. PURE.
 *
 * (The first version compared once-counted tool output with fresh input —
 * mostly cache rewrites — and called the fleet "not worth it". Re-read-
 * weighted, the same fleet is ≈ 9–26 %.)
 */
export function proxyVerdict(s) {
  const r = s.reread || {};
  const comp = (r.json || 0) + (r.log || 0) + (r.search || 0) + (r.html || 0);
  const low = comp * 0.85 + (r.prose || 0) * 0.2;
  const high = comp * 0.85 + (r.prose || 0) * 0.4 + (r.code || 0) * 0.5;
  const worth = high >= 0.15;
  const pct = (x) => `${Math.round(x * 100)}%`;
  return {
    worth,
    low: round(low),
    high: round(high),
    text: `a compression proxy would cut re-read input by ≈ ${pct(low)}–${pct(high)} here (${pct(comp)} json/log/search/html, ${pct(r.code || 0)} code, ${pct(r.prose || 0)} prose of what requests re-read)` +
      (worth ? ' — worth an A/B with brain:tokens before/after; watch for edits that miss after compressed reads.' : ' — not worth it; context length is the lever.')
  };
}

function round(x) { return Math.round(x * 1000) / 1000; }
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }

// --- I/O ---------------------------------------------------------------------

export function transcriptsRoot(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** All *.jsonl under `dir`, including subagent transcripts in nested folders. */
export function listTranscripts(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function readJsonl(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line is normal while a session writes */ }
  }
  return out;
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
const pct = (x) => (x * 100).toFixed(1) + '%';

export function renderText(s, { scope }) {
  const L = [];
  L.push(`brain:tokens — ${scope}`);
  L.push(`  ${s.sessions} transcripts · ${s.requests} API requests · ${s.window.from?.slice(0, 10) || '—'} → ${s.window.to?.slice(0, 10) || '—'}`);
  L.push('');
  L.push('Usage (exact, deduplicated per request)');
  L.push(`  fresh input   ${fmt(s.usage.freshInput).padStart(8)}  (input ${fmt(s.usage.input)} + cache writes ${fmt(s.usage.cacheWrite)})`);
  L.push(`  cache reads   ${fmt(s.usage.cacheRead).padStart(8)}  → cache-hit ratio ${pct(s.cacheHitRatio)}`);
  L.push(`  output        ${fmt(s.usage.output).padStart(8)}`);
  L.push('');
  L.push(`Context per request: p50 ${fmt(s.context.p50)} · p90 ${fmt(s.context.p90)} · max ${fmt(s.context.max)}`);
  L.push(`  input spent in requests > 200k context: ${pct(s.context.inputShareAbove200k)} · > 500k: ${pct(s.context.inputShareAbove500k)}`);
  L.push('');
  L.push(`Tool output (estimated, ~${CHARS_PER_TOKEN} chars/token): ${fmt(s.toolOutput.estTokens)}`);
  L.push('  ' + KINDS.map((k) => `${k} ${fmt(s.toolOutput.byKind[k])}`).join(' · '));
  L.push(`  compressible (${[...COMPRESSIBLE].join('+')}): ${pct(s.toolOutput.compressibleShare)} of tool output`);
  L.push('');
  L.push('Top tools by output');
  for (const t of s.tools.slice(0, 10)) {
    L.push(`  ${t.name.padEnd(34).slice(0, 34)} ${fmt(t.estTokens).padStart(7)}  ${String(t.calls).padStart(5)} calls  ${t.dominantKind.padEnd(5)} compressible ${pct(t.compressibleShare)}`);
  }
  L.push('');
  L.push('Loss guards');
  const lo = s.loss;
  L.push(lo.compactions
    ? `  compactions ${lo.compactions} · dropped ${fmt(lo.droppedTokens)} · re-read after them ${fmt(lo.rereadTokens)} in ${lo.rereadCalls} calls (${fmt(lo.rereadPerCompaction)} per compaction) = ${pct(lo.rereadVsDropped)} of what they dropped — kill line 33%`
    : '  compactions 0 — nothing to judge yet');
  const ed = s.edits;
  const why = Object.entries(ed.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  L.push(`  edits ${ed.total} · failed on the file's content ${ed.contentFailed} (${pct(ed.contentFailRate)}) — the rate compression could raise · all failures ${ed.failed}${why ? ` (${why})` : ''}`);
  L.push('');
  L.push(`Verdict: ${proxyVerdict(s).text}`);
  L.push('');
  L.push('Read: tool output enters context once fresh, then rides along as cache reads.');
  L.push('A proxy saves at most the compressible share of it. Every request re-reads the');
  L.push('whole context, so long sessions multiply everything — context length is usually');
  L.push('the bigger lever than packing: compact, hand off, or split into subagents.');
  return L.join('\n');
}

function main(argv) {
  const args = [...argv];
  const json = takeFlag(args, '--json');
  const all = takeFlag(args, '--all-projects');
  const days = Number(takeOption(args, '--days') || 7);
  const root = takeOption(args, '--root') || transcriptsRoot();
  const bad = unknownFlags(args, []);
  if (bad.length || !(days > 0)) {
    process.stderr.write('Usage: npm run brain:tokens -- [--days 7] [--all-projects] [--root DIR] [--json]\n');
    process.exit(1);
  }
  const dir = all ? root : path.join(root, projectSlug(ROOT));
  const files = listTranscripts(dir);
  const sinceMs = Date.now() - days * 86400_000;
  const report = emptyReport();
  for (const f of files) {
    try { if (fs.statSync(f).mtimeMs < sinceMs) continue; } catch { continue; }
    addTranscript(report, readJsonl(f), { sinceMs });
  }
  const s = summarize(report);
  const scope = `${all ? 'all projects' : path.basename(ROOT)} · last ${days} d`;
  if (json) process.stdout.write(JSON.stringify({ scope, ...s }, null, 2) + '\n');
  else process.stdout.write(renderText(s, { scope }) + '\n');
  if (!files.length) process.stderr.write(`[brain:tokens] no transcripts under ${dir}\n`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
