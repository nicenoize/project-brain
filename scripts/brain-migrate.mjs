/**
 * brain-migrate — convert a symlink/skill-mode install to CLI mode (ADR 0028,
 * docs/strategy-agent-ops.md §M1).
 *
 * In a HOST repo that consumes the package at skills/project-brain, this
 * command rewrites the legacy wiring onto the `project-brain` CLI:
 *
 *   1. package.json `brain:*` scripts: the
 *      `node --preserve-symlinks[-main] skills/project-brain/scripts/brain-X.mjs …`
 *      forms become `project-brain <verb> …` for the public verbs (the verb
 *      table mirrors bin/cli.mjs, which we cannot import — it executes argv at
 *      module top level) and `project-brain x <script> …` for everything else.
 *      Extra args (`--type code --symbol`, …) are preserved verbatim. Entries
 *      with no CLI surface (bash bin/*.sh updaters, non-brain-* node scripts)
 *      are REMOVED — in CLI mode npm owns install/update, and `x` only reaches
 *      scripts/brain-*.mjs. Unrecognized commands are never guessed at: they
 *      are reported and left untouched.
 *   2. .claude/settings.json hook commands pointing at
 *      skills/project-brain/scripts/brain-*.mjs become `project-brain x …`
 *      equivalents; matchers, events, extra args and shell suffixes
 *      (`|| true`, redirects) are preserved. We deliberately do NOT import
 *      parsing helpers from setup-claude-settings.mjs: its exports cover
 *      drift/merge, not command rewriting, so the minimal JSON surgery lives
 *      here. (Its module top level is side-effect-free — init-plan.mjs imports
 *      it — but there is simply nothing to reuse for this direction.)
 *   3. Offers removal of previously auto-enabled third-party plugins and
 *      marketplaces whose keys match
 *      templates/claude-code/settings.community-plugins.json (listed by name;
 *      a marketplace is only removed when no remaining enabled plugin still
 *      references it). User-added plugins are never touched.
 *
 * NEVER touches `.project-brain/` data.
 *
 * Consent UX mirrors setup-package.mjs:
 *   --dry-run   print the full plan and exit 0 — writes NOTHING
 *   --yes       apply every group without prompting
 *   (interactive per-group Y/n prompts only when stdin AND stdout are TTYs;
 *    non-TTY without flags applies everything, exactly like the installer)
 *
 * The plan* functions below are PURE (plain data in, plain data out — no fs,
 * no env, no prompts) and unit-tested in tests/brain-migrate.test.mjs.
 * computeMigratePlan() only READS the filesystem; the shell at the bottom
 * prints, prompts, and applies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PACKAGE_DIR, read, write, takeFlag } from './common.mjs';

/**
 * Public verb table — MUST mirror bin/cli.mjs (VERBS + ADVANCED_VERBS),
 * keyed by script basename. Everything not listed here migrates to the
 * `project-brain x <script>` escape hatch.
 */
export const VERB_BY_SCRIPT = {
  'brain-init.mjs': 'init',
  'brain-health.mjs': 'status',
  'brain-lease.mjs': 'lease',
  'brain-work.mjs': 'work',
  'brain-brief.mjs': 'brief',
  'brain-grill.mjs': 'grill',
  'brain-handoff.mjs': 'handoff',
  'brain-guard.mjs': 'guard',
  'brain-repair.mjs': 'doctor',
  'brain-search.mjs': 'search',
  'brain-ask.mjs': 'ask',
  'brain-orchestrate.mjs': 'orchestrate',
  'brain-migrate.mjs': 'migrate'
};

/** Provisional bin name (bin/cli.mjs, package.json `bin`). */
export const CLI_NAME = 'project-brain';

// Legacy npm-script forms emitted by mergePackageScripts (scripts/common.mjs):
//   node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/<name>.mjs [args]
//   bash skills/project-brain/bin/<name>.sh
const LEGACY_NODE_RE =
  /^node(?:\s+--preserve-symlinks(?:-main)?)*\s+skills\/project-brain\/scripts\/([\w.-]+?)\.mjs(\s+.*)?$/;
const LEGACY_BASH_RE = /^bash\s+skills\/project-brain\//;

/**
 * PURE. Rewrite one package.json script command.
 * @returns {{ action: 'rewrite', to: string } | { action: 'remove', reason: string }
 *          | { action: 'skip-unrecognized' } | { action: 'skip-untouched' }}
 */
export function rewriteScriptCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd.includes('skills/project-brain/')) return { action: 'skip-untouched' };
  const m = cmd.match(LEGACY_NODE_RE);
  if (m) {
    const scriptFile = `${m[1]}.mjs`;
    const args = m[2] ?? '';
    if (m[1].startsWith('brain-')) {
      const verb = VERB_BY_SCRIPT[scriptFile];
      const to = verb
        ? `${CLI_NAME} ${verb}${args}`
        : `${CLI_NAME} x ${m[1].slice('brain-'.length)}${args}`;
      return { action: 'rewrite', to };
    }
    // Non-brain-* node scripts (install-cursor-hooks.mjs, …) have no CLI
    // surface — the `x` hatch only reaches scripts/brain-*.mjs.
    return { action: 'remove', reason: 'no CLI equivalent (symlink-mode plumbing)' };
  }
  if (LEGACY_BASH_RE.test(cmd)) {
    // bin/update.sh / bin/install-hooks.sh are the symlink-mode updater; in
    // CLI mode npm install/update owns this.
    return { action: 'remove', reason: 'symlink-mode updater; npm owns this in CLI mode' };
  }
  // References the skill path in a shape we don't understand — never guess.
  return { action: 'skip-unrecognized' };
}

/**
 * PURE. Plan the package.json `scripts` rewrite.
 * @param {object} scripts host package.json `scripts` map (or {})
 * @returns {{ id: string, group: string, changes: {key, from, to, action, reason?}[] }}
 */
export function planScriptRewrites(scripts = {}) {
  const changes = [];
  for (const [key, from] of Object.entries(scripts ?? {})) {
    const r = rewriteScriptCommand(from);
    if (r.action === 'skip-untouched') continue;
    changes.push({
      key,
      from,
      to: r.action === 'rewrite' ? r.to : null,
      action: r.action,
      ...(r.reason ? { reason: r.reason } : {})
    });
  }
  return { id: 'package-scripts', group: 'package.json scripts', changes };
}

// Hook command fragment: `node [--preserve-symlinks[-main]] ["]$CLAUDE_PROJECT_DIR/]skills/project-brain/scripts/brain-X.mjs["]`
// — rewritten in place so matchers, args, redirects and `|| true` survive.
const HOOK_NODE_RE =
  /node\s+(?:--preserve-symlinks(?:-main)?\s+)*(["']?)(?:\$CLAUDE_PROJECT_DIR\/)?skills\/project-brain\/scripts\/brain-([\w.-]+?)\.mjs\1/g;

/**
 * PURE. Rewrite one hook command string.
 * @returns {{ changed: boolean, to: string, unrecognized: boolean }}
 */
export function rewriteHookCommand(command) {
  const cmd = String(command ?? '');
  const to = cmd.replace(HOOK_NODE_RE, (_all, _q, bare) => `${CLI_NAME} x ${bare}`);
  const changed = to !== cmd;
  return {
    changed,
    to,
    unrecognized: !changed && cmd.includes('skills/project-brain/')
  };
}

/**
 * PURE. Plan the .claude/settings.json `hooks` rewrite. Returns the change
 * list plus a rewritten deep copy (`nextHooks`) so apply is a plain assign.
 * @param {object} hooks the settings `hooks` object (or {})
 */
export function planHookRewrites(hooks = {}) {
  const nextHooks = structuredClone(hooks ?? {});
  const changes = [];
  const unrecognized = [];
  for (const [event, groups] of Object.entries(nextHooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of group?.hooks ?? []) {
        if (typeof h?.command !== 'string') continue;
        const r = rewriteHookCommand(h.command);
        if (r.changed) {
          changes.push({ event, from: h.command, to: r.to });
          h.command = r.to;
        } else if (r.unrecognized) {
          unrecognized.push({ event, command: h.command });
        }
      }
    }
  }
  return { id: 'claude-hooks', group: '.claude/settings.json hooks', changes, unrecognized, nextHooks };
}

/**
 * PURE. Plan removal of previously auto-enabled third-party plugins and
 * marketplaces: only keys that ALSO appear in the community template are
 * offered for removal (user-added entries are never touched), and a
 * marketplace only goes when no surviving enabled plugin still references it
 * (plugin keys are `name@marketplace`).
 * @param {object} settings  parsed host .claude/settings.json (or {})
 * @param {object} community parsed settings.community-plugins.json (or {})
 */
export function planPluginRemovals(settings = {}, community = {}) {
  const installedPlugins = settings?.enabledPlugins ?? {};
  const communityPlugins = community?.enabledPlugins ?? {};
  const plugins = Object.keys(installedPlugins).filter((k) => k in communityPlugins);

  const surviving = Object.keys(installedPlugins).filter((k) => !plugins.includes(k));
  const installedMarkets = settings?.extraKnownMarketplaces ?? {};
  const communityMarkets = community?.extraKnownMarketplaces ?? {};
  const marketplaces = Object.keys(installedMarkets).filter(
    (mk) => mk in communityMarkets && !surviving.some((p) => p.endsWith(`@${mk}`))
  );

  return { id: 'community-plugins', group: 'community plugins/marketplaces', plugins, marketplaces };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Compute the full migrate plan for the host repo at `cwd`. READ-ONLY: fs
 * reads only — never writes, prompts, or spawns.
 * @param {{ cwd?: string, packageDir?: string }} opts
 * @returns {{ skill: {exists: boolean, resolvesToPackage: boolean}, groups: object[] }}
 */
export function computeMigratePlan({ cwd = ROOT, packageDir = PACKAGE_DIR } = {}) {
  const skillPath = path.join(cwd, 'skills', 'project-brain');
  const exists = fs.existsSync(skillPath);
  let resolvesToPackage = false;
  if (exists) {
    try {
      resolvesToPackage = fs.realpathSync(skillPath) === fs.realpathSync(packageDir);
    } catch { /* broken symlink — treated as not resolving */ }
  }

  const pkg = readJsonSafe(path.join(cwd, 'package.json')) ?? {};
  const scripts = planScriptRewrites(pkg.scripts ?? {});

  const settings = readJsonSafe(path.join(cwd, '.claude', 'settings.json')) ?? {};
  const hooks = planHookRewrites(settings.hooks ?? {});

  const community =
    readJsonSafe(path.join(packageDir, 'templates', 'claude-code', 'settings.community-plugins.json')) ?? {};
  const plugins = planPluginRemovals(settings, community);

  return { skill: { exists, resolvesToPackage }, groups: [scripts, hooks, plugins] };
}

/** Does this group still have work to do? (drives prompts and dry-run detail) */
function groupPending(g) {
  switch (g.id) {
    case 'package-scripts':
      return g.changes.some((c) => c.action === 'rewrite' || c.action === 'remove');
    case 'claude-hooks':
      return g.changes.length > 0;
    case 'community-plugins':
      return g.plugins.length + g.marketplaces.length > 0;
    default:
      return false;
  }
}

function describeGroup(g) {
  switch (g.id) {
    case 'package-scripts': {
      const rewrites = g.changes.filter((c) => c.action === 'rewrite').length;
      const removes = g.changes.filter((c) => c.action === 'remove').length;
      return `${rewrites} script(s) to rewrite onto the ${CLI_NAME} CLI, ${removes} to remove`;
    }
    case 'claude-hooks':
      return `${g.changes.length} hook command(s) to rewrite onto \`${CLI_NAME} x\``;
    case 'community-plugins':
      return `${g.plugins.length} plugin(s), ${g.marketplaces.length} marketplace(s) to remove`;
    default:
      return '';
  }
}

function printPlan(plan, { detail = false } = {}) {
  console.log('Project Brain migrate plan (skill mode -> CLI mode):');
  for (const g of plan.groups) {
    const pending = groupPending(g);
    console.log(`- ${g.group}: ${pending ? describeGroup(g) : 'nothing to do'}`);
    if (!detail || !pending) continue;
    if (g.id === 'package-scripts') {
      for (const c of g.changes) {
        if (c.action === 'rewrite') console.log(`    ${c.key}: ${c.from} -> ${c.to}`);
        else if (c.action === 'remove') console.log(`    ${c.key}: remove (${c.reason})`);
      }
    } else if (g.id === 'claude-hooks') {
      for (const c of g.changes) console.log(`    [${c.event}] ${c.from} -> ${c.to}`);
    } else if (g.id === 'community-plugins') {
      for (const p of g.plugins) console.log(`    remove plugin ${p}`);
      for (const m of g.marketplaces) console.log(`    remove marketplace ${m}`);
    }
  }
  const skipped = plan.groups.find((g) => g.id === 'package-scripts')
    ?.changes.filter((c) => c.action === 'skip-unrecognized') ?? [];
  for (const c of skipped) {
    console.log(`  note: ${c.key} references skills/project-brain in an unrecognized form; left untouched`);
  }
  for (const u of plan.groups.find((g) => g.id === 'claude-hooks')?.unrecognized ?? []) {
    console.log(`  note: [${u.event}] hook references skills/project-brain in an unrecognized form; left untouched`);
  }
  console.log('  note: .project-brain/ data is never touched by migrate.');
}

/** Ask y/n per group; empty answer = yes. Interactive TTY contexts only. */
async function collectConsent(plan) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const accepted = new Set();
  try {
    for (const g of plan.groups) {
      if (!groupPending(g)) continue;
      const answer = (await rl.question(`Apply ${g.group}? [Y/n] `)).trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') accepted.add(g.id);
      else console.log(`  skipped ${g.group}`);
    }
  } finally {
    rl.close();
  }
  return accepted;
}

function applyPlan(plan, accepted, cwd) {
  const applied = [];

  const scriptsGroup = plan.groups.find((g) => g.id === 'package-scripts');
  if (accepted.has('package-scripts') && groupPending(scriptsGroup)) {
    const pkgPath = path.join(cwd, 'package.json');
    const pkg = JSON.parse(read(pkgPath, '{}'));
    pkg.scripts ||= {};
    for (const c of scriptsGroup.changes) {
      if (c.action === 'rewrite') pkg.scripts[c.key] = c.to;
      else if (c.action === 'remove') delete pkg.scripts[c.key];
    }
    write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    applied.push(scriptsGroup.group);
  }

  const hooksGroup = plan.groups.find((g) => g.id === 'claude-hooks');
  const pluginsGroup = plan.groups.find((g) => g.id === 'community-plugins');
  const wantHooks = accepted.has('claude-hooks') && groupPending(hooksGroup);
  const wantPlugins = accepted.has('community-plugins') && groupPending(pluginsGroup);
  if (wantHooks || wantPlugins) {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    const settings = readJsonSafe(settingsPath) ?? {};
    if (wantHooks) {
      settings.hooks = hooksGroup.nextHooks;
      applied.push(hooksGroup.group);
    }
    if (wantPlugins) {
      for (const p of pluginsGroup.plugins) delete settings.enabledPlugins?.[p];
      if (settings.enabledPlugins && Object.keys(settings.enabledPlugins).length === 0) {
        delete settings.enabledPlugins;
      }
      for (const m of pluginsGroup.marketplaces) delete settings.extraKnownMarketplaces?.[m];
      if (settings.extraKnownMarketplaces && Object.keys(settings.extraKnownMarketplaces).length === 0) {
        delete settings.extraKnownMarketplaces;
      }
      applied.push(pluginsGroup.group);
    }
    write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Shell — only runs when invoked directly (subprocess-test discipline: the
// pure planners above stay importable without side effects).
// ---------------------------------------------------------------------------
function isMain() {
  try {
    const here = fs.realpathSync(new URL(import.meta.url).pathname);
    const invoked = fs.realpathSync(process.argv[1] ?? '');
    return here === invoked;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const dryRun = takeFlag(args, '--dry-run');
  const yes = takeFlag(args, '--yes');
  const interactive = !dryRun && !yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (help) {
    console.log(`Usage: ${CLI_NAME} migrate [--dry-run] [--yes]

Convert a symlink/skill-mode install to CLI mode: rewrite package.json
brain:* scripts and .claude/settings.json hooks onto the ${CLI_NAME} CLI,
and offer removal of previously auto-enabled community plugins.
Never touches .project-brain/ data.

  --dry-run   print the plan and exit 0 (writes nothing)
  --yes       apply every group without prompting`);
    process.exit(0);
  }

  try {
    const plan = computeMigratePlan({ cwd: ROOT, packageDir: PACKAGE_DIR });

    if (!plan.skill.exists) {
      console.log('No skill-mode install detected (skills/project-brain is absent); nothing to migrate.');
      process.exit(0);
    }
    if (!plan.skill.resolvesToPackage) {
      console.warn(
        '[brain:migrate] warning: skills/project-brain does not resolve to this package checkout — ' +
        'migrating the wiring anyway (the rewrite is textual).'
      );
    }

    if (dryRun) {
      printPlan(plan, { detail: true });
      console.log('Dry run: nothing was written.');
      process.exit(0);
    }

    let accepted;
    if (interactive) {
      printPlan(plan, { detail: true });
      accepted = await collectConsent(plan);
    } else {
      // Non-TTY / --yes: apply everything, same convention as setup-package.mjs.
      printPlan(plan);
      accepted = new Set(plan.groups.map((g) => g.id));
    }

    const applied = applyPlan(plan, accepted, ROOT);
    if (applied.length) {
      console.log(`Migrated: ${applied.join(', ')}.`);
      console.log(`Next: \`npm i -D ${CLI_NAME}\` (or your install source) so npm scripts and hooks can resolve the CLI, then remove the skills/project-brain symlink when ready.`);
    } else {
      console.log('Nothing to migrate — the host already uses the CLI forms.');
    }
  } catch (error) {
    process.stderr.write(`[brain:migrate] ${error.message || error}\n`);
    process.exit(1);
  }
}
