/**
 * Git worktree manager for parallel agent sessions.
 *
 * Spawns N worktrees with GitFlow-shaped branch names
 * (feature/<issue>-<slug>-wp<N>) and keeps each worktree's
 * skills/project-brain symlink pointing at the canonical source,
 * so every worker sees the same brain. Subcommands: spawn, list, repair.
 */
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
  npm run brain:worktree -- repair [--force]

Defaults: base branch prefers develop, then dev, main, master, else current branch.
Worktrees live under <repo>/.worktrees/ unless --dir or BRAIN_WORKTREE_DIR is set.
Each worker gets its own Git branch (GitFlow naming) and suggested BRAIN_TASK / <tool>-worker-N actor.
Tool defaults to claude; set BRAIN_WORKTREE_TOOL or --tool for Cursor, Gemini, Codex, etc.

repair: rewrite skills/project-brain in every worktree to an absolute symlink
        when the source repo uses a sibling-symlink layout and the relative
        target does not resolve from the worktree. --force rewrites even when
        the symlink currently resolves (useful for re-anchoring after the
        source moves).`);
  process.exit(0);
}

const command = ['list', 'remove', 'prune', 'repair'].includes(argv[0]) ? argv[0] : 'spawn';
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

/**
 * Resolve where the source repo's `skills/project-brain` actually lives on
 * disk (absolute path), or `null` if the source isn't a symlink (vendored
 * or submodule layouts don't need patching — `git worktree add` copies a
 * real directory).
 */
function resolveSourceBrainTarget(sourceRoot) {
  const linkPath = path.join(sourceRoot, 'skills', 'project-brain');
  let st;
  try { st = fs.lstatSync(linkPath); } catch { return null; }
  if (!st.isSymbolicLink()) return null;
  try { return fs.realpathSync(linkPath); } catch { return null; }
}

/**
 * If the worktree's `skills/project-brain` symlink fails to resolve from
 * inside the worktree (the common case for `../project-brain` when the
 * worktree sits in a different parent), atomically replace it with an
 * absolute symlink to the source repo's resolved brain path.
 *
 * Returns one of: 'ok' (resolves, no action), 'fixed', 'forced',
 * 'skipped:not-symlink' (vendored), 'skipped:no-source' (source not
 * resolvable). Never throws — symlink fixes are best-effort.
 */
function fixBrainSymlinkInWorktree(wtPath, sourceTarget, { force = false } = {}) {
  if (!sourceTarget) return 'skipped:no-source';
  const wtLink = path.join(wtPath, 'skills', 'project-brain');
  let st;
  try { st = fs.lstatSync(wtLink); } catch { return 'skipped:no-symlink'; }
  if (!st.isSymbolicLink()) return 'skipped:not-symlink';

  // Cheap precise check: if the symlink already points at the canonical
  // source target (after resolving) and resolves to a working brain dir,
  // skip the rewrite entirely. Saves the rename + log noise when called
  // repeatedly (e.g. fixBrainSymlinkInWorktree invoked per worktree on
  // every orchestrate cycle).
  if (!force) {
    let currentTarget = '';
    try { currentTarget = fs.readlinkSync(wtLink); } catch {}
    const canonical = path.resolve(path.dirname(wtLink), currentTarget);
    const desired = path.resolve(sourceTarget);
    const resolves = fs.existsSync(path.join(wtLink, 'SKILL.md')) || fs.existsSync(path.join(wtLink, 'scripts'));
    if (resolves && canonical === desired) return 'ok';
    if (resolves) return 'ok'; // works but points elsewhere — preserve old lenient behavior
  }

  try {
    // Atomic replace: write to a sibling temp link, then rename over.
    const tmp = `${wtLink}.tmp-${process.pid}`;
    try { fs.unlinkSync(tmp); } catch {}
    fs.symlinkSync(sourceTarget, tmp);
    fs.renameSync(tmp, wtLink);
    return force ? 'forced' : 'fixed';
  } catch (err) {
    console.warn(`  [worktree-symlink] could not rewrite ${wtLink}: ${err.message}`);
    return 'error';
  }
}

/** Parse `git worktree list --porcelain` into [{path, branch}, …]. */
function listWorktrees(sourceRoot) {
  let raw;
  try {
    raw = sh('git worktree list --porcelain', { cwd: sourceRoot });
  } catch {
    return [];
  }
  const entries = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), branch: '' };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === '' && cur) {
      entries.push(cur);
      cur = null;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

if (command === 'list') {
  console.log(sh('git worktree list', { cwd: root }));
  const sourceTarget = resolveSourceBrainTarget(root);
  if (sourceTarget) {
    const broken = [];
    for (const wt of listWorktrees(root)) {
      if (path.resolve(wt.path) === path.resolve(root)) continue;
      if (!fs.existsSync(wt.path)) continue;
      const wtLink = path.join(wt.path, 'skills', 'project-brain');
      let st;
      try { st = fs.lstatSync(wtLink); } catch { continue; }
      if (!st.isSymbolicLink()) continue;
      const resolves = fs.existsSync(path.join(wtLink, 'SKILL.md')) || fs.existsSync(path.join(wtLink, 'scripts'));
      if (!resolves) broken.push(wt.path);
    }
    if (broken.length) {
      console.log(`\n[brain:worktree] ${broken.length} worktree(s) have a broken skills/project-brain symlink:`);
      for (const p of broken) console.log(`  ${p}`);
      console.log(`Run: npm run brain:worktree -- repair`);
    }
  }
  process.exit(0);
}

if (command === 'repair') {
  const force = rest.includes('--force');
  const sourceTarget = resolveSourceBrainTarget(root);
  if (!sourceTarget) {
    console.log('[brain:worktree] source skills/project-brain is not a symlink (vendored/submodule); nothing to repair.');
    process.exit(0);
  }
  const wts = listWorktrees(root);
  let fixed = 0, ok = 0, missing = 0, skipped = 0;
  for (const wt of wts) {
    if (path.resolve(wt.path) === path.resolve(root)) continue;
    if (!fs.existsSync(wt.path)) { missing++; continue; }
    const result = fixBrainSymlinkInWorktree(wt.path, sourceTarget, { force });
    if (result === 'fixed' || result === 'forced') {
      fixed++;
      console.log(`  ${result}: ${wt.path}`);
    } else if (result === 'ok') {
      ok++;
    } else {
      skipped++;
    }
  }
  console.log(`[brain:worktree] repair: ${fixed} rewritten, ${ok} already ok, ${skipped} skipped, ${missing} missing on disk.`);
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

  // If the source repo uses the sibling-symlink layout for skills/project-brain,
  // the freshly-created worktree inherits the same relative target — which
  // almost always fails to resolve from the worktree's directory. Patch it to
  // an absolute symlink so `npm run brain:*` works without manual fix-up.
  const sourceTarget = resolveSourceBrainTarget(root);
  if (sourceTarget) {
    const result = fixBrainSymlinkInWorktree(wtPath, sourceTarget);
    if (result === 'fixed') {
      console.log(`  [worktree-symlink] rewrote skills/project-brain → ${sourceTarget}`);
    }
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
