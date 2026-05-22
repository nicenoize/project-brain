/**
 * PR-body assembler: synthesizes a structured PR description from the
 * current branch's commits, the workstream row in active_state.md, and
 * the issue (if linked). Writes the body to a file or stdout so the
 * developer/agent can paste or `gh pr create --body-file`.
 */
import fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { activeStateJson } from './active-state.mjs';
import { read, write } from './common.mjs';

const args = process.argv.slice(2);
const command = args[0] === 'prepare' ? args.shift() : 'prepare';
const opts = parseArgs(args);

if (opts.help || command !== 'prepare') {
  console.log(`Usage:
  npm run brain:pr -- prepare [--task issue-123-auth] [--write .project-brain/pr-body.md] [--github]
`);
  process.exit(opts.help ? 0 : 1);
}

const body = buildPrBody(opts);
if (opts.write) {
  write(opts.write, body);
  console.log(`Wrote ${opts.write}`);
}
if (opts.github) createOrUpdatePr(body, opts);
else console.log(body);

function buildPrBody(opts) {
  const branch = sh('git rev-parse --abbrev-ref HEAD') || 'unknown';
  const base = opts.base || inferBase(branch);
  const files = changedFiles(base);
  const state = activeStateJson();
  const task = opts.task || process.env.BRAIN_TASK || inferTask(branch, state.workstreams);
  const workstream = state.workstreams.find(w => w.taskId === task) || null;
  const commits = sh(`git log --oneline ${q(base)}..HEAD`).split('\n').filter(Boolean).slice(0, 20);
  const sessions = listSessionFiles(task);
  const modules = touchedModules(files);
  const tests = files.filter(f => /(^|\/)(__tests__|tests?|e2e)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
  const brainFiles = files.filter(f => f.startsWith('.project-brain/'));
  const issue = branch.match(/\/(\d+)-/)?.[1] || task.match(/issue-(\d+)/)?.[1] || '';

  return [
    '## Summary',
    ...summaryBullets(commits, files),
    '',
    '## Project Brain',
    `- Task: ${task ? `\`${task}\`` : 'Needs Review'}`,
    `- Workstream: ${workstream ? `${workstream.owner || 'unowned'} / ${workstream.status || 'active'}` : 'Needs Review'}`,
    `- Modules: ${modules.length ? modules.map(m => `\`${m}\``).join(', ') : 'Needs Review'}`,
    `- Sessions: ${sessions.length ? sessions.map(s => `\`${s}\``).join(', ') : 'None found'}`,
    '',
    '## Changed Files',
    ...(files.length ? files.map(f => `- \`${f}\``) : ['- None detected against base']),
    '',
    '## Verification',
    '- [ ] `npm run brain:guard`',
    '- [ ] Relevant lint/typecheck/test commands from `.project-brain/repo_context.md`',
    brainFiles.length ? '- [x] Project Brain docs updated' : '- [ ] Project Brain docs updated or not needed',
    tests.length ? `- [x] Test files changed: ${tests.map(t => `\`${t}\``).join(', ')}` : '- [ ] Tests added/updated or explicitly not needed',
    '',
    '## Risks / Review Focus',
    ...riskBullets(files),
    '',
    issue ? `Closes #${issue}` : '<!-- Add Closes #issue when applicable -->',
    ''
  ].join('\n');
}

function createOrUpdatePr(body, opts) {
  const gh = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (gh.status !== 0) {
    console.error('brain:pr --github requires gh installed and authenticated.');
    process.exit(1);
  }
  const title = opts.title || sh('git log -1 --pretty=%s') || 'Project Brain PR';
  const base = opts.base || inferBase(sh('git rev-parse --abbrev-ref HEAD'));
  const result = spawnSync('gh', ['pr', 'create', '--draft', '--base', base, '--title', title, '--body', body], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'gh pr create failed\n');
    process.exit(result.status || 1);
  }
  console.log(result.stdout.trim());
}

function summaryBullets(commits, files) {
  if (commits.length) return commits.slice(0, 5).map(c => `- ${c.replace(/^[a-f0-9]+\s+/, '')}`);
  if (files.length) return [`- Updated ${files.length} file(s).`];
  return ['- Needs Review'];
}

function riskBullets(files) {
  const risks = [];
  if (files.length > 12) risks.push('- Large file set; review package boundaries and hidden coupling.');
  if (files.some(f => f.startsWith('.project-brain/active_state.md'))) risks.push('- `active_state.md` changed; check for merge conflicts with other agents.');
  if (files.some(f => /\.(config|env)\.[cm]?[jt]s$/.test(f))) risks.push('- Config/env files changed; check deployment impact.');
  if (!risks.length) risks.push('- Needs Review');
  return risks;
}

function changedFiles(base) {
  const out = sh(`git diff --name-only ${q(base)}...HEAD`);
  const tracked = out ? out.split('\n').filter(Boolean) : sh('git diff --name-only HEAD').split('\n').filter(Boolean);
  const untracked = sh('git ls-files --others --exclude-standard').split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter(isReviewablePath);
}

function isReviewablePath(file) {
  return ![
    /^\.project-brain\/\.sync-state\.json$/,
    /^\.project-brain\/runner-logs\//,
    /^\.project-brain\/sessions\//,
    /^\.project-brain\/search_index\.json$/,
    /^\.project-brain\/index_manifest\.json$/,
    /^\.project-brain\/vector-db\//
  ].some(pattern => pattern.test(file));
}

function touchedModules(files) {
  return [...new Set(files.map(f => {
    const parts = f.split('/');
    if (parts[0] === '.project-brain' && parts[1]) return `.project-brain/${parts[1]}`;
    if (['app', 'pages', 'components', 'lib', 'src', 'server', 'scripts', 'packages', 'apps'].includes(parts[0])) return parts.slice(0, 2).join('/');
    return parts[0] || '';
  }).filter(Boolean))].slice(0, 20);
}

function listSessionFiles(task) {
  if (!task) return [];
  if (!fs.existsSync('.project-brain/sessions')) return [];
  return fs.readdirSync('.project-brain/sessions')
    .filter(file => file.endsWith('.md') && (!task || file.includes(task) || read(`.project-brain/sessions/${file}`).includes(`task_id: "${task}"`)))
    .map(file => `.project-brain/sessions/${file}`)
    .slice(0, 8);
}

function inferTask(branch, workstreams) {
  const issue = branch.match(/\/(\d+)-([a-z0-9-]+)/);
  if (issue) {
    const prefix = `issue-${issue[1]}`;
    const found = workstreams.find(w => w.taskId.startsWith(prefix));
    if (found) return found.taskId;
    return `issue-${issue[1]}-${issue[2]}`;
  }
  const found = workstreams.find(w => w.branch === branch);
  return found?.taskId || '';
}

function inferBase(branch) {
  if (/^release\//.test(branch) || /^hotfix\//.test(branch)) return branchExists('main') ? 'main' : 'master';
  if (branchExists('develop')) return 'develop';
  if (branchExists('dev')) return 'dev';
  return branchExists('main') ? 'main' : 'master';
}

function branchExists(name) {
  return Boolean(sh(`git rev-parse --verify ${q(name)}`));
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : '';
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--github') { opts.github = true; continue; }
    if (a === '--task') { opts.task = val; i += val ? 1 : 0; continue; }
    if (a === '--base') { opts.base = val; i += val ? 1 : 0; continue; }
    if (a === '--title') { opts.title = val; i += val ? 1 : 0; continue; }
    if (a === '--write') { opts.write = val || '.project-brain/pr-body.md'; i += val ? 1 : 0; continue; }
  }
  return opts;
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
