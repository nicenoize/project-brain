import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  startRunner,
  listRunners,
  stopRunner,
  tailLog,
  probePid,
  recordId
} from '../scripts/runner-supervisor.mjs';

/** Every PID we ever spawn lands here; the final test asserts all are dead. */
const spawnedPids = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-runner-supervisor-'));
  return {
    root,
    runnersDir: path.join(root, 'runners'),
    logDir: path.join(root, 'runner-logs')
  };
}

/** Long-running dummy child (ticks every 100ms) via the supervisor itself. */
function startTickRunner(dirs, id = 'wp-tick') {
  const cmd = `'${process.execPath}' -e 'setInterval(() => console.log("tick"), 100)'`;
  const started = startRunner({
    workPackageId: id,
    runnerCmd: cmd,
    worktreeDir: dirs.root,
    logDir: dirs.logDir,
    runnersDir: dirs.runnersDir
  });
  if (started.ok) spawnedPids.push(started.pid);
  return started;
}

function killQuietly(pid) {
  for (const target of [-pid, pid]) {
    try { process.kill(target, 'SIGKILL'); } catch { /* already dead */ }
  }
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/** A PID that is guaranteed dead: spawn a no-op child and let it exit. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

test('startRunner writes a supervision record and listRunners shows it running', async () => {
  const dirs = fixture();
  let pid;
  try {
    const started = startTickRunner(dirs, 'issue-1-wp01');
    assert.equal(started.ok, true);
    pid = started.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);

    const recordFile = path.join(dirs.runnersDir, 'issue-1-wp01.json');
    assert.ok(fs.existsSync(recordFile), 'supervision record must exist');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    assert.equal(record.pid, pid);
    assert.equal(record.workPackageId, 'issue-1-wp01');
    assert.equal(record.status, 'running');
    assert.ok(record.startedAt);
    assert.ok(record.logFile.endsWith('issue-1-wp01.log'));

    assert.equal(probePid(pid).alive, true, 'child must actually be alive');
    const listed = listRunners({ runnersDir: dirs.runnersDir });
    assert.equal(listed.ok, true);
    assert.equal(listed.warnings.length, 0);
    const entry = listed.runners.find(r => r.id === 'issue-1-wp01');
    assert.ok(entry, 'listRunners must include the runner');
    assert.equal(entry.status, 'running');
  } finally {
    if (pid) killQuietly(pid);
  }
});

test('stopRunner terminates within grace and asserts real process death', async () => {
  const dirs = fixture();
  let pid;
  try {
    const started = startTickRunner(dirs, 'wp-stop');
    assert.equal(started.ok, true);
    pid = started.pid;

    const stopped = await stopRunner('wp-stop', { graceMs: 2000, runnersDir: dirs.runnersDir });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.status, 'stopped');

    // The process must REALLY be dead: kill(pid, 0) throws ESRCH.
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');

    const record = JSON.parse(fs.readFileSync(path.join(dirs.runnersDir, 'wp-stop.json'), 'utf8'));
    assert.equal(record.status, 'exited');
    assert.ok(record.endedAt);

    // Idempotent: stopping an already-dead runner is a no-op success.
    const again = await stopRunner('wp-stop', { graceMs: 500, runnersDir: dirs.runnersDir });
    assert.equal(again.ok, true);
    assert.equal(again.status, 'already-exited');
  } finally {
    if (pid) killQuietly(pid);
  }
});

test('tailLog returns bounded output (last N lines, capped bytes, no full read)', async () => {
  const dirs = fixture();
  let pid;
  try {
    const started = startTickRunner(dirs, 'wp-tail');
    assert.equal(started.ok, true);
    pid = started.pid;

    const gotTicks = await waitFor(() => {
      const t = tailLog('wp-tail', { runnersDir: dirs.runnersDir });
      return t.ok && t.lines.some(l => l.includes('tick'));
    });
    assert.equal(gotTicks, true, 'log should contain tick output');

    // Bound checks against a large fabricated log for determinism.
    const bigLog = path.join(dirs.logDir, 'big.log');
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
    fs.writeFileSync(bigLog, `${lines.join('\n')}\n`);
    fs.writeFileSync(
      path.join(dirs.runnersDir, 'wp-big.json'),
      JSON.stringify({ pid: deadPid(), workPackageId: 'wp-big', startedAt: new Date().toISOString(), logFile: bigLog, status: 'exited' })
    );
    const tail = tailLog('wp-big', { lines: 10, maxBytes: 4096, runnersDir: dirs.runnersDir });
    assert.equal(tail.ok, true);
    assert.equal(tail.lines.length, 10);
    assert.deepEqual(tail.lines.at(-1), 'line-4999');
    assert.ok(tail.bytesRead <= 4096, `bytesRead ${tail.bytesRead} must respect maxBytes`);
    assert.equal(tail.truncated, true);

    // Missing log file is a total, empty result — not a throw.
    fs.writeFileSync(
      path.join(dirs.runnersDir, 'wp-nolog.json'),
      JSON.stringify({ pid: deadPid(), workPackageId: 'wp-nolog', logFile: path.join(dirs.logDir, 'missing.log'), status: 'exited' })
    );
    const empty = tailLog('wp-nolog', { runnersDir: dirs.runnersDir });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.lines, []);
  } finally {
    if (pid) killQuietly(pid);
  }
});

test('listRunners reconciles a dead-PID record as orphaned and persists it', () => {
  const dirs = fixture();
  fs.mkdirSync(dirs.runnersDir, { recursive: true });
  const bogus = deadPid();
  fs.writeFileSync(
    path.join(dirs.runnersDir, 'wp-orphan.json'),
    JSON.stringify({ pid: bogus, workPackageId: 'wp-orphan', startedAt: new Date().toISOString(), logFile: path.join(dirs.logDir, 'wp-orphan.log'), status: 'running' })
  );
  const listed = listRunners({ runnersDir: dirs.runnersDir });
  assert.equal(listed.ok, true);
  const entry = listed.runners.find(r => r.id === 'wp-orphan');
  assert.ok(entry);
  assert.ok(['orphaned', 'exited'].includes(entry.status), `dead PID must reconcile, got ${entry.status}`);
  assert.equal(entry.status, 'orphaned', 'record claiming running with a dead PID is orphaned');
  const persisted = JSON.parse(fs.readFileSync(path.join(dirs.runnersDir, 'wp-orphan.json'), 'utf8'));
  assert.equal(persisted.status, 'orphaned');
  assert.ok(persisted.endedAt);
});

test('corrupt records never throw: skipped with a warning entry', () => {
  const dirs = fixture();
  fs.mkdirSync(dirs.runnersDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.runnersDir, 'wp-corrupt.json'), 'not json {{{');
  fs.writeFileSync(path.join(dirs.runnersDir, 'wp-array.json'), '[1,2,3]');
  fs.writeFileSync(
    path.join(dirs.runnersDir, 'wp-fine.json'),
    JSON.stringify({ pid: deadPid(), workPackageId: 'wp-fine', logFile: '', status: 'exited' })
  );
  const listed = listRunners({ runnersDir: dirs.runnersDir });
  assert.equal(listed.ok, true);
  assert.equal(listed.warnings.length, 2);
  assert.ok(listed.warnings.every(w => w.warning === 'corrupt-record'));
  assert.deepEqual(listed.runners.map(r => r.id), ['wp-fine']);
});

test('total on missing state: empty dir listing, unknown-id stop and tail', async () => {
  const dirs = fixture(); // runnersDir never created
  const listed = listRunners({ runnersDir: dirs.runnersDir });
  assert.deepEqual(listed, { ok: true, runners: [], warnings: [] });

  const stopped = await stopRunner('nope', { graceMs: 100, runnersDir: dirs.runnersDir });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.status, 'record-not-found');

  const tailed = tailLog('nope', { runnersDir: dirs.runnersDir });
  assert.equal(tailed.ok, false);
  assert.deepEqual(tailed.lines, []);

  assert.equal(startRunner({ runnerCmd: 'true' }).ok, false, 'missing workPackageId is an error object');
  assert.equal(startRunner({ workPackageId: 'x' }).ok, false, 'missing runnerCmd is an error object');
  assert.equal(recordId('a b/c'), 'a-b-c');
});

test('no zombie children survive the test run', async () => {
  for (const pid of spawnedPids) killQuietly(pid);
  const allDead = await waitFor(() => spawnedPids.every(pid => !probePid(pid).alive), 3000);
  assert.equal(allDead, true, `zombie runner pids still alive: ${spawnedPids.filter(pid => probePid(pid).alive).join(', ')}`);
});
