import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const GUARD_SCRIPT = path.join(scriptsDir, 'brain-guard.mjs');

/** Brain-enabled repo with the four required brain files + a clean git state. */
function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-guard-sec-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  for (const name of ['context_index.md', 'active_state.md', 'product_plan.md', 'repo_context.md']) {
    fs.writeFileSync(path.join(cwd, '.project-brain', name), `# ${name}\n`);
  }
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });
  execSync('git checkout -q -b feature/1-test', { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
  execSync('git add README.md .project-brain', { cwd });
  execSync('git -c commit.gpgsign=false commit -q -m "chore(brain): init"', { cwd });
  return cwd;
}

/** Stage one source file so semgrep has something to scan. */
function stageOneFile(cwd) {
  const f = path.join(cwd, 'src.js');
  fs.writeFileSync(f, 'export const x = 1;\n');
  execSync('git add src.js', { cwd });
  return f;
}

/** Write an executable shell script that prints `payload` to stdout and exits with `code`. */
function fakeBin(dir, name, payload, code = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'PAYLOAD'\n${payload}\nPAYLOAD\nexit ${code}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function runGuard(cwd, env = {}) {
  return spawnSync(process.execPath, [GUARD_SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

test('without any security env vars, scanners do not run', () => {
  const cwd = makeRepo();
  const r = runGuard(cwd);
  // Guard may still warn about other things, but should not mention scanners.
  assert.doesNotMatch(r.stdout + r.stderr, /gitleaks|semgrep|npm audit/i);
});

test('BRAIN_GUARD_GITLEAKS=1 with fake binary reporting a finding blocks the commit', () => {
  const cwd = makeRepo();
  const binDir = path.join(cwd, '_bin');
  const payload = JSON.stringify([
    { RuleID: 'aws-key', File: 'src/config.js', StartLine: 5, Description: 'AWS access key' }
  ]);
  const bin = fakeBin(binDir, 'gitleaks', payload, 1);

  const r = runGuard(cwd, {
    BRAIN_GUARD_GITLEAKS: '1',
    BRAIN_GUARD_GITLEAKS_BIN: bin
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gitleaks: aws-key in src\/config\.js:5/);
});

test('BRAIN_GUARD_GITLEAKS=1 with missing binary warns and does not block', () => {
  const cwd = makeRepo();
  // Use a name that almost certainly does not exist on PATH.
  const r = runGuard(cwd, {
    BRAIN_GUARD_GITLEAKS: '1',
    PATH: '/nonexistent-path'
  });
  // Should not block — gitleaks unavailable becomes a warning.
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gitleaks: skipped/);
});

test('BRAIN_GUARD_NPM_AUDIT=1 with high vulns blocks; with low only warns', () => {
  // high vulns -> error
  {
    const cwd = makeRepo();
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"x","version":"0.0.0"}\n');
    const binDir = path.join(cwd, '_bin');
    const payload = JSON.stringify({
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 } }
    });
    const bin = fakeBin(binDir, 'npm', payload, 1);
    const r = runGuard(cwd, {
      BRAIN_GUARD_NPM_AUDIT: '1',
      BRAIN_GUARD_NPM_BIN: bin
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /npm audit: 2 critical\/high-severity/);
  }
  // low vulns -> warning, no block
  {
    const cwd = makeRepo();
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"x","version":"0.0.0"}\n');
    const binDir = path.join(cwd, '_bin');
    const payload = JSON.stringify({
      metadata: { vulnerabilities: { info: 0, low: 3, moderate: 0, high: 0, critical: 0 } }
    });
    const bin = fakeBin(binDir, 'npm', payload, 0);
    const r = runGuard(cwd, {
      BRAIN_GUARD_NPM_AUDIT: '1',
      BRAIN_GUARD_NPM_BIN: bin
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /npm audit: 3 non-blocking vulnerabilities/);
  }
});

test('BRAIN_GUARD_SEMGREP=1 with one ERROR severity finding blocks; WARNING does not', () => {
  // ERROR -> block
  {
    const cwd = makeRepo();
    stageOneFile(cwd);
    const binDir = path.join(cwd, '_bin');
    const payload = JSON.stringify({
      results: [
        {
          check_id: 'js.sqli.tainted-sql',
          path: 'src.js',
          start: { line: 1 },
          extra: { severity: 'ERROR', message: 'SQL injection risk' }
        }
      ]
    });
    const bin = fakeBin(binDir, 'semgrep', payload, 0);
    const r = runGuard(cwd, {
      BRAIN_GUARD_SEMGREP: '1',
      BRAIN_GUARD_SEMGREP_BIN: bin
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /semgrep: js\.sqli\.tainted-sql in src\.js:1/);
  }
  // WARNING -> warn, not block
  {
    const cwd = makeRepo();
    stageOneFile(cwd);
    const binDir = path.join(cwd, '_bin');
    const payload = JSON.stringify({
      results: [
        {
          check_id: 'js.style.lint',
          path: 'src.js',
          start: { line: 1 },
          extra: { severity: 'WARNING', message: 'style nit' }
        }
      ]
    });
    const bin = fakeBin(binDir, 'semgrep', payload, 0);
    const r = runGuard(cwd, {
      BRAIN_GUARD_SEMGREP: '1',
      BRAIN_GUARD_SEMGREP_BIN: bin
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /semgrep: js\.style\.lint/);
  }
});

test('BRAIN_GUARD_SECURITY=1 enables all available scanners at once', () => {
  const cwd = makeRepo();
  stageOneFile(cwd);
  const binDir = path.join(cwd, '_bin');
  const gl = fakeBin(binDir, 'gitleaks', '[]', 0);
  const sg = fakeBin(binDir, 'semgrep', '{"results":[]}', 0);
  const np = fakeBin(binDir, 'npm', '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}', 0);
  const r = runGuard(cwd, {
    BRAIN_GUARD_SECURITY: '1',
    BRAIN_GUARD_GITLEAKS_BIN: gl,
    BRAIN_GUARD_SEMGREP_BIN: sg,
    BRAIN_GUARD_NPM_BIN: np
  });
  // No findings -> no errors and no warnings about scanners; should pass.
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Project Brain guard passed/);
});
