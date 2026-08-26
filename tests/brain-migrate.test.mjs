/**
 * brain-migrate tests (scripts/brain-migrate.mjs, ADR 0028 / strategy §M1).
 *
 * Unit tests cover the pure planners (script rewriting incl. arg
 * preservation, hook-command rewriting, community plugin/marketplace
 * matching). Subprocess tests spawn the script against a mkdtemp host wired
 * like a real symlink install and assert consent semantics: --dry-run writes
 * nothing; --yes rewrites package.json + .claude/settings.json and leaves
 * .project-brain/ byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  rewriteScriptCommand,
  planScriptRewrites,
  rewriteHookCommand,
  planHookRewrites,
  planPluginRemovals,
  computeMigratePlan,
  CLI_NAME
} from '../scripts/brain-migrate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = fs.realpathSync(path.resolve(here, '..'));
const MIGRATE = path.join(PACKAGE_ROOT, 'scripts', 'brain-migrate.mjs');

const LEGACY = (script, extra = '') =>
  `node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/${script}${extra}`;

// --- pure: package.json script rewriting -----------------------------------

test('rewriteScriptCommand maps public verbs to their direct form', () => {
  assert.deepEqual(rewriteScriptCommand(LEGACY('brain-guard.mjs')), {
    action: 'rewrite',
    to: `${CLI_NAME} guard`
  });
  // brain-health -> status, brain-repair -> doctor (renamed verbs)
  assert.equal(rewriteScriptCommand(LEGACY('brain-health.mjs')).to, `${CLI_NAME} status`);
  assert.equal(rewriteScriptCommand(LEGACY('brain-repair.mjs')).to, `${CLI_NAME} doctor`);
});

test('rewriteScriptCommand preserves extra args (brain:symbol form)', () => {
  const r = rewriteScriptCommand(LEGACY('brain-search.mjs', ' --type code --symbol'));
  assert.deepEqual(r, { action: 'rewrite', to: `${CLI_NAME} search --type code --symbol` });
});

test('rewriteScriptCommand routes non-public scripts through the x hatch', () => {
  assert.equal(rewriteScriptCommand(LEGACY('brain-sync.mjs')).to, `${CLI_NAME} x sync`);
  assert.equal(
    rewriteScriptCommand(LEGACY('brain-session-digest.mjs')).to,
    `${CLI_NAME} x session-digest`
  );
});

test('rewriteScriptCommand handles the single --preserve-symlinks flag form too', () => {
  const r = rewriteScriptCommand('node --preserve-symlinks skills/project-brain/scripts/brain-lease.mjs');
  assert.deepEqual(r, { action: 'rewrite', to: `${CLI_NAME} lease` });
});

test('rewriteScriptCommand removes symlink-mode plumbing with no CLI surface', () => {
  assert.equal(rewriteScriptCommand('bash skills/project-brain/bin/update.sh').action, 'remove');
  assert.equal(rewriteScriptCommand('bash skills/project-brain/bin/install-hooks.sh').action, 'remove');
  assert.equal(rewriteScriptCommand(LEGACY('install-cursor-hooks.mjs')).action, 'remove');
});

test('rewriteScriptCommand never guesses: unrecognized skill refs and user scripts are untouched', () => {
  assert.equal(
    rewriteScriptCommand('cat skills/project-brain/SKILL.md | less').action,
    'skip-unrecognized'
  );
  assert.equal(rewriteScriptCommand('vite build').action, 'skip-untouched');
  assert.equal(rewriteScriptCommand('node scripts/my-own.mjs').action, 'skip-untouched');
});

test('planScriptRewrites reports only skill-referencing entries', () => {
  const plan = planScriptRewrites({
    'brain:guard': LEGACY('brain-guard.mjs'),
    'brain:symbol': LEGACY('brain-search.mjs', ' --type code --symbol'),
    'brain:update-skill': 'bash skills/project-brain/bin/update.sh',
    dev: 'vite'
  });
  assert.equal(plan.id, 'package-scripts');
  assert.equal(plan.changes.length, 3);
  const byKey = Object.fromEntries(plan.changes.map((c) => [c.key, c]));
  assert.equal(byKey['brain:guard'].to, `${CLI_NAME} guard`);
  assert.equal(byKey['brain:symbol'].to, `${CLI_NAME} search --type code --symbol`);
  assert.equal(byKey['brain:update-skill'].action, 'remove');
  assert.ok(!byKey.dev);
});

// --- pure: hook command rewriting ------------------------------------------

test('rewriteHookCommand rewrites $CLAUDE_PROJECT_DIR hook forms and keeps suffixes', () => {
  const r = rewriteHookCommand(
    'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-route.mjs" --hook --event sessionstart || true'
  );
  assert.equal(r.changed, true);
  assert.equal(r.to, `${CLI_NAME} x route --hook --event sessionstart || true`);
});

test('rewriteHookCommand keeps redirects intact and handles unquoted forms', () => {
  const r = rewriteHookCommand(
    'node skills/project-brain/scripts/brain-prune.mjs --apply >/dev/null 2>&1 || true'
  );
  assert.equal(r.to, `${CLI_NAME} x prune --apply >/dev/null 2>&1 || true`);
  const untouched = rewriteHookCommand("echo '=== Project Brain ===' && cat .project-brain/active_state.md");
  assert.equal(untouched.changed, false);
  assert.equal(untouched.unrecognized, false);
});

test('planHookRewrites preserves matchers/events and rewrites in a deep copy', () => {
  const hooks = {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-lint-conventions.mjs"' }
        ]
      }
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'cat .project-brain/active_state.md' }] }
    ]
  };
  const before = structuredClone(hooks);
  const plan = planHookRewrites(hooks);
  assert.deepEqual(hooks, before, 'input must not be mutated');
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].event, 'PreToolUse');
  assert.equal(plan.nextHooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit');
  assert.equal(plan.nextHooks.PreToolUse[0].hooks[0].command, `${CLI_NAME} x lint-conventions`);
  assert.equal(plan.nextHooks.SessionStart[0].hooks[0].command, 'cat .project-brain/active_state.md');
});

// --- pure: community plugin/marketplace removal ----------------------------

const COMMUNITY = {
  enabledPlugins: { 'caveman@caveman': true, 'unit-testing@claude-code-workflows': true },
  extraKnownMarketplaces: {
    caveman: { source: { source: 'github', repo: 'JuliusBrussee/caveman' } },
    'claude-code-workflows': { source: { source: 'github', repo: 'wshobson/agents' } }
  }
};

test('planPluginRemovals matches template keys only, keeps user plugins', () => {
  const plan = planPluginRemovals(
    {
      enabledPlugins: { 'caveman@caveman': true, 'mine@my-market': true },
      extraKnownMarketplaces: { caveman: {}, 'my-market': {} }
    },
    COMMUNITY
  );
  assert.deepEqual(plan.plugins, ['caveman@caveman']);
  assert.deepEqual(plan.marketplaces, ['caveman']);
});

test('planPluginRemovals keeps a marketplace still referenced by a surviving plugin', () => {
  const plan = planPluginRemovals(
    {
      // user manually enabled another plugin from the community marketplace —
      // the marketplace must survive even though its key matches the template
      enabledPlugins: { 'unit-testing@claude-code-workflows': true, 'my-extra@claude-code-workflows': true },
      extraKnownMarketplaces: { 'claude-code-workflows': {} }
    },
    COMMUNITY
  );
  assert.deepEqual(plan.plugins, ['unit-testing@claude-code-workflows']);
  assert.deepEqual(plan.marketplaces, []);
});

test('planPluginRemovals is a no-op on empty settings', () => {
  const plan = planPluginRemovals({}, COMMUNITY);
  assert.deepEqual(plan.plugins, []);
  assert.deepEqual(plan.marketplaces, []);
});

// --- subprocess: mkdtemp host ----------------------------------------------

const HOST_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: { allow: ['Bash(npm run brain:*)'] },
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-route.mjs" --hook --event sessionstart || true'
          }
        ]
      }
    ],
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-lint-conventions.mjs"'
          }
        ]
      }
    ]
  },
  enabledPlugins: { 'caveman@caveman': true, 'mine@my-market': true },
  extraKnownMarketplaces: {
    caveman: { source: { source: 'github', repo: 'JuliusBrussee/caveman' } },
    'my-market': { source: { source: 'github', repo: 'me/market' } }
  }
};

function makeHost() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-migrate-')));
  fs.mkdirSync(path.join(cwd, 'skills'), { recursive: true });
  fs.symlinkSync(PACKAGE_ROOT, path.join(cwd, 'skills', 'project-brain'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.project-brain', 'active_state.md'), '# Active State\n- untouched\n');
  fs.writeFileSync(path.join(cwd, '.project-brain', 'context_index.md'), '# Context\n');
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          'brain:guard': LEGACY('brain-guard.mjs'),
          'brain:sync': LEGACY('brain-sync.mjs'),
          'brain:symbol': LEGACY('brain-search.mjs', ' --type code --symbol'),
          'brain:update-skill': 'bash skills/project-brain/bin/update.sh',
          dev: 'vite'
        }
      },
      null,
      2
    ) + '\n'
  );
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.claude', 'settings.json'),
    JSON.stringify(HOST_SETTINGS, null, 2) + '\n'
  );
  return cwd;
}

function runMigrate(cwd, args) {
  const env = { ...process.env };
  delete env.BRAIN_ROOT;
  return spawnSync(process.execPath, [MIGRATE, ...args], { cwd, encoding: 'utf8', env });
}

function snapshotBrainDir(cwd) {
  const dir = path.join(cwd, '.project-brain');
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    out[name] = fs.readFileSync(path.join(dir, name));
  }
  return out;
}

test('computeMigratePlan detects the symlinked package and plans all three groups', () => {
  const cwd = makeHost();
  const plan = computeMigratePlan({ cwd, packageDir: PACKAGE_ROOT });
  assert.equal(plan.skill.exists, true);
  assert.equal(plan.skill.resolvesToPackage, true);
  const scripts = plan.groups.find((g) => g.id === 'package-scripts');
  assert.equal(scripts.changes.length, 4);
  const hooks = plan.groups.find((g) => g.id === 'claude-hooks');
  assert.equal(hooks.changes.length, 2);
  const plugins = plan.groups.find((g) => g.id === 'community-plugins');
  assert.deepEqual(plugins.plugins, ['caveman@caveman']);
  assert.deepEqual(plugins.marketplaces, ['caveman']);
});

test('migrate --dry-run prints the plan and writes nothing', () => {
  const cwd = makeHost();
  const pkgBefore = fs.readFileSync(path.join(cwd, 'package.json'));
  const settingsBefore = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'));
  const brainBefore = snapshotBrainDir(cwd);

  const r = runMigrate(cwd, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /migrate plan/);
  assert.match(r.stdout, /Dry run: nothing was written\./);
  assert.match(r.stdout, /caveman@caveman/, 'plugins offered for removal are listed by name');

  assert.deepEqual(fs.readFileSync(path.join(cwd, 'package.json')), pkgBefore);
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.claude', 'settings.json')), settingsBefore);
  assert.deepEqual(snapshotBrainDir(cwd), brainBefore);
});

test('migrate --yes rewrites package.json + settings and leaves .project-brain byte-identical', () => {
  const cwd = makeHost();
  const brainBefore = snapshotBrainDir(cwd);

  const r = runMigrate(cwd, ['--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Migrated:/);

  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['brain:guard'], `${CLI_NAME} guard`);
  assert.equal(pkg.scripts['brain:sync'], `${CLI_NAME} x sync`);
  assert.equal(pkg.scripts['brain:symbol'], `${CLI_NAME} search --type code --symbol`);
  assert.ok(!('brain:update-skill' in pkg.scripts), 'symlink-mode updater is removed');
  assert.equal(pkg.scripts.dev, 'vite', 'user scripts are untouched');
  assert.ok(
    !JSON.stringify(pkg).includes('--preserve-symlinks skills/'),
    'no legacy --preserve-symlinks skills/ forms remain'
  );

  const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(
    settings.hooks.SessionStart[0].hooks[0].command,
    `${CLI_NAME} x route --hook --event sessionstart || true`
  );
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit', 'matchers preserved');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `${CLI_NAME} x lint-conventions`);
  assert.ok(!('caveman@caveman' in (settings.enabledPlugins ?? {})), 'community plugin removed');
  assert.equal(settings.enabledPlugins['mine@my-market'], true, 'user plugin kept');
  assert.ok(!('caveman' in (settings.extraKnownMarketplaces ?? {})), 'community marketplace removed');
  assert.ok('my-market' in settings.extraKnownMarketplaces, 'user marketplace kept');
  assert.deepEqual(settings.permissions.allow, ['Bash(npm run brain:*)'], 'permissions untouched');

  assert.deepEqual(snapshotBrainDir(cwd), brainBefore, '.project-brain data must be byte-identical');

  // Idempotence: a second run finds nothing left to migrate and writes nothing.
  const pkgAfter = fs.readFileSync(path.join(cwd, 'package.json'));
  const r2 = runMigrate(cwd, ['--yes']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /Nothing to migrate/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'package.json')), pkgAfter);
});

test('migrate without a skill install exits 0 with a clear message', () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-migrate-none-')));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  const r = runMigrate(cwd, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No skill-mode install detected/);
});

test('cli dispatcher exposes migrate as an advanced verb', () => {
  const CLI = path.join(PACKAGE_ROOT, 'bin', 'cli.mjs');
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const advanced = r.stdout.slice(r.stdout.indexOf('Advanced:'));
  assert.match(advanced, /^\s{2}migrate\b/m, 'migrate should be listed in the Advanced tier');
});
