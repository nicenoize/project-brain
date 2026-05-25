/**
 * brain:speckit — bridge from github/spec-kit artifacts into Project Brain.
 *
 * Subcommands:
 *   import <id>    Mirror specs/<id>/spec.md into .project-brain/features/<id>.md
 *                  with brain's frontmatter + cross-links (advisory copy;
 *                  spec.md remains canonical).
 *   tasks  <id>    Parse specs/<id>/tasks.md ("- [ ] T### [P?] [USn] …") and
 *                  emit one .project-brain/work-packages/spec-<id>-wpN.md per
 *                  user-story group, reusing brain-ticket buildPlan/render.
 *                  --github creates GitHub issues; --write writes files.
 *   analyze <id>   If specs/<id>/analyze.md exists, scaffold ADRs via brain:adr.
 *
 * Activation: runs anywhere, but each subcommand checks for the expected
 * spec-kit paths and prints a "spec-kit not initialized; run `specify init` first"
 * message instead of throwing when they're missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, BRAIN_DIR, ensureDir, exists, read, write, takeFlag, takeOption } from './common.mjs';
import { buildPlan, renderMarkdown } from './brain-ticket.mjs';

const args = process.argv.slice(2);
const command = ['import', 'tasks', 'analyze'].includes(args[0]) ? args.shift() : '';
const opts = {
  json: takeFlag(args, '--json'),
  write: takeFlag(args, '--write'),
  github: takeFlag(args, '--github'),
  help: takeFlag(args, '--help') || takeFlag(args, '-h'),
  base: takeOption(args, '--base') || 'develop',
  tool: takeOption(args, '--tool') || process.env.BRAIN_TOOL || 'codex',
  actor: takeOption(args, '--actor') || process.env.BRAIN_ACTOR || ''
};
const id = args[0] || '';

if (opts.help || !command || !id) {
  console.log(`Usage:
  npm run brain:speckit -- import  <id>           Pull specs/<id>/spec.md into .project-brain/features/<id>.md
  npm run brain:speckit -- tasks   <id> [--write] [--github]
  npm run brain:speckit -- analyze <id>           Scaffold ADRs from specs/<id>/analyze.md (if any)

Options:
  --write     Write the work-packages to .project-brain/work-packages/ (tasks subcommand)
  --github    Open one GitHub issue per work-package via gh (tasks subcommand)
  --base x    GitFlow base branch for generated work-packages (default: develop)
  --tool x    Suggested worker tool (default: codex; honored: cursor|claude|gemini|codex)
  --actor x   Suggested owner label (default: $BRAIN_ACTOR)
  --json      Print JSON to stdout instead of Markdown
`);
  process.exit(opts.help ? 0 : 1);
}

if (!checkSpeckit(id, command)) process.exit(1);

if (command === 'import') runImport(id);
else if (command === 'tasks') runTasks(id, opts);
else if (command === 'analyze') runAnalyze(id);

// ---------- import ----------

function runImport(featureId) {
  const specPath = path.join(ROOT, 'specs', featureId, 'spec.md');
  const planPath = path.join(ROOT, 'specs', featureId, 'plan.md');
  const tasksPath = path.join(ROOT, 'specs', featureId, 'tasks.md');
  const specText = read(specPath);
  const parsed = parseSpec(specText);

  const featuresDir = path.join(BRAIN_DIR, 'features');
  ensureDir(featuresDir);
  const target = path.join(featuresDir, `${featureId}.md`);
  const body = renderFeatureDoc(featureId, parsed, {
    specPath: rel(specPath),
    planPath: exists(planPath) ? rel(planPath) : '',
    tasksPath: exists(tasksPath) ? rel(tasksPath) : ''
  });
  write(target, body);
  console.log(`Wrote ${path.relative(ROOT, target)}`);
}

function parseSpec(text) {
  const lines = text.split('\n');
  let title = '';
  const titleMatch = text.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/m);
  if (titleMatch) title = titleMatch[1].replace(/^\[|\]$/g, '').trim();

  // Functional + Success requirement lines (markdown-bold ids).
  const fr = [];
  for (const m of text.matchAll(/^\s*-\s*\*\*FR-\d+\*\*:\s*(.+)$/gm)) fr.push(m[1].trim());
  const sc = [];
  for (const m of text.matchAll(/^\s*-\s*\*\*SC-\d+\*\*:\s*(.+)$/gm)) sc.push(m[1].trim());

  // User-story headings + priorities.
  const stories = [];
  for (const m of text.matchAll(/^###\s+(User Story\s+\d+\s*-\s*[^(]+)\s*\((Priority:\s*[^)]+)\)/gm)) {
    stories.push({ title: m[1].trim(), priority: m[2].replace(/^Priority:\s*/i, '').trim() });
  }

  // NEEDS CLARIFICATION markers anywhere in the document.
  const clarifications = [];
  for (const m of text.matchAll(/\[NEEDS CLARIFICATION:\s*([^\]]+)\]/g)) clarifications.push(m[1].trim());

  // Status line from spec-kit header.
  let status = 'draft';
  const statusMatch = text.match(/^\*\*Status\*\*:\s*(.+)$/m);
  if (statusMatch) status = statusMatch[1].trim().toLowerCase();

  return { title, status, stories, fr, sc, clarifications };
}

function renderFeatureDoc(featureId, parsed, paths) {
  const date = new Date().toISOString().slice(0, 10);
  const title = parsed.title || featureId;
  const frontmatter = [
    '---',
    `title: ${escapeFm(title)}`,
    `status: ${parsed.status || 'draft'}`,
    `layer: feature`,
    `feature: ${featureId}`,
    `last_updated: ${date}`,
    `spec_source: ${paths.specPath}`,
    '---'
  ].join('\n');

  const links = [
    `> **Source:** [\`${paths.specPath}\`](../../${paths.specPath}) (spec-kit)`
  ];
  if (paths.planPath) links.push(`> **Technical plan:** [\`${paths.planPath}\`](../../${paths.planPath})`);
  if (paths.tasksPath) links.push(`> **Tasks:** [\`${paths.tasksPath}\`](../../${paths.tasksPath})`);

  const stories = parsed.stories.length
    ? ['## User stories', ...parsed.stories.map(s => `- ${s.title} _(${s.priority})_`)].join('\n')
    : '';
  const accept = (parsed.fr.length || parsed.sc.length)
    ? ['## Acceptance summary',
        ...(parsed.fr.length ? ['', '**Functional:**', ...parsed.fr.slice(0, 12).map(line => `- ${line}`)] : []),
        ...(parsed.sc.length ? ['', '**Success criteria:**', ...parsed.sc.slice(0, 12).map(line => `- ${line}`)] : [])
      ].join('\n')
    : '';
  const open = parsed.clarifications.length
    ? ['## Open questions', ...parsed.clarifications.slice(0, 12).map(line => `- ${line}`)].join('\n')
    : '';

  const notes = paths.planPath
    ? `## Implementation notes\n\n- See \`${paths.planPath}\` for technical context, project structure, and complexity tracking.`
    : '';

  return [
    frontmatter,
    '',
    `# ${title}`,
    '',
    links.join('\n'),
    '',
    stories,
    accept ? '\n' + accept : '',
    open ? '\n' + open : '',
    notes ? '\n' + notes : ''
  ].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- tasks ----------

function runTasks(featureId, opts) {
  const tasksPath = path.join(ROOT, 'specs', featureId, 'tasks.md');
  const text = read(tasksPath);
  const groups = parseTasks(text);
  if (!groups.length) {
    console.error(`No parseable tasks found in ${rel(tasksPath)}. Expected lines like "- [ ] T001 [P] [US1] description".`);
    process.exit(1);
  }

  // One brain work-package per user-story group.
  const packageCount = groups.length;
  const allFiles = [...new Set(groups.flatMap(g => g.files))];
  const slug = `spec-${featureId}`;
  const plan = buildPlan({
    title: `Spec-kit feature ${featureId}`,
    slug,
    summary: `Implement spec-kit feature ${featureId} as ${packageCount} user-story-scoped work package(s).`,
    packageCount,
    files: allFiles,
    modules: [],
    labels: ['agent-ready', 'spec-kit', `spec-kit:${featureId}`],
    actor: opts.actor,
    tool: opts.tool,
    base: opts.base,
    maxFiles: 8
  });

  // Annotate each package with the actual tasks from tasks.md.
  for (let i = 0; i < plan.packages.length; i++) {
    const group = groups[i];
    plan.packages[i].title = `${group.userStory}: ${plan.packages[i].title}`;
    plan.packages[i].speckitTasks = group.tasks;
    plan.packages[i].parallelizable = group.tasks.filter(t => t.parallel).map(t => t.id);
  }

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (opts.write) {
    const dir = path.join(BRAIN_DIR, 'work-packages');
    ensureDir(dir);
    for (const pkg of plan.packages) {
      const target = path.join(dir, `${pkg.id}.md`);
      write(target, renderPackageMarkdown(plan, pkg));
      console.log(`Wrote ${path.relative(ROOT, target)}`);
    }
  } else {
    console.log(renderMarkdown(plan));
  }

  if (opts.github) {
    openGithubIssues(plan, featureId);
  }
}

function parseTasks(text) {
  // Lines like: "- [ ] T001 [P] [US1] Description with src/path.ts"
  const lines = text.split('\n');
  const groups = new Map();
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\[[ x]\]\s+(T\d+)(?:\s+\[P\])?\s+\[(US\d+)\]\s+(.+)$/i);
    if (!m) continue;
    const [, id, story, descRaw] = m;
    const parallel = /\[P\]/i.test(line);
    const desc = descRaw.trim();
    const files = [...desc.matchAll(/([a-zA-Z0-9_\-./]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|tf|ya?ml|json|md))/g)].map(x => x[1]);
    if (!groups.has(story)) groups.set(story, { userStory: story, tasks: [], files: new Set() });
    const g = groups.get(story);
    g.tasks.push({ id, story, parallel, description: desc, files });
    for (const f of files) g.files.add(f);
  }
  return [...groups.values()].map(g => ({ ...g, files: [...g.files] }));
}

function renderPackageMarkdown(plan, pkg) {
  const taskRows = (pkg.speckitTasks || [])
    .map(t => `- ${t.parallel ? '[P] ' : ''}**${t.id}**: ${t.description}`)
    .join('\n');
  return [
    `# ${pkg.title}`,
    '',
    `**Branch:** \`${pkg.branch}\``,
    `**Task ID:** \`${pkg.taskId}\``,
    `**Actor/tool:** ${pkg.actor} / ${pkg.tool}`,
    `**Base:** ${pkg.base}`,
    pkg.dependsOn.length ? `**Depends on:** ${pkg.dependsOn.join(', ')}` : '',
    '',
    `## Objective`, pkg.objective,
    '',
    `## Spec-kit tasks`, taskRows || '- (no tasks)',
    pkg.parallelizable?.length ? `\nParallelizable: ${pkg.parallelizable.join(', ')}` : '',
    '',
    `## Acceptance`, pkg.acceptanceCriteria.map(line => `- ${line}`).join('\n'),
    '',
    `## Verification`, pkg.verification.map(line => `- ${line}`).join('\n'),
    '',
    `## Handoff`, pkg.handoff.map(line => `- ${line}`).join('\n')
  ].filter(Boolean).join('\n') + '\n';
}

function openGithubIssues(plan, featureId) {
  for (const pkg of plan.packages) {
    const title = `[spec-kit:${featureId}] ${pkg.title}`;
    const body = renderPackageMarkdown(plan, pkg);
    const result = spawnSync('gh', ['issue', 'create', '--title', title, '--body', body, '--label', `agent-ready,spec-kit,spec-kit:${featureId}`], { stdio: 'inherit' });
    if (result.status) console.warn(`gh issue create failed for ${pkg.id} (exit ${result.status})`);
  }
}

// ---------- analyze ----------

function runAnalyze(featureId) {
  const analyzePath = path.join(ROOT, 'specs', featureId, 'analyze.md');
  if (!exists(analyzePath)) {
    console.error(`No specs/${featureId}/analyze.md found. Run /speckit.analyze in your agent first.`);
    process.exit(1);
  }
  // Cheap pass: invoke brain:adr per top-level analysis heading found.
  const text = read(analyzePath);
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 6);
  if (!headings.length) {
    console.error(`No ## headings found in ${rel(analyzePath)}; can't scaffold ADRs.`);
    process.exit(1);
  }
  for (const heading of headings) {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'brain:adr', '--', heading], { stdio: 'inherit' });
    if (result.status) console.warn(`brain:adr scaffold failed for "${heading}" (exit ${result.status})`);
  }
}

// ---------- helpers ----------

function checkSpeckit(featureId, command) {
  if (command === 'tasks' || command === 'analyze' || command === 'import') {
    const dir = path.join(ROOT, 'specs', featureId);
    if (!exists(dir)) {
      console.error(`Spec-kit feature directory not found: specs/${featureId}/`);
      console.error('Run `specify init` then `/speckit.specify ...` in your agent first.');
      return false;
    }
  }
  return true;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function escapeFm(value) {
  const s = String(value);
  if (/^[A-Za-z0-9 _\-:/.,()'"]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}
