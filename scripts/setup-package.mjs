/**
 * setup-package — consent-prompting shell over the pure install planner.
 *
 * Wires a host repo up to Project Brain: brain:* npm scripts + deps in
 * package.json, .gitignore entries, PR template, CI workflow, the additive
 * .claude/settings.json merge (setup-claude-settings.mjs) and cursor hooks.
 *
 * The WHAT is computed by scripts/init-plan.mjs (pure, unit-tested); this
 * shell only prints the plan, collects consent, and applies it
 * (docs/strategy-agent-ops.md, ADR 0028).
 *
 * Flags:
 *   --dry-run   print the full plan and exit 0 — writes NOTHING, spawns nothing
 *   --yes       apply every group without prompting (bin/setup.sh passes this)
 *
 * Prompting happens ONLY when stdin AND stdout are TTYs and neither flag is
 * given. In non-TTY contexts (git post-checkout/post-merge hooks, CI,
 * brain:update-skill from a hook) it applies everything exactly like the old
 * installer — it must never hang on a prompt.
 *
 * Env bypasses are unchanged and live where they always did:
 * PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS / _CLAUDE_COMMANDS / _CAVEMAN_ULTRA are
 * honored inside setup-claude-settings.mjs (the plan surfaces the first one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { read, write } from './common.mjs';
import { syncClaudeSettings } from './setup-claude-settings.mjs';
import { computeInitPlan, DEFAULT_PACKAGE } from './init-plan.mjs';

const args = process.argv.slice(2);
const help = args.includes('--help') || args.includes('-h');
const dryRun = args.includes('--dry-run');
const yes = args.includes('--yes');
const interactive = !dryRun && !yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);

const KNOWN_FLAGS = new Set(['--help', '-h', '--dry-run', '--yes']);

const USAGE = [
  'project-brain setup — merge brain scripts, deps, .gitignore and templates into this repo.',
  '',
  'Usage: node scripts/setup-package.mjs [--dry-run | --yes]',
  '',
  '  --dry-run   print the full plan and exit 0 — writes NOTHING',
  '  --yes       apply every group without prompting (bin/setup.sh and bin/update.sh pass this)',
  '  --help      this text',
  '',
  'With a TTY and no flags it prompts per group. Without a TTY it refuses:',
  'writing a repo is not something to infer from the absence of a terminal.'
].join('\n');

/* An installer must never run by accident.
 *
 * This script had no --help, so `setup-package.mjs --help` fell through the
 * flag checks and performed a full install — the flag people type precisely
 * BECAUSE they do not yet want anything to happen. Worse, a non-TTY run with
 * no flags was defined to "behave like --yes", so any script, CI step, hook or
 * agent that invoked it bare rewrote package.json, .gitignore and the
 * templates with no consent and no way to have asked for less. That is the
 * exact gate ADR 0028's consent flow was added to install, bypassed by every
 * non-interactive caller.
 *
 * Both shipped callers (bin/setup.sh, bin/update.sh) pass --yes and are
 * unaffected. Anything else now fails loudly, which is the correct failure:
 * the fix is one word on the command line. */
if (help) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
if (unknown.length) {
  console.error(`setup-package: unknown argument(s): ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}

const packagePath = 'package.json';

/** Does this group still have work to do? (drives prompts and dry-run detail) */
function groupPending(g) {
  switch (g.id) {
    case 'package-scripts':
    case 'package-deps':
      return g.changes.length > 0;
    case 'gitignore':
      return g.changes.some((c) => c.action === 'append');
    case 'templates':
      return g.changes.some((c) => c.action === 'copy');
    case 'claude-settings':
      return !g.skip;
    case 'cursor-hooks':
      return Boolean(g.installer);
    default:
      return true;
  }
}

function describeGroup(g) {
  switch (g.id) {
    case 'package-scripts': {
      const fresh = g.changes.filter((c) => c.from === null).length;
      return `${g.changes.length} script(s) to add/refresh (${fresh} new, ${g.changes.length - fresh} refreshed)`;
    }
    case 'package-deps':
      return `${g.changes.length} dependency entr${g.changes.length === 1 ? 'y' : 'ies'} to add`;
    case 'gitignore':
      return `${g.changes.filter((c) => c.action === 'append').length} entr${g.changes.filter((c) => c.action === 'append').length === 1 ? 'y' : 'ies'} to append`;
    case 'templates':
      return g.changes.map((c) => `${c.file}: ${c.action}`).join(', ');
    case 'claude-settings':
    case 'cursor-hooks':
      return g.summary;
    default:
      return '';
  }
}

function printPlan(plan, { detail = false } = {}) {
  console.log('Project Brain install plan:');
  for (const g of plan) {
    const pending = groupPending(g);
    console.log(`- ${g.group}: ${pending ? describeGroup(g) : 'nothing to do'}`);
    if (!detail || !pending || !Array.isArray(g.changes)) continue;
    for (const c of g.changes) {
      if (g.id === 'package-scripts' || g.id === 'package-deps') {
        console.log(`    ${c.key}: ${c.from === null ? 'add' : `refresh (was: ${c.from})`}`);
      } else if (g.id === 'gitignore') {
        if (c.action === 'append') console.log(`    append ${c.entry}`);
      } else if (g.id === 'templates') {
        console.log(`    ${c.action === 'copy' ? `copy ${c.src} -> ${c.file}` : `${c.file} exists; left untouched`}`);
      }
    }
  }
}

/**
 * Apply the accepted package.json groups. Same result as the old
 * mergePackageScripts(mergePackageDeps(pkg)) + write when both groups are
 * accepted (the merge = ensure containers + set the diffed keys).
 */
function applyPackageJson(plan, accepted) {
  const wantScripts = accepted.has('package-scripts');
  const wantDeps = accepted.has('package-deps');
  if (!wantScripts && !wantDeps) return;
  const pkg = fs.existsSync(packagePath)
    ? JSON.parse(read(packagePath))
    : structuredClone(DEFAULT_PACKAGE);
  if (wantScripts) {
    pkg.scripts ||= {};
    for (const c of plan.find((g) => g.id === 'package-scripts').changes) pkg.scripts[c.key] = c.to;
  }
  if (wantDeps) {
    pkg.dependencies ||= {};
    pkg.optionalDependencies ||= {};
    for (const c of plan.find((g) => g.id === 'package-deps').changes) {
      pkg[c.field] ||= {};
      pkg[c.field][c.key] = c.to;
    }
  }
  write(packagePath, JSON.stringify(pkg, null, 2) + '\n');
}

function applyTemplates(group) {
  for (const c of group.changes) {
    if (c.action !== 'copy') continue;
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    fs.copyFileSync(c.src, c.file);
  }
}

function applyCursorHooks(group) {
  if (!group.installer) return;
  const r = spawnSync(process.execPath, [group.installer], { stdio: 'inherit', cwd: process.cwd() });
  if (r.status) console.warn('install-cursor-hooks exited', r.status);
}

/** Ask y/n per group; empty answer = yes. Interactive TTY contexts only. */
async function collectConsent(plan) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const accepted = new Set();
  try {
    for (const g of plan) {
      if (!groupPending(g)) continue; // nothing to consent to
      const answer = (await rl.question(`Apply ${g.group}? [Y/n] `)).trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') accepted.add(g.id);
      else console.log(`  skipped ${g.group}`);
    }
  } finally {
    rl.close();
  }
  return accepted;
}

try {
  const plan = computeInitPlan({ cwd: process.cwd(), env: process.env });

  if (dryRun) {
    printPlan(plan, { detail: true });
    console.log('Dry run: nothing was written.');
    process.exit(0);
  }

  let accepted;
  if (interactive) {
    printPlan(plan, { detail: true });
    accepted = await collectConsent(plan);
  } else if (yes) {
    printPlan(plan);
    accepted = new Set(plan.map((g) => g.id));
  } else {
    // No TTY and no --yes: show the work and stop. Never prompt (that would
    // hang a hook), never write (that would be consent nobody gave).
    printPlan(plan);
    console.error(
      '\nsetup-package: no terminal to ask on, and --yes was not given — nothing was written.\n' +
      'Re-run with --yes to apply the plan above, or --dry-run to inspect it in full.'
    );
    process.exit(1);
  }

  applyPackageJson(plan, accepted);

  if (accepted.has('gitignore')) write('.gitignore', plan.find((g) => g.id === 'gitignore').next);

  if (accepted.has('templates')) applyTemplates(plan.find((g) => g.id === 'templates'));

  const applied = plan.filter((g) => accepted.has(g.id)).map((g) => g.group);
  if (applied.length) console.log(`Updated: ${applied.join(', ')}.`);

  // Honors PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS / _CLAUDE_COMMANDS / _CAVEMAN_ULTRA internally.
  if (accepted.has('claude-settings')) syncClaudeSettings();

  if (accepted.has('cursor-hooks')) applyCursorHooks(plan.find((g) => g.id === 'cursor-hooks'));
} catch (error) {
  process.stderr.write(`[setup-package] ${error.message || error}\n`);
  process.exit(1);
}
