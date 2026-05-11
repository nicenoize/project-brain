import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR, ensureDir, exists, write } from './common.mjs';

const dirs = ['features', 'modules', 'decisions', 'sessions', 'vector-db'].map(d => path.join(BRAIN_DIR, d));
dirs.forEach(ensureDir);

const files = {
  'context_index.md': `# Context Index\n\nPurpose: compact, low-token map of the project. Claude should load this first.\n\n## Project Snapshot\n- Status: Needs Review\n- Stack: Needs Review\n- Primary goal: Needs Review\n\n## Current Focus\n- Needs Review\n\n## Core Modules\n- Needs Review\n\n## Active Features\n- Needs Review\n\n## Key Decisions\n- Needs Review\n\n## Retrieval Hints\n- Use semantic search before loading full specs.\n- Load master_plan.md only when details are missing or ambiguous.\n`,
  'master_plan.md': `# Master Plan\n\nPaste or import the complete project plan here.\n\nAfter adding it, ask Claude:\n\n> Use the project-brain skill. Ingest .project-brain/master_plan.md and update context_index, product_plan, modules, features, and decisions.\n`,
  'product_plan.md': `# Product Plan\n\n## Vision\nNeeds Review\n\n## Target Users\nNeeds Review\n\n## Core Value Proposition\nNeeds Review\n\n## Roadmap\n### Now\n- Needs Review\n\n### Next\n- Needs Review\n\n### Later\n- Needs Review\n\n## Non-Goals\n- Needs Review\n`,
  'repo_context.md': `# Repo Context\n\n## Stack\n- Framework: Needs Review\n- Language: Needs Review\n- Package manager: Needs Review\n\n## Commands\n- Install: \`npm install\`\n- Dev: Needs Review\n- Lint: Needs Review\n- Typecheck: Needs Review\n- Test: Needs Review\n- Build: Needs Review\n\n## Architecture Conventions\n- Needs Review\n\n## Git Workflow\n- Branch model: GitFlow inherited from the global Project Brain conventions.\n- Default work base: \`develop\`.\n- Default PR target: \`develop\`.\n- Protected branches: \`main\` and \`develop\`.\n- Branches: \`feature/<issue>-slug\`, \`fix/<issue>-slug\`, \`refactor/<issue>-slug\`, \`chore/<issue>-slug\`, \`docs/<issue>-slug\`, \`test/<issue>-slug\`, \`release/<version-or-date>\`, \`hotfix/<issue>-slug\`.\n- Commit format: \`type(scope): short description\`.\n\n## Code Conventions\n- TypeScript-first where applicable.\n- Avoid \`any\` unless justified.\n- Keep modules cohesive.\n\n## Team Memory\n- Project Brain Markdown is the shared source of truth.\n- Cavemem may be used locally for personal/session memory.\n- Durable facts from Cavemem must be promoted into Project Brain.\n- Caveman may be used for low-token communication; it is not memory.\n`,
  'active_state.md': `# Active State\n\n## How to use (team + agents)\n\n- **Single merge point**: one human or lead agent applies edits here to avoid git conflicts.\n- **Parallel work**: assign a stable \`task_id\` per workstream; use \`.project-brain/sessions/\` for handoffs; use the file lease table below.\n- **Tools**: label actors (\`--actor\`) and tool (\`--tool cursor|claude|gemini|codex|human|other\`) when starting sessions so search/pack can prefer the right context.\n- **Retrieval**: \`BRAIN_TASK=<task_id> npm run brain:pack -- "…"\` or \`--task\` / \`--actor\` on \`brain:search\` / \`brain:ask\` boosts matching session chunks.\n\n## File leases (optional; coordinate before editing)\n\n| path glob or file | locked_by | until (ISO date or PR) | tool / notes |\n|-------------------|-----------|-------------------------|----------------|\n| _None_ | | | |\n\n## Active workstreams\n\n| task_id | owner (GitHub @ or agent label) | tool | branch | scope / links | status |\n|---------|-------------------------------|------|--------|---------------|--------|\n| _None_ | | | | | |\n\n## Blockers\n\n- None recorded\n\n## Overlaps / conflict risks\n\n- None recorded\n\n## Last sync\n\n- Needs Review\n`
};

for (const [name, content] of Object.entries(files)) {
  const p = path.join(BRAIN_DIR, name);
  if (!exists(p)) write(p, content);
}

console.log('Initialized .project-brain');
