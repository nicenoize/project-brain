import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoName } from '../scripts/repo-name.mjs';

test('a subfolder, a worktree and a gone folder name their repository; a home under git does not', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-name-')));
  const repo = path.join(base, 'shop-app');
  fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
  assert.equal(repoName(path.join(repo, 'apps', 'web'), { home: '/nowhere' }), 'shop-app');
  assert.equal(repoName(path.join(repo, 'apps', 'gone-since'), { home: '/nowhere' }), 'shop-app');
  const wt = path.join(repo, '.claude', 'worktrees', 'agent-1234');
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: repo });
  assert.equal(repoName(path.join(wt, 'src'), { home: '/nowhere' }), 'shop-app');
  const plain = path.join(base, 'notes');
  fs.mkdirSync(plain);
  assert.equal(repoName(plain, { home: '/nowhere' }), 'notes');
  // a home folder kept in git is not the project of everything below it
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'scratch'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: home });
  assert.equal(repoName(path.join(home, 'scratch'), { home }), 'scratch');
  assert.equal(repoName(null), null);
});
