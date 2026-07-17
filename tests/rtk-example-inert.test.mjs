import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectCommands } from '../scripts/setup-claude-settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const RTK_EXAMPLE = path.join(REPO, 'templates', 'claude-code', 'settings.rtk-example.json');
const RECOMMENDED = path.join(REPO, 'templates', 'claude-code', 'settings.recommended.json');
const SETTINGS_SCRIPT = path.join(REPO, 'scripts', 'setup-claude-settings.mjs');

// ---------------------------------------------------------------------------
// The RTK example file: present, valid JSON, correctly shaped
// ---------------------------------------------------------------------------

test('rtk example: exists and is valid JSON', () => {
  assert.ok(fs.existsSync(RTK_EXAMPLE), 'settings.rtk-example.json missing');
  const raw = fs.readFileSync(RTK_EXAMPLE, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'rtk example is not valid JSON');
});

test('rtk example: PreToolUse Bash rewrite that EXCLUDES npm run brain:*', () => {
  const cfg = JSON.parse(fs.readFileSync(RTK_EXAMPLE, 'utf8'));
  const pre = cfg.hooks?.PreToolUse ?? [];
  const bash = pre.filter((g) => g.matcher === 'Bash');
  assert.ok(bash.length > 0, 'no Bash PreToolUse group in rtk example');
  const cmds = [...collectCommands(bash)];
  // The brain:* exclusion is the load-bearing invariant: without it RTK would
  // lossy-compress brain:pack/search/ask output — the packed context the brain
  // exists to provide.
  assert.ok(
    cmds.some((c) => c.includes('brain:*')),
    'rtk example must exclude brain:* from rewriting'
  );
});

// ---------------------------------------------------------------------------
// Inertness: setup reads ONLY settings.recommended.json, so a fresh setup run
// installs NO RTK config — even with the example file sitting right beside it.
// ---------------------------------------------------------------------------

test('rtk example is INERT: fresh setup does not install any rtk config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-rtk-inert-'));
  try {
    // Copy BOTH real template files to the path setup-claude-settings.mjs reads.
    const tplDir = path.join(dir, 'skills', 'project-brain', 'templates', 'claude-code');
    fs.mkdirSync(tplDir, { recursive: true });
    fs.copyFileSync(RECOMMENDED, path.join(tplDir, 'settings.recommended.json'));
    fs.copyFileSync(RTK_EXAMPLE, path.join(tplDir, 'settings.rtk-example.json'));

    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

    const r = spawnSync(process.execPath, [SETTINGS_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1',
        PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1'
      }
    });
    assert.equal(r.status, 0, `settings sync failed: ${r.stderr}`);

    const merged = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
    assert.ok(!/rtk/i.test(merged), 'RTK config leaked into installed settings — example is NOT inert');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The recommended (installed) template must NOT carry RTK — RTK stays opt-in.
// ---------------------------------------------------------------------------

test('settings.recommended.json carries no rtk wiring (RTK stays opt-in)', () => {
  const raw = fs.readFileSync(RECOMMENDED, 'utf8');
  assert.ok(!/rtk/i.test(raw), 'RTK must not be in the default-installed recommended settings');
});
