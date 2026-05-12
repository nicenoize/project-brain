import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BRAIN_DIR, ensureDir, exists, write } from './common.mjs';

const dirs = ['features', 'modules', 'decisions', 'sessions', 'work-packages', 'orchestration', 'vector-db'].map(d => path.join(BRAIN_DIR, d));
dirs.forEach(ensureDir);

const evalTemplateCandidates = [
  path.join('skills', 'project-brain', 'templates', 'brain', 'eval.json'),
  path.join('templates', 'brain', 'eval.json')
];
const evalTemplate = evalTemplateCandidates.find((p) => fs.existsSync(p));
const evalDest = path.join(BRAIN_DIR, 'eval.json');
if (evalTemplate && !exists(evalDest)) {
  fs.copyFileSync(evalTemplate, evalDest);
}

const decisionsGuideCandidates = [
  path.join('skills', 'project-brain', 'templates', 'brain', 'DECISIONS.md'),
  path.join('templates', 'brain', 'DECISIONS.md')
];
const decisionsGuide = decisionsGuideCandidates.find((p) => fs.existsSync(p));
const decisionsGuideDest = path.join(BRAIN_DIR, 'DECISIONS.md');
if (decisionsGuide && !exists(decisionsGuideDest)) {
  fs.copyFileSync(decisionsGuide, decisionsGuideDest);
}

const moduleMapCandidates = [
  path.join('skills', 'project-brain', 'templates', 'brain', 'MODULE_MAP.md'),
  path.join('templates', 'brain', 'MODULE_MAP.md')
];
const moduleMapTemplate = moduleMapCandidates.find((p) => fs.existsSync(p));
const moduleMapDest = path.join(BRAIN_DIR, 'MODULE_MAP.md');
if (moduleMapTemplate && !exists(moduleMapDest)) {
  fs.copyFileSync(moduleMapTemplate, moduleMapDest);
}

const inferred = inferRepoProfile();

const files = {
  'context_index.md': buildContextIndex(inferred),
  'master_plan.md': `# Master Plan\n\nPaste or import the complete project plan here.\n\nAfter adding it, ask Claude:\n\n> Use the project-brain skill. Ingest .project-brain/master_plan.md and update context_index, product_plan, modules, features, and decisions.\n`,
  'product_plan.md': `# Product Plan\n\n## Vision\nNeeds Review\n\n## Target Users\nNeeds Review\n\n## Core Value Proposition\nNeeds Review\n\n## Roadmap\n### Now\n- Needs Review\n\n### Next\n- Needs Review\n\n### Later\n- Needs Review\n\n## Non-Goals\n- Needs Review\n`,
  'repo_context.md': buildRepoContext(inferred),
  'active_state.md': `# Active State\n\n## Workstreams\n\n| task_id | owner | tool | branch | scope / links | status |\n|---------|-------|------|--------|---------------|--------|\n| _None_ | | | | | |\n\n## File Leases\n\n| path glob or file | locked_by | until | notes |\n|-------------------|-----------|-------|-------|\n| _None_ | | | |\n\n## Blockers\n\n- None recorded\n\n## Overlaps\n\n- None recorded\n\n## Last Sync\n\n- Needs Review\n`
};

for (const [name, content] of Object.entries(files)) {
  const p = path.join(BRAIN_DIR, name);
  if (!exists(p)) write(p, content);
}

console.log('Initialized .project-brain');

function inferRepoProfile() {
  const pkg = readPackageJson();
  const pm = inferPackageManager();
  const frameworks = inferFrameworks(pkg);
  const lang = inferLanguage(pkg);
  return { pkg, pm, frameworks, lang };
}

function readPackageJson() {
  const p = path.join(ROOT, 'package.json');
  if (!exists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function inferPackageManager() {
  if (fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml'))) {
    return { name: 'pnpm', install: 'pnpm install', run: (s) => `pnpm run ${s}` };
  }
  if (fs.existsSync(path.join(ROOT, 'yarn.lock'))) {
    return { name: 'yarn', install: 'yarn', run: (s) => `yarn ${s}` };
  }
  if (fs.existsSync(path.join(ROOT, 'bun.lockb')) || fs.existsSync(path.join(ROOT, 'bun.lock'))) {
    return { name: 'bun', install: 'bun install', run: (s) => `bun run ${s}` };
  }
  return { name: 'npm', install: 'npm install', run: (s) => `npm run ${s}` };
}

function inferFrameworks(pkg) {
  if (!pkg) return [];
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const out = [];
  const has = (k) => Boolean(deps[k]);
  if (has('next')) out.push('Next.js');
  if (has('nuxt')) out.push('Nuxt');
  if (has('svelte') && !has('next')) out.push('Svelte');
  if (has('@remix-run/react') || has('@remix-run/node')) out.push('Remix');
  if (has('react') && !has('next') && !has('@remix-run/react')) out.push('React');
  if (has('vue') && !has('nuxt')) out.push('Vue');
  if (has('express')) out.push('Express');
  if (has('fastify')) out.push('Fastify');
  if (has('hono')) out.push('Hono');
  if (has('@nestjs/core')) out.push('NestJS');
  if (has('vite') && !out.length) out.push('Vite');
  return [...new Set(out)];
}

function inferLanguage(pkg) {
  if (!pkg) return 'Unknown';
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.typescript || (pkg.devDependencies && pkg.devDependencies.typescript)) return 'TypeScript';
  return 'JavaScript';
}

function buildRepoContext(inferred) {
  const { pkg, pm, frameworks, lang } = inferred;
  const name = pkg?.name ? String(pkg.name) : 'this repository';
  const fwLine = frameworks.length ? frameworks.join(', ') : 'Needs Review';
  const scripts = pkg?.scripts || {};
  const devScript = pickScript(scripts, ['dev', 'start', 'serve', 'develop']);
  const lintScript = pickScript(scripts, ['lint', 'eslint']);
  const testScript = pickScript(scripts, ['test', 'vitest', 'jest']);
  const typeScript = pickScript(scripts, ['typecheck', 'check-types', 'tsc']);
  const buildScript = pickScript(scripts, ['build', 'compile']);

  const dev = devScript ? pm.run(devScript) : 'Needs Review';
  const lint = lintScript ? pm.run(lintScript) : 'Needs Review';
  const test = testScript ? pm.run(testScript) : 'Needs Review';
  const typecheck = typeScript ? pm.run(typeScript) : 'Needs Review';
  const build = buildScript ? pm.run(buildScript) : 'Needs Review';

  return `# Repo Context\n\n## Stack\n- Framework: ${fwLine}\n- Language: ${lang}\n- Package manager: ${pm.name}\n- Package: \`${name}\`\n\n## Commands\n- Install: \`${pm.install}\`\n- Dev: \`${dev}\`\n- Lint: \`${lint}\`\n- Typecheck: \`${typecheck}\`\n- Test: \`${test}\`\n- Build: \`${build}\`\n\n## Architecture Conventions\n- Needs Review\n\n## Git Workflow\n- Branch model: GitFlow inherited from the global Project Brain conventions.\n- Default work base: \`develop\`.\n- Default PR target: \`develop\`.\n- Protected branches: \`main\` and \`develop\`.\n- Branches: \`feature/<issue>-slug\`, \`fix/<issue>-slug\`, \`refactor/<issue>-slug\`, \`chore/<issue>-slug\`, \`docs/<issue>-slug\`, \`test/<issue>-slug\`, \`release/<version-or-date>\`, \`hotfix/<issue>-slug\`.\n- Commit format: \`type(scope): short description\`.\n\n## Code Conventions\n- TypeScript-first where applicable.\n- Avoid \`any\` unless justified.\n- Keep modules cohesive.\n\n## Team Memory\n- Project Brain Markdown is the shared source of truth.\n- Cavemem may be used locally for personal/session memory.\n- Durable facts from Cavemem must be promoted into Project Brain.\n- Caveman may be used for low-token communication; it is not memory.\n`;
}

function pickScript(scripts, candidates) {
  for (const c of candidates) {
    if (scripts[c]) return c;
  }
  return '';
}

function buildContextIndex(inferred) {
  const fw = inferred.frameworks.length ? inferred.frameworks.join(', ') : 'Needs Review';
  const pm = inferred.pm || { name: 'npm', install: 'npm install', run: (s) => `npm run ${s}` };
  const lang = inferred.lang || 'Needs Review';
  const scripts = inferred.pkg?.scripts || {};
  const devScript = pickScript(scripts, ['dev', 'start', 'serve', 'develop']);
  const checkScript = pickScript(scripts, ['check', 'validate', 'ci']);
  const lintScript = pickScript(scripts, ['lint', 'eslint']);
  const testScript = pickScript(scripts, ['test', 'vitest', 'jest']);
  const dev = devScript ? pm.run(devScript) : 'Needs Review';
  const check =
    checkScript ? pm.run(checkScript) : lintScript && testScript ? `${pm.run(lintScript)} / ${pm.run(testScript)}` : lintScript ? pm.run(lintScript) : testScript ? pm.run(testScript) : 'Needs Review';
  return `# Context Index\n\nPurpose: compact map agents load before search. Keep this under ~700 tokens; move details to product_plan, repo_context, modules, features, or decisions.\n\n## Snapshot\n- Status: Initialized (fill after first audit)\n- Stack: ${fw} · ${lang} · ${pm.name}\n- Goal: Needs Review\n\n## Current Focus\n- Needs Review\n\n## Modules\n- Needs Review\n\n## Features\n- Needs Review\n\n## Decisions\n- Needs Review\n\n## Commands\n- Install: \`${pm.install}\`\n- Dev: \`${dev}\`\n- Check: \`${check}\`\n\n## Retrieval Hints\n- Search before opening full specs.\n- Load master_plan.md only for ambiguity or re-ingestion.\n- Hand-maintained architecture map: [MODULE_MAP.md](MODULE_MAP.md) (seed from \`templates/brain/MODULE_MAP.md\`; not auto-generated).\n`;
}
