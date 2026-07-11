/**
 * Token-budgeted prompt packing for agent context windows.
 *
 * Runs brain:search behind the scenes, then assembles a Markdown blob
 * that fits within --max-tokens (default 2600). Modes: full | resume
 * (current task only) | minimal (architecture map). Drives `brain:ask`
 * and the auto-compact resume slice.
 */
import fs from 'node:fs';
import { BRAIN_DIR, read, takeFlag, takeOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { retrieve, staleResults, staleBanner } from './retrieval.mjs';
import { openStore } from './store.mjs';

const args = process.argv.slice(2);
const tightBudget = takeFlag(args, '--tight-budget');
const maxTokens = Number(
  takeOption(args, '--max-tokens') ||
    process.env.BRAIN_PACK_MAX_TOKENS ||
    (tightBudget ? 2000 : 2600)
);
const format = takeOption(args, '--format') || 'text';
// --for-agent [name] prepends a short priming preamble + prioritizes long-shelf-life
// records (decisions, module summaries, cross-project edges, recent sessions). The
// optional name is cosmetic (claude, cursor, codex, ...) and surfaces in the preamble.
const forAgentRequested = args.includes('--for-agent');
const agentName = takeOption(args, '--for-agent') || (forAgentRequested ? 'agent' : '');
const mode = takeOption(args, '--mode')
  || (takeFlag(args, '--resume') ? 'resume'
      : takeFlag(args, '--minimal') ? 'minimal'
      : agentName ? 'for-agent'
      : 'default');
const includeAutoCompact = takeFlag(args, '--include-auto-compact') || process.env.BRAIN_PACK_INCLUDE_AUTO_COMPACT === '1';
const printBudget = takeFlag(args, '--print-budget') || process.env.BRAIN_PACK_PRINT_BUDGET === '1';
const taskOpt = takeOption(args, '--task');
const actorOpt = takeOption(args, '--actor');
const projectOpt = takeOption(args, '--project');
const writeTo = takeOption(args, '--write');
const query = args.join(' ').trim();

if (!query && import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    'Usage: npm run brain:pack -- "query" [--max-tokens N] [--tight-budget] [--mode default|resume|minimal|for-agent] [--for-agent [name]] [--include-auto-compact] [--print-budget] [--format json|text] [--task <workstream-id>] [--actor <label>] [--project name[,name2]] [--write <path>]'
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
  const project = trimStr(opts.project || projectOpt || process.env.BRAIN_PROJECT);
  let ranked = await retrieve(query, store, embedder, {
    topK: Number(process.env.BRAIN_PACK_CANDIDATES || 32),
    candidates: Number(process.env.BRAIN_PACK_CANDIDATES || 64),
    taskId,
    actor,
    ...(project ? { filter: { project } } : {})
  });
  ranked = ranked.filter(record => includeCompact || !isAutoCompactRecord(record));
  if (packMode === 'minimal') ranked = ranked.filter(record => record.isSummary || record.type === 'decision' || record.type === 'module-summary');
  if (packMode === 'resume') ranked = prioritizeResumeRecords(ranked);
  if (packMode === 'for-agent') ranked = prioritizeAgentPrimerRecords(ranked);

  const sources = [];
  const parts = [];
  let used = 0;

  // for-agent priming preamble: short, dated, references the query + agent label.
  if (packMode === 'for-agent') {
    const preamble = buildAgentPreamble(opts.forAgent || agentName || 'agent', query);
    const tokens = estimateTokens(preamble);
    parts.push(preamble);
    sources.push({ file: '(synthetic)', label: 'agent-preamble', tokens, core: true });
    used += tokens;
  }

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

  // Query-time staleness (ADR 0025): flag packed source files that drifted from
  // the index, over the ≤8 distinct top result files. Default-on; opt-out
  // BRAIN_STALE_BANNER=0. Output-only, never affects what/how we packed. The
  // banner rides at the very top of the prompt so a consuming agent (incl.
  // brain:ask's spawned children) sees it before any packed context.
  const stale = process.env.BRAIN_STALE_BANNER === '0' ? [] : staleResults(ranked);
  const banner = staleBanner(ranked);
  const prompt = banner ? `${banner}\n\n${parts.join('\n\n')}` : parts.join('\n\n');
  return { prompt, sources, stale, estimatedTokens: used };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packed = await packPrompt(query, { maxTokens, mode, forAgent: agentName });
  if (printBudget) {
    console.error(`[brain:pack] estimated tokens: ${packed.estimatedTokens} / budget ${maxTokens}`);
  }
  const output = format === 'json' ? JSON.stringify(packed, null, 2) : packed.prompt;
  if (writeTo) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(writeTo), { recursive: true });
    writeFileSync(writeTo, `${output}\n`);
    console.error(`[brain:pack] wrote ${writeTo}`);
  } else {
    console.log(output);
  }
}

function coreFiles(packMode = 'default') {
  const activeMax = packMode === 'minimal' ? 220
    : packMode === 'resume' ? 320
    : packMode === 'for-agent' ? 420
    : 0;
  const indexMax = packMode === 'minimal' ? 420
    : packMode === 'resume' ? 520
    : packMode === 'for-agent' ? 600
    : 0;
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

/** Agent-priming prioritization: favor durable facts an agent needs first. */
export function prioritizeAgentPrimerRecords(records) {
  return [...records].sort((a, b) => agentPrimerRank(b) - agentPrimerRank(a) || b.score - a.score);
}

export function agentPrimerRank(record) {
  let rank = 0;
  if (record.type === 'decision') rank += 5;
  if (record.type === 'cross-project-edge') rank += 4;
  if (record.isModuleSummary) rank += 3;
  if (record.type === 'repo-summary' || record.type === 'fleet-summary') rank += 3;
  if (record.type === 'feature-summary') rank += 2;
  if (record.type === 'session' || record.type === 'auto-compact') rank += 2;
  if (record.isSummary) rank += 1;
  return rank;
}

export function buildAgentPreamble(agent, query) {
  const today = new Date().toISOString().slice(0, 10);
  return `# Agent Priming — ${agent} · ${today}

You are a coding agent working in this project. The records below are durable
context the brain considers most relevant for: "${query || '(no query — general priming)'}".

Working agreement:
1. **Check active_state.md first** — workstreams and file leases tell you what work
   is in flight. Do not start work that conflicts with an active lease.
2. **Search before grepping** — use \`npm run brain:search "..."\` and
   \`npm run brain:pack "..."\` for token-budgeted context lookups.
3. **Record durable choices** — when you make a non-obvious decision, write a new
   ADR under \`.project-brain/decisions/<n>-slug.md\` with frontmatter.
4. **Mark your work** — \`npm run brain:work start --slug X --actor <you> --tool <you>\`
   before substantive changes; \`brain:work end\` when done.
5. **Stay in scope** — keep changes minimal and well-scoped; no speculative refactors.

Records by relevance follow. Each is labeled \`<file>#chunk-<n>\`.

---
`;
}

function trimStr(v) {
  return String(v ?? '').trim();
}

