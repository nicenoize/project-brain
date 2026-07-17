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
import os from 'node:os';
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
  listIndexableFiles,
  readDirtyFiles,
  clearDirtyFiles
} from './common.mjs';

const SYNC_BG_LOCK = path.join(BRAIN_DIR, '.sync-bg.lock');
const SYNC_DEBOUNCE_MS = Number(process.env.BRAIN_SYNC_DEBOUNCE_MS || 30_000);
const SYNC_NICE = process.env.BRAIN_SYNC_NICE !== '0';

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock() {
  if (!fs.existsSync(SYNC_BG_LOCK)) return null;
  try { return JSON.parse(read(SYNC_BG_LOCK)); } catch { return null; }
}

function writeLock(pid) {
  ensureDir(BRAIN_DIR);
  try {
    fs.writeFileSync(SYNC_BG_LOCK, JSON.stringify({ pid, ts: Date.now() }));
  } catch {}
}

function clearLock() {
  try { fs.unlinkSync(SYNC_BG_LOCK); } catch {}
}

function recentlyCompletedSync() {
  if (!fs.existsSync(MANIFEST)) return false;
  try {
    const stat = fs.statSync(MANIFEST);
    return Date.now() - stat.mtimeMs < SYNC_DEBOUNCE_MS;
  } catch { return false; }
}

function wrapWithNice(execPath, args) {
  if (!SYNC_NICE) return { cmd: execPath, args };
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux') {
    // nice is a POSIX coreutil and is universally available; ionice is Linux-only.
    if (platform === 'linux') {
      // ionice -c 3 = idle I/O class; nice -n 19 = lowest CPU priority.
      return { cmd: 'ionice', args: ['-c', '3', 'nice', '-n', '19', execPath, ...args] };
    }
    return { cmd: 'nice', args: ['-n', '19', execPath, ...args] };
  }
  return { cmd: execPath, args };
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
// --if-stale (issue #35): near-free no-op unless files were staged dirty by the
// PostToolUse hook since the last sync. Meant for the opt-in git post-commit
// hook — clean tree ⇒ instant exit, no listIndexableFiles hash-scan. When the
// dirty list is non-empty the normal hash-diff sync runs and drains it.
const ifStale = args.includes('--if-stale');
const allowBackground = process.env.BRAIN_BACKGROUND === '1';

if (isFastMode() && !force) {
  console.log('Project Brain sync: fast mode skip (BRAIN_FAST=1).');
  writeSyncState({ action: 'skip', reason: 'fast mode', branch: gitBranchSafe() });
  process.exit(0);
}

if (ifStale && !force && !readDirtyFiles().length) {
  console.log('Project Brain sync: nothing staged (--if-stale no-op).');
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
  clearDirtyFiles(); // staged files already match the manifest — drain the hint
  console.log('Project Brain index is up to date.');
  process.exit(0);
}

const decision = decideSync(changed, deleted, { force });
console.log(`Project Brain sync: ${decision.action} — ${decision.reason} (changed=${changed.length}, deleted=${deleted.length})`);

if (dryRun) {
  console.log(JSON.stringify({ decision, changed: changed.length, deleted: deleted.length }, null, 2));
  process.exit(0);
}

// A real sync now owns the current changed set; drain the dirty-file hint. The
// manifest stays the source of truth, so clearing here is safe even if the
// re-index later fails — the next sync re-detects via hash-diff (issue #35).
clearDirtyFiles();

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

  // Debounce: if a sync finished within the window, skip.
  if (!force && recentlyCompletedSync()) {
    writeSyncState({
      action: 'skip',
      reason: `debounced (manifest updated <${SYNC_DEBOUNCE_MS}ms ago)`,
      branch: gitBranchSafe(),
      changed: changed.length,
      deleted: deleted.length
    });
    console.log(`Project Brain sync: debounced (last sync <${SYNC_DEBOUNCE_MS}ms ago).`);
    process.exit(0);
  }

  // Global single-bg-sync lock: if another bg sync is already in flight, skip.
  const lock = readLock();
  if (lock && pidAlive(lock.pid)) {
    writeSyncState({
      action: 'skip',
      reason: `bg sync already running (pid ${lock.pid})`,
      branch: gitBranchSafe(),
      changed: changed.length,
      deleted: deleted.length
    });
    console.log(`Project Brain sync: bg sync already running (pid ${lock.pid}); skipping.`);
    process.exit(0);
  }
  if (lock) clearLock(); // stale lock from a crashed sync

  const out = fs.openSync(SYNC_BG_LOG, 'a');
  fs.writeSync(out, `\n--- ${new Date().toISOString()} bg sync (changed=${changed.length}, deleted=${deleted.length})\n`);
  const { cmd, args: spawnArgs } = wrapWithNice(process.execPath, [indexScript, ...indexArgs]);
  const child = spawn(cmd, spawnArgs, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...env, BRAIN_SYNC_LOCK: SYNC_BG_LOCK }
  });
  child.unref();
  writeLock(child.pid);
  writeSyncState({
    action: 'background',
    reason: decision.reason,
    branch: gitBranchSafe(),
    changed: changed.length,
    deleted: deleted.length,
    pid: child.pid,
    niced: SYNC_NICE
  });
  console.log(`Project Brain index running in background (pid ${child.pid}${SYNC_NICE ? ', niced' : ''}). Logs: .project-brain/.sync-bg.log`);
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
