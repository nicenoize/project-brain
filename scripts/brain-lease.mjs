/**
 * CLI for `## File Leases` in active_state.md.
 *
 * `add <path> --task <id> --actor <label>` reserves a glob/file for one
 * worker; other agents see it before they touch the same file.
 * `list` prints the live lease table. `release` drops one or all
 * leases for a task/actor. All mutations go through withStateLock.
 *
 * Targets are validated against the canonical lease-overlap.mjs grammar at
 * creation: unsupported patterns (braces, negation, escapes, `?`) are
 * REJECTED with exit 1 instead of being mis-checked later (strategy M3).
 * Overlaps with active leases held by a DIFFERENT actor produce a warning
 * on stderr — advisory, never blocking.
 */
import { addLease, activeStateJson, releaseLeases } from './active-state.mjs';
import { validateTarget, targetsOverlap, UnsupportedPatternError, LEASE_TARGET_GRAMMAR } from './lease-overlap.mjs';

const args = process.argv.slice(2);
const command = args.shift() || 'list';
const opts = parseArgs(args);

if (opts.help || !['add', 'list', 'release'].includes(command)) {
  console.log(`Usage:
  npm run brain:lease -- add "src/auth.ts,lib/session.ts" --task issue-123 --actor codex-a [--until PR-42] [--notes text]
  npm run brain:lease -- list [--json]
  npm run brain:lease -- release --task issue-123
  npm run brain:lease -- release --actor codex-a
  npm run brain:lease -- release --target src/auth.ts
`);
  process.exit(opts.help ? 0 : 1);
}

if (command === 'add') {
  const targets = splitList(opts.target || args.join(' '));
  if (!targets.length) {
    console.error('brain:lease add requires a file/glob target.');
    process.exit(1);
  }
  // Validate ALL targets before adding ANY (transaction-like): unsupported
  // patterns are rejected at creation instead of mis-checked at brief time.
  for (const target of targets) {
    const check = validateTarget(target);
    if (!check.ok) {
      console.error(`brain:lease add rejected '${target}': ${check.reason}.`);
      console.error(`Supported targets: ${LEASE_TARGET_GRAMMAR.forms.join('; ')}.`);
      process.exit(1);
    }
  }
  const actor = opts.actor || process.env.BRAIN_ACTOR || '';
  const task = opts.task || process.env.BRAIN_TASK || '';
  const project = opts.project || process.env.BRAIN_PROJECT || '';
  const lockedBy = actor || task || 'Needs Review';
  warnOnOverlaps(targets, lockedBy);
  for (const target of targets) {
    addLease({
      target,
      project,
      lockedBy,
      until: opts.until || '',
      notes: [task ? `task=${task}` : '', opts.notes || ''].filter(Boolean).join(' ')
    });
  }
  console.log(`Added ${targets.length} lease(s).`);
}

if (command === 'release') {
  releaseLeases({
    taskId: opts.task || process.env.BRAIN_TASK || '',
    lockedBy: opts.actor || process.env.BRAIN_ACTOR || '',
    project: opts.project || process.env.BRAIN_PROJECT || '',
    target: opts.target || ''
  });
  console.log('Released matching lease(s).');
}

if (command === 'list') {
  const state = activeStateJson();
  if (opts.json) console.log(JSON.stringify(state.leases, null, 2));
  else {
    if (!state.leases.length) console.log('No active leases.');
    for (const lease of state.leases) {
      // Flag legacy rows the canonical M3 grammar no longer honors, so a
      // stale pre-migration lease can't sit silently invisible to conflict
      // checks (review finding: silent narrowing of old semantics).
      const invalid = splitList(lease.target)
        .map((t) => ({ t, check: validateTarget(t) }))
        .filter((x) => !x.check.ok);
      const flag = invalid.length
        ? `  [WARN: unsupported target syntax (${invalid.map((x) => x.t).join(', ')}) — IGNORED by conflict checks; re-create this lease]`
        : '';
      console.log(`${lease.target} | ${lease.lockedBy || 'unowned'} | until=${lease.until || 'unspecified'} | ${lease.notes || ''}`.trim() + flag);
    }
  }
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : '';
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--task') { opts.task = val; i += val ? 1 : 0; continue; }
    if (a === '--actor') { opts.actor = val; i += val ? 1 : 0; continue; }
    if (a === '--target') { opts.target = val; i += val ? 1 : 0; continue; }
    if (a === '--until') { opts.until = val; i += val ? 1 : 0; continue; }
    if (a === '--notes') { opts.notes = val; i += val ? 1 : 0; continue; }
    if (a === '--project') { opts.project = val; i += val ? 1 : 0; continue; }
    positional.push(a);
  }
  if (!opts.target && positional.length) opts.target = positional.join(' ');
  return opts;
}

function splitList(value) {
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

/**
 * Warn (never block) when a new target overlaps an active lease held by a
 * DIFFERENT actor, using the canonical targetsOverlap(). Advisory read of
 * the table (the subsequent add still runs under withStateLock); legacy
 * lease rows with unsupported targets are skipped rather than crashing.
 */
function warnOnOverlaps(targets, lockedBy) {
  let existing = [];
  try { existing = activeStateJson().leases || []; } catch { return; }
  for (const target of targets) {
    for (const lease of existing) {
      if ((lease.lockedBy || '') === lockedBy) continue; // self-held: no warning
      // Old tables tolerate comma/space lists inside one target cell (as brief does).
      const parts = String(lease.target || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const hit = parts.some(part => {
        try { return targetsOverlap(target, part); }
        catch (error) {
          if (error instanceof UnsupportedPatternError) return false;
          throw error;
        }
      });
      if (hit) {
        console.error(`[brain:lease] warning: '${target}' overlaps active lease '${lease.target}' ` +
          `held by ${lease.lockedBy || 'unowned'}${lease.until ? ` until ${lease.until}` : ''}.`);
      }
    }
  }
}
