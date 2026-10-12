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
    firstTs: null,
    lastTs: null
  };
}

/**
 * Fold one transcript (array of parsed JSONL records) into `report`.
 * Records older than `sinceMs` are ignored.
 */
export function addTranscript(report, records, { sinceMs = 0 } = {}) {
  const seenRequests = new Set();
  const toolNames = new Map(); // tool_use_id → tool name
  let counted = false;
  for (const r of records) {
    const ts = r && r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (sinceMs && !(ts >= sinceMs)) continue;
    const msg = r && r.message;
    if (!msg) continue;
    if (r.type === 'assistant') {
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c && c.type === 'tool_use') toolNames.set(c.id, c.name);
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
    tools
  };
}

/**
 * H1 (docs/roadmap-next.md): is a compression proxy (Headroom & co.) worth it
 * HERE? Only when tool output is a real share of fresh input AND most of it
 * is the json/log/search/html such proxies shrink. Measured across all
 * projects it was 11 % and 17 % — not worth it; a log-heavy repo may differ.
 * PURE.
 */
export function proxyVerdict(s) {
  const fresh = s.usage.freshInput || 0;
  const toolShare = fresh ? s.toolOutput.estTokens / fresh : 0;
  const comp = s.toolOutput.compressibleShare;
  const worth = toolShare >= 0.2 && comp >= 0.4;
  return {
    worth,
    toolShare: round(toolShare),
    compressibleShare: comp,
    text: worth
      ? `a compression proxy would pay here: tool output is ${(toolShare * 100).toFixed(0)}% of fresh input and ${(comp * 100).toFixed(0)}% of it is json/log/search/html (see settings.community-plugins.json for Headroom).`
      : `a compression proxy would not pay here: tool output is ${(toolShare * 100).toFixed(0)}% of fresh input, ${(comp * 100).toFixed(0)}% of it compressible — context length is the lever.`
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
