#!/usr/bin/env node
/**
 * brain:recall — the COLD layer of a session's context (K6, docs/roadmap-next.md).
 *
 * After a compaction, everything that was dropped is still in the session's
 * transcript on disk. This finds it again on demand — the agent asks for the
 * detail it needs instead of carrying every old tool result in every request.
 *
 *   npm run brain:recall -- "<terms>" [--session <id>] [--limit 5] [--json]
 *   MCP: brain_recall { query, session?, limit? }
 *
 * Search, not retrieval-by-embedding: all query terms must occur in a record
 * (case-insensitive); hits rank by how many terms appear, then by recency.
 * Each hit is an excerpt around the first match, labelled with the call
 * number, the tool, and whether it lies before a compaction — so the agent
 * can tell "what I read at call 312, since compacted" from "what I just did".
 *
 * Scope is deliberately narrow: transcripts of THIS project only (Claude
 * Code's per-project directory), read-only, streamed line by line so a
 * 250 MB transcript never sits in memory. Nothing is indexed or copied.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isMainModule } from './is-main.mjs';
import { ROOT, takeFlag, takeOption, unknownFlags } from './common.mjs';
import { projectSlug, transcriptsRoot, listTranscripts } from './brain-tokens.mjs';

export const RECALL_CAP = Object.freeze({ limitDefault: 5, limitMax: 15, excerptChars: 700, totalBytes: 7000 });

// --- pure core ---------------------------------------------------------------

/** Query → lowercase terms; quoted phrases stay whole. */
export function parseQuery(q) {
  const terms = [];
  String(q || '').replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => {
    const t = (phrase || word || '').toLowerCase().trim();
    if (t.length >= 2) terms.push(t);
    return '';
  });
  return [...new Set(terms)];
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.type === 'text' ? c.text || '' : '')).join('\n');
  return '';
}

/** A tool call as a human would write it: the command, the path and its new text. */
export function callText(name, input) {
  if (typeof input.command === 'string') return input.command;
  const p = input.file_path || input.notebook_path || input.path;
  const body = input.new_string ?? input.content ?? input.new_source ?? input.pattern ?? input.query ?? input.url;
  if (p || body) return [p, body].filter((x) => typeof x === 'string' && x).join('\n');
  return JSON.stringify(input);
}

/**
 * The searchable pieces of one transcript record: [{ kind, tool, text }].
 * Tool calls are searched by their input (command, path, pattern); results
 * by their output. Thinking and metadata records are skipped.
 */
export function recordPieces(r, toolNames) {
  const out = [];
  const content = r && r.message && r.message.content;
  if (r.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text' && b.text) out.push({ kind: 'agent', tool: null, text: b.text });
      if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        const text = callText(b.name, b.input || {});
        // A recall must not find itself (or earlier recalls) as the top hit.
        if (/brain[-:_]recall/.test(text) || /brain_recall$/.test(b.name || '')) { toolNames.set(b.id, '(recall)'); continue; }
        out.push({ kind: 'call', tool: b.name, text });
      }
    }
  } else if (r.type === 'user' && !r.isCompactSummary) {
    if (typeof content === 'string') out.push({ kind: 'user', tool: null, text: content });
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_result') {
          const tool = toolNames.get(b.tool_use_id) || null;
          if (tool !== '(recall)') out.push({ kind: 'result', tool, text: textOf(b.content) });
        }
        else if (b.type === 'text' && b.text) out.push({ kind: 'user', tool: null, text: b.text });
      }
    }
  }
  return out;
}

/** Excerpt of `text` around the first occurrence of any term. */
export function excerpt(text, terms, chars = RECALL_CAP.excerptChars) {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - Math.floor(chars / 3));
  const end = Math.min(text.length, start + chars);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * Fold-style matcher so the I/O layer can stream: feed records in order,
 * then `results()` returns the ranked, budgeted hits.
 */
export function createMatcher(query, { limit = RECALL_CAP.limitDefault } = {}) {
  const terms = parseQuery(query);
  const toolNames = new Map();
  const hits = [];
  let call = 0;
  let compaction = 0;
  return {
    terms,
    feed(r) {
      if (!r || typeof r !== 'object') return;
      if (r.type === 'system' && r.subtype === 'compact_boundary') { compaction += 1; return; }
      for (const p of recordPieces(r, toolNames)) {
        if (p.kind === 'call') call += 1;
        if (!terms.length || !p.text) continue;
        const low = p.text.toLowerCase();
        const matched = terms.filter((t) => low.includes(t)).length;
        if (matched < terms.length) continue;
        hits.push({ ...p, call, compaction, matched, ts: r.timestamp || null, text: excerpt(p.text, terms) });
      }
    },
    results() {
      const latestCompaction = compaction;
      const ranked = hits
        .map((h, i) => ({ ...h, order: i, compacted: h.compaction < latestCompaction }))
        .sort((a, b) => b.matched - a.matched || b.order - a.order)
        .slice(0, Math.min(Math.max(1, limit), RECALL_CAP.limitMax));
      return { terms, total: hits.length, compactions: latestCompaction, hits: ranked.map(({ order, ...h }) => h) };
    }
  };
}

/** Render hits as an answer under a byte budget (whole hits only). */
export function renderRecall(res, { budgetBytes = RECALL_CAP.totalBytes, source = '' } = {}) {
  if (!res.terms.length) return 'recall: give one or more search terms.';
  const lines = [`recall: ${res.total} match${res.total === 1 ? '' : 'es'} for ${res.terms.map((t) => `"${t}"`).join(' ')}${res.total > res.hits.length ? ` — showing ${res.hits.length}` : ''}`];
  let used = Buffer.byteLength(lines[0], 'utf8');
  for (const h of res.hits) {
    const where = h.kind === 'result' ? `result of ${h.tool || 'tool'}` : h.kind === 'call' ? `${h.tool} call` : h.kind === 'agent' ? 'agent said' : 'user said';
    const block = `\n— call #${h.call} · ${where}${h.compacted ? ' · before a compaction' : ''}\n${h.text}`;
    const cost = Buffer.byteLength(block, 'utf8');
    if (used + cost > budgetBytes) break;
    lines.push(block);
    used += cost;
  }
  if (source) lines.push(`\nsource: ${source} (read-only transcript search; nothing indexed)`);
  return lines.join('\n');
}

// --- I/O ---------------------------------------------------------------------

/** Transcript to search: an explicit session of this project, else the newest. */
export function resolveTranscript(session, { root = transcriptsRoot(), cwd = ROOT } = {}) {
  const dir = path.join(root, projectSlug(cwd));
  const files = listTranscripts(dir).filter((f) => !f.includes(`${path.sep}subagents${path.sep}`));
  if (session) {
    const safe = String(session).replace(/[^\w-]/g, '');
    return files.find((f) => path.basename(f, '.jsonl') === safe) || null;
  }
  let best = null;
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    } catch { /* raced */ }
  }
  return best ? best.f : null;
}

export async function recall(query, { session = null, limit, file = null } = {}) {
  const target = file || resolveTranscript(session);
  const matcher = createMatcher(query, { limit });
  if (!target || !matcher.terms.length) return { file: target, ...matcher.results() };
  const rl = readline.createInterface({ input: fs.createReadStream(target, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { matcher.feed(JSON.parse(line)); } catch { /* torn line */ }
  }
  return { file: target, ...matcher.results() };
}

async function main(argv) {
  const args = [...argv];
  const json = takeFlag(args, '--json');
  const session = takeOption(args, '--session') || null;
  const limit = Number(takeOption(args, '--limit') || RECALL_CAP.limitDefault);
  const bad = unknownFlags(args, []);
  const query = args.filter((a) => !a.startsWith('--')).join(' ');
  if (bad.length || !query) {
    process.stderr.write('Usage: npm run brain:recall -- "<terms>" [--session <id>] [--limit 5] [--json]\n');
    process.exit(1);
  }
  const res = await recall(query, { session, limit });
  if (!res.file) {
    process.stderr.write(`[brain:recall] no transcript for this project${session ? ` with session ${session}` : ''}\n`);
    process.exit(1);
  }
  if (json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else process.stdout.write(renderRecall(res, { source: path.basename(res.file) }) + '\n');
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
