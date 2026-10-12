import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INIT = fileURLToPath(new URL('../scripts/brain-init.mjs', import.meta.url));
const freshRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};

test('init --dry-run lists what it would create and writes NOTHING (not even the usage ledger)', () => {
  const dir = freshRepo();
  const r = spawnSync(process.execPath, [INIT, '--dry-run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would create/);
  assert.match(r.stdout, /active_state\.md/);
  assert.deepEqual(fs.readdirSync(dir), ['.git']);
});

test('init refuses an unknown flag before writing anything', () => {
  const dir = freshRepo();
  const r = spawnSync(process.execPath, [INIT, '--dryrun'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag\(s\): --dryrun — nothing was written/);
  assert.deepEqual(fs.readdirSync(dir), ['.git']);
});

test('plain init still initializes', () => {
  const dir = freshRepo();
  const r = spawnSync(process.execPath, [INIT], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(dir, '.project-brain', 'active_state.md')));
});
