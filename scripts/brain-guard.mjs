import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { read } from './common.mjs';

let errors = [];
let warnings = [];

const strictContextIndex = process.argv.includes('--strict-context-index') || process.env.BRAIN_GUARD_STRICT_CONTEXT_INDEX === '1';
const warnTok = Number(process.env.BRAIN_CONTEXT_INDEX_WARN_TOKENS || 700);

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

const branch = process.env.GITHUB_HEAD_REF || sh('git rev-parse --abbrev-ref HEAD');
if (branch && branch !== 'HEAD' && !['main', 'master', 'develop', 'dev'].includes(branch)) {
  const ok = /^(feature|fix|refactor|chore|docs|test|release|hotfix)\/[a-z0-9]+[a-z0-9-]*$/.test(branch) || /^(feature|fix|refactor|chore|docs|test|hotfix)\/\d+-[a-z0-9-]+$/.test(branch);
  if (!ok) errors.push(`Branch name does not match convention: ${branch}`);
  if (/^(feature|fix|refactor|chore|docs|test)\//.test(branch) && !/^(feature|fix|refactor|chore|docs|test)\/\d+-[a-z0-9-]+$/.test(branch)) {
    warnings.push(`Branch is not issue-linked: ${branch}. Prefer <type>/<issue-number>-description before push/PR.`);
  }
}

const baseBranch = process.env.GITHUB_BASE_REF || '';
if (baseBranch && branch && branch !== 'HEAD') {
  if (/^(feature|fix|refactor|chore|docs|test)\//.test(branch) && !['develop', 'dev'].includes(baseBranch)) {
    errors.push(`Work branch ${branch} targets ${baseBranch}. GitFlow PRs for this branch type must target develop.`);
  }
  if (/^release\//.test(branch) && !['main', 'master'].includes(baseBranch)) {
    errors.push(`Release branch ${branch} targets ${baseBranch}. Release PRs must target main.`);
  }
}

const staged = sh('git diff --cached --name-only').split('\n').filter(Boolean);
const protectedBranch = ['main', 'master', 'develop', 'dev'].includes(branch);
if (protectedBranch && staged.length) {
  const target = branch === 'main' || branch === 'master' ? 'release/hotfix PR' : 'feature/fix PR';
  warnings.push(`You are committing directly on ${branch}. Prefer a ${target} branch and PR.`);
}

const requiredBrain = ['.project-brain/context_index.md', '.project-brain/active_state.md', '.project-brain/product_plan.md', '.project-brain/repo_context.md'];
for (const file of requiredBrain) if (!fs.existsSync(file)) errors.push(`Missing required brain file: ${file}`);

const ctxPath = '.project-brain/context_index.md';
if (fs.existsSync(ctxPath)) {
  const body = read(ctxPath);
  const est = estimateTokens(body);
  if (est > warnTok) {
    const msg = `context_index.md is ~${est} tokens (soft budget ${warnTok}). Trim bullets or move detail to repo_context/product_plan.`;
    if (strictContextIndex) errors.push(msg);
    else warnings.push(msg);
  }
}

const codeFiles = staged.filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && fs.existsSync(f));
for (const file of codeFiles) {
  const text = read(file);
  if (/\bTODO\b|\bFIXME\b/.test(text)) warnings.push(`${file}: contains TODO/FIXME. Track it in the brain or an issue.`);
  if (/:\s*any\b|as\s+any\b/.test(text)) warnings.push(`${file}: contains TypeScript any usage.`);
  {
    const matches = text.match(/NEXT_PUBLIC_[A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD)/g) || [];
    const knownPublic = new Set(['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']);
    const isConfigFile = /(env|config|settings)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file);
    const offending = matches.filter(m => !knownPublic.has(m));
    if (offending.length && !isConfigFile) errors.push(`${file}: suspicious public env var name exposing secret-like value (${offending[0]}).`);
  }
  if (/process\.env\[[^\]]+\]|process\.env\.[A-Z0-9_]+/.test(text) && !/(env|config|settings)\.(ts|tsx|js|jsx)$/.test(file)) {
    warnings.push(`${file}: reads process.env outside obvious config/env file.`);
  }
}

const commitMsg = sh('git log -1 --no-merges --pretty=%s');
if (commitMsg && !/^(feat|fix|refactor|chore|docs|test)\([a-z0-9-]+\): [a-z0-9]/.test(commitMsg)) {
  warnings.push(`Last commit message may not match convention: ${commitMsg}`);
}

const brainFeatureModule = staged.filter(f => /^\.project-brain\/(features|modules)\/.+\.md$/i.test(f));
const brainDecision = staged.some(f => /^\.project-brain\/decisions\/.+\.md$/i.test(f));
if (brainFeatureModule.length && !brainDecision) {
  warnings.push('Staged `.project-brain/features/` or `modules/` updates without a matching `decisions/` change. Record durable architecture or product decisions in `.project-brain/decisions/` when behavior or policy shifts.');
}

const conventionPaths = ['AGENTS.md', 'references/conventions.md'].filter((p) => fs.existsSync(p));
const tsStaged = staged.filter((f) => /\.(ts|tsx)$/i.test(f) && fs.existsSync(f));
if (conventionPaths.length && tsStaged.length >= 15) {
  const conventionsStaged = staged.some((f) => f === 'AGENTS.md' || f === 'references/conventions.md');
  if (!conventionsStaged) {
    warnings.push(
      `Many TypeScript files staged (${tsStaged.length}); if standards or agent instructions shift, update ${conventionPaths.join(' or ')}.`
    );
  }
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
