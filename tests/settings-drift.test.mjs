import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeSettingsDrift, collectCommands, hookIdentity, dedupeBrainHooks } from '../scripts/setup-claude-settings.mjs';

const SETTINGS_SCRIPT = fileURLToPath(new URL('../scripts/setup-claude-settings.mjs', import.meta.url));

// A trimmed-down recommended template that carries the ambient-routing wiring
// (ADR 0023) plus a recommended permission — the two things #34 says drift.
const RECOMMENDED = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: { allow: ['Bash(npm run brain:*)'] },
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'echo state && cat .project-brain/active_state.md' }] },
      { hooks: [{ type: 'command', command: 'node brain-route.mjs --hook --event sessionstart || true' }] }
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'node brain-route.mjs --hook --event userpromptsubmit || true' }] }
    ]
  }
};

// ---------------------------------------------------------------------------
// collectCommands — flatten a hook-group array to a Set of trimmed commands
// ---------------------------------------------------------------------------

test('collectCommands: flattens groups, trims, tolerates junk', () => {
  const cmds = collectCommands([
    { hooks: [{ command: '  a  ' }, { command: 'b' }] },
    { hooks: [{ notACommand: true }] },
    null
  ]);
  assert.deepEqual([...cmds].sort(), ['a', 'b']);
  assert.deepEqual([...collectCommands(undefined)], []);
});

// ---------------------------------------------------------------------------
// computeSettingsDrift — PURE comparison
// ---------------------------------------------------------------------------

test('computeSettingsDrift: pre-ambient settings drift the routing hooks + permission', () => {
  // The club-ops case: current scripts, but a settings.json with none of the
  // recommended hooks and none of the recommended permissions.
  const installed = { permissions: { allow: [] }, hooks: {} };
  const d = computeSettingsDrift(installed, RECOMMENDED);
  assert.equal(d.drift, true);
  assert.equal(d.hookDrift, 3); // 2x SessionStart + 1x UserPromptSubmit
  assert.equal(d.allowDrift, 1);
  const events = new Set(d.missingHooks.map((h) => h.event));
  assert.ok(events.has('SessionStart'));
  assert.ok(events.has('UserPromptSubmit'));
});

test('computeSettingsDrift: no drift when installed already carries the recommended wiring', () => {
  const d = computeSettingsDrift(RECOMMENDED, RECOMMENDED);
  assert.equal(d.drift, false);
  assert.equal(d.hookDrift, 0);
  assert.equal(d.allowDrift, 0);
  assert.deepEqual(d.missingHooks, []);
  assert.deepEqual(d.missingAllow, []);
});

test('computeSettingsDrift: partial install reports only the missing hook', () => {
  const installed = {
    permissions: { allow: ['Bash(npm run brain:*)'] },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'echo state && cat .project-brain/active_state.md' }] }
      ]
      // UserPromptSubmit + the SessionStart route hook are missing
    }
  };
  const d = computeSettingsDrift(installed, RECOMMENDED);
  assert.equal(d.allowDrift, 0);
  assert.equal(d.hookDrift, 2);
  const cmds = d.missingHooks.map((h) => h.command);
  assert.ok(cmds.some((c) => c.includes('sessionstart')));
  assert.ok(cmds.some((c) => c.includes('userpromptsubmit')));
});

test('computeSettingsDrift: defensive against empty/undefined inputs', () => {
  assert.equal(computeSettingsDrift().drift, false);
  assert.equal(computeSettingsDrift({}, {}).drift, false);
  assert.equal(computeSettingsDrift(undefined, RECOMMENDED).drift, true);
});

// ---------------------------------------------------------------------------
// Additive-merge safety — user-added hooks/permissions MUST survive an update
// (exercises the real setup-claude-settings.mjs end-to-end in a temp cwd).
// ---------------------------------------------------------------------------

test('real template: tool-time nudge PreToolUse groups (Bash + Read|Glob) merge in with matchers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tool-wiring-'));
  try {
    // Copy the REAL recommended template to the path setup-claude-settings.mjs reads.
    const realTpl = fileURLToPath(new URL('../templates/claude-code/settings.recommended.json', import.meta.url));
    const tplDir = path.join(dir, 'skills', 'project-brain', 'templates', 'claude-code');
    fs.mkdirSync(tplDir, { recursive: true });
    fs.copyFileSync(realTpl, path.join(tplDir, 'settings.recommended.json'));

    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

    const r = spawnSync(process.execPath, [SETTINGS_SCRIPT], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1', PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1' }
    });
    assert.equal(r.status, 0, `settings sync failed: ${r.stderr}`);

    const merged = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    const pre = merged.hooks.PreToolUse;
    const matchers = pre.map((g) => g.matcher);
    assert.ok(matchers.includes('Bash'), 'Bash matcher missing');
    assert.ok(matchers.includes('Read|Glob'), 'Read|Glob matcher missing');
    const cmds = [...collectCommands(pre)];
    assert.ok(cmds.some((c) => c.includes('brain-route-tool.mjs') && c.includes('--surface bash')), 'bash tool-hook not wired');
    assert.ok(cmds.some((c) => c.includes('brain-route-tool.mjs') && c.includes('--surface read')), 'read tool-hook not wired');
    assert.ok([...cmds].some((c) => c.includes('brain-lint-conventions.mjs')), 'existing convention-lint hook dropped');

    // Idempotent: a second sync adds nothing more.
    const before = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
    spawnSync(process.execPath, [SETTINGS_SCRIPT], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1', PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1' }
    });
    assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), before, 'second sync not idempotent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('additive merge preserves user-added hooks/permissions while adding recommended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-settings-'));
  try {
    // Recommended template on disk, at the path setup-claude-settings.mjs reads.
    const tplDir = path.join(dir, 'skills', 'project-brain', 'templates', 'claude-code');
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'settings.recommended.json'), JSON.stringify(RECOMMENDED, null, 2));

    // A host settings.json with the developer's OWN hook + permission, and a
    // partial slice of the recommended wiring already present.
    const claudeDir = path.join(dir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const userHookCmd = 'node my-own-custom-hook.mjs';
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          permissions: { allow: ['Bash(git status)'] },
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: userHookCmd }] }]
          }
        },
        null,
        2
      )
    );

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

    const merged = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));

    // User permission survives; recommended permission is added.
    assert.ok(merged.permissions.allow.includes('Bash(git status)'), 'user permission dropped');
    assert.ok(merged.permissions.allow.includes('Bash(npm run brain:*)'), 'recommended permission not added');

    // User's own SessionStart hook survives; both recommended SessionStart hooks land.
    const ssCmds = collectCommands(merged.hooks.SessionStart);
    assert.ok(ssCmds.has(userHookCmd), 'user hook dropped');
    assert.ok([...ssCmds].some((c) => c.includes('sessionstart')), 'recommended route hook not added');
    assert.ok([...ssCmds].some((c) => c.includes('active_state.md')), 'recommended active-state hook not added');

    // UserPromptSubmit event created from scratch.
    const upsCmds = collectCommands(merged.hooks.UserPromptSubmit);
    assert.ok([...upsCmds].some((c) => c.includes('userpromptsubmit')), 'UserPromptSubmit hook not added');

    // A re-run is idempotent: zero drift afterwards.
    const drift = computeSettingsDrift(merged, RECOMMENDED);
    assert.equal(drift.drift, false, 'drift remains after merge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Community plugins are opt-in (decisions/0028): a plain sync must never
// enable third-party plugins/marketplaces; the opt-in flag merges them.
// ---------------------------------------------------------------------------

test('plain sync adds no third-party plugins; opt-in flag merges them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-community-'));
  try {
    const tplDir = path.join(dir, 'skills', 'project-brain', 'templates', 'claude-code');
    fs.mkdirSync(tplDir, { recursive: true });
    const realTpl = fileURLToPath(new URL('../templates/claude-code/settings.recommended.json', import.meta.url));
    fs.copyFileSync(realTpl, path.join(tplDir, 'settings.recommended.json'));
    const realCommunity = fileURLToPath(new URL('../templates/claude-code/settings.community-plugins.json', import.meta.url));
    fs.copyFileSync(realCommunity, path.join(tplDir, 'settings.community-plugins.json'));

    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

    const baseEnv = { ...process.env, PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1', PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1' };
    delete baseEnv.PROJECT_BRAIN_COMMUNITY_PLUGINS;

    // Plain sync: no third-party keys appear.
    let r = spawnSync(process.execPath, [SETTINGS_SCRIPT], { cwd: dir, encoding: 'utf8', env: baseEnv });
    assert.equal(r.status, 0, `plain sync failed: ${r.stderr}`);
    let merged = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(merged.enabledPlugins, undefined, 'plain sync must not enable plugins');
    assert.equal(merged.extraKnownMarketplaces, undefined, 'plain sync must not register marketplaces');

    // Recommended template itself must carry no third-party wiring.
    const rec = JSON.parse(fs.readFileSync(realTpl, 'utf8'));
    assert.equal(rec.enabledPlugins, undefined, 'settings.recommended.json must not ship enabledPlugins');
    assert.equal(rec.extraKnownMarketplaces, undefined, 'settings.recommended.json must not ship extraKnownMarketplaces');

    // Opt-in: community set merges.
    r = spawnSync(process.execPath, [SETTINGS_SCRIPT], {
      cwd: dir, encoding: 'utf8', env: { ...baseEnv, PROJECT_BRAIN_COMMUNITY_PLUGINS: '1' }
    });
    assert.equal(r.status, 0, `opt-in sync failed: ${r.stderr}`);
    merged = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(merged.enabledPlugins && Object.keys(merged.enabledPlugins).length > 0, 'opt-in did not merge plugins');
    assert.ok(merged.extraKnownMarketplaces && Object.keys(merged.extraKnownMarketplaces).length > 0, 'opt-in did not merge marketplaces');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Legacy-hook upgrade: the pre-M2 SessionStart full-cat command must be
// rewritten to the budget-capped state digest on sync — never left to inject
// alongside the new form (double injection).
// ---------------------------------------------------------------------------

test('sync upgrades legacy active_state cat hook to the state digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-legacy-hook-'));
  try {
    const tplDir = path.join(dir, 'skills', 'project-brain', 'templates', 'claude-code');
    fs.mkdirSync(tplDir, { recursive: true });
    const realTpl = fileURLToPath(new URL('../templates/claude-code/settings.recommended.json', import.meta.url));
    fs.copyFileSync(realTpl, path.join(tplDir, 'settings.recommended.json'));

    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const legacy = "echo '=== Project Brain: Active State ===' && cat .project-brain/active_state.md";
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: legacy }] }] }
    }));

    const r = spawnSync(process.execPath, [SETTINGS_SCRIPT], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1', PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1' }
    });
    assert.equal(r.status, 0, `sync failed: ${r.stderr}`);
    assert.match(r.stdout, /legacy-hooks-upgraded:1/);

    const merged = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    const cmds = [...collectCommands(merged.hooks.SessionStart)];
    assert.ok(!cmds.some((c) => c.includes('cat .project-brain/active_state.md')), 'legacy cat hook survived');
    const digestCmds = cmds.filter((c) => c.includes('brain-state-digest.mjs'));
    assert.equal(digestCmds.length, 1, `expected exactly one digest hook, got ${digestCmds.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const REAL_TEMPLATE = fileURLToPath(new URL('../templates/claude-code/settings.recommended.json', import.meta.url));
/** Put the REAL template where setup-claude-settings.mjs reads it; without it the sync skips and proves nothing. */
function withRealTemplate(dir) {
  const tplDir = path.join(dir, 'skills', 'project-brain', 'templates', 'claude-code');
  fs.mkdirSync(tplDir, { recursive: true });
  fs.copyFileSync(REAL_TEMPLATE, path.join(tplDir, 'settings.recommended.json'));
}

const DIGEST_TEMPLATE = 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-state-digest.mjs" || true';
const DIGEST_HAND_FIXED = 'node --preserve-symlinks --preserve-symlinks-main "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-state-digest.mjs" || true';

test('hookIdentity: same script + args is the same hook, whatever the node flags and tail', () => {
  assert.equal(hookIdentity(DIGEST_TEMPLATE), hookIdentity(DIGEST_HAND_FIXED));
  assert.equal(hookIdentity(DIGEST_TEMPLATE), 'brain-script:brain-state-digest.mjs');
  assert.equal(
    hookIdentity('node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-prune.mjs" --apply >/dev/null 2>&1 || true'),
    'brain-script:brain-prune.mjs --apply');
  assert.notEqual(
    hookIdentity('node "$X/scripts/brain-route.mjs" --hook --event sessionstart || true'),
    hookIdentity('node "$X/scripts/brain-route.mjs" --hook --event userpromptsubmit || true'),
    'different arguments are different hooks');
  assert.equal(hookIdentity('  echo hi  '), 'echo hi', 'a non-brain command keeps exact identity');
});

test('drift: a hand-fixed hook (node flags added) is not "missing"', () => {
  const recommended = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: DIGEST_TEMPLATE }] }] } };
  const installed = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: DIGEST_HAND_FIXED }] }] } };
  assert.equal(computeSettingsDrift(installed, recommended).hookDrift, 0);
});

test('settings sync (real template): a hand-fixed digest hook is not appended a second time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-settings-identity-'));
  withRealTemplate(dir);
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: DIGEST_HAND_FIXED }] }] }
  }));
  const r = spawnSync(process.execPath, [SETTINGS_SCRIPT], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1', PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1' }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Synced \.claude\/settings\.json/, 'the sync ran instead of skipping');
  const merged = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  const digests = [...collectCommands(merged.hooks.SessionStart)].filter((c) => c.includes('brain-state-digest.mjs'));
  assert.deepEqual(digests, [DIGEST_HAND_FIXED], 'kept the hand-fixed form, added no duplicate');
});

const ROUTE_SS = 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-route.mjs" --hook --event sessionstart || true';
const LINT = 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-lint-conventions.mjs"';

test('dedupeBrainHooks: repeated brain hooks go, user hooks and distinct args stay', () => {
  const hooks = {
    SessionStart: [
      { hooks: [{ type: 'command', command: DIGEST_HAND_FIXED }] },
      { hooks: [{ type: 'command', command: ROUTE_SS }] },
      { hooks: [{ type: 'command', command: DIGEST_TEMPLATE }, { type: 'command', command: ROUTE_SS }] },
      { hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: 'echo mine' }] }
    ],
    PreToolUse: [
      { matcher: 'Edit', hooks: [{ type: 'command', command: LINT }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: LINT }] }
    ]
  };
  assert.equal(dedupeBrainHooks(hooks), 3);
  const ss = hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(ss, [DIGEST_HAND_FIXED, ROUTE_SS, 'echo mine', 'echo mine'], 'first occurrence kept, user duplicates untouched');
  assert.equal(hooks.SessionStart.length, 3, 'the emptied group is gone');
  assert.equal(hooks.PreToolUse.length, 1);
});

test('settings sync (real template): a partially known group adds only its missing hooks, and cleans old duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-settings-partial-'));
  withRealTemplate(dir);
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: ROUTE_SS }] }, { hooks: [{ type: 'command', command: ROUTE_SS }] }]
    }
  }));
  const run = () => spawnSync(process.execPath, [SETTINGS_SCRIPT], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA: '1', PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS: '1' }
  });
  const first = run();
  assert.equal(first.status, 0);
  assert.match(first.stdout, /duplicate-brain-hooks-removed:1/, 'the old duplicate was cleaned');
  const once = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'), once, 'a second sync changes nothing');
  const merged = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  for (const [event, groups] of Object.entries(merged.hooks)) {
    const ids = groups.flatMap((g) => g.hooks.map((h) => hookIdentity(h.command))).filter((id) => id.startsWith('brain-script:'));
    assert.equal(new Set(ids).size, ids.length, `${event}: no brain hook twice (${ids.join(', ')})`);
  }
});
