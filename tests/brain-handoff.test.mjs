import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const HANDOFF_SCRIPT = path.join(scriptsDir, 'brain-handoff.mjs');

/** Set up a tmpdir that looks like a brain-enabled single-project repo. */
function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-handoff-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  // Minimal git repo so HEAD/branch/log queries don't blow up.
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });
  execSync('git checkout -q -b feature/test', { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
  execSync('git add README.md', { cwd });
  execSync('git -c commit.gpgsign=false commit -q -m "chore: init"', { cwd });
  return cwd;
}

function runHandoff(cwd, args) {
  return spawnSync(process.execPath, [HANDOFF_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('status reports inactive when no state file exists', () => {
  const cwd = makeRepo();
  const r = runHandoff(cwd, ['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No hand-off active/);
});

test('status --json reports {active:false} when no state', () => {
  const cwd = makeRepo();
  const r = runHandoff(cwd, ['status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.active, false);
});

test('prepare without --write prints a brief to stdout with required sections', () => {
  const cwd = makeRepo();
  const r = runHandoff(cwd, ['prepare', '--from', 'sebastian', '--reason', 'vacation', '--until', '2026-06-15']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# Hand-off — sebastian.*until 2026-06-15/);
  assert.match(r.stdout, /## TL;DR/);
  assert.match(r.stdout, /## Where I'll be/);
  assert.match(r.stdout, /## In flight/);
  assert.match(r.stdout, /What's OK to do without me/);
  assert.match(r.stdout, /When I return/);
});

test('prepare --json emits a parseable structured snapshot', () => {
  const cwd = makeRepo();
  const r = runHandoff(cwd, ['prepare', '--from', 's', '--reason', 'demo', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.from, 's');
  assert.equal(parsed.reason, 'demo');
  assert.ok(Array.isArray(parsed.perProject));
  assert.ok(parsed.perProject.length >= 1);
  assert.equal(parsed.perProject[0].branch, 'feature/test');
});

test('prepare --write writes consolidated doc, per-repo brief, and state file', () => {
  const cwd = makeRepo();
  const r = runHandoff(cwd, ['prepare', '--from', 's', '--reason', 'vac', '--until', '2026-07-01', '--write']);
  assert.equal(r.status, 0, r.stderr);

  // State file
  const statePath = path.join(cwd, '.project-brain', 'handoff-state.json');
  assert.ok(fs.existsSync(statePath), 'state file should exist');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.active, true);
  assert.equal(state.until, '2026-07-01');
  assert.equal(state.from, 's');
  assert.ok(state.startedAt);

  // Consolidated doc
  const handoffsDir = path.join(cwd, '.project-brain', 'handoffs');
  const dateSlug = state.startedAt.slice(0, 10);
  const consolidated = path.join(handoffsDir, `${dateSlug}-handoff.md`);
  assert.ok(fs.existsSync(consolidated), `consolidated doc should exist at ${consolidated}`);
  const consolidatedText = fs.readFileSync(consolidated, 'utf8');
  assert.match(consolidatedText, /Hand-off — s/);

  // Per-repo HANDOFF.md at root (single-project mode)
  const perRepo = path.join(cwd, 'HANDOFF.md');
  assert.ok(fs.existsSync(perRepo), 'per-repo HANDOFF.md should exist at project root');
  const perRepoText = fs.readFileSync(perRepo, 'utf8');
  assert.match(perRepoText, /Hand-off \(this repo\) — s/);
});

test('status after prepare --write reports active state', () => {
  const cwd = makeRepo();
  runHandoff(cwd, ['prepare', '--from', 's', '--reason', 'vac', '--write']);
  const r = runHandoff(cwd, ['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hand-off active: s/);
});

test('end summarizes commits since handoff started and clears active flag', () => {
  const cwd = makeRepo();
  runHandoff(cwd, ['prepare', '--from', 's', '--reason', 'vac', '--write']);

  // Simulate "colleague commits while away" by adding one more commit.
  fs.writeFileSync(path.join(cwd, 'colleague.txt'), 'work\n');
  execSync('git add colleague.txt', { cwd });
  execSync('git -c commit.gpgsign=false commit -q -m "feat: colleague work"', { cwd });

  const r = runHandoff(cwd, ['end']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /What changed while you were away/);
  assert.match(r.stdout, /feat: colleague work/);

  // State should now show active:false
  const state = JSON.parse(fs.readFileSync(path.join(cwd, '.project-brain', 'handoff-state.json'), 'utf8'));
  assert.equal(state.active, false);
  assert.ok(state.endedAt);
});

test('end fails when no handoff is active', () => {
  const cwd = makeRepo();
  const r = runHandoff(cwd, ['end']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No hand-off active/);
});

test('prepare records uncommitted changes in the brief', () => {
  const cwd = makeRepo();
  fs.writeFileSync(path.join(cwd, 'wip.txt'), 'in progress\n');
  const r = runHandoff(cwd, ['prepare', '--from', 's', '--reason', 'sick']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Uncommitted local changes/);
  assert.match(r.stdout, /wip\.txt/);
});
