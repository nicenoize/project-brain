/**
 * Merge the brain's recommended .claude/settings.json into the host
 * project's settings file. Additive only:
 *   - never overwrite an existing value
 *   - for `hooks`, only append a hook group whose `command` string is
 *     not already present anywhere under the same event name
 *   - for object maps (`enabledPlugins`, `extraKnownMarketplaces`,
 *     `permissions.allow`), only add missing keys/entries
 *
 * Called from setup-package.mjs at the end of `brain:update-skill`, so
 * consumers automatically get the brain's hook wiring and the
 * recommended plugin/marketplace set when they update the skill.
 *
 * Bypass with PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1 (e.g. CI, projects
 * that manage their own .claude/settings.json by hand).
 */
import fs from 'node:fs';
import path from 'node:path';

const HOST_SETTINGS = path.join(process.cwd(), '.claude', 'settings.json');
const TEMPLATE = path.join(
  process.cwd(),
  'skills',
  'project-brain',
  'templates',
  'claude-code',
  'settings.recommended.json',
);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function mergeAllowList(existing = [], extra = []) {
  const set = new Set(existing);
  let added = 0;
  for (const entry of extra) {
    if (!set.has(entry)) {
      set.add(entry);
      added += 1;
    }
  }
  return { merged: [...set], added };
}

function mergeObjectMap(existing = {}, extra = {}) {
  let added = 0;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in existing)) {
      existing[k] = v;
      added += 1;
    }
  }
  return { merged: existing, added };
}

function collectCommands(hookGroups) {
  const cmds = new Set();
  for (const group of hookGroups ?? []) {
    for (const h of group?.hooks ?? []) {
      if (typeof h?.command === 'string') cmds.add(h.command.trim());
    }
  }
  return cmds;
}

function mergeHooks(existing = {}, extra = {}) {
  let added = 0;
  for (const [event, groups] of Object.entries(extra)) {
    const have = collectCommands(existing[event]);
    const wantedGroups = [];
    for (const group of groups) {
      const groupCmds = (group.hooks ?? [])
        .map((h) => h?.command?.trim())
        .filter(Boolean);
      const allKnown = groupCmds.every((c) => have.has(c));
      if (allKnown) continue;
      wantedGroups.push(group);
      groupCmds.forEach((c) => have.add(c));
      added += 1;
    }
    if (wantedGroups.length > 0) {
      existing[event] = [...(existing[event] ?? []), ...wantedGroups];
    }
  }
  return { merged: existing, added };
}

export function syncClaudeSettings() {
  if (process.env.PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS === '1') {
    console.log('Skipping .claude/settings.json sync (PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1).');
    return;
  }
  if (!fs.existsSync(TEMPLATE)) {
    console.warn(`[brain] settings template not found at ${TEMPLATE}; skipping`);
    return;
  }
  const recommended = readJson(TEMPLATE);
  if (!recommended) return;

  const existing = readJson(HOST_SETTINGS, {});
  fs.mkdirSync(path.dirname(HOST_SETTINGS), { recursive: true });

  // $schema — set if missing
  if (!existing.$schema && recommended.$schema) existing.$schema = recommended.$schema;

  // permissions.allow — union
  existing.permissions = existing.permissions ?? {};
  const allowResult = mergeAllowList(
    existing.permissions.allow ?? [],
    recommended.permissions?.allow ?? [],
  );
  existing.permissions.allow = allowResult.merged;

  // hooks — append non-duplicate groups per event
  existing.hooks = existing.hooks ?? {};
  const hooksResult = mergeHooks(existing.hooks, recommended.hooks ?? {});

  // enabledPlugins — union (project may override individually to false later)
  existing.enabledPlugins = existing.enabledPlugins ?? {};
  const pluginsResult = mergeObjectMap(existing.enabledPlugins, recommended.enabledPlugins ?? {});

  // extraKnownMarketplaces — union
  existing.extraKnownMarketplaces = existing.extraKnownMarketplaces ?? {};
  const marketsResult = mergeObjectMap(
    existing.extraKnownMarketplaces,
    recommended.extraKnownMarketplaces ?? {},
  );

  fs.writeFileSync(HOST_SETTINGS, JSON.stringify(existing, null, 2) + '\n');
  const summary = [
    `allow:+${allowResult.added}`,
    `hooks:+${hooksResult.added}`,
    `plugins:+${pluginsResult.added}`,
    `marketplaces:+${marketsResult.added}`,
  ].join(' ');
  console.log(`Synced .claude/settings.json (${summary}).`);

  syncClaudeCommands();
  setCavemanUltra();
}

/**
 * Copy brain-provided custom slash commands into .claude/commands/.
 * Additive: never overwrites a file the developer has touched. The
 * /brain-speckit-* commands bridge spec-kit's /speckit.* flow into the
 * brain pipeline (see decisions/0012-spec-kit-integration.md).
 */
function syncClaudeCommands() {
  if (process.env.PROJECT_BRAIN_SKIP_CLAUDE_COMMANDS === '1') return;
  const templateDir = path.join(
    process.cwd(),
    'skills',
    'project-brain',
    'templates',
    'claude-code',
    'commands',
  );
  if (!fs.existsSync(templateDir)) return;
  const targetDir = path.join(process.cwd(), '.claude', 'commands');
  fs.mkdirSync(targetDir, { recursive: true });
  let added = 0;
  for (const name of fs.readdirSync(templateDir)) {
    if (!name.endsWith('.md')) continue;
    const src = path.join(templateDir, name);
    const dst = path.join(targetDir, name);
    if (fs.existsSync(dst)) continue; // don't clobber developer edits
    fs.copyFileSync(src, dst);
    added += 1;
  }
  if (added) console.log(`Installed ${added} brain slash command(s) under .claude/commands/.`);
}

/**
 * Idempotently set the caveman compression mode to `ultra` (the token-
 * efficient default for inter-agent communication per the brain's
 * ADR convention). Skips when:
 *   - PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA=1 (developer opt-out)
 *   - flag file already contains a non-default mode the developer
 *     picked themselves (lite/wenyan/wenyan-lite/etc.) — only `full`
 *     (the SessionStart-hook default) and empty get upgraded.
 *
 * The caveman plugin lives at user scope, so the flag is at
 * ~/.claude/.caveman-active and applies across all projects on this
 * machine. First project to setup wins; subsequent projects are
 * no-ops.
 */
function setCavemanUltra() {
  if (process.env.PROJECT_BRAIN_SKIP_CAVEMAN_ULTRA === '1') return;
  const flag = path.join(process.env.HOME ?? '', '.claude', '.caveman-active');
  if (!flag.startsWith('/')) return; // safety: no HOME, abort
  let current = '';
  try {
    current = fs.readFileSync(flag, 'utf8').trim();
  } catch {
    // file may not exist — that's fine, we'll create it
  }
  if (current && current !== 'full') {
    console.log(`Caveman already set to '${current}' — leaving as-is.`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, 'ultra');
    console.log("Caveman compression set to 'ultra' (token-efficient default).");
  } catch (err) {
    console.warn(`[brain] failed to set caveman mode: ${err.message}`);
  }
}

// Allow `node scripts/setup-claude-settings.mjs` direct invocation too.
// Use realpath so the check survives symlinked vendor checkouts.
import { realpathSync } from 'node:fs';
try {
  const here = realpathSync(new URL(import.meta.url).pathname);
  const invoked = realpathSync(process.argv[1] ?? '');
  if (here === invoked) syncClaudeSettings();
} catch {
  // No-op when invoked as a module.
}
