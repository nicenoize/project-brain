import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import { BRAIN_DIR, ROOT, ensureDir, read, sha256, slugify, write } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';
import { packPrompt } from './brain-pack.mjs';
import { newSessionFilePath, readSessionMeta, sessionTimestampSlug } from './session-util.mjs';

const DEFAULT_QUERY =
  'Resume workstream: goals, architecture, open decisions, next concrete implementation steps, key file paths and symbols.';

const args = process.argv.slice(2);

function takeOption(name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  const v = args[i + 1] || '';
  args.splice(i, v ? 2 : 1);
  return v;
}

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function guessToolFromHookJson(raw, trigger) {
  if (!raw.trim()) return '';
  try {
    const j = JSON.parse(raw);
    const stack = [j];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      for (const k of ['tool', 'client', 'agent', 'source', 'ide']) {
        const v = cur[k];
        if (typeof v === 'string' && v.trim()) return normalizeTool(v);
      }
      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  } catch {
    /* ignore */
  }
  if (trigger === 'preCompact' || trigger === 'stop') return 'cursor';
  return '';
}

function normalizeTool(s) {
  const t = String(s).toLowerCase();
  if (t.includes('cursor')) return 'cursor';
  if (t.includes('claude') || t.includes('anthropic')) return 'claude';
  if (t.includes('gemini') || t.includes('google')) return 'gemini';
  if (t.includes('codex') || t.includes('openai')) return 'codex';
  return slugify(t).slice(0, 24) || 'other';
}

async function indexSessionFile(filePath, expiresAt) {
  if (process.env.BRAIN_COMPACT_EMBED_INDEX !== '1') return;
  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const relative = path.relative(ROOT, filePath);
  const text = read(filePath);
  const meta = readSessionMeta(filePath, path.basename(filePath));
  const branch = sh('git rev-parse --abbrev-ref HEAD') || 'unknown';
  const vector = await embedder.embed(`${relative}\n${text}`);
  const stat = fs.statSync(filePath);
  await store.upsert([
    {
      id: `session:${sha256(relative)}`,
      file: relative,
      chunk: -1,
      title: `Auto-compact ${branch}${meta.taskId ? ` · ${meta.taskId}` : ''}`,
      type: 'auto-compact',
      heading: branch,
      text,
      embeddingText: `${relative}\n${text}`,
      isSummary: true,
      isModuleSummary: false,
      isProjectSummary: false,
      branch,
      expiresAt,
      changedFiles: [],
      taskId: meta.taskId || '',
      actor: meta.actor || '',
      tool: meta.tool || '',
      parentRun: meta.parentRun || '',
      provenance: 'generated',
      layer: 'session',
      docStatus: 'draft',
      synthetic: true,
      noindex: true,
      mtime: stat.mtime.toISOString(),
      vector
    }
  ]);
  await store.close();
}

function ttlHours() {
  return Number(process.env.BRAIN_COMPACT_TTL_HOURS || process.env.BRAIN_SESSION_TTL_HOURS || 72);
}

async function main() {
  const cursorHook = args.includes('--cursor-hook');
  if (cursorHook) process.env.BRAIN_QUIET = '1';
  let trigger = 'manual';
  if (cursorHook) {
    const i = args.indexOf('--cursor-hook');
    trigger = args[i + 1] || 'hook';
    args.splice(i, args[i + 1] ? 2 : 1);
    let stdin = '';
    try {
      stdin = fs.readFileSync(0, 'utf8');
    } catch {
      stdin = '';
    }
    const guessed = guessToolFromHookJson(stdin, trigger);
    if (guessed && !process.env.BRAIN_TOOL && !process.env.BRAIN_COMPACT_TOOL) {
      process.env.BRAIN_COMPACT_TOOL = guessed;
    }
  }

  const maxTokens = Number(takeOption('--max-tokens') || process.env.BRAIN_COMPACT_MAX_TOKENS || 1200);
  const taskId = takeOption('--task') || process.env.BRAIN_TASK || '';
  const actor = takeOption('--actor') || process.env.BRAIN_ACTOR || '';
  const tool =
    takeOption('--tool') ||
    process.env.BRAIN_TOOL ||
    process.env.BRAIN_COMPACT_TOOL ||
    process.env.BRAIN_WORKTREE_TOOL ||
    '';
  const queryArg = args.join(' ').trim();
  const query = queryArg || DEFAULT_QUERY;

  const branch = sh('git rev-parse --abbrev-ref HEAD') || 'unknown';
  const branchSlug = slugify(branch);
  const sessionsDir = path.join(BRAIN_DIR, 'sessions');
  ensureDir(sessionsDir);

  const packed = await packPrompt(query, {
    maxTokens,
    taskId,
    actor,
    mode: process.env.BRAIN_COMPACT_PACK_MODE || 'resume',
    includeAutoCompact: false
  });

  const stamp = sessionTimestampSlug();
  const file = newSessionFilePath(sessionsDir, branchSlug, 'auto-compact', stamp);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours() * 60 * 60 * 1000).toISOString();

  const sourceLines = packed.sources
    .filter((s) => !s.core)
    .slice(0, 40)
    .map((s) => `- \`${s.file}\`${s.chunk != null ? ` chunk ${s.chunk}` : ''} (~${s.tokens} tok)`);

  const body = [
    '---',
    'type: auto-compact',
    'provenance: generated',
    'noindex: true',
    'layer: session',
    `task_id: ${JSON.stringify(taskId)}`,
    `branch: ${JSON.stringify(branch)}`,
    `actor: ${JSON.stringify(actor)}`,
    `tool: ${JSON.stringify(tool || 'unspecified')}`,
    `compact_trigger: ${JSON.stringify(trigger)}`,
    `generated_at: ${JSON.stringify(now.toISOString())}`,
    `estimated_pack_tokens: ${packed.estimatedTokens}`,
    '---',
    '',
    '# Auto-compact snapshot',
    '',
    'Machine-generated **resume slice** for low-token reload. After chat compaction or a new agent turn, load `context_index.md` and `active_state.md` first, then this file (or run `npm run brain:pack` with the same `BRAIN_TASK` / `BRAIN_ACTOR`).',
    '',
    '## Packed brain context',
    '',
    packed.prompt,
    '',
    '## Retrieval sources (subset)',
    '',
    ...(sourceLines.length ? sourceLines : ['- (core files only)']),
    '',
    '## Do not compact list (human/agent)',
    '',
    '- Secrets, credentials, destructive commands',
    '- Numbers, legal names, or URLs not yet in `.project-brain/`',
    '- Ambiguous requirements until confirmed',
    ''
  ].join('\n');

  write(file, body);
  await indexSessionFile(file, expiresAt);

  const rel = path.relative(ROOT, file);
  if (!cursorHook) {
    console.log(`Wrote ${rel} (~${packed.estimatedTokens} est. tokens in pack body).`);
  }

  const doSync = !cursorHook && process.env.BRAIN_COMPACT_SYNC !== '0';
  if (doSync) {
    const code = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'brain:sync'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, BRAIN_BACKGROUND: process.env.BRAIN_COMPACT_SYNC_BG || '1' }
    }).status;
    if (code) console.warn(`brain:sync exited ${code}`);
  }

  if (cursorHook) {
    console.log(JSON.stringify({ ok: true, wrote: rel, estimatedTokens: packed.estimatedTokens, trigger }));
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  if (process.argv.includes('--cursor-hook')) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
  process.exit(1);
});
