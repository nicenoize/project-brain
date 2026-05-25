/**
 * Splits a large task into N work packages a single agent can finish
 * in one session. Optionally creates the GitHub issue + sub-issues.
 *
 * Sizes each package by file count / domain breadth, emits
 * .project-brain/work-packages/<id>.md, and (with --github) opens
 * paired issues so an orchestrator run can pick them up later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRAIN_DIR, ROOT, ensureDir, slugify, write } from './common.mjs';

// Run CLI side effects only when invoked directly, so `import { buildPlan }`
// from sibling scripts (e.g. brain-speckit.mjs) doesn't double-execute.
const __isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (__isMain) main();

function main() {
const args = process.argv.slice(2);
const command = args[0] === 'draft' || args[0] === 'create' ? args.shift() : 'draft';
const opts = parseArgs(args);
const title = opts.title || args.join(' ').trim();

if (!title || opts.help) {
  console.log(`Usage:
  npm run brain:ticket -- "large task title" [--packages 3] [--files a.ts,b.ts] [--modules auth,billing]
  npm run brain:ticket -- draft "large task title" --packages 4 --write
  npm run brain:ticket -- create "large task title" --packages 4 --github

Options:
  --packages N          Number of agent-sized work packages (default: 3, max: 12)
  --slug text           Stable slug used for ids and filenames
  --summary text        Short parent-ticket summary
  --files a,b,c         Known touched files/globs; split across packages
  --modules a,b         Related modules
  --labels a,b          Labels for GitHub issue creation
  --actor name          Suggested owner/orchestrator label
  --tool codex          Suggested tool: cursor|claude|gemini|codex|human|other
  --base develop        Expected GitFlow base branch
  --max-files N         Max files/globs per package before warning (default: 5)
  --write              Write Markdown to .project-brain/work-packages/
  --github             Create GitHub issues with gh issue create
  --json               Print JSON instead of Markdown
`);
  process.exit(title ? 0 : 1);
}

const packageCount = Math.min(Math.max(Number(opts.packages || 3), 1), 12);
const slug = slugify(opts.slug || title);
const base = opts.base || 'develop';
const actor = opts.actor || '';
const tool = normalizeTool(opts.tool || process.env.BRAIN_TOOL || '');
const labels = splitList(opts.labels || 'agent-ready,project-brain');
const files = splitList(opts.files);
const modules = splitList(opts.modules);
const summary = opts.summary || `Deliver ${title} through bounded, independently verifiable work packages.`;
const maxFiles = Math.max(Number(opts.maxFiles || 5), 1);
const plan = buildPlan({ title, slug, summary, packageCount, files, modules, labels, actor, tool, base, maxFiles });

if (opts.github || command === 'create') {
  createGithubIssues(plan);
}

if (opts.write) {
  const dir = path.join(BRAIN_DIR, 'work-packages');
  ensureDir(dir);
  const file = path.join(dir, `${dateSlug()}-${slug}.md`);
  write(file, renderMarkdown(plan));
  console.log(`Wrote ${path.relative(ROOT, file)}`);
}

if (opts.json) console.log(JSON.stringify(plan, null, 2));
else console.log(renderMarkdown(plan));

} // end main()

export function buildPlan(input) {
  const size = scoreTask(input);
  const slices = splitFiles(input.files, input.packageCount);
  const packages = [];
  for (let i = 0; i < input.packageCount; i++) {
    const n = i + 1;
    const kind = packageKind(n, input.packageCount);
    const id = `${input.slug}-wp${String(n).padStart(2, '0')}`;
    const packageFiles = slices[i] || [];
    const deps = n === 1 ? [] : [`${input.slug}-wp${String(n - 1).padStart(2, '0')}`];
    packages.push({
      id,
      title: `${kind}: ${input.title}`,
      branch: `feature/${id}`,
      taskId: id,
      actor: input.actor || `${input.tool || 'agent'}-worker-${n}`,
      tool: input.tool || 'codex',
      base: input.base,
      dependsOn: deps,
      modules: input.modules,
      files: packageFiles,
      maxFiles: input.maxFiles,
      objective: objectiveFor(kind, input.title, packageFiles),
      scope: scopeFor(kind, packageFiles),
      outOfScope: outOfScopeFor(kind),
      acceptanceCriteria: acceptanceFor(kind),
      verification: verificationFor(kind),
      handoff: [
        `Run npm run brain:compact with BRAIN_TASK=${id} before handing off.`,
        'Record unresolved questions and changed files in the session file.',
        'Promote durable architecture decisions into .project-brain/decisions/.'
      ],
      risks: risksFor(kind, packageFiles, input.maxFiles)
    });
  }
  return {
    type: 'agent-work-packages',
    title: input.title,
    slug: input.slug,
    summary: input.summary,
    base: input.base,
    labels: input.labels,
    modules: input.modules,
    size,
    generatedAt: new Date().toISOString(),
    orchestration: {
      parentTaskId: input.slug,
      recommendedFlow: [
        'Create parent issue from this plan.',
        'Create one child issue per work package.',
        'Spawn one worktree/agent per independent child issue.',
        'Use one merge actor for active_state.md and final integration.',
        'Run brain:maintain and project checks before PR.'
      ]
    },
    packages
  };
}

export function renderMarkdown(plan) {
  const lines = [
    '---',
    `type: ${JSON.stringify(plan.type)}`,
    `slug: ${JSON.stringify(plan.slug)}`,
    `base: ${JSON.stringify(plan.base)}`,
    `generated_at: ${JSON.stringify(plan.generatedAt)}`,
    '---',
    '',
    `# Agent Work Packages: ${plan.title}`,
    '',
    `Summary: ${plan.summary}`,
    '',
    `Base branch: \`${plan.base}\``,
    `Labels: ${plan.labels.map(l => `\`${l}\``).join(', ') || 'None'}`,
    plan.modules.length ? `Modules: ${plan.modules.map(m => `\`${m}\``).join(', ')}` : 'Modules: Needs Review',
    '',
    '## Agent Size Score',
    `- Score: ${plan.size.score}/100 (${plan.size.band})`,
    `- Recommendation: ${plan.size.recommendation}`,
    ...plan.size.reasons.map(reason => `- ${reason}`),
    '',
    '## Orchestration',
    ...plan.orchestration.recommendedFlow.map(item => `- ${item}`),
    ''
  ];
  for (const wp of plan.packages) {
    lines.push(
      `## ${wp.id}: ${wp.title}`,
      '',
      `- Branch: \`${wp.branch}\``,
      `- Task: \`${wp.taskId}\``,
      `- Actor: \`${wp.actor}\``,
      `- Tool: \`${wp.tool}\``,
      `- Depends on: ${wp.dependsOn.length ? wp.dependsOn.map(d => `\`${d}\``).join(', ') : 'None'}`,
      '',
      '### Objective',
      wp.objective,
      '',
      '### Scope',
      ...wp.scope.map(item => `- ${item}`),
      '',
      '### Files / Globs',
      ...(wp.files.length ? wp.files.map(file => `- \`${file}\``) : ['- Needs discovery']),
      '',
      '### Out of Scope',
      ...wp.outOfScope.map(item => `- ${item}`),
      '',
      '### Acceptance Criteria',
      ...wp.acceptanceCriteria.map(item => `- [ ] ${item}`),
      '',
      '### Verification',
      ...wp.verification.map(item => `- [ ] ${item}`),
      '',
      '### Handoff',
      ...wp.handoff.map(item => `- ${item}`),
      '',
      '### Risks',
      ...wp.risks.map(item => `- ${item}`),
      ''
    );
  }
  return `${lines.join('\n').trim()}\n`;
}

function createGithubIssues(plan) {
  const gh = spawnSync('gh', ['--version'], { cwd: ROOT, encoding: 'utf8' });
  if (gh.status !== 0) {
    console.error('brain:ticket: --github requires the GitHub CLI (`gh`) to be installed and authenticated.');
    process.exit(1);
  }
  const parentBody = renderParentIssue(plan);
  const parent = spawnSync('gh', ['issue', 'create', '--title', `[Brain] ${plan.title}`, '--body', parentBody, ...labelArgs(plan.labels)], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (parent.status !== 0) {
    process.stderr.write(parent.stderr || parent.stdout || 'gh issue create failed\n');
    process.exit(parent.status || 1);
  }
  const parentUrl = parent.stdout.trim();
  console.log(`Created parent issue: ${parentUrl}`);
  for (const wp of plan.packages) {
    const body = renderPackageIssue(wp, parentUrl);
    const child = spawnSync('gh', ['issue', 'create', '--title', `[${wp.id}] ${wp.title}`, '--body', body, ...labelArgs(plan.labels)], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    if (child.status !== 0) {
      process.stderr.write(child.stderr || child.stdout || `failed creating ${wp.id}\n`);
      process.exit(child.status || 1);
    }
    console.log(`Created ${wp.id}: ${child.stdout.trim()}`);
  }
}

function renderParentIssue(plan) {
  return [
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    '## Work Packages',
    ...plan.packages.map(wp => `- [ ] ${wp.id}: ${wp.title}`),
    '',
    '## Orchestration',
    ...plan.orchestration.recommendedFlow.map(item => `- ${item}`),
    '',
    '## Agent Size Score',
    `- ${plan.size.score}/100 (${plan.size.band})`,
    `- ${plan.size.recommendation}`,
    '',
    `Generated by Project Brain at ${plan.generatedAt}.`
  ].join('\n');
}

function renderPackageIssue(wp, parentUrl) {
  return [
    `Parent: ${parentUrl}`,
    '',
    `Branch: \`${wp.branch}\``,
    `Task: \`${wp.taskId}\``,
    `Suggested actor: \`${wp.actor}\``,
    `Tool: \`${wp.tool}\``,
    `Depends on: ${wp.dependsOn.length ? wp.dependsOn.map(d => `\`${d}\``).join(', ') : 'None'}`,
    '',
    '## Objective',
    wp.objective,
    '',
    '## Scope',
    ...wp.scope.map(item => `- ${item}`),
    '',
    '## Files / Globs',
    ...(wp.files.length ? wp.files.map(file => `- \`${file}\``) : ['- Needs discovery']),
    '',
    '## Out of Scope',
    ...wp.outOfScope.map(item => `- ${item}`),
    '',
    '## Acceptance Criteria',
    ...wp.acceptanceCriteria.map(item => `- [ ] ${item}`),
    '',
    '## Verification',
    ...wp.verification.map(item => `- [ ] ${item}`),
    '',
    '## Handoff',
    ...wp.handoff.map(item => `- ${item}`)
  ].join('\n');
}

function objectiveFor(kind, title, files) {
  if (kind === 'Discovery') return `Map the existing behavior and constraints for ${title}; do not make broad implementation changes.`;
  if (kind === 'Implementation') return `Implement the smallest coherent slice of ${title}${files.length ? ' in the owned files/globs' : ''}.`;
  if (kind === 'Integration') return `Connect completed slices for ${title}, resolve overlaps, and keep behavior consistent across modules.`;
  return `Verify ${title}, update durable Project Brain docs, and prepare handoff/PR evidence.`;
}

function scopeFor(kind, files) {
  if (kind === 'Discovery') return ['Identify owned modules, entry points, risks, and missing tests.', 'Produce a short implementation map for downstream agents.'];
  if (kind === 'Implementation') return ['Change only the owned files/globs unless blocked.', 'Keep public contracts stable unless the ticket explicitly changes them.'];
  if (kind === 'Integration') return ['Resolve cross-package wiring and conflicts.', 'Confirm combined behavior across package boundaries.'];
  return ['Run required checks.', 'Update feature/module/decision docs when durable facts changed.', 'Prepare PR-ready summary and test evidence.'];
}

function outOfScopeFor(kind) {
  if (kind === 'Discovery') return ['Production code changes except tiny instrumentation or comments approved by the orchestrator.'];
  if (kind === 'Implementation') return ['Unrelated refactors, style churn, dependency upgrades, or cross-package rewrites.'];
  if (kind === 'Integration') return ['New feature scope not covered by child packages.'];
  return ['Large new implementation work; file a follow-up package instead.'];
}

function acceptanceFor(kind) {
  if (kind === 'Discovery') return ['Relevant files, symbols, commands, and risks are listed.', 'Work is split small enough that each implementation package can be completed independently.'];
  if (kind === 'Implementation') return ['Owned behavior is implemented.', 'Existing callers remain compatible.', 'Tests or manual verification cover the changed behavior.'];
  if (kind === 'Integration') return ['All dependent package assumptions are reconciled.', 'No active file leases conflict.', 'Combined flow works end to end.'];
  return ['Checks are run or explicitly documented as not runnable.', 'Project Brain docs and session handoff are updated.', 'PR summary includes scope, risks, and verification.'];
}

function verificationFor(kind) {
  const base = ['Run `npm run brain:guard`.', 'Run relevant project lint/typecheck/test commands from `.project-brain/repo_context.md`.'];
  if (kind === 'Discovery') return ['Run `npm run brain:ask -- "relevant architecture and modules" --pack --max-tokens 1200`.', 'Confirm proposed package boundaries with the orchestrator.'];
  if (kind === 'Integration') return [...base, 'Run the full user flow or integration test that crosses package boundaries.'];
  if (kind === 'Verification') return [...base, 'Run `npm run brain:maintain`.', 'Run `npm run brain:eval` when retrieval behavior changed.'];
  return base;
}

function risksFor(kind, files, maxFiles) {
  const risks = [];
  if (files.length > maxFiles) risks.push(`Package owns ${files.length} files/globs; split further if the agent starts losing context.`);
  if (!files.length && kind !== 'Discovery') risks.push('Owned files are not known yet; discovery package should finish first.');
  if (kind === 'Integration') risks.push('Integration agent must not rewrite child-package implementation without checking assumptions.');
  risks.push('If scope grows, stop and create another work package instead of expanding this one.');
  return risks;
}

function packageKind(index, total) {
  if (index === 1 && total > 1) return 'Discovery';
  if (index === total && total > 2) return 'Verification';
  if (index === total && total === 2) return 'Integration';
  if (index === total - 1 && total > 3) return 'Integration';
  return 'Implementation';
}

function scoreTask(input) {
  let score = 20;
  const reasons = [];
  if (!input.files.length) {
    score += 20;
    reasons.push('Owned files are unknown; discovery should run first.');
  } else if (input.files.length > input.maxFiles) {
    const extra = Math.min(25, (input.files.length - input.maxFiles) * 4);
    score += extra;
    reasons.push(`${input.files.length} known files/globs exceeds the per-agent target of ${input.maxFiles}.`);
  } else {
    reasons.push(`${input.files.length} known files/globs fits the per-agent target.`);
  }
  if (input.modules.length > 1) {
    score += Math.min(25, (input.modules.length - 1) * 12);
    reasons.push(`${input.modules.length} modules means integration risk is non-trivial.`);
  }
  if (input.packageCount > 1) {
    score += Math.min(18, input.packageCount * 3);
    reasons.push(`${input.packageCount} packages planned; use explicit dependencies and one merge actor.`);
  }
  if (/\b(migration|auth|billing|payment|infra|schema|deploy|security|multi-agent|parallel)\b/i.test(input.title)) {
    score += 25;
    reasons.push('Title includes high-risk or cross-cutting keywords.');
  }
  score = Math.min(100, score);
  const band = score >= 70 ? 'large' : score >= 45 ? 'medium' : 'small';
  const recommendedPackages = score >= 70 ? Math.max(input.packageCount, 5) : score >= 45 ? Math.max(input.packageCount, 3) : Math.max(input.packageCount, 1);
  const recommendation = score >= 70
    ? `Use discovery first, ${recommendedPackages}+ packages, and avoid parallel integration until dependencies are clear.`
    : score >= 45
      ? `Use ${recommendedPackages} packages with a dedicated verification/integration package.`
      : 'One agent may be enough; keep a session handoff and explicit verification.';
  return { score, band, recommendedPackages, recommendation, reasons };
}

function splitFiles(files, count) {
  const out = Array.from({ length: count }, () => []);
  for (let i = 0; i < files.length; i++) out[i % count].push(files[i]);
  return out;
}

function parseArgs(argv) {
  const opts = { title: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : '';
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--write') { opts.write = true; continue; }
    if (a === '--github') { opts.github = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--packages') { opts.packages = val; i += val ? 1 : 0; continue; }
    if (a === '--slug') { opts.slug = val; i += val ? 1 : 0; continue; }
    if (a === '--summary') { opts.summary = val; i += val ? 1 : 0; continue; }
    if (a === '--files') { opts.files = val; i += val ? 1 : 0; continue; }
    if (a === '--modules') { opts.modules = val; i += val ? 1 : 0; continue; }
    if (a === '--labels') { opts.labels = val; i += val ? 1 : 0; continue; }
    if (a === '--actor') { opts.actor = val; i += val ? 1 : 0; continue; }
    if (a === '--tool') { opts.tool = val; i += val ? 1 : 0; continue; }
    if (a === '--base') { opts.base = val; i += val ? 1 : 0; continue; }
    if (a === '--max-files') { opts.maxFiles = val; i += val ? 1 : 0; continue; }
    positional.push(a);
  }
  opts.title = positional.join(' ').trim();
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

function labelArgs(values) {
  return values.flatMap(label => ['--label', label]);
}

function dateSlug() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}
