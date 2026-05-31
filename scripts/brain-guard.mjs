/**
 * Pre-commit / CI guard for GitFlow + brain hygiene.
 *
 * Verifies the current branch's base is allowed (develop|dev|epic/<n>),
 * warns when context_index.md exceeds BRAIN_CONTEXT_INDEX_WARN_TOKENS,
 * runs brain:link-check on staged brain docs, and fails the commit
 * (with --strict) on any block-severity convention rule hit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
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
const issueLinkedWork =
  /^(feature|fix|refactor|chore|docs|test)\/\d+-[a-z0-9-]+$/.test(branch) ||
  /^epic\/\d+-[a-z0-9-]+$/.test(branch);
if (branch && branch !== 'HEAD' && !['main', 'master', 'develop', 'dev'].includes(branch)) {
  const ok =
    /^(feature|fix|refactor|chore|docs|test|release|hotfix)\/[a-z0-9]+[a-z0-9-]*$/.test(branch) ||
    /^(feature|fix|refactor|chore|docs|test|hotfix)\/\d+-[a-z0-9-]+$/.test(branch) ||
    /^epic\/\d+-[a-z0-9-]+$/.test(branch);
  if (!ok) errors.push(`Branch name does not match convention: ${branch}`);
  if (/^(feature|fix|refactor|chore|docs|test)\//.test(branch) && !issueLinkedWork) {
    warnings.push(`Branch is not issue-linked: ${branch}. Prefer <type>/<issue-number>-description before push/PR.`);
  }
  if (/^epic\//.test(branch) && !/^epic\/\d+-[a-z0-9-]+$/.test(branch)) {
    warnings.push(`Epic branch is not issue-linked: ${branch}. Prefer epic/<issue-number>-description.`);
  }
}

const baseBranch = process.env.GITHUB_BASE_REF || '';
const epicBase = /^epic\/\d+-[a-z0-9-]+$/.test(baseBranch);
if (baseBranch && branch && branch !== 'HEAD') {
  if (/^(feature|fix|refactor|chore|docs|test)\//.test(branch) && !['develop', 'dev'].includes(baseBranch) && !epicBase) {
    errors.push(`Work branch ${branch} targets ${baseBranch}. GitFlow PRs for this branch type must target develop or an epic/* integration branch.`);
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

const brainDocStaged = staged.some((f) => /^\.project-brain\/.+\.md$/i.test(f));
if (brainDocStaged) {
  try {
    const linkCheckPath = new URL('./brain-link-check.mjs', import.meta.url).pathname;
    const linkCheck = spawnSync(process.execPath, [linkCheckPath, '--quiet'], { encoding: 'utf8' });
    if (linkCheck.status === 1) {
      errors.push(
        'Broken code references in `.project-brain/**.md` (run `npm run brain:link-check` for details).\n' +
          (linkCheck.stdout || '').trim()
      );
    }
  } catch {
    // best-effort: never block commits when the link-check itself errors
  }
}

// Security gates: opt-in via env, skip silently if tool isn't installed.
// `BRAIN_GUARD_SECURITY=1` enables all available scanners; individual
// flags (`BRAIN_GUARD_GITLEAKS=1`, `BRAIN_GUARD_SEMGREP=1`, `BRAIN_GUARD_NPM_AUDIT=1`)
// toggle one at a time. Findings at high|critical severity block (push to
// errors); lower severities push to warnings.
{
  const secResult = runSecurityScanners(staged);
  for (const e of secResult.errors) errors.push(e);
  for (const w of secResult.warnings) warnings.push(w);
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

// ---- security scanners ----

function isScannerEnabled(name) {
  if (process.env.BRAIN_GUARD_SECURITY === '1') return true;
  const key = `BRAIN_GUARD_${name.toUpperCase().replace(/[-:]/g, '_')}`;
  return process.env[key] === '1';
}

function scannerBin(name) {
  const key = `BRAIN_GUARD_${name.toUpperCase().replace(/[-:]/g, '_')}_BIN`;
  return process.env[key] || name;
}

function hasBin(name) {
  if (process.env[`BRAIN_GUARD_${name.toUpperCase().replace(/[-:]/g, '_')}_BIN`]) return true;
  try { execSync(`command -v ${name}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function runSecurityScanners(stagedFiles) {
  const errs = [];
  const warns = [];
  if (isScannerEnabled('gitleaks')) {
    const res = runGitleaks();
    if (res.skipped) warns.push(`gitleaks: skipped (${res.skipped})`);
    else for (const f of res.findings) {
      const where = `${f.File || f.file || 'unknown'}:${f.StartLine || f.start_line || ''}`;
      errs.push(`gitleaks: ${f.RuleID || f.rule_id || 'secret-finding'} in ${where}`);
    }
  }
  if (isScannerEnabled('semgrep')) {
    const codeStaged = stagedFiles.filter(f => fs.existsSync(f));
    const res = runSemgrep(codeStaged);
    if (res.skipped) warns.push(`semgrep: skipped (${res.skipped})`);
    else for (const f of res.findings) {
      const where = `${f.path || 'unknown'}:${f.start?.line ?? ''}`;
      const severity = String(f.extra?.severity || 'WARNING').toUpperCase();
      const msg = `semgrep: ${f.check_id || 'rule'} in ${where} — ${f.extra?.message || ''}`.trim();
      if (severity === 'ERROR') errs.push(msg);
      else warns.push(msg);
    }
  }
  if (isScannerEnabled('npm_audit') || isScannerEnabled('npm-audit')) {
    const res = runNpmAudit();
    if (res.skipped) warns.push(`npm audit: skipped (${res.skipped})`);
    else {
      const level = (process.env.BRAIN_GUARD_NPM_AUDIT_LEVEL || 'high').toLowerCase();
      const blocking = level === 'critical' ? ['critical'] : ['critical', 'high'];
      const blockingTotal = blocking.reduce((acc, k) => acc + (res.summary[k] || 0), 0);
      if (blockingTotal) {
        errs.push(`npm audit: ${blockingTotal} ${blocking.join('/')}-severity vulnerabilities (run \`npm audit\`)`);
      } else {
        const total = Object.values(res.summary).reduce((a, b) => a + (b || 0), 0);
        if (total) warns.push(`npm audit: ${total} non-blocking vulnerabilities (below threshold ${level})`);
      }
    }
  }
  return { errors: errs, warnings: warns };
}

function runGitleaks() {
  if (!hasBin('gitleaks')) return { skipped: 'gitleaks not installed; set BRAIN_GUARD_GITLEAKS_BIN to override' };
  const bin = scannerBin('gitleaks');
  // `protect --staged` is the pre-commit fast-path: only scans staged hunks.
  const r = spawnSync(bin, ['protect', '--staged', '--no-banner', '--report-format', 'json', '--redact'], { encoding: 'utf8' });
  if (r.error) return { skipped: `gitleaks spawn failed: ${r.error.code || r.error.message}` };
  const findings = [];
  // gitleaks emits JSON to stdout when findings exist; exits non-zero on findings.
  if (r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed)) findings.push(...parsed);
    } catch {}
  }
  return { findings };
}

function runSemgrep(stagedFiles) {
  if (!hasBin('semgrep')) return { skipped: 'semgrep not installed; set BRAIN_GUARD_SEMGREP_BIN to override' };
  if (!stagedFiles.length) return { findings: [] };
  const bin = scannerBin('semgrep');
  const config = process.env.BRAIN_GUARD_SEMGREP_CONFIG || 'auto';
  const r = spawnSync(bin, ['--config', config, '--json', '--quiet', '--metrics', 'off', ...stagedFiles], { encoding: 'utf8' });
  if (r.error) return { skipped: `semgrep spawn failed: ${r.error.code || r.error.message}` };
  const findings = [];
  if (r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed?.results)) findings.push(...parsed.results);
    } catch {}
  }
  return { findings };
}

function runNpmAudit() {
  if (!hasBin('npm')) return { skipped: 'npm not installed' };
  if (!fs.existsSync('package.json')) return { skipped: 'no package.json in cwd' };
  const bin = scannerBin('npm');
  const r = spawnSync(bin, ['audit', '--json'], { encoding: 'utf8' });
  if (r.error) return { skipped: `npm spawn failed: ${r.error.code || r.error.message}` };
  let summary = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  if (r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (parsed?.metadata?.vulnerabilities) summary = { ...summary, ...parsed.metadata.vulnerabilities };
    } catch {}
  }
  return { summary };
}
