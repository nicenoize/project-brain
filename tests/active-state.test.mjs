import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');

/**
 * Spawn a child Node process that imports active-state.mjs with cwd set to
 * `cwd`, exercises a lease op, and exits. We do this via subprocess so each
 * "agent" sees a fresh module load and a clean lock file path.
 */
function childAddLease(cwd, target) {
  const code = `
    const url = new URL('file://${scriptsDir.replace(/\\\\/g, '/')}/active-state.mjs');
    const mod = await import(url.href);
    mod.addLease({ target: ${JSON.stringify(target)}, lockedBy: 'pid-' + process.pid, until: '', notes: 't' });
    process.exit(0);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
}

test('addWorkstream + addLease persist new `project` column', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fleet-cols-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  const code = `
    const mod = await import('file://${scriptsDir.replace(/\\\\/g, '/')}/active-state.mjs');
    mod.addWorkstream({ taskId: 'issue-99', owner: 'me', tool: 'codex', project: 'backend', branch: 'feature/99-x' });
    mod.addLease({ target: 'lib/auth.ts', project: 'backend', lockedBy: 'me' });
    console.log(JSON.stringify(mod.activeStateJson()));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  const state = JSON.parse(r.stdout.trim());
  assert.equal(state.workstreams[0].project, 'backend');
  assert.equal(state.workstreams[0].branch, 'feature/99-x');
  assert.equal(state.leases[0].project, 'backend');
  assert.equal(state.leases[0].target, 'lib/auth.ts');
});

test('legacy 6-column workstreams + 4-column leases parse correctly', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fleet-legacy-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.project-brain', 'active_state.md'), `# Active State

## Workstreams

| task_id | owner | tool | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- |
| issue-7 | alice | codex | feature/7-x | lib/auth.ts | active |

## File Leases

| path glob or file | locked_by | until | notes |
| --- | --- | --- | --- |
| lib/auth.ts | alice | | |

## Blockers

- None recorded
`);
  const code = `
    const mod = await import('file://${scriptsDir.replace(/\\\\/g, '/')}/active-state.mjs');
    console.log(JSON.stringify(mod.activeStateJson()));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  const state = JSON.parse(r.stdout.trim());
  // Legacy row: project should be empty, branch/scope/status preserved.
  assert.equal(state.workstreams[0].taskId, 'issue-7');
  assert.equal(state.workstreams[0].project, '');
  assert.equal(state.workstreams[0].branch, 'feature/7-x');
  assert.equal(state.workstreams[0].scope, 'lib/auth.ts');
  assert.equal(state.workstreams[0].status, 'active');
  assert.equal(state.leases[0].target, 'lib/auth.ts');
  assert.equal(state.leases[0].project, '');
  assert.equal(state.leases[0].lockedBy, 'alice');
});

test('concurrent addLease calls do not lose rows', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-state-test-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });

  const N = 5;
  const children = Array.from({ length: N }, (_, i) => childAddLease(cwd, `path-${i}`));
  for (const c of children) {
    if (c.status !== 0) {
      throw new Error(`child failed (${c.status}): ${c.stderr || c.stdout}`);
    }
  }

  const text = fs.readFileSync(path.join(cwd, '.project-brain', 'active_state.md'), 'utf8');
  for (let i = 0; i < N; i++) {
    assert.ok(text.includes(`path-${i}`), `expected lease path-${i} to survive\n${text}`);
  }
});
