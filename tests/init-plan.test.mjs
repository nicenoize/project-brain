/**
 * init-plan tests — the pure installer planning core (scripts/init-plan.mjs)
 * and the consent shell around it (scripts/setup-package.mjs).
 *
 *   1. Unit tests of the pure plan computation against fixture host
 *      package.json / .gitignore data (no fs, no subprocess).
 *   2. Subprocess: `setup-package.mjs --dry-run` in a temp host dir must exit
 *      0 and modify NOTHING.
 *   3. Subprocess: `--yes` (and the flagless non-TTY hook path) must apply the
 *      whole plan like the pre-consent installer — and never hang on a prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GITIGNORE_ENTRIES,
  TEMPLATE_COPIES,
  planPackageJson,
  planGitignore,
  planTemplates,
  planClaudeSettings,
  planCursorHooks,
  computeInitPlan
} from '../scripts/init-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const SETUP_SCRIPT = path.join(REPO, 'scripts', 'setup-package.mjs');

// ---------------------------------------------------------------------------
// Unit: planPackageJson
// ---------------------------------------------------------------------------

test('planPackageJson: fresh host (no package.json) plans full script + dep set', () => {
  const p = planPackageJson(null);
  assert.equal(p.exists, false);
  assert.ok(p.scripts.changes.length >= 40, `expected the full brain:* set, got ${p.scripts.changes.length}`);
  const init = p.scripts.changes.find((c) => c.key === 'brain:init');
  assert.ok(init, 'brain:init missing from plan');
  assert.equal(init.from, null);
  assert.ok(init.to.includes('skills/project-brain/scripts/brain-init.mjs'));

  const depKeys = p.dependencies.changes.map((c) => `${c.field}:${c.key}`);
  assert.ok(depKeys.includes('dependencies:fast-glob'));
  assert.ok(depKeys.includes('dependencies:@xenova/transformers'));
  assert.ok(depKeys.includes('optionalDependencies:@lancedb/lancedb'));
  assert.ok(depKeys.includes('optionalDependencies:typescript'));
});

test('planPackageJson: user-owned scripts are preserved, stale brain paths refreshed', () => {
  const pkg = {
    scripts: {
      'brain:init': 'echo my-custom-init', // user override — must survive
      'brain:index': 'node skills/project-brain/scripts/old-index.mjs', // stale brain path — refresh
      test: 'node --test' // unrelated — untouched
    }
  };
  const p = planPackageJson(pkg);
  assert.equal(p.exists, true);
  assert.ok(!p.scripts.changes.some((c) => c.key === 'brain:init'), 'user brain:init override must not be planned over');
  assert.ok(!p.scripts.changes.some((c) => c.key === 'test'), 'unrelated script must not appear in plan');
  const idx = p.scripts.changes.find((c) => c.key === 'brain:index');
  assert.ok(idx, 'stale skills/project-brain script should be refreshed');
  assert.equal(idx.from, 'node skills/project-brain/scripts/old-index.mjs');
});

test('planPackageJson: never mutates its input (merge helpers run on a copy)', () => {
  const pkg = { scripts: { test: 'node --test' }, dependencies: { left: '1.0.0' } };
  const before = JSON.stringify(pkg);
  planPackageJson(pkg);
  assert.equal(JSON.stringify(pkg), before, 'planPackageJson mutated the host pkg object');
});

test('planPackageJson: dep already in devDependencies is not re-added', () => {
  const p = planPackageJson({ devDependencies: { 'fast-glob': '^3.3.0' } });
  assert.ok(
    !p.dependencies.changes.some((c) => c.key === 'fast-glob'),
    'fast-glob in devDependencies must not be planned into dependencies'
  );
});

// ---------------------------------------------------------------------------
// Unit: planGitignore
// ---------------------------------------------------------------------------

test('planGitignore: empty file appends every entry, output is well-formed', () => {
  const g = planGitignore('');
  const appends = g.changes.filter((c) => c.action === 'append');
  assert.equal(appends.length, GITIGNORE_ENTRIES.length);
  for (const entry of GITIGNORE_ENTRIES) assert.ok(g.next.includes(`${entry}\n`), `missing ${entry}`);
});

test('planGitignore: existing entries are skipped, next is unchanged', () => {
  const text = GITIGNORE_ENTRIES.map((e) => `${e}\n`).join('');
  const g = planGitignore(text);
  assert.equal(g.changes.filter((c) => c.action === 'append').length, 0);
  assert.equal(g.next, text);
});

test('planGitignore: missing trailing newline gets one before appending', () => {
  const g = planGitignore('node_modules');
  assert.ok(g.next.startsWith('node_modules\n'));
  assert.ok(g.next.endsWith('\n'));
});

// ---------------------------------------------------------------------------
// Unit: planTemplates / planClaudeSettings / planCursorHooks
// ---------------------------------------------------------------------------

test('planTemplates: absent destinations are copied, present ones left untouched', () => {
  const none = planTemplates([]);
  assert.deepEqual(none.changes.map((c) => c.action), ['copy', 'copy']);
  const one = planTemplates(['.github/PULL_REQUEST_TEMPLATE.md']);
  const byFile = Object.fromEntries(one.changes.map((c) => [c.file, c.action]));
  assert.equal(byFile['.github/PULL_REQUEST_TEMPLATE.md'], 'skip-exists');
  assert.equal(byFile['.github/workflows/project-brain.yml'], 'copy');
});

test('planClaudeSettings: skip env and drift summaries', () => {
  assert.match(planClaudeSettings({ skip: true }).summary, /PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS/);
  const drift = planClaudeSettings({
    installed: {},
    recommended: { permissions: { allow: ['Bash(npm run brain:*)'] } }
  });
  assert.match(drift.summary, /allow:\+1/);
  const clean = planClaudeSettings({
    installed: { permissions: { allow: ['Bash(npm run brain:*)'] } },
    recommended: { permissions: { allow: ['Bash(npm run brain:*)'] } }
  });
  assert.match(clean.summary, /up to date/);
});

test('planCursorHooks: with and without an installer', () => {
  assert.match(planCursorHooks('scripts/install-cursor-hooks.mjs').summary, /install-cursor-hooks/);
  assert.match(planCursorHooks('').summary, /skipped/);
});

// ---------------------------------------------------------------------------
// Fixture host + snapshot helpers for the fs / subprocess tests
// ---------------------------------------------------------------------------

function makeHost({ pkg, gitignore } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-init-plan-'));
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  // The package checkout, exactly as consumers mount it.
  fs.symlinkSync(REPO, path.join(dir, 'skills', 'project-brain'), 'dir');
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  return dir;
}

/** relPath -> content for every real file under dir (symlinks not followed). */
function snapshot(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) out.set(r, '<symlink>');
      else if (e.isDirectory()) walk(r);
      else out.set(r, fs.readFileSync(path.join(dir, r), 'utf8'));
    }
  };
  walk('');
  return out;
}

// Sandbox HOME so setCavemanUltra can never touch the real ~/.claude, and use
// the documented settings bypass so tests stay focused on the installer core.
const childEnv = (dir) => ({
  ...process.env,
  HOME: dir,
  PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS: '1'
});

test('computeInitPlan: full plan over a fixture host, read-only', () => {
  const dir = makeHost({
    pkg: { name: 'host-app', scripts: { test: 'node --test' } },
    gitignore: 'node_modules/\n'
  });
  try {
    const before = snapshot(dir);
    const plan = computeInitPlan({ cwd: dir, env: { PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS: '1' } });
    assert.deepEqual(
      plan.map((g) => g.id),
      ['package-scripts', 'package-deps', 'gitignore', 'templates', 'claude-settings', 'cursor-hooks']
    );
    assert.ok(plan[0].changes.length >= 40);
    assert.equal(plan.find((g) => g.id === 'claude-settings').skip, true);
    assert.ok(plan.find((g) => g.id === 'cursor-hooks').installer.includes('install-cursor-hooks.mjs'));
    assert.deepEqual(snapshot(dir), before, 'computeInitPlan wrote to the host');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subprocess: --dry-run writes nothing
// ---------------------------------------------------------------------------

test('setup-package --dry-run: exit 0 and NO files modified', () => {
  const dir = makeHost({
    pkg: { name: 'host-app', scripts: { test: 'node --test' } },
    gitignore: 'node_modules/\n'
  });
  try {
    const before = snapshot(dir);
    const r = spawnSync(process.execPath, [SETUP_SCRIPT, '--dry-run'], {
      cwd: dir, encoding: 'utf8', env: childEnv(dir), timeout: 30000
    });
    assert.equal(r.status, 0, `dry-run failed: ${r.stderr}`);
    assert.match(r.stdout, /Project Brain install plan/);
    assert.match(r.stdout, /Dry run: nothing was written/);
    assert.deepEqual(snapshot(dir), before, 'dry-run modified host files');
    assert.ok(!fs.existsSync(path.join(dir, '.github')), 'dry-run created .github');
    assert.ok(!fs.existsSync(path.join(dir, '.cursor')), 'dry-run ran the cursor-hooks installer');
    assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'dry-run touched .claude');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subprocess: --yes applies the whole plan
// ---------------------------------------------------------------------------

test('setup-package --yes: applies scripts, deps, .gitignore, templates; preserves user entries', () => {
  const dir = makeHost({
    pkg: { name: 'host-app', scripts: { test: 'node --test', 'brain:init': 'echo custom' } },
    gitignore: 'node_modules/\n'
  });
  try {
    const r = spawnSync(process.execPath, [SETUP_SCRIPT, '--yes'], {
      cwd: dir, encoding: 'utf8', env: childEnv(dir), timeout: 30000
    });
    assert.equal(r.status, 0, `--yes failed: ${r.stderr}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['brain:index']?.includes('skills/project-brain/'), 'brain:index script missing');
    assert.ok(pkg.scripts['brain:search']?.includes('skills/project-brain/'), 'brain:search script missing');
    assert.equal(pkg.scripts['brain:init'], 'echo custom', 'user brain:init override was clobbered');
    assert.equal(pkg.scripts.test, 'node --test', 'unrelated user script was clobbered');
    assert.equal(pkg.dependencies['fast-glob'], '^3.3.2');
    assert.equal(pkg.optionalDependencies['@lancedb/lancedb'], '^0.9.0');

    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(ignore.startsWith('node_modules/\n'), 'existing .gitignore content lost');
    for (const entry of GITIGNORE_ENTRIES) assert.ok(ignore.includes(entry), `missing ${entry}`);

    for (const { dest } of TEMPLATE_COPIES) {
      assert.ok(fs.existsSync(path.join(dir, dest)), `${dest} not copied`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup-package with no flags in a non-TTY context: applies all, never prompts/hangs', () => {
  const dir = makeHost({ gitignore: '' });
  try {
    // stdin is a pipe (not a TTY) — the hook/CI case. Must behave like --yes.
    const r = spawnSync(process.execPath, [SETUP_SCRIPT], {
      cwd: dir, encoding: 'utf8', env: childEnv(dir), timeout: 30000, input: ''
    });
    assert.equal(r.status, 0, `non-TTY run failed: ${r.stderr}`);
    assert.ok(!r.stdout.includes('[Y/n]'), 'non-TTY run printed a prompt');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['brain:init']?.includes('skills/project-brain/'), 'package.json not created/merged');
    assert.equal(pkg.private, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
