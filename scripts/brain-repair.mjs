/**
 * brain:repair — nuke the local semantic index and queue a clean rebuild.
 *
 * Use when:
 *   - Lance "Append with different schema" errors persist after upgrade
 *   - JSON mirror grows past Node's string limit (ERR_STRING_TOO_LONG)
 *   - search_index.json contains thousands of phantom rows after a botched
 *     background sync
 *   - brain:health flags ghost paths in the tens of thousands
 *
 * What gets removed (under .project-brain/):
 *   - vector-db/                  Lance table directory
 *   - search_index.json[.tmp.*]   JSON mirror + leftover temp files
 *   - index_manifest.json         change-detection manifest
 *   - .fleet-cache/               fleet-mode detector caches (rebuilt next run)
 *
 * What stays:
 *   - Everything else under .project-brain/ (Git-tracked Markdown). Source
 *     of truth is never touched.
 *
 * After running, kick off `npm run brain:index -- --force` to rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR, exists, takeFlag } from './common.mjs';

const args = process.argv.slice(2);
const dryRun = takeFlag(args, '--dry-run');
const yes = takeFlag(args, '--yes') || takeFlag(args, '-y');
const help = takeFlag(args, '--help') || takeFlag(args, '-h');

if (help) {
  console.log(`Usage:
  npm run brain:repair             # interactive (prompts before deleting)
  npm run brain:repair -- --yes    # non-interactive (no prompt)
  npm run brain:repair -- --dry-run

Removes .project-brain/vector-db/, search_index.json (+leftover .tmp),
.project-brain/index_manifest.json, and .project-brain/.fleet-cache/.
Source-of-truth markdown under .project-brain/ is never touched.

After repair, run:  npm run brain:index -- --force
`);
  process.exit(0);
}

const targets = [
  path.join(BRAIN_DIR, 'vector-db'),
  path.join(BRAIN_DIR, 'search_index.json'),
  path.join(BRAIN_DIR, 'index_manifest.json'),
  path.join(BRAIN_DIR, '.fleet-cache'),
  path.join(BRAIN_DIR, '.skill-audit-cache')
];

const existing = targets.filter(exists);
const stragglers = collectTmpStragglers();

if (!existing.length && !stragglers.length) {
  console.log('Project Brain: nothing to repair — no generated index files found.');
  process.exit(0);
}

console.log('Project Brain repair — will remove:');
for (const t of existing) {
  let size = '';
  try {
    const s = fs.statSync(t);
    if (s.isDirectory()) size = ` (dir)`;
    else size = ` (${humanBytes(s.size)})`;
  } catch {}
  console.log(`  - ${path.relative(process.cwd(), t)}${size}`);
}
for (const t of stragglers) {
  console.log(`  - ${path.relative(process.cwd(), t)} (stale tmp)`);
}

if (dryRun) {
  console.log('\n(dry-run; nothing removed)');
  process.exit(0);
}

if (!yes && process.stdin.isTTY) {
  process.stdout.write('\nProceed? [y/N] ');
  const answer = readOneLineSync().trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }
}

for (const t of [...existing, ...stragglers]) {
  try {
    fs.rmSync(t, { recursive: true, force: true });
    console.log(`  removed ${path.relative(process.cwd(), t)}`);
  } catch (error) {
    console.error(`  failed to remove ${t}: ${error.message || error}`);
  }
}

console.log('\nNext step:');
console.log('  npm run brain:index -- --force');
console.log('\n(Optional) follow with `npm run brain:health` to verify a clean state.');

function collectTmpStragglers() {
  if (!exists(BRAIN_DIR)) return [];
  try {
    return fs.readdirSync(BRAIN_DIR)
      .filter(name => /^search_index\.json\.tmp(\.|$)/.test(name))
      .map(name => path.join(BRAIN_DIR, name));
  } catch {
    return [];
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v > 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function readOneLineSync() {
  const buf = Buffer.alloc(1024);
  let read = 0;
  while (read < buf.length) {
    let n;
    try { n = fs.readSync(0, buf, read, 1); } catch { break; }
    if (n === 0) break;
    if (buf[read] === 0x0a) { read++; break; }
    read++;
  }
  return buf.slice(0, read).toString('utf8');
}
