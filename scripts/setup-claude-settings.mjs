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
 * consumers automatically get the brain's hook wiring when they update
 * the skill. Third-party plugins/marketplaces are NEVER merged silently:
 * they live in settings.community-plugins.json and require
 * PROJECT_BRAIN_COMMUNITY_PLUGINS=1 or --community-plugins (decisions/0028).
 *
 * Bypass with PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1 (e.g. CI, projects
 * that manage their own .claude/settings.json by hand).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_SETTINGS = path.join(process.cwd(), '.claude', 'settings.json');
const TEMPLATE = path.join(
  process.cwd(),
  'skills',
  'project-brain',
  'templates',
  'claude-code',
  'settings.recommended.json',
);
// Third-party plugins/marketplaces live in a separate template and are only
// merged on explicit opt-in — a commercial-grade installer must never enable
// external code silently (decisions/0028). Audit marketplaces with
// brain:skill-audit before opting in.
const COMMUNITY_TEMPLATE = path.join(
  path.dirname(TEMPLATE),
  'settings.community-plugins.json',
);
const COMMUNITY_OPT_IN =
  process.env.PROJECT_BRAIN_COMMUNITY_PLUGINS === '1' ||
  process.argv.includes('--community-plugins');

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

/**
 * The auto-compact window to opt into, or null. Claude Code compacts 1M-context
 * models at ≈ 967k tokens; measured on real sessions, a 300k window cuts input
 * by ≈ 2/3 (docs/roadmap-next.md, workstream K). Opt-in because a lower window
 * is only safe together with the warm layer (brain-warm.mjs) that re-injects
 * the session state after each compaction.
 *
 *   PROJECT_BRAIN_AUTO_COMPACT_WINDOW=1|300000   or   --auto-compact-window[=N]
 *
 * PURE given argv/env. `1`/bare flag → the measured default 300000; values
 * outside Claude Code's accepted 100000–1000000 are refused (null).
 */
export const AUTO_COMPACT_DEFAULT = 300000;
export function autoCompactWindowOptIn(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a === '--auto-compact-window' || a.startsWith('--auto-compact-window='));
  const raw = flag ? (flag.split('=')[1] ?? '1') : env.PROJECT_BRAIN_AUTO_COMPACT_WINDOW;
  if (raw === undefined || raw === '' || raw === '0') return null;
  const n = raw === '1' ? AUTO_COMPACT_DEFAULT : Number(raw);
  return Number.isInteger(n) && n >= 100000 && n <= 1000000 ? n : null;
}

/**
 * K2 (docs/roadmap-next.md): what Claude Code's own compaction summary should
 * keep and drop. Claude Code reads a "Compact Instructions" section of
 * CLAUDE.md; this block lives between markers so updates replace only it.
 * CLAUDE.md is sent with EVERY request — the block stays near 150 tokens.
 * Written only with the auto-compact opt-in: the two belong together.
 */
export const COMPACT_BEGIN = '<!-- project-brain:compact-instructions — managed; edit outside these markers -->';
export const COMPACT_END = '<!-- /project-brain:compact-instructions -->';
export const COMPACT_BLOCK = [
  COMPACT_BEGIN,
  '## Compact Instructions',
  '',
  'Keep: the user\'s goal and latest asks in their words; decisions and why; paths with line ranges being changed; what last passed or failed (tests, build); open items and the next step; ruled-out approaches, one line each.',
  'Drop: raw tool output, file contents, logs, search results, resolved errors. The project brain re-injects session state after compaction, and `brain_recall` fetches any dropped detail from the transcript, so keep pointers (path:line, command), not copies.',
  COMPACT_END
].join('\n');

/**
 * PURE. Insert or refresh the managed block. Returns the new text and what
 * happened ('added' | 'updated' | 'unchanged'). Text outside the markers is
 * never touched; a lone begin marker (hand-damaged block) is left alone.
 */
export function upsertCompactInstructions(text = '', block = COMPACT_BLOCK) {
  const begin = text.indexOf(COMPACT_BEGIN);
  const end = text.indexOf(COMPACT_END);
  if (begin !== -1 && end > begin) {
    const next = text.slice(0, begin) + block + text.slice(end + COMPACT_END.length);
    return { text: next, status: next === text ? 'unchanged' : 'updated' };
  }
  if (begin !== -1) return { text, status: 'unchanged' };
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: text + sep + block + '\n', status: 'added' };
}

/**
 * PURE (mutates `existing`). Add the template's env keys a settings file does
 * not set yet — never overwrite a value the developer chose. The template's
 * env (e.g. BRAIN_USAGE_LOG) used to be silently dropped by the sync.
 */
export function mergeEnv(existing = {}, extra = {}) {
  let added = 0;
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in existing)) {
      existing[k] = String(v);
      added += 1;
    }
  }
  return added;
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

export function collectCommands(hookGroups) {
  const cmds = new Set();
  for (const group of hookGroups ?? []) {
    for (const h of group?.hooks ?? []) {
      if (typeof h?.command === 'string') cmds.add(h.command.trim());
    }
  }
  return cmds;
}

/**
 * PURE. What a hook command DOES, for de-duplication: the brain script it runs
 * plus its arguments, ignoring node flags, `|| true` and output redirection.
 *
 * Commands used to be compared as exact strings, so a hook a user had fixed by
 * hand, e.g. `node --preserve-symlinks …/brain-state-digest.mjs || true` (the
 * workaround for the symlink bug), counted as "missing". The next update then
 * appended the template form beside it, and once both forms work, the digest
 * is injected twice. Non-brain commands keep exact-string identity.
 */
export function hookIdentity(command) {
  const cmd = String(command || '').trim();
  const m = cmd.match(/^node\s+(?:--[\w-]+(?:=\S+)?\s+)*["']?([^"'\s]*\/scripts\/([\w.-]+\.mjs))["']?(.*)$/);
  if (!m) return cmd;
  const args = m[3]
    .replace(/\s*\|\|\s*true\s*$/, '')
    .replace(/\s*[12]?>\s*\/dev\/null(\s+2>&1)?/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return `brain-script:${m[2]}${args ? ` ${args}` : ''}`;
}

/** Hook identities (hookIdentity) present in a list of hook groups. */
function collectHookIdentities(hookGroups) {
  return new Set([...collectCommands(hookGroups)].map(hookIdentity));
}

/**
 * PURE. Report the drift between an installed `.claude/settings.json` object
 * and the recommended template — i.e. what the additive merge WOULD still add.
 * Focused on the wiring that silently rots when `bin/update.sh` refreshes
 * scripts but not settings (issue #34): ambient-routing hooks (ADR 0023) and
 * the recommended permission allow-list. Never mutates its inputs.
 *
 * @param {object} installed   parsed host .claude/settings.json (or {})
 * @param {object} recommended parsed settings.recommended.json (or {})
 * @returns {{ missingHooks: {event:string,command:string}[], missingAllow: string[], hookDrift: number, allowDrift: number, drift: boolean }}
 */
export function computeSettingsDrift(installed = {}, recommended = {}) {
  const missingHooks = [];
  const recHooks = recommended?.hooks ?? {};
  const instHooks = installed?.hooks ?? {};
  for (const [event, groups] of Object.entries(recHooks)) {
    const have = collectHookIdentities(instHooks[event]);
    for (const group of groups ?? []) {
      for (const h of group?.hooks ?? []) {
        const cmd = typeof h?.command === 'string' ? h.command.trim() : '';
        if (cmd && !have.has(hookIdentity(cmd))) missingHooks.push({ event, command: cmd });
      }
    }
  }
  const haveAllow = new Set(installed?.permissions?.allow ?? []);
  const missingAllow = (recommended?.permissions?.allow ?? []).filter((a) => !haveAllow.has(a));
  return {
    missingHooks,
    missingAllow,
    hookDrift: missingHooks.length,
    allowDrift: missingAllow.length,
    drift: missingHooks.length > 0 || missingAllow.length > 0
  };
}

/**
 * Upgrade legacy hook commands in place before the additive merge, so an
 * update never leaves both the old and new form injecting side by side.
 * Currently: the pre-M2 SessionStart full `cat active_state.md` becomes the
 * budget-capped state digest (see brain-state-digest.mjs / ADR 0024).
 * Returns the number of rewritten commands.
 */
function upgradeLegacyHooks(existing = {}) {
  const LEGACY_STATE_CAT =
    /^echo '=== Project Brain: Active State ==='\s*&&\s*cat \.project-brain\/active_state\.md$/;
  const DIGEST_CMD =
    'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-state-digest.mjs" || true';
  let rewritten = 0;
  for (const groups of Object.values(existing)) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook?.command === 'string' && LEGACY_STATE_CAT.test(hook.command.trim())) {
          hook.command = DIGEST_CMD;
          rewritten += 1;
        }
      }
    }
  }
  return rewritten;
}

/**
 * PURE (mutates `hooks` in place, returns the count). Drop a BRAIN hook that
 * repeats an earlier brain hook of the same event (by hookIdentity), and any
 * group that empties out. Only brain-script hooks are touched: a user's own
 * hook is theirs to duplicate.
 */
export function dedupeBrainHooks(hooks = {}) {
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    const seen = new Set();
    const kept = [];
    for (const group of groups ?? []) {
      const list = (group?.hooks ?? []).filter((h) => {
        const id = typeof h?.command === 'string' ? hookIdentity(h.command) : '';
        if (!id.startsWith('brain-script:')) return true;
        if (seen.has(id)) { removed += 1; return false; }
        seen.add(id);
        return true;
      });
      if (list.length || !(group?.hooks ?? []).length) kept.push({ ...group, hooks: list });
    }
    hooks[event] = kept;
  }
  return removed;
}

function mergeHooks(existing = {}, extra = {}) {
  let added = 0;
  for (const [event, groups] of Object.entries(extra)) {
    const have = collectHookIdentities(existing[event]);
    const wantedGroups = [];
    for (const group of groups) {
      // Only the hooks this settings file does not have yet. Appending the
      // whole group when ONE of its hooks was missing re-added the others:
      // that is how club-ops ended up running brain-route at SessionStart and
      // lint-conventions on every edit twice.
      const missing = (group.hooks ?? []).filter((h) => {
        const cmd = h?.command?.trim();
        return cmd && !have.has(hookIdentity(cmd));
      });
      if (!missing.length) continue;
      wantedGroups.push({ ...group, hooks: missing });
      missing.forEach((h) => have.add(hookIdentity(h.command.trim())));
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

  // hooks — upgrade legacy forms first, then append non-duplicate groups
  existing.hooks = existing.hooks ?? {};
  const upgraded = upgradeLegacyHooks(existing.hooks);
  const deduped = dedupeBrainHooks(existing.hooks);
  const hooksResult = mergeHooks(existing.hooks, recommended.hooks ?? {});

  // env — additive; the auto-compact window only on explicit opt-in.
  existing.env = existing.env ?? {};
  const window = autoCompactWindowOptIn();
  const envAdded = mergeEnv(existing.env, {
    ...(recommended.env ?? {}),
    ...(window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: window } : {}),
  });
  if (Object.keys(existing.env).length === 0) delete existing.env;

  // K7: the context status-line segment — explicit opt-in, and never over an
  // existing status line (a project one would replace the user's own).
  let statusLine = null;
  if (process.argv.includes('--statusline') || process.env.PROJECT_BRAIN_STATUSLINE === '1') {
    if (existing.statusLine) statusLine = 'kept-yours';
    else {
      existing.statusLine = {
        type: 'command',
        command: 'node "$CLAUDE_PROJECT_DIR/skills/project-brain/scripts/brain-statusline.mjs"'
      };
      statusLine = 'added';
    }
  }

  // K2: compact instructions in CLAUDE.md, with the same opt-in.
  let compactStatus = null;
  if (window) {
    const claudeMd = path.join(process.cwd(), 'CLAUDE.md');
    const before = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
    const res = upsertCompactInstructions(before);
    if (res.status !== 'unchanged') fs.writeFileSync(claudeMd, res.text);
    compactStatus = res.status;
  }

  // enabledPlugins / extraKnownMarketplaces — third-party code, opt-in only
  // (decisions/0028). Without the opt-in nothing is merged; existing user
  // entries are never touched either way.
  const community = COMMUNITY_OPT_IN ? readJson(COMMUNITY_TEMPLATE, {}) : {};
  existing.enabledPlugins = existing.enabledPlugins ?? {};
  const pluginsResult = mergeObjectMap(existing.enabledPlugins, community.enabledPlugins ?? {});
  if (Object.keys(existing.enabledPlugins).length === 0) delete existing.enabledPlugins;

  existing.extraKnownMarketplaces = existing.extraKnownMarketplaces ?? {};
  const marketsResult = mergeObjectMap(
    existing.extraKnownMarketplaces,
    community.extraKnownMarketplaces ?? {},
  );
  if (Object.keys(existing.extraKnownMarketplaces).length === 0) {
    delete existing.extraKnownMarketplaces;
  }

  fs.writeFileSync(HOST_SETTINGS, JSON.stringify(existing, null, 2) + '\n');
  const summary = [
    `allow:+${allowResult.added}`,
    `hooks:+${hooksResult.added}`,
    `env:+${envAdded}`,
    ...(compactStatus ? [`compact-instructions:${compactStatus}`] : []),
    ...(statusLine ? [`statusline:${statusLine}`] : []),
    `plugins:+${pluginsResult.added}`,
    `marketplaces:+${marketsResult.added}`,
    ...(upgraded > 0 ? [`legacy-hooks-upgraded:${upgraded}`] : []),
    ...(deduped > 0 ? [`duplicate-brain-hooks-removed:${deduped}`] : []),
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
  const here = realpathSync(fileURLToPath(import.meta.url));
  const invoked = realpathSync(process.argv[1] ?? '');
  if (here === invoked) syncClaudeSettings();
} catch {
  // No-op when invoked as a module.
}
