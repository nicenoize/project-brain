import fs from 'node:fs';
import { execSync } from 'node:child_process';
import fg from 'fast-glob';
import { read } from './common.mjs';

let errors = [];
let warnings = [];

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch && !['main', 'master', 'develop', 'dev'].includes(branch)) {
  const ok = /^(feature|fix|refactor|chore|docs|test)\/[a-z0-9]+[a-z0-9-]*$/.test(branch) || /^(feature|fix|refactor|chore|docs|test)\/\d+-[a-z0-9-]+$/.test(branch);
  if (!ok) errors.push(`Branch name does not match convention: ${branch}`);
}

const staged = sh('git diff --cached --name-only').split('\n').filter(Boolean);
const protectedBranch = ['main', 'master', 'develop', 'dev'].includes(branch);
if (protectedBranch && staged.length) warnings.push(`You are committing directly on ${branch}. Only do this intentionally.`);

const requiredBrain = ['.project-brain/context_index.md', '.project-brain/active_state.md', '.project-brain/product_plan.md', '.project-brain/repo_context.md'];
for (const file of requiredBrain) if (!fs.existsSync(file)) errors.push(`Missing required brain file: ${file}`);

const codeFiles = staged.filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && fs.existsSync(f));
for (const file of codeFiles) {
  const text = read(file);
  if (/\bTODO\b|\bFIXME\b/.test(text)) warnings.push(`${file}: contains TODO/FIXME. Track it in the brain or an issue.`);
  if (/:\s*any\b|as\s+any\b/.test(text)) warnings.push(`${file}: contains TypeScript any usage.`);
  if (/NEXT_PUBLIC_[A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD)/.test(text)) errors.push(`${file}: suspicious public env var name exposing secret-like value.`);
  if (/process\.env\[[^\]]+\]|process\.env\.[A-Z0-9_]+/.test(text) && !/(env|config|settings)\.(ts|tsx|js|jsx)$/.test(file)) {
    warnings.push(`${file}: reads process.env outside obvious config/env file.`);
  }
}

const commitMsg = sh('git log -1 --pretty=%s');
if (commitMsg && !/^(feat|fix|refactor|chore|docs|test)\([a-z0-9-]+\): [a-z0-9]/.test(commitMsg)) {
  warnings.push(`Last commit message may not match convention: ${commitMsg}`);
}

if (errors.length || warnings.length) {
  if (warnings.length) {
    console.log('\nProject Brain warnings:');
    for (const w of warnings) console.log(`- ${w}`);
  }
  if (errors.length) {
    console.error('\nProject Brain errors:');
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
}
console.log('Project Brain guard passed.');
