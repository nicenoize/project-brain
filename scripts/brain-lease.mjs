/**
 * CLI for `## File Leases` in active_state.md.
 *
 * `add <path> --task <id> --actor <label>` reserves a glob/file for one
 * worker; other agents see it before they touch the same file.
 * `list` prints the live lease table. `release` drops one or all
 * leases for a task/actor. All mutations go through withStateLock.
 */
import { addLease, activeStateJson, releaseLeases } from './active-state.mjs';

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
  const actor = opts.actor || process.env.BRAIN_ACTOR || '';
  const task = opts.task || process.env.BRAIN_TASK || '';
  for (const target of targets) {
    addLease({
      target,
      lockedBy: actor || task || 'Needs Review',
      until: opts.until || '',
      notes: [task ? `task=${task}` : '', opts.notes || ''].filter(Boolean).join(' ')
    });
  }
  console.log(`Added ${targets.length} lease(s).`);
}

if (command === 'release') {
  releaseLeases({ taskId: opts.task || process.env.BRAIN_TASK || '', lockedBy: opts.actor || process.env.BRAIN_ACTOR || '', target: opts.target || '' });
  console.log('Released matching lease(s).');
}

if (command === 'list') {
  const state = activeStateJson();
  if (opts.json) console.log(JSON.stringify(state.leases, null, 2));
  else {
    if (!state.leases.length) console.log('No active leases.');
    for (const lease of state.leases) {
      console.log(`${lease.target} | ${lease.lockedBy || 'unowned'} | until=${lease.until || 'unspecified'} | ${lease.notes || ''}`.trim());
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
    positional.push(a);
  }
  if (!opts.target && positional.length) opts.target = positional.join(' ');
  return opts;
}

function splitList(value) {
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}
