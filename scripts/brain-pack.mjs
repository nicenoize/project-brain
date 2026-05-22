import fs from 'node:fs';
import { BRAIN_DIR, read, takeFlag, takeOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve } from './retrieval.mjs';
import { openStore } from './store.mjs';

const args = process.argv.slice(2);
const tightBudget = takeFlag(args, '--tight-budget');
const maxTokens = Number(
  takeOption(args, '--max-tokens') ||
    process.env.BRAIN_PACK_MAX_TOKENS ||
    (tightBudget ? 2000 : 2600)
);
const format = takeOption(args, '--format') || 'text';
const mode = takeOption(args, '--mode') || (takeFlag(args, '--resume') ? 'resume' : takeFlag(args, '--minimal') ? 'minimal' : 'default');
const includeAutoCompact = takeFlag(args, '--include-auto-compact') || process.env.BRAIN_PACK_INCLUDE_AUTO_COMPACT === '1';
const printBudget = takeFlag(args, '--print-budget') || process.env.BRAIN_PACK_PRINT_BUDGET === '1';
const taskOpt = takeOption(args, '--task');
const actorOpt = takeOption(args, '--actor');
const query = args.join(' ').trim();

if (!query && import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    'Usage: npm run brain:pack -- "query" [--max-tokens N] [--tight-budget] [--mode default|resume|minimal] [--include-auto-compact] [--print-budget] [--format json|text] [--task <workstream-id>] [--actor <label>]'
  );
  console.error('Env: BRAIN_TASK, BRAIN_ACTOR, BRAIN_PACK_MAX_TOKENS (defaults to 2600; --tight-budget uses 2000). BRAIN_PACK_PRINT_BUDGET=1 logs token usage to stderr.');
  process.exit(1);
}

export async function packPrompt(query, opts = {}) {
  const budget = Number(opts.maxTokens || maxTokens);
  const packMode = opts.mode || mode;
  const includeCompact = Boolean(opts.includeAutoCompact ?? includeAutoCompact);
  const embedder = openEmbedder(opts);
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const taskId = trimStr(opts.taskId || taskOpt || process.env.BRAIN_TASK);
  const actor = trimStr(opts.actor || actorOpt || process.env.BRAIN_ACTOR);
  let ranked = await retrieve(query, store, embedder, {
    topK: Number(process.env.BRAIN_PACK_CANDIDATES || 32),
    candidates: Number(process.env.BRAIN_PACK_CANDIDATES || 64),
    taskId,
    actor
  });
  ranked = ranked.filter(record => includeCompact || !isAutoCompactRecord(record));
  if (packMode === 'minimal') ranked = ranked.filter(record => record.isSummary || record.type === 'decision' || record.type === 'module-summary');
  if (packMode === 'resume') ranked = prioritizeResumeRecords(ranked);

  const sources = [];
  const parts = [];
  let used = 0;
  for (const core of coreFiles(packMode)) {
    const text = read(core.path).trim();
    if (!text) continue;
    const body = core.maxTokens ? limitTokens(text, core.maxTokens) : text;
    const tokens = estimateTokens(body);
    if (used + tokens > budget && parts.length) continue;
    parts.push(`## ${core.label}\n\n${body}`);
    sources.push({ file: core.path, tokens, core: true });
    used += tokens;
  }

  const seen = new Set();
  for (const record of ranked) {
    const key = `${record.file}:${record.heading || record.chunk}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = `## ${record.file}#chunk-${record.chunk}\n\n${record.text}`;
    const tokens = estimateTokens(text);
    if (used + tokens > budget) continue;
    parts.push(text);
    sources.push({ file: record.file, chunk: record.chunk, score: record.score, tokens });
    used += tokens;
  }
  await store.close();
  return { prompt: parts.join('\n\n'), sources, estimatedTokens: used };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packed = await packPrompt(query, { maxTokens, mode });
  if (printBudget) {
    console.error(`[brain:pack] estimated tokens: ${packed.estimatedTokens} / budget ${maxTokens}`);
  }
  if (format === 'json') console.log(JSON.stringify(packed, null, 2));
  else console.log(packed.prompt);
}

function coreFiles(packMode = 'default') {
  const activeMax = packMode === 'minimal' ? 220 : packMode === 'resume' ? 320 : 0;
  const indexMax = packMode === 'minimal' ? 420 : packMode === 'resume' ? 520 : 0;
  return [
    { label: 'context_index.md', path: `${BRAIN_DIR}/context_index.md`, maxTokens: indexMax },
    { label: 'active_state.md', path: `${BRAIN_DIR}/active_state.md`, maxTokens: activeMax }
  ];
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function limitTokens(text, max) {
  if (!max) return text;
  const limit = max * 4;
  const value = String(text);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).replace(/\s+\S*$/, '').trim()}\n\n[truncated by brain:pack ${max} token cap]`;
}

function isAutoCompactRecord(record) {
  const file = String(record.file || '');
  const title = String(record.title || '').toLowerCase();
  const text = String(record.text || '');
  return (
    file.includes('__auto-compact__') ||
    title.includes('auto-compact') ||
    text.includes('type: auto-compact') ||
    (file === '.project-brain/sessions' && text.includes('__auto-compact__'))
  ) && (
    record.type === 'session' ||
    record.type === 'auto-compact' ||
    record.type === 'module-summary' ||
    file.startsWith('.project-brain/sessions')
  );
}

function prioritizeResumeRecords(records) {
  return [...records].sort((a, b) => resumeRank(b) - resumeRank(a) || b.score - a.score);
}

function resumeRank(record) {
  let rank = 0;
  if (record.type === 'session' || record.type === 'auto-compact') rank += 4;
  if (record.type === 'decision') rank += 3;
  if (record.isModuleSummary) rank += 2;
  if (record.isSummary) rank += 1;
  return rank;
}

function trimStr(v) {
  return String(v ?? '').trim();
}

