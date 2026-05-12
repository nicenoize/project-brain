import { execSync, spawnSync } from 'node:child_process';
import { addWorkstream, activeStateJson, endWorkstream, releaseLeases } from './active-state.mjs';
import { slugify } from './common.mjs';

const args = process.argv.slice(2);
const command = args.shift() || 'status';
const opts = parseArgs(args);

if (opts.help || !['start', 'status', 'end'].includes(command)) {
  console.log(`Usage:
  npm run brain:work -- start --issue 123 --slug auth-hardening --actor codex --tool codex [--files lib/auth.ts,app/login.tsx] [--no-branch]
  npm run brain:work -- status [--json]
  npm run brain:work -- end --task issue-123-auth-hardening
`);
  process.exit(opts.help ? 0 : 1);
}

if (command === 'status') {
  const state = activeStateJson();
  if (opts.json) console.log(JSON.stringify(state, null, 2));
  else {
    console.log('Workstreams:');
    if (!state.workstreams.length) console.log('- none');
    for (const w of state.workstreams) console.log(`- ${w.taskId} | ${w.status || 'active'} | ${w.owner || 'unowned'} | ${w.branch || 'no branch'} | ${w.scope || ''}`);
    console.log('\nLeases:');
    if (!state.leases.length) console.log('- none');
    for (const l of state.leases) console.log(`- ${l.target} | ${l.lockedBy || 'unowned'} | ${l.notes || ''}`);
  }
}

if (command === 'start') {
  const issue = String(opts.issue || '').replace(/^#/, '');
  const slug = slugify(opts.slug || opts.title || args.join(' ') || 'work');
  const task = opts.task || (issue ? `issue-${issue}-${slug}` : `${slug}-${dateSlug()}`);
  const actor = opts.actor || process.env.BRAIN_ACTOR || 'agent';
  const tool = normalizeTool(opts.tool || process.env.BRAIN_TOOL || 'codex');
  const branchType = opts.type || 'feature';
  const branch = opts.branch || (issue ? `${branchType}/${issue}-${slug}` : `${branchType}/${slug}-${dateSlug()}`);
  const scope = opts.scope || (issue ? `#${issue} ${slug}` : slug);
  if (!opts.noBranch) ensureBranch(branch, opts.base || defaultBase());
  runNpm(['run', 'brain:session', '--', 'start', '--task', task, '--actor', actor, '--tool', tool]);
  addWorkstream({ taskId: task, owner: actor, tool, branch, scope, status: 'active' });
  const files = splitList(opts.files);
  for (const target of files) {
    runNpm(['run', 'brain:lease', '--', 'add', target, '--task', task, '--actor', actor, '--notes', `branch=${branch}`]);
  }
  const query = opts.query || `${slug} ${files.join(' ')}`.trim();
  const pack = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'brain:pack', '--', query, '--mode', 'resume', '--max-tokens', opts.maxTokens || '1200', '--task', task, '--actor', actor], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, BRAIN_TASK: task, BRAIN_ACTOR: actor }
  });
  console.log(`Started workstream ${task}`);
  console.log(`Branch: ${branch}`);
  console.log(`Actor/tool: ${actor}/${tool}`);
  if (files.length) console.log(`Leases: ${files.join(', ')}`);
  if (pack.stdout) {
    console.log('\n## Initial Context Pack\n');
    console.log(pack.stdout.trim());
  }
}

if (command === 'end') {
  const task = opts.task || process.env.BRAIN_TASK || '';
  if (!task) {
    console.error('brain:work end requires --task or BRAIN_TASK.');
    process.exit(1);
  }
  runNpm(['run', 'brain:session', '--', 'end', '--task', task]);
  endWorkstream(task, opts.status || 'done');
  releaseLeases({ taskId: task });
  console.log(`Ended workstream ${task}.`);
}

function ensureBranch(branch, base) {
  const current = sh('git rev-parse --abbrev-ref HEAD');
  if (current === branch) return;
  const branches = sh('git branch --list').split('\n').map(line => line.replace(/^\*?\s+/, '').trim());
  if (branches.includes(branch)) {
    execSync(`git switch ${q(branch)}`, { stdio: 'inherit' });
    return;
  }
  execSync(`git switch ${q(base)}`, { stdio: 'inherit' });
  execSync(`git switch -c ${q(branch)}`, { stdio: 'inherit' });
}

function defaultBase() {
  const branches = sh('git branch --list').split('\n').map(line => line.replace(/^\*?\s+/, '').trim());
  if (branches.includes('develop')) return 'develop';
  if (branches.includes('dev')) return 'dev';
  if (branches.includes('main')) return 'main';
  return sh('git rev-parse --abbrev-ref HEAD') || 'HEAD';
}

function runNpm(argv) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', argv, { stdio: 'inherit', env: process.env });
  if (result.status) process.exit(result.status);
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : '';
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-branch') { opts.noBranch = true; continue; }
    if (a === '--issue') { opts.issue = val; i += val ? 1 : 0; continue; }
    if (a === '--slug') { opts.slug = val; i += val ? 1 : 0; continue; }
    if (a === '--title') { opts.title = val; i += val ? 1 : 0; continue; }
    if (a === '--task') { opts.task = val; i += val ? 1 : 0; continue; }
    if (a === '--actor') { opts.actor = val; i += val ? 1 : 0; continue; }
    if (a === '--tool') { opts.tool = val; i += val ? 1 : 0; continue; }
    if (a === '--type') { opts.type = val; i += val ? 1 : 0; continue; }
    if (a === '--branch') { opts.branch = val; i += val ? 1 : 0; continue; }
    if (a === '--base') { opts.base = val; i += val ? 1 : 0; continue; }
    if (a === '--scope') { opts.scope = val; i += val ? 1 : 0; continue; }
    if (a === '--files') { opts.files = val; i += val ? 1 : 0; continue; }
    if (a === '--query') { opts.query = val; i += val ? 1 : 0; continue; }
    if (a === '--max-tokens') { opts.maxTokens = val; i += val ? 1 : 0; continue; }
    if (a === '--status') { opts.status = val; i += val ? 1 : 0; continue; }
    positional.push(a);
  }
  opts.title ||= positional.join(' ').trim();
  return opts;
}

function splitList(value) {
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function normalizeTool(value) {
  const v = String(value || '').toLowerCase().trim();
  if (['cursor', 'claude', 'gemini', 'codex', 'human', 'other'].includes(v)) return v;
  if (v === 'claude-code') return 'claude';
  if (v === 'openai' || v === 'codex-cli' || v === 'gpt') return 'codex';
  return v ? 'other' : 'codex';
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dateSlug() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}
