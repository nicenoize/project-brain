import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { slugify } from './common.mjs';

const argv = process.argv.slice(2);
if (argv[0] === 'help' || argv[0] === '-h' || argv[0] === '--help') {
  console.log(`Usage:
  npm run brain:worktree -- spawn [-n|--count N] [--base develop] [--type feature|fix|...]
      [--issue 123] [--slug kebab-label] [--tool cursor|claude|gemini|codex|human|other]
      [--dir /path/to/parent] [--parent <orchestrator-id>] [--json]
  npm run brain:worktree -- list
  npm run brain:worktree -- remove <absolute-or-relative-worktree-path>
  npm run brain:worktree -- prune

Defaults: base branch prefers develop, then dev, main, master, else current branch.
Worktrees live under <repo>/.worktrees/ unless --dir or BRAIN_WORKTREE_DIR is set.
Each worker gets its own Git branch (GitFlow naming) and suggested BRAIN_TASK / <tool>-worker-N actor.
Tool defaults to claude; set BRAIN_WORKTREE_TOOL or --tool for Cursor, Gemini, Codex, etc.`);
  process.exit(0);
}

const command = argv[0] === 'list' || argv[0] === 'remove' || argv[0] === 'prune' ? argv[0] : 'spawn';
const rest = command === 'spawn' ? argv : argv.slice(1);

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function repoRoot() {
  try {
    return sh('git rev-parse --show-toplevel');
  } catch {
    return '';
  }
}

const CANON_TOOLS = new Set(['cursor', 'claude', 'gemini', 'codex', 'human', 'other']);

/** Map CLI/env tool label to session --tool and actor prefix (e.g. cursor-worker-2). */
function resolveWorktreeTool(raw) {
  const r = String(raw ?? 'claude').toLowerCase().trim();
  if (r === 'claude-code' || r === 'anthropic') return { tool: 'claude', actorPrefix: 'claude' };
  if (r === 'openai' || r === 'gpt' || r === 'codex-cli') return { tool: 'codex', actorPrefix: 'codex' };
  if (CANON_TOOLS.has(r)) return { tool: r, actorPrefix: r };
  const slug = slugify(r);
  return { tool: 'other', actorPrefix: slug || 'agent' };
}

function parseSpawnFlags(args) {
  const f = {
    count: 1,
    base: '',
    type: 'feature',
    issue: '',
    slug: '',
    prefix: '',
    parent: '',
    tool: '',
    json: false,
    dir: ''
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    const next = args[i + 1];
    const val = next && !next.startsWith('-') ? next : '';
    if (a === '-n' || a === '--count') { f.count = Math.max(1, parseInt(val, 10) || 1); i += val ? 2 : 1; continue; }
    if (a === '--base') { f.base = val; i += val ? 2 : 1; continue; }
    if (a === '--type') { f.type = val; i += val ? 2 : 1; continue; }
    if (a === '--issue') { f.issue = val; i += val ? 2 : 1; continue; }
    if (a === '--slug') { f.slug = val; i += val ? 2 : 1; continue; }
    if (a === '--prefix') { f.prefix = val; i += val ? 2 : 1; continue; }
    if (a === '--parent') { f.parent = val; i += val ? 2 : 1; continue; }
    if (a === '--tool') { f.tool = val; i += val ? 2 : 1; continue; }
    if (a === '--json') { f.json = true; i++; continue; }
    if (a === '--dir') { f.dir = val; i += val ? 2 : 1; continue; }
    if (a === 'spawn') { i++; continue; }
    i++;
  }
  if (!Number.isFinite(f.count) || f.count < 1) f.count = 1;
  if (f.count > 32) f.count = 32;
  return f;
}

function branchNameSet(repo) {
  const lines = sh('git branch -a', { cwd: repo }).split('\n').map(l => l.replace(/^\*?\s+/, '').trim()).filter(Boolean);
  const names = new Set();
  for (const line of lines) {
    if (line.includes('->')) continue;
    if (line.startsWith('remotes/')) {
      const parts = line.split('/');
      if (parts.length >= 3 && parts[2] === 'HEAD') continue;
      names.add(parts.slice(2).join('/'));
    } else names.add(line);
  }
  return names;
}

function resolveBase(repo, requested) {
  const names = branchNameSet(repo);
  const has = (n) => names.has(n);
  if (requested && has(requested)) return requested;
  if (has('develop')) return 'develop';
  if (has('dev')) return 'dev';
  if (has('main')) return 'main';
  if (has('master')) return 'master';
  const cur = sh('git rev-parse --abbrev-ref HEAD', { cwd: repo });
  return cur || 'HEAD';
}

function q(p) {
  if (process.platform === 'win32') return `"${p.replace(/"/g, '\\"')}"`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

const root = repoRoot();
if (!root) {
  console.error('brain:worktree must run inside a Git repository.');
  process.exit(1);
}

if (command === 'list') {
  console.log(sh('git worktree list', { cwd: root }));
  process.exit(0);
}

if (command === 'prune') {
  execSync('git worktree prune', { cwd: root, stdio: 'inherit' });
  console.log('worktree prune done.');
  process.exit(0);
}

if (command === 'remove') {
  const target = rest[0];
  if (!target) {
    console.error('Usage: npm run brain:worktree -- remove <path>');
    process.exit(1);
  }
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  execSync(`git worktree remove --force ${q(abs)}`, { cwd: root, stdio: 'inherit' });
  process.exit(0);
}

// spawn
const f = parseSpawnFlags(rest);
const toolInput = (f.tool || process.env.BRAIN_WORKTREE_TOOL || 'claude').trim();
const { tool: sessionTool, actorPrefix } = resolveWorktreeTool(toolInput);
if (sessionTool === 'other' && toolInput.toLowerCase() !== 'other' && !CANON_TOOLS.has(toolInput.toLowerCase())) {
  console.warn(`brain:worktree: unrecognized tool "${toolInput}"; using --tool other with actor prefix "${actorPrefix}".`);
}
const base = resolveBase(root, f.base);
const workType = (f.type || 'feature').toLowerCase();
const allowed = new Set(['feature', 'fix', 'refactor', 'chore', 'docs', 'test']);
if (!allowed.has(workType)) {
  console.error(`--type must be one of: ${[...allowed].join(', ')}`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const rawIssue = f.issue ? String(f.issue).trim() : '';
const issueDigits = rawIssue.match(/\d+/)?.[0] || '';
const issuePart = rawIssue ? (issueDigits || slugify(rawIssue)) : '';
const slugBase = f.slug || f.prefix || 'parallel';
const slug = slugify(slugBase) || 'parallel';

const parentDir = f.dir
  ? path.resolve(f.dir)
  : (process.env.BRAIN_WORKTREE_DIR
    ? path.resolve(root, process.env.BRAIN_WORKTREE_DIR)
    : path.join(root, '.worktrees'));
ensureDir(parentDir);

const workers = [];
for (let i = 1; i <= f.count; i++) {
  const branchSuffix = issuePart && f.count > 1 ? `-wt${i}` : '';
  let branchName;
  if (issuePart) {
    branchName = `${workType}/${issuePart}-${slug}${branchSuffix}`;
  } else if (f.count > 1) {
    branchName = `${workType}/${slug}-wt${i}-${stamp}`;
  } else {
    branchName = `${workType}/${slug}-${stamp}`;
  }
  const dirName = `wt-${String(i).padStart(2, '0')}-${slugify(branchName).slice(0, 48)}`;
  const wtPath = path.join(parentDir, dirName);

  if (fs.existsSync(wtPath)) {
    console.error(`Refusing to clobber existing path: ${wtPath}`);
    process.exit(1);
  }

  try {
    execSync(`git worktree add -b ${q(branchName)} ${q(wtPath)} ${q(base)}`, { cwd: root, stdio: 'inherit' });
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }

  const actor = `${actorPrefix}-worker-${i}`;
  const task = issuePart
    ? (f.count > 1 ? `issue-${issuePart}-${slug}-wt${i}` : `issue-${issuePart}-${slug}`)
    : (f.count > 1 ? `${slug}-wt${i}-${stamp}` : `${slug}-${stamp}`);
  workers.push({
    index: i,
    path: wtPath,
    branch: branchName,
    base,
    tool: sessionTool,
    actor,
    task,
    sessionStart: `npm run brain:session -- start --task ${task} --actor ${actor} --tool ${sessionTool}${f.parent ? ` --parent ${f.parent}` : ''}`,
    pack: `BRAIN_TASK=${task} BRAIN_ACTOR=${actor} npm run brain:pack -- "your task brief" --max-tokens 3000`
  });
}

if (f.json) {
  console.log(JSON.stringify({ root, base, parentDir, tool: sessionTool, toolInput, workers }, null, 2));
} else {
  console.log(`Created ${workers.length} worktree(s) from base ${base} (session tool=${sessionTool}).`);
  console.log(`Brain Markdown stays in Git; each checkout has its own copy. Run indexing inside each tree if you rely on local retrieval.\n`);
  for (const w of workers) {
    console.log(`--- Worker ${w.index} ---`);
    console.log(`  directory:  ${w.path}`);
    console.log(`  branch:     ${w.branch}`);
    console.log(`  cd:         cd ${q(w.path).replace(/^'|'$/g, '')}`);
    console.log(`  tool:       ${w.tool}`);
    console.log(`  session:    (from worktree) ${w.sessionStart}`);
    console.log(`  pack:       (from worktree) ${w.pack}`);
    console.log('');
  }
  console.log('Open one terminal or agent UI per worktree (Cursor, Claude Code, Codex CLI, Gemini, …) so cwd matches that tree.');
  console.log('Merge brain updates (active_state, features, sessions) via normal GitFlow PRs; prefer one merge actor for active_state.md.');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}
