/**
 * PR-body assembler: synthesizes a structured PR description from the
 * current branch's commits, the workstream row in active_state.md, and
 * the issue (if linked). Writes the body to a file or stdout so the
 * developer/agent can paste or `gh pr create --body-file`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { activeStateJson } from './active-state.mjs';
import { BRAIN_DIR, ROOT, ensureDir, exists, read, write } from './common.mjs';
import { parseFeatureSpec, workstreamMatchesFeature } from './feature-spec.mjs';

const KNOWN_COMMANDS = ['prepare', 'stage'];

const args = process.argv.slice(2);
const command = KNOWN_COMMANDS.includes(args[0]) ? args.shift() : 'prepare';
const opts = parseArgs(args);

if (opts.help) {
  console.log(`Usage:
  npm run brain:pr -- prepare [--task issue-123-auth] [--write <path>] [--github]
  npm run brain:pr -- stage   --feature <slug> [--write] [--out <dir>]
`);
  process.exit(0);
}

if (command === 'prepare') {
  const body = buildPrBody(opts);
  if (opts.write) {
    write(opts.write, body);
    console.log(`Wrote ${opts.write}`);
  }
  if (opts.github) createOrUpdatePr(body, opts);
  else console.log(body);
} else if (command === 'stage') {
  stageFeaturePrs(opts);
}

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
    if (a === '--feature') { opts.feature = val; i += val ? 1 : 0; continue; }
    if (a === '--out') { opts.out = val; i += val ? 1 : 0; continue; }
  }
  return opts;
}

/**
 * Stage one PR body per project for a multi-repo feature. Reads the spec at
 * .project-brain/features/<slug>.md, finds the linked workstreams in
 * active_state.md (one per project), and writes one body per project to
 * .project-brain/pr-bodies/<slug>-<project>.md (or --out dir).
 */
function stageFeaturePrs(o) {
  const slug = (o.feature || '').trim();
  if (!slug) {
    process.stderr.write('[brain:pr] stage requires --feature <slug>\n');
    process.exit(1);
  }
  const specPath = path.join(BRAIN_DIR, 'features', `${slug}.md`);
  if (!exists(specPath)) {
    process.stderr.write(`[brain:pr] feature spec not found: ${path.relative(ROOT, specPath)}\n`);
    process.exit(1);
  }
  const specBody = read(specPath);
  const meta = parseFeatureSpec(specBody);
  const featureTitle = meta.title || slug;
  const issue = meta.issue || '';

  const state = (() => { try { return activeStateJson(); } catch { return { workstreams: [], leases: [] }; } })();
  const linked = state.workstreams.filter(w => workstreamMatchesFeature(w, slug));

  const projectBranches = new Map();
  for (const w of linked) {
    if (w.project && w.branch) projectBranches.set(w.project, w.branch);
  }

  let projectList = (meta.projects || []).slice();
  if (!projectList.length && projectBranches.size) {
    projectList = [...projectBranches.keys()];
  }
  if (!projectList.length) {
    // Single-project fallback: emit one body labeled "this-repo".
    const curBranch = linked[0]?.branch || sh('git rev-parse --abbrev-ref HEAD') || 'unknown';
    projectList = ['this-repo'];
    projectBranches.set('this-repo', curBranch);
  }

  const outDir = o.out || path.join(BRAIN_DIR, 'pr-bodies');
  const bodies = [];
  for (const project of projectList) {
    const branch = projectBranches.get(project) || (issue ? `feature/${issue}-${slug}` : `feature/${slug}`);
    const body = renderStageBody({
      slug,
      title: featureTitle,
      issue,
      project,
      projects: projectList,
      projectBranches,
      branch,
      specPath: path.relative(ROOT, specPath),
      hasContractChanges: /^##\s+Contract changes/m.test(specBody)
    });
    bodies.push({ project, branch, body });

    if (o.write) {
      ensureDir(outDir);
      const outPath = path.join(outDir, `${slug}-${project}.md`);
      write(outPath, body);
      console.log(`Wrote ${path.relative(ROOT, outPath)}`);
    }
  }

  if (!o.write) {
    for (const { project, body } of bodies) {
      console.log(`\n=== ${project} ===\n`);
      console.log(body);
    }
  }
}

function renderStageBody({ slug, title, issue, project, projects, projectBranches, branch, specPath, hasContractChanges }) {
  const lines = [
    '## Summary',
    '',
    `Part of feature [\`${slug}\`](${specPath}) — ${title}.`,
    `Project: \`${project}\`. Branch: \`${branch}\`.`,
    '',
    '## Cross-repo coordination',
    '',
    `This PR is one of ${projects.length} linked PR${projects.length === 1 ? '' : 's'} for this feature.`,
    ...(projects.length > 1 ? ['Linked branches (keep consistent across repos):', ''] : []),
  ];
  if (projects.length > 1) {
    for (const p of projects) {
      const b = projectBranches.get(p) || branch;
      const marker = p === project ? ' ← **this PR**' : '';
      lines.push(`- \`${p}\`: \`${b}\`${marker}`);
    }
    lines.push('');
    lines.push('## Merge order');
    lines.push('');
    lines.push('Contract / schema changes (proto / openapi / shared types) merge first; downstream consumers follow.');
    lines.push('');
  }
  lines.push('## Verification');
  lines.push('');
  lines.push('- [ ] `npm run brain:guard`');
  lines.push('- [ ] Lint/typecheck/test from `repo_context.md`');
  if (projects.length > 1) lines.push('- [ ] Cross-project consumers checked (`npm run brain:edges`)');
  lines.push('- [ ] Feature spec acceptance criteria met');
  lines.push('');
  if (hasContractChanges) {
    lines.push('## ⚠️ Contract changes');
    lines.push('');
    lines.push(`The feature spec lists contract changes — review the **Contract changes** section in [\`${specPath}\`](${specPath}) and confirm every downstream consumer in this PR.`);
    lines.push('');
  }
  lines.push('## Feature spec');
  lines.push('');
  lines.push(`See [\`${specPath}\`](${specPath}) for goal, constraints, and acceptance criteria.`);
  lines.push('');
  if (issue) lines.push(`Closes #${issue}`);
  else lines.push('<!-- Add Closes #<issue> if applicable -->');
  lines.push('');
  return lines.join('\n');
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
