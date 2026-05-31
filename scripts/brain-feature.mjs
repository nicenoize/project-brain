/**
 * Cross-repo feature coordination.
 *
 * `start --slug X --projects a,b,c [--issue 123]` scaffolds a multi-repo
 * feature spec at .project-brain/features/<slug>.md, spawns one git
 * worktree per named project on a consistent branch (<type>/<issue>-<slug>),
 * and registers one workstream per project in active_state.md.
 *
 * `status [--slug X]` lists tracked features with their linked branches
 * and active workstreams.
 *
 * `end --slug X` ends the linked workstreams and releases leases tagged
 * with the feature. Worktrees are left in place (remove with
 * `brain:worktree -- remove <path>`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BRAIN_DIR,
  ROOT,
  ensureDir,
  exists,
  read,
  write,
  takeFlag,
  takeOption,
  slugify
} from './common.mjs';
import {
  activeStateJson,
  addWorkstream,
  endWorkstream,
  releaseLeases
} from './active-state.mjs';
import { discoverProjects, isFleetMode } from './projects.mjs';
import { parseFeatureSpec, workstreamMatchesFeature } from './feature-spec.mjs';

const FEATURES_DIR = path.join(BRAIN_DIR, 'features');

const args = process.argv.slice(2);
const command = args.shift() || 'status';
const help = takeFlag(args, '--help') || takeFlag(args, '-h');

if (help || !['start', 'status', 'end'].includes(command)) {
  printUsage();
  process.exit(help ? 0 : 1);
}

try {
  if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'end') await endFeature();
} catch (error) {
  process.stderr.write(`[brain:feature] ${error.message || error}\n`);
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  npm run brain:feature -- start --slug <name> [--projects a,b,c] [--issue 123]
                                  [--title "..."] [--base develop] [--type feature|fix|refactor|chore|docs|test]
                                  [--actor me] [--no-worktrees] [--json]
  npm run brain:feature -- status [--slug <name>] [--json]
  npm run brain:feature -- end --slug <name> [--status done|cancelled] [--json]

start:
  Creates .project-brain/features/<slug>.md, spawns one worktree per project
  on branch <type>/<issue>-<slug>, and registers one workstream per project.

  In fleet mode, --projects is required (comma-list of discovered project names).
  In single-project mode, --projects is ignored; the current repo is the target.

  Pass --no-worktrees to skip worktree spawning (useful for tests or when
  you'll spawn them later via brain:worktree).

end:
  Closes the linked workstreams and releases their leases. Worktrees stay.`);
}

async function start() {
  const slug = slugify(takeOption(args, '--slug') || '');
  if (!slug) {
    process.stderr.write('[brain:feature] start requires --slug <name>\n');
    process.exit(1);
  }
  const issue = String(takeOption(args, '--issue') || '').replace(/^#/, '');
  const projectsArg = takeOption(args, '--projects') || '';
  const title = takeOption(args, '--title') || slug.replace(/-/g, ' ');
  const base = takeOption(args, '--base') || '';
  const type = takeOption(args, '--type') || 'feature';
  const actor = takeOption(args, '--actor') || process.env.BRAIN_ACTOR || process.env.USER || 'me';
  const noWorktrees = takeFlag(args, '--no-worktrees');
  const asJson = takeFlag(args, '--json');

  const discovered = discoverProjects(ROOT);
  const fleet = isFleetMode(discovered);
  const requested = projectsArg.split(',').map(s => s.trim()).filter(Boolean);
  const targetProjects = resolveTargetProjects(fleet, discovered, requested);

  const branch = issue ? `${type}/${issue}-${slug}` : `${type}/${slug}`;
  const taskIdBase = issue ? `issue-${issue}-${slug}` : `feature-${slug}`;

  ensureDir(FEATURES_DIR);
  const specPath = path.join(FEATURES_DIR, `${slug}.md`);
  if (exists(specPath)) {
    process.stderr.write(`[brain:feature] feature spec already exists: ${path.relative(ROOT, specPath)}\n`);
    process.stderr.write('Pick a different --slug or end the existing feature first.\n');
    process.exit(1);
  }
  const spec = renderFeatureSpec({ slug, title, issue, branch, projects: targetProjects, actor });
  write(specPath, spec);

  const worktrees = [];
  if (!noWorktrees) {
    for (const proj of targetProjects) {
      const result = spawnWorktree({ project: proj, branch, base, type, slug, issue });
      worktrees.push({ project: proj, ...result });
    }
  }

  for (const proj of targetProjects) {
    const taskId = fleet ? `${taskIdBase}-${proj}` : taskIdBase;
    addWorkstream({
      taskId,
      owner: actor,
      tool: process.env.BRAIN_TOOL || 'human',
      project: fleet ? proj : '',
      branch,
      scope: `feature ${slug}${issue ? ` (#${issue})` : ''}`,
      status: 'active'
    });
  }

  if (asJson) {
    console.log(JSON.stringify({
      slug,
      branch,
      specPath: path.relative(ROOT, specPath),
      projects: targetProjects,
      worktrees
    }, null, 2));
  } else {
    console.log(`Feature started: ${slug}`);
    console.log(`  Branch: ${branch}`);
    console.log(`  Spec: ${path.relative(ROOT, specPath)}`);
    console.log(`  Projects: ${targetProjects.map(p => p === '.' ? '(this repo)' : p).join(', ')}`);
    for (const wt of worktrees) {
      const label = wt.project === '.' ? '(this repo)' : wt.project;
      console.log(`  - ${label}: ${wt.path || '(no worktree)'}${wt.error ? ` — ${wt.error}` : ''}`);
    }
    if (noWorktrees) console.log('  (worktrees skipped per --no-worktrees)');
    console.log(`\nNext: cd into a worktree, edit the spec at ${path.relative(ROOT, specPath)}, run brain:work or brain:pack as usual.`);
  }
}

async function status() {
  const slug = takeOption(args, '--slug');
  const asJson = takeFlag(args, '--json');
  if (!exists(FEATURES_DIR)) {
    if (asJson) console.log('[]');
    else console.log('No features tracked.');
    return;
  }
  const state = safeActiveState();
  const files = slug
    ? [path.join(FEATURES_DIR, `${slugify(slug)}.md`)]
    : fs.readdirSync(FEATURES_DIR).filter(f => f.endsWith('.md')).map(f => path.join(FEATURES_DIR, f));
  const features = [];
  for (const file of files) {
    if (!exists(file)) continue;
    const body = read(file);
    const meta = parseFeatureSpec(body);
    const baseName = path.basename(file, '.md');
    const featureSlug = meta.feature || baseName;
    const linked = state.workstreams.filter(w => workstreamMatchesFeature(w, featureSlug));
    features.push({
      slug: featureSlug,
      title: meta.title || '',
      issue: meta.issue || '',
      status: meta.status || 'unknown',
      file: path.relative(ROOT, file),
      projects: meta.projects || [],
      branches: [...new Set(linked.map(w => w.branch).filter(Boolean))],
      workstreams: linked
    });
  }
  if (asJson) console.log(JSON.stringify(features, null, 2));
  else printStatusText(features);
}

function printStatusText(features) {
  if (!features.length) {
    console.log('No features match.');
    return;
  }
  for (const f of features) {
    console.log(`${f.slug}${f.issue ? ` (#${f.issue})` : ''} — ${f.title}`);
    console.log(`  file: ${f.file}`);
    console.log(`  status: ${f.status}`);
    if (f.projects.length) console.log(`  projects: ${f.projects.join(', ')}`);
    if (f.branches.length) console.log(`  branches: ${f.branches.join(', ')}`);
    if (f.workstreams.length) {
      console.log(`  workstreams:`);
      for (const w of f.workstreams) {
        console.log(`    - ${w.taskId} | ${w.status || 'active'} | ${w.project || '(no project)'}`);
      }
    }
    console.log('');
  }
}

async function endFeature() {
  const slug = slugify(takeOption(args, '--slug') || '');
  const newStatus = takeOption(args, '--status') || 'done';
  const asJson = takeFlag(args, '--json');
  if (!slug) {
    process.stderr.write('[brain:feature] end requires --slug <name>\n');
    process.exit(1);
  }
  const state = safeActiveState();
  const linked = state.workstreams.filter(w => workstreamMatchesFeature(w, slug));
  if (!linked.length) {
    process.stderr.write(`[brain:feature] no workstreams found for feature "${slug}"\n`);
    process.exit(1);
  }
  for (const w of linked) {
    endWorkstream(w.taskId, newStatus);
    releaseLeases({ taskId: w.taskId });
  }
  if (asJson) {
    console.log(JSON.stringify({ slug, status: newStatus, ended: linked.map(w => w.taskId) }, null, 2));
  } else {
    console.log(`Feature ${slug} ended (${newStatus}).`);
    for (const w of linked) console.log(`  - ${w.taskId}`);
  }
}

// ---- helpers ----

function safeActiveState() {
  try { return activeStateJson(); }
  catch { return { workstreams: [], leases: [], blockers: [], overlaps: [] }; }
}

function resolveTargetProjects(fleet, discovered, requested) {
  if (!fleet) return ['.'];
  if (!requested.length) {
    process.stderr.write('[brain:feature] start in fleet mode requires --projects a,b,c\n');
    process.stderr.write(`Available: ${discovered.map(p => p.name).join(', ')}\n`);
    process.exit(1);
  }
  const names = new Set(discovered.map(p => p.name));
  const missing = requested.filter(name => !names.has(name));
  if (missing.length) {
    process.stderr.write(`[brain:feature] unknown projects: ${missing.join(', ')}\n`);
    process.stderr.write(`Available: ${discovered.map(p => p.name).join(', ')}\n`);
    process.exit(1);
  }
  return requested;
}

function spawnWorktree({ project, branch, base, type, slug, issue }) {
  const argv = [
    'run', 'brain:worktree', '--', 'spawn',
    '--type', type,
    '--slug', slug,
    '--count', '1',
    '--json'
  ];
  if (project !== '.') argv.push('--project', project);
  if (issue) argv.push('--issue', issue);
  if (base) argv.push('--base', base);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, argv, { encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || 'worktree failed').trim().split('\n').pop();
    return { path: '', branch, error: tail };
  }
  try {
    // brain:worktree --json prints JSON, but `npm run` prefixes lines (banner).
    // Try to extract the JSON object by finding the first '{'.
    const idx = r.stdout.indexOf('{');
    if (idx === -1) return { path: '', branch, error: 'no JSON in brain:worktree output' };
    const parsed = JSON.parse(r.stdout.slice(idx));
    const worker = (parsed.workers || [])[0];
    return { path: worker?.path || '', branch: worker?.branch || branch };
  } catch (err) {
    return { path: '', branch, error: `could not parse brain:worktree JSON: ${err.message}` };
  }
}

function renderFeatureSpec({ slug, title, issue, branch, projects, actor }) {
  const today = new Date().toISOString().slice(0, 10);
  const projectsYaml = projects.length && projects[0] !== '.'
    ? projects.map(p => `  - ${p}`).join('\n')
    : '  - (single-project)';
  const projectTableRows = projects.map(p =>
    `| ${p === '.' ? '(this repo)' : p} | \`${branch}\` | active |`
  ).join('\n');
  return `---
title: ${title}
status: draft
feature: ${slug}
issue: ${issue || ''}
date: ${today}
owner: ${actor}
projects:
${projectsYaml}
---

# ${title}

## Goal

_Needs Review_

## Constraints

_Needs Review_

## Acceptance criteria

- [ ] _Needs Review_

## Implementation notes

_Needs Review_

## Cross-project coordination

| project | branch | status |
|---|---|---|
${projectTableRows}

Branch convention: \`${branch}\` in each project. Keep branch names consistent across repos so reviewers can correlate PRs.

## Contract changes

List proto / openapi / shared-types changes here. \`brain:edges\` detects downstream consumers; surface them in PR bodies via \`brain:pr -- stage --feature ${slug}\`.

## Decisions

Record durable choices in \`.project-brain/decisions/\` with \`feature: ${slug}\` in the frontmatter. They surface alongside this spec in retrieval.

## Status log

- ${today} — Feature started by ${actor}.
`;
}

