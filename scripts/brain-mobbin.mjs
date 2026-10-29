#!/usr/bin/env node
/**
 * Mobbin library: every Mobbin search an agent ran, kept on this Mac with its
 * screenshots, so a close question is answered from here before Mobbin is
 * asked again.
 *
 *   brain:mobbin ingest            read new Mobbin results from every transcript
 *   brain:mobbin search <terms>    local results, closest first (--tool, --platform)
 *   brain:mobbin stats             searches kept, calls answered locally
 *   brain:mobbin hook              PreToolUse for mcp__*Mobbin__search_*: a close
 *                                  earlier search answers instead (the call is
 *                                  denied with the local result); the same call
 *                                  again goes through to Mobbin
 *
 * Read from the transcripts, not from a PostToolUse payload: Claude Code keeps
 * each result there, the screenshots under the session's tool-results/, and the
 * transcript shape is the one the rest of the brain already reads. The library
 * lives in ~/.project-brain/mobbin (BRAIN_HOME), shared by every project.
 * BRAIN_MOBBIN_EXCLUDE (a regex on the transcript path) keeps projects out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const libDir = (env = process.env) => path.join(env.BRAIN_HOME || path.join(os.homedir(), '.project-brain'), 'mobbin');
const TOOL_RE = /mobbin__search_/i;
const RETRY_MS = 30 * 60_000;
export const THRESHOLD = 0.6;

const STOP = new Set(('a an the in on of for to and or with without by from at into via app apps application ' +
  'screen screens page pages ui ux design example examples showing show that this').split(' '));

/** Content words of a query: lowercase, plural s dropped, stop words out. */
export function terms(query) {
  return [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
}

/** Jaccard over content words: 1 for the same question in other words, 0 for nothing shared. */
export function similarity(a, b) {
  const x = new Set(terms(a)), y = new Set(terms(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const toolOf = (name) => String(name || '').replace(/^.*__/, '');

/** One entry from a tool_use and its tool_result; null when the result carries no JSON. */
export function entryFrom(use, result, { project = '', ts = null } = {}) {
  const parts = Array.isArray(result.content) ? result.content : [{ type: 'text', text: String(result.content || '') }];
  const images = [];
  let data = null;
  for (const p of parts) {
    if (p?.type !== 'text') continue;
    const img = /^\[Image: source: (.+)\]$/.exec(p.text.trim());
    if (img) { images.push(img[1]); continue; }
    if (!data) { try { const j = JSON.parse(p.text); if (j && typeof j === 'object') data = j; } catch { /* not the result body */ } }
  }
  if (!data || result.is_error) return null;
  const items = (data.screens || data.flows || data.sections || data.results || []).map((r) => ({
    id: r.id || r.screen_id || null,
    name: r.name || null,
    app: r.app_name || r.app || null,
    url: r.mobbin_url || null,
    screens: r.screen_count || undefined
  }));
  return {
    id: use.id,
    tool: toolOf(use.name),
    platform: use.input?.platform || data.platform || null,
    query: use.input?.query || data.query || '',
    ts,
    project,
    items,
    sources: images
  };
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function loadEntries(env = process.env) {
  const file = path.join(libDir(env), 'entries.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function transcriptFiles(env) {
  const homes = [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')];
  try { for (const e of fs.readdirSync(os.homedir())) if (/^\.claude-/.test(e)) homes.push(path.join(os.homedir(), e)); } catch { /* unreadable home */ }
  const roots = env.BRAIN_MOBBIN_TRANSCRIPTS ? [env.BRAIN_MOBBIN_TRANSCRIPTS] : [...new Set(homes.filter(Boolean))].map((h) => path.join(h, 'projects'));
  const exclude = env.BRAIN_MOBBIN_EXCLUDE ? new RegExp(env.BRAIN_MOBBIN_EXCLUDE) : null;
  const out = [];
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== 'tool-results' && e.name !== 'memory') walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && !(exclude && exclude.test(p))) out.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * Read what was appended to each transcript since the last run. Per file the
 * scan keeps the byte offset and the Mobbin calls still waiting for their
 * result, so a call and its result may land in different runs.
 */
export function ingest({ env = process.env } = {}) {
  const dir = libDir(env);
  const scanFile = path.join(dir, 'scan.json');
  const scan = readJson(scanFile, {});
  const known = new Set(loadEntries(env).map((e) => e.id));
  const added = [];
  for (const file of transcriptFiles(env)) {
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    const state = scan[file] || { offset: 0, pending: {} };
    if (size < state.offset) { state.offset = 0; state.pending = {}; }
    if (size === state.offset) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buf, 0, buf.length, state.offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1; // a half-written last line waits for the next run
    state.offset += Buffer.byteLength(text.slice(0, end));
    const chunk = text.slice(0, end);
    if (!/mobbin/i.test(chunk) && !Object.keys(state.pending).length) { scan[file] = state; continue; }
    const project = path.basename(path.dirname(file)).replace(/^-Users-[^-]+-/, '').replace(/^-/, '');
    for (const line of chunk.split('\n')) {
      if (!line || (!/mobbin/i.test(line) && !Object.keys(state.pending).some((id) => line.includes(id)))) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type === 'tool_use' && TOOL_RE.test(b.name || '')) state.pending[b.id] = { id: b.id, name: b.name, input: b.input, ts: rec.timestamp };
        if (b.type === 'tool_result' && state.pending[b.tool_use_id]) {
          const use = state.pending[b.tool_use_id];
          delete state.pending[b.tool_use_id];
          if (known.has(use.id)) continue;
          const entry = entryFrom(use, b, { project, ts: use.ts });
          if (!entry) continue;
          entry.images = keepImages(entry, dir);
          delete entry.sources;
          known.add(entry.id);
          added.push(entry);
        }
      }
    }
    scan[file] = state;
  }
  if (added.length) {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'entries.jsonl'), added.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  writeJson(scanFile, scan);
  return added;
}

/** Copy the screenshots out of the session's tool-results/, which goes when the session is deleted. */
function keepImages(entry, dir) {
  const out = [];
  entry.sources.forEach((src, i) => {
    const dest = path.join(dir, 'images', `${entry.id}-${i}${path.extname(src) || '.webp'}`);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      out.push(dest);
    } catch { /* the source is gone: the entry keeps its links */ }
  });
  return out;
}

/** Earlier searches closest to `query`, same tool and platform when given. */
export function search(entries, query, { tool = null, platform = null, min = 0.2, limit = 5 } = {}) {
  return entries
    .filter((e) => (!tool || e.tool === tool) && (!platform || !e.platform || e.platform === platform))
    .map((e) => ({ entry: e, score: similarity(query, e.query) }))
    .filter((h) => h.score >= min)
    .sort((a, b) => b.score - a.score || String(b.entry.ts).localeCompare(String(a.entry.ts)))
    .slice(0, limit);
}

export function renderHit({ entry, score }) {
  const lines = [`"${entry.query}" (${entry.tool}, ${entry.platform || 'any'}, ${String(entry.ts || '').slice(0, 10)}, similarity ${score.toFixed(2)})`];
  entry.items.forEach((it, i) => {
    const img = entry.images?.[i] && entry.items.length === entry.images.length ? ` — ${entry.images[i]}` : '';
    lines.push(`- ${[it.app, it.name].filter(Boolean).join(': ') || it.id}${it.screens ? ` (${it.screens} screens)` : ''} — ${it.url || ''}${img}`);
  });
  if (entry.images?.length && entry.items.length !== entry.images.length) lines.push(`  screenshots: ${entry.images.join(', ')}`);
  return lines.join('\n');
}

const retryKey = (session, tool, input) => crypto.createHash('sha256').update(`${session}\0${tool}\0${JSON.stringify(input)}`).digest('hex').slice(0, 16);

/**
 * The PreToolUse answer for one Mobbin search: deny with the local result when
 * an earlier search is close enough, unless this exact call was already
 * answered locally in this session (then the agent wants Mobbin: let it go).
 */
export function decide(payload, { env = process.env, now = Date.now(), entries = null } = {}) {
  const name = payload?.tool_name || '';
  if (!TOOL_RE.test(name) || env.BRAIN_MOBBIN_LOCAL === '0') return null;
  const input = payload.tool_input || {};
  const tool = toolOf(name);
  const dir = libDir(env);
  const retryFile = path.join(dir, 'retry.json');
  const retry = readJson(retryFile, {});
  for (const [k, t] of Object.entries(retry)) if (now - t > RETRY_MS) delete retry[k];
  const key = retryKey(payload.session_id || '', tool, input);
  if (retry[key]) {
    delete retry[key];
    writeJson(retryFile, retry);
    return null;
  }
  const [hit] = search(entries || loadEntries(env), input.query || '', { tool, platform: input.platform || null, min: Number(env.BRAIN_MOBBIN_THRESHOLD || THRESHOLD), limit: 1 });
  if (!hit) return null;
  retry[key] = now;
  writeJson(retryFile, retry);
  fs.appendFileSync(path.join(dir, 'answered.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), tool, query: input.query, from: hit.entry.id, score: Number(hit.score.toFixed(2)) }) + '\n');
  const reason = [
    'Mobbin library (local, no Mobbin call): a close earlier search already has this.',
    renderHit(hit),
    'Read the screenshots above with the Read tool. If they do not fit, call the same tool again with the same input: the repeat goes through to Mobbin.'
  ].join('\n');
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function stats(env) {
  const entries = loadEntries(env);
  const answered = (() => { try { return fs.readFileSync(path.join(libDir(env), 'answered.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const byTool = {};
  for (const e of entries) byTool[e.tool] = (byTool[e.tool] || 0) + 1;
  const images = entries.reduce((s, e) => s + (e.images?.length || 0), 0);
  console.log(`${entries.length} Mobbin searches kept (${Object.entries(byTool).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}), ${images} screenshots · ${answered} calls answered locally · ${libDir(env)}`);
}

async function main(argv) {
  const [cmd = 'stats', ...rest] = argv;
  const env = process.env;
  if (cmd === 'hook') {
    // A hook never stands in the way: any failure lets the call through.
    try {
      const raw = fs.readFileSync(0, 'utf8');
      ingest({ env });
      const out = decide(JSON.parse(raw || '{}'), { env });
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* let Mobbin answer */ }
    return 0;
  }
  if (cmd === 'ingest') {
    const added = ingest({ env });
    console.log(`${added.length} new Mobbin search${added.length === 1 ? '' : 'es'} kept`);
    stats(env);
    return 0;
  }
  if (cmd === 'search') {
    const opt = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest.splice(i, 2)[1] : null; };
    const tool = opt('--tool'), platform = opt('--platform');
    ingest({ env });
    const hits = search(loadEntries(env), rest.join(' '), { tool, platform, limit: 5 });
    if (!hits.length) { console.log('nothing close in the Mobbin library'); return 1; }
    console.log(hits.map(renderHit).join('\n\n'));
    return 0;
  }
  if (cmd === 'stats') { stats(env); return 0; }
  console.error('usage: brain:mobbin ingest | search <terms> [--tool search_screens] [--platform ios] | stats | hook');
  return 2;
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) process.exit(await main(process.argv.slice(2)));
