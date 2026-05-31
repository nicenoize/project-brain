import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const FEATURE_SCRIPT = path.join(scriptsDir, 'brain-feature.mjs');

/** Minimal single-project brain repo for isolation. */
function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-feature-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });
  execSync('git checkout -q -b feature/test', { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
  execSync('git add README.md', { cwd });
  execSync('git -c commit.gpgsign=false commit -q -m "chore: init"', { cwd });
  return cwd;
}

function runFeature(cwd, args) {
  return spawnSync(process.execPath, [FEATURE_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('status with no features dir reports empty', () => {
  const cwd = makeRepo();
  const r = runFeature(cwd, ['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No features tracked/);
});

test('start --no-worktrees writes spec, registers workstream, single-project', () => {
  const cwd = makeRepo();
  const r = runFeature(cwd, [
    'start',
    '--slug', 'login-flow',
    '--title', 'Login flow refactor',
    '--no-worktrees',
    '--json'
  ]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.slug, 'login-flow');
  assert.equal(parsed.branch, 'feature/login-flow');
  assert.deepEqual(parsed.projects, ['.']);
  assert.deepEqual(parsed.worktrees, []);

  // Spec written
  const specPath = path.join(cwd, '.project-brain', 'features', 'login-flow.md');
  assert.ok(fs.existsSync(specPath));
  const spec = fs.readFileSync(specPath, 'utf8');
  assert.match(spec, /^title: Login flow refactor/m);
  assert.match(spec, /feature: login-flow/);
  assert.match(spec, /branch convention: `feature\/login-flow`/i);
  assert.match(spec, /## Cross-project coordination/);

  // Workstream registered
  const stateText = fs.readFileSync(path.join(cwd, '.project-brain', 'active_state.md'), 'utf8');
  assert.match(stateText, /feature-login-flow/);
});

test('start --issue derives branch and taskId from issue', () => {
  const cwd = makeRepo();
  const r = runFeature(cwd, [
    'start', '--slug', 'auth', '--issue', '42', '--no-worktrees', '--json'
  ]);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.branch, 'feature/42-auth');

  const stateText = fs.readFileSync(path.join(cwd, '.project-brain', 'active_state.md'), 'utf8');
  assert.match(stateText, /issue-42-auth/);
  assert.match(stateText, /feature\/42-auth/);
});

test('start refuses to overwrite an existing spec', () => {
  const cwd = makeRepo();
  runFeature(cwd, ['start', '--slug', 'dup', '--no-worktrees']);
  const r = runFeature(cwd, ['start', '--slug', 'dup', '--no-worktrees']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
});

test('status lists tracked features with their branches', () => {
  const cwd = makeRepo();
  runFeature(cwd, ['start', '--slug', 'one', '--no-worktrees']);
  runFeature(cwd, ['start', '--slug', 'two', '--issue', '99', '--no-worktrees']);
  const r = runFeature(cwd, ['status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const features = JSON.parse(r.stdout);
  const slugs = features.map(f => f.slug).sort();
  assert.deepEqual(slugs, ['one', 'two']);
  const two = features.find(f => f.slug === 'two');
  assert.equal(two.issue, '99');
  assert.ok(two.branches.includes('feature/99-two'));
});

test('end closes the workstream(s) for the feature', () => {
  const cwd = makeRepo();
  runFeature(cwd, ['start', '--slug', 'done-me', '--no-worktrees']);
  const r = runFeature(cwd, ['end', '--slug', 'done-me', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.status, 'done');
  assert.ok(parsed.ended.includes('feature-done-me'));

  const stateText = fs.readFileSync(path.join(cwd, '.project-brain', 'active_state.md'), 'utf8');
  // Status column should now be 'done' for the row
  assert.match(stateText, /feature-done-me.+done/);
});

test('end fails when no workstreams match', () => {
  const cwd = makeRepo();
  const r = runFeature(cwd, ['end', '--slug', 'never-started']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no workstreams found/);
});

test('start in fleet mode requires --projects', () => {
  // Create a tmpdir with two sibling projects so isFleetMode() returns true.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-feature-fleet-'));
  fs.mkdirSync(path.join(root, '.project-brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'service-a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'service-b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'service-a', 'package.json'), '{"name":"a"}');
  fs.writeFileSync(path.join(root, 'service-b', 'package.json'), '{"name":"b"}');
  execSync('git init --quiet', { cwd: root });
  execSync('git config user.email t@example.com', { cwd: root });
  execSync('git config user.name Tester', { cwd: root });
  execSync('git checkout -q -b main', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# fleet\n');
  execSync('git add .', { cwd: root });
  execSync('git -c commit.gpgsign=false commit -q -m "chore: init"', { cwd: root });

  const noProjects = runFeature(root, ['start', '--slug', 'cross', '--no-worktrees']);
  assert.notEqual(noProjects.status, 0);
  assert.match(noProjects.stderr, /requires --projects/);

  const unknownProject = runFeature(root, ['start', '--slug', 'cross', '--projects', 'service-c', '--no-worktrees']);
  assert.notEqual(unknownProject.status, 0);
  assert.match(unknownProject.stderr, /unknown projects: service-c/);

  const ok = runFeature(root, ['start', '--slug', 'cross', '--projects', 'service-a,service-b', '--no-worktrees', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.deepEqual(parsed.projects, ['service-a', 'service-b']);

  // Two workstreams (one per project) should appear
  const stateText = fs.readFileSync(path.join(root, '.project-brain', 'active_state.md'), 'utf8');
  assert.match(stateText, /feature-cross-service-a/);
  assert.match(stateText, /feature-cross-service-b/);
});
