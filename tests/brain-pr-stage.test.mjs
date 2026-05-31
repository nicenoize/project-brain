import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const PR_SCRIPT = path.join(scriptsDir, 'brain-pr.mjs');
const FEATURE_SCRIPT = path.join(scriptsDir, 'brain-feature.mjs');

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-pr-stage-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });
  execSync('git checkout -q -b feature/1-test', { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
  execSync('git add README.md', { cwd });
  execSync('git -c commit.gpgsign=false commit -q -m "chore: init"', { cwd });
  return cwd;
}

function makeFleetRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-pr-stage-fleet-'));
  fs.mkdirSync(path.join(root, '.project-brain'), { recursive: true });
  for (const name of ['frontend', 'backend', 'workers']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'package.json'), `{"name":"${name}"}`);
  }
  execSync('git init --quiet', { cwd: root });
  execSync('git config user.email t@example.com', { cwd: root });
  execSync('git config user.name Tester', { cwd: root });
  execSync('git checkout -q -b main', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# fleet\n');
  execSync('git add .', { cwd: root });
  execSync('git -c commit.gpgsign=false commit -q -m "chore: init"', { cwd: root });
  return root;
}

function run(script, cwd, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('stage requires --feature slug', () => {
  const cwd = makeRepo();
  const r = run(PR_SCRIPT, cwd, ['stage']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires --feature/);
});

test('stage errors on missing feature spec', () => {
  const cwd = makeRepo();
  const r = run(PR_SCRIPT, cwd, ['stage', '--feature', 'nope']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /feature spec not found/);
});

test('stage emits one PR body for single-project feature', () => {
  const cwd = makeRepo();
  // Bootstrap a feature spec
  const fr = run(FEATURE_SCRIPT, cwd, ['start', '--slug', 'login', '--issue', '7', '--no-worktrees']);
  assert.equal(fr.status, 0, fr.stderr);

  const r = run(PR_SCRIPT, cwd, ['stage', '--feature', 'login']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== this-repo ===/);
  assert.match(r.stdout, /Part of feature \[`login`\]/);
  assert.match(r.stdout, /Closes #7/);
});

test('stage --write writes per-project bodies to .project-brain/pr-bodies/', () => {
  const cwd = makeRepo();
  run(FEATURE_SCRIPT, cwd, ['start', '--slug', 'login', '--no-worktrees']);
  const r = run(PR_SCRIPT, cwd, ['stage', '--feature', 'login', '--write']);
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(cwd, '.project-brain', 'pr-bodies', 'login-this-repo.md');
  assert.ok(fs.existsSync(out), `expected body at ${out}`);
  const body = fs.readFileSync(out, 'utf8');
  assert.match(body, /Feature spec/);
});

test('stage emits one body per project in fleet mode', () => {
  const root = makeFleetRepo();
  // Start a feature across two of three projects
  const fr = run(FEATURE_SCRIPT, root, [
    'start', '--slug', 'auth', '--issue', '42', '--projects', 'frontend,backend',
    '--no-worktrees', '--json'
  ]);
  assert.equal(fr.status, 0, fr.stderr);

  const r = run(PR_SCRIPT, root, ['stage', '--feature', 'auth', '--write']);
  assert.equal(r.status, 0, r.stderr);

  const outDir = path.join(root, '.project-brain', 'pr-bodies');
  const frontendPath = path.join(outDir, 'auth-frontend.md');
  const backendPath = path.join(outDir, 'auth-backend.md');
  assert.ok(fs.existsSync(frontendPath));
  assert.ok(fs.existsSync(backendPath));

  const fe = fs.readFileSync(frontendPath, 'utf8');
  assert.match(fe, /Project: `frontend`/);
  assert.match(fe, /`frontend`: `feature\/42-auth` ← \*\*this PR\*\*/);
  assert.match(fe, /`backend`: `feature\/42-auth`/);
  assert.match(fe, /Merge order/);
  assert.match(fe, /Cross-project consumers/);
});

test('stage surfaces contract-changes section when spec includes it', () => {
  const cwd = makeRepo();
  run(FEATURE_SCRIPT, cwd, ['start', '--slug', 'proto-bump', '--no-worktrees']);
  // The default spec template already has a "## Contract changes" header
  const r = run(PR_SCRIPT, cwd, ['stage', '--feature', 'proto-bump']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Contract changes/);
});
