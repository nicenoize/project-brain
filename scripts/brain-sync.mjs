/**
 * Incremental re-index based on file-content hash diff.
 *
 * Compares the current indexable file set against index_manifest.json,
 * computes changed + deleted paths, and invokes brain-index with
 * BRAIN_CHANGED_FILES / BRAIN_DELETED_FILES so only the affected files
 * re-embed. `--force` triggers a full rebuild.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ROOT,
  BRAIN_DIR,
  MANIFEST,
  SYNC_BG_LOG,
  read,
  sha256,
  ensureDir,
  isFastMode,
  classifyChanges,
  writeSyncState,
  gitBranchSafe,
  listIndexableFiles
} from './common.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const allowBackground = process.env.BRAIN_BACKGROUND === '1';

if (isFastMode() && !force) {
  console.log('Project Brain sync: fast mode skip (BRAIN_FAST=1).');
  writeSyncState({ action: 'skip', reason: 'fast mode', branch: gitBranchSafe() });
  process.exit(0);
}

let oldManifest = { files: {} };
if (fs.existsSync(MANIFEST)) {
  try { oldManifest = JSON.parse(read(MANIFEST)); } catch { oldManifest = { files: {} }; }
}

const files = await listIndexableFiles();
const current = {};
const changed = [];
const deleted = [];

for (const file of files) {
  current[file] = sha256(read(path.join(ROOT, file)));
  if (!oldManifest.files?.[file] || oldManifest.files[file].hash !== current[file]) {
    changed.push(file);
  }
}
for (const file of Object.keys(oldManifest.files || {})) {
  if (!current[file]) deleted.push(file);
}

if (!changed.length && !deleted.length && !force) {
  console.log('Project Brain index is up to date.');
  process.exit(0);
}

const decision = decideSync(changed, deleted, { force });
console.log(`Project Brain sync: ${decision.action} — ${decision.reason} (changed=${changed.length}, deleted=${deleted.length})`);

if (dryRun) {
  console.log(JSON.stringify({ decision, changed: changed.length, deleted: deleted.length }, null, 2));
  process.exit(0);
}

if (decision.action === 'skip') {
  writeSyncState({ action: 'skip', reason: decision.reason, branch: gitBranchSafe(), changed: changed.length, deleted: deleted.length });
  process.exit(0);
}

const indexScript = new URL('./brain-index.mjs', import.meta.url).pathname;
const indexArgs = force ? ['--force'] : [];
const env = {
  ...process.env,
  BRAIN_CHANGED_FILES: changed.join('\n'),
  BRAIN_DELETED_FILES: deleted.join('\n')
};

if (decision.action === 'background' && allowBackground) {
  ensureDir(BRAIN_DIR);
  const out = fs.openSync(SYNC_BG_LOG, 'a');
  fs.writeSync(out, `\n--- ${new Date().toISOString()} bg sync (changed=${changed.length}, deleted=${deleted.length})\n`);
  const child = spawn(process.execPath, [indexScript, ...indexArgs], {
    detached: true,
    stdio: ['ignore', out, out],
    env
  });
  child.unref();
  writeSyncState({
    action: 'background',
    reason: decision.reason,
    branch: gitBranchSafe(),
    changed: changed.length,
    deleted: deleted.length,
    pid: child.pid
  });
  console.log(`Project Brain index running in background (pid ${child.pid}). Logs: .project-brain/.sync-bg.log`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [indexScript, ...indexArgs], { stdio: 'inherit', env });
writeSyncState({
  action: decision.action === 'background' ? 'foreground-fallback' : decision.action,
  reason: decision.reason,
  branch: gitBranchSafe(),
  changed: changed.length,
  deleted: deleted.length,
  status: result.status || 0
});
process.exit(result.status || 0);

function decideSync(changedFiles, deletedFiles, opts = {}) {
  if (opts.force) return { action: 'foreground', reason: 'forced (--force)' };
  const all = [...changedFiles, ...deletedFiles];
  const counts = classifyChanges(all);
  if (!counts.brain && !counts.code) {
    return { action: 'skip', reason: `only ignored changes (${counts.ignored})` };
  }
  if (counts.brain) {
    return { action: 'background', reason: `${counts.brain} brain doc(s) changed` };
  }
  if (counts.code > 10) {
    return { action: 'background', reason: `${counts.code} code files changed (>10)` };
  }
  return { action: 'foreground', reason: `${counts.code} code file(s)` };
}
