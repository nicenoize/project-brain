import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR, ensureDir, exists, write } from './common.mjs';

const dirs = ['features', 'modules', 'decisions', 'sessions', 'work-packages', 'vector-db'].map(d => path.join(BRAIN_DIR, d));
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

const files = {
  'context_index.md': `# Context Index\n\nPurpose: compact map agents load before search. Keep this under ~700 tokens; move details to product_plan, repo_context, modules, features, or decisions.\n\n## Snapshot\n- Status: Needs Review\n- Stack: Needs Review\n- Goal: Needs Review\n\n## Current Focus\n- Needs Review\n\n## Modules\n- Needs Review\n\n## Features\n- Needs Review\n\n## Decisions\n- Needs Review\n\n## Commands\n- Install: Needs Review\n- Dev: Needs Review\n- Check: Needs Review\n\n## Retrieval Hints\n- Search before opening full specs.\n- Load master_plan.md only for ambiguity or re-ingestion.\n`,
  'master_plan.md': `# Master Plan\n\nPaste or import the complete project plan here.\n\nAfter adding it, ask Claude:\n\n> Use the project-brain skill. Ingest .project-brain/master_plan.md and update context_index, product_plan, modules, features, and decisions.\n`,
  'product_plan.md': `# Product Plan\n\n## Vision\nNeeds Review\n\n## Target Users\nNeeds Review\n\n## Core Value Proposition\nNeeds Review\n\n## Roadmap\n### Now\n- Needs Review\n\n### Next\n- Needs Review\n\n### Later\n- Needs Review\n\n## Non-Goals\n- Needs Review\n`,
  'repo_context.md': `# Repo Context\n\n## Stack\n- Framework: Needs Review\n- Language: Needs Review\n- Package manager: Needs Review\n\n## Commands\n- Install: \`npm install\`\n- Dev: Needs Review\n- Lint: Needs Review\n- Typecheck: Needs Review\n- Test: Needs Review\n- Build: Needs Review\n\n## Architecture Conventions\n- Needs Review\n\n## Git Workflow\n- Branch model: GitFlow inherited from the global Project Brain conventions.\n- Default work base: \`develop\`.\n- Default PR target: \`develop\`.\n- Protected branches: \`main\` and \`develop\`.\n- Branches: \`feature/<issue>-slug\`, \`fix/<issue>-slug\`, \`refactor/<issue>-slug\`, \`chore/<issue>-slug\`, \`docs/<issue>-slug\`, \`test/<issue>-slug\`, \`release/<version-or-date>\`, \`hotfix/<issue>-slug\`.\n- Commit format: \`type(scope): short description\`.\n\n## Code Conventions\n- TypeScript-first where applicable.\n- Avoid \`any\` unless justified.\n- Keep modules cohesive.\n\n## Team Memory\n- Project Brain Markdown is the shared source of truth.\n- Cavemem may be used locally for personal/session memory.\n- Durable facts from Cavemem must be promoted into Project Brain.\n- Caveman may be used for low-token communication; it is not memory.\n`,
  'active_state.md': `# Active State\n\n## Workstreams\n\n| task_id | owner | tool | branch | scope / links | status |\n|---------|-------|------|--------|---------------|--------|\n| _None_ | | | | | |\n\n## File Leases\n\n| path glob or file | locked_by | until | notes |\n|-------------------|-----------|-------|-------|\n| _None_ | | | |\n\n## Blockers\n\n- None recorded\n\n## Overlaps\n\n- None recorded\n\n## Last Sync\n\n- Needs Review\n`
};

for (const [name, content] of Object.entries(files)) {
  const p = path.join(BRAIN_DIR, name);
  if (!exists(p)) write(p, content);
}

console.log('Initialized .project-brain');
