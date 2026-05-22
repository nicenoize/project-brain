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
