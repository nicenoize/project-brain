// headBranch / refExists read .git's files instead of spawning git. Every
// answer they give must be git's own; where they cannot be sure they say null
// and the caller asks git. Checked against git itself in each shape a repo
// takes: a branch with a slash, detached HEAD, an unborn branch, packed refs,
// a linked worktree, a tag named like a branch, a remote, GIT_DIR set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { headBranch, refExists, headSha } from '../scripts/git-files.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const gitBranch = (cwd) => { try { return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch { return ''; } };
const gitVerifies = (cwd, name) => spawnSync('git', ['rev-parse', '--verify', '--quiet', name], { cwd }).status === 0;
const env = {}; // no GIT_DIR from the test runner

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-files-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
  return dir;
}

/** The file answer must equal git's whenever it is not null. */
function agrees(cwd, names = ['develop', 'dev', 'main', 'master']) {
  const b = headBranch(cwd, env);
  if (b !== null) assert.equal(b, gitBranch(cwd), `branch in ${cwd}`);
  const sha = headSha(cwd, env);
  if (sha !== null) assert.equal(sha, git(cwd, 'rev-parse', 'HEAD'), `HEAD in ${cwd}`);
  for (const n of names) {
    const r = refExists(cwd, n, env);
    if (r !== null) assert.equal(r, gitVerifies(cwd, n), `ref ${n} in ${cwd}`);
  }
  return b;
}

test('a plain repo, a slashed branch, a subfolder', () => {
  const dir = repo();
  assert.equal(agrees(dir), 'main');
  git(dir, 'checkout', '-q', '-b', 'feature/split-invoices');
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  assert.equal(agrees(path.join(dir, 'src', 'deep')), 'feature/split-invoices');
  assert.equal(refExists(dir, 'develop', env), false);
  assert.equal(refExists(dir, 'main', env), true);
});

test('detached HEAD, packed refs, a tag named like a branch, a remote', () => {
  const dir = repo();
  git(dir, 'tag', 'develop');
  git(dir, 'checkout', '-q', '--detach');
  assert.equal(agrees(dir), 'HEAD');
  assert.equal(refExists(dir, 'develop', env), true, 'git verifies a tag by its short name');
  git(dir, 'pack-refs', '--all');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'main')), 'refs are packed now');
  agrees(dir);
  assert.equal(refExists(dir, 'main', env), true);
  const other = repo();
  git(dir, 'remote', 'add', 'origin', other);
  git(dir, 'fetch', '-q', 'origin');
  agrees(dir, ['develop', 'dev', 'main', 'master', 'origin']);
});

test('a linked worktree reads its own HEAD and the shared refs', () => {
  const dir = repo();
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-1');
  git(dir, 'worktree', 'add', '-q', '-b', 'agent/one', wt);
  assert.equal(agrees(wt), 'agent/one');
  assert.equal(refExists(wt, 'main', env), true);
});

test('where the files cannot be sure, they say null and git decides', () => {
  const unborn = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-files-unborn-')));
  git(unborn, 'init', '-q', '-b', 'main');
  assert.equal(headBranch(unborn, env), null, 'no commit yet: git fails, so do not guess');
  assert.equal(gitBranch(unborn), '');
  const dir = repo();
  assert.equal(headBranch(dir, { GIT_DIR: path.join(dir, '.git') }), null, 'GIT_DIR set');
  assert.equal(refExists(dir, '../main', env), null, 'not a plain name');
  const none = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-files-none-')));
  assert.equal(headBranch(none, env), null, 'not a repository');
});
