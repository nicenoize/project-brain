import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  globToRegExp, holdMatches, addHold, readHolds, releaseHolds, matchingHold, queueSteer, peekInbox, drainInbox,
  inboxCounts, appendEvent, readRecentEvents, createPending, readPending, decide, awaitDecision, engineFresh,
  markSeen, readSeen, safeId, busDir, statePath
} from '../scripts/companion-bus.mjs';
import { steerContext, editTarget, hookOutput, handle } from '../scripts/brain-companion-hook.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = '0beaff67-9520-4d36-a926-d4d2aefdafda';

test('globs: ** spans directories, * and ? stay in a segment, a trailing slash means the whole tree', () => {
  const m = (g, p) => globToRegExp(g).test(p);
  assert.ok(m('src/billing/**', 'src/billing/a.ts'));
  assert.ok(m('src/billing/**', 'src/billing/deep/b.ts'));
  assert.ok(!m('src/billing/**', 'src/billingx/a.ts'));
  assert.ok(m('src/*.ts', 'src/a.ts'));
  assert.ok(!m('src/*.ts', 'src/x/a.ts'));
  assert.ok(m('**/*.test.mjs', 'tests/a.test.mjs'));
  assert.ok(m('**/*.test.mjs', 'a.test.mjs'));
  assert.ok(m('src/billing/', 'src/billing/x/y.ts'));
  assert.ok(m('file?.md', 'file1.md'));
  assert.ok(!m('file?.md', 'file12.md'));
  assert.ok(m('a+b(c).md', 'a+b(c).md'));
  assert.ok(m('**', 'anything/at/all'));
});

test('holds: scoped to a repo root or everywhere, expire, release by id prefix or all', () => {
  const dir = tmp('bus-holds-');
  const now = Date.parse('2026-10-22T12:00:00Z');
  const repo = path.join(dir, 'repo');
  const a = addHold(dir, { glob: 'src/billing/**', root: repo, minutes: 30, now });
  assert.ok(holdMatches(a, path.join(repo, 'src/billing/x.ts'), now));
  assert.ok(!holdMatches(a, path.join(repo, 'src/auth/x.ts'), now));
  assert.ok(!holdMatches(a, path.join(dir, 'other/src/billing/x.ts'), now), 'another repo is not held');
  assert.ok(!holdMatches(a, path.join(repo, 'src/billing/x.ts'), now + 31 * 60_000), 'expired');
  const all = addHold(dir, { glob: '**', root: null, minutes: 0, now });
  assert.equal(all.until, null);
  assert.ok(holdMatches(all, '/anywhere/at/all.ts', now));
  assert.equal(readHolds(dir, now).length, 2);
  assert.equal(readHolds(dir, now + 31 * 60_000).length, 1, 'the expired one drops out on read');
  assert.equal(matchingHold(dir, path.join(repo, 'src/billing/x.ts'), now).id, a.id);
  assert.throws(() => releaseHolds(dir, 'h', now), /matches 2 holds/);
  assert.equal(releaseHolds(dir, a.id, now), 1);
  assert.equal(readHolds(dir, now).length, 1);
  assert.equal(releaseHolds(dir, 'all', now), 1);
  assert.deepEqual(readHolds(dir, now), []);
});

test('inbox: notes queue per session and are claimed exactly once', () => {
  const dir = tmp('bus-inbox-');
  assert.throws(() => queueSteer(dir, '../evil', 'x'), /not a session id/);
  assert.throws(() => queueSteer(dir, SID, '   '), /empty note/);
  queueSteer(dir, SID, 'keep ROUND_HALF_EVEN like tax.ts');
  queueSteer(dir, SID, 'and run the invoice tests');
  assert.equal(peekInbox(dir, SID).length, 2);
  assert.deepEqual(inboxCounts(dir), { [SID]: 2 });
  const first = drainInbox(dir, SID);
  const second = drainInbox(dir, SID);
  assert.deepEqual(first.map((n) => n.text), ['keep ROUND_HALF_EVEN like tax.ts', 'and run the invoice tests']);
  assert.deepEqual(second, []);
  assert.deepEqual(inboxCounts(dir), {});
  assert.equal(safeId('a/b'), '');
  assert.equal(safeId('..'), '');
});

test('events: appended, read back newest-last within a window, trimmed past the cap', () => {
  const dir = tmp('bus-events-');
  for (let i = 0; i < 50; i++) appendEvent(dir, { kind: 'steer-delivered', i }, { maxBytes: 1500 });
  const ev = readRecentEvents(dir, { limit: 100 });
  assert.ok(ev.length < 50 && ev.length > 5, `trimmed to ${ev.length}`);
  assert.equal(ev[ev.length - 1].i, 49);
  assert.deepEqual(readRecentEvents(dir, { sinceMs: Date.now() + 1000 }), []);
  assert.deepEqual(readRecentEvents(tmp('bus-empty-')), []);
});

test('pending + decisions: answer, wait, time out; dead hooks leave no ghosts', async () => {
  const dir = tmp('bus-pending-');
  const p = createPending(dir, { session: SID, file: '/r/a.ts', deadline: Date.now() + 60_000 });
  assert.equal(readPending(dir).length, 1);
  setTimeout(() => decide(dir, p.id, 'deny', { reason: 'not now' }), 50);
  assert.deepEqual(await awaitDecision(dir, p.id, { timeoutMs: 2000, pollMs: 20 }), { decision: 'deny', reason: 'not now', by: 'cli' });
  assert.equal((await awaitDecision(dir, p.id, { timeoutMs: 60, pollMs: 20 })).decision, 'timeout', 'a decision is consumed once');
  assert.throws(() => decide(dir, p.id, 'maybe'), /allow or deny/);
  createPending(dir, { session: SID, file: '/r/b.ts', deadline: Date.now() - 10_000 });
  assert.equal(readPending(dir).length, 1, 'past its deadline + grace a pending file is swept');
});

test('presence: engine freshness from the state file, seen marks per session', () => {
  const dir = tmp('bus-seen-');
  assert.equal(engineFresh(dir), false);
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  assert.equal(engineFresh(dir), true);
  assert.equal(engineFresh(dir, Date.now() + 60_000), false);
  markSeen(dir, SID);
  markSeen(dir, 'bad/id');
  assert.deepEqual(Object.keys(readSeen(dir)), [SID]);
});

test('paths follow BRAIN_HOME and BRAIN_COMPANION_STATE', () => {
  assert.equal(busDir({ BRAIN_HOME: '/h' }), '/h/companion');
  assert.equal(statePath({ BRAIN_HOME: '/h' }), '/h/companion/state.json');
  assert.equal(busDir({ BRAIN_COMPANION_STATE: '/x/s.json' }), '/x');
});

test('hook pieces: steer text, edit target, output shape', () => {
  const at = new Date(2026, 9, 22, 14, 3).getTime();
  assert.equal(steerContext([]), '');
  assert.match(steerContext([{ text: 'keep it', at }]), /^Note from the user, sent from the companion.*\n- 14:03 keep it$/s);
  assert.match(steerContext([{ text: 'a', at }, { text: 'b', at }]), /^Notes from the user.*take them/s);
  assert.equal(editTarget({ tool_input: { file_path: 'src/a.ts' } }, '/repo'), '/repo/src/a.ts');
  assert.equal(editTarget({ tool_input: { notebook_path: '/n.ipynb' } }, '/repo'), '/n.ipynb');
  assert.equal(editTarget({ tool_input: {} }, '/repo'), '');
  assert.equal(hookOutput('PreToolUse'), null);
  assert.deepEqual(hookOutput('PreToolUse', { decision: 'ask', reason: 'r', context: 'c' }), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r', additionalContext: 'c' } });
});

test('handle: steer lands once, unheld edits pass silently, other events are ignored', async () => {
  const dir = tmp('bus-handle-');
  queueSteer(dir, SID, 'keep ROUND_HALF_EVEN');
  const out = await handle({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_input: { file_path: '/r/a.ts' }, cwd: '/r' }, { dir });
  assert.match(out.hookSpecificOutput.additionalContext, /keep ROUND_HALF_EVEN/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(await handle({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_input: {} }, { dir }), null);
  assert.equal(await handle({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Edit', tool_input: { file_path: '/r/a.ts' } }, { dir }), null);
  assert.equal(await handle({ hook_event_name: 'Stop', session_id: SID }, { dir }), null);
  queueSteer(dir, SID, 'from the prompt side');
  const p = await handle({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'go' }, { dir });
  assert.equal(p.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(p.hookSpecificOutput.additionalContext, /from the prompt side/);
  assert.deepEqual(readRecentEvents(dir).map((e) => e.kind), ['steer-delivered', 'steer-delivered']);
  assert.ok(readSeen(dir)[SID]);
});

test('handle: a held edit asks at once without an engine, waits for approve or deny with one, falls back on timeout', async () => {
  const dir = tmp('bus-hold-');
  const repo = path.join(dir, 'repo');
  addHold(dir, { glob: 'src/billing/**', root: repo, minutes: 30 });
  const edit = { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/billing/invoice.ts') }, cwd: repo };

  let out = await handle(edit, { dir, timeoutMs: 5000 });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /not running/);

  fs.writeFileSync(path.join(dir, 'state.json'), '{}'); // an engine is writing
  const answer = (decision, reason) => {
    const iv = setInterval(() => {
      const p = readPending(dir)[0];
      if (p) { clearInterval(iv); decide(dir, p.id, decision, { reason }); }
    }, 20);
  };
  answer('allow');
  out = await handle(edit, { dir, timeoutMs: 3000 });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');

  answer('deny', 'tax rules first');
  out = await handle(edit, { dir, timeoutMs: 3000 });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /tax rules first/);

  out = await handle(edit, { dir, timeoutMs: 150 });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /no answer/);
  assert.deepEqual(readPending(dir), [], 'no pending file outlives its hook');
  assert.deepEqual(readRecentEvents(dir).map((e) => e.kind), ['held-ask', 'held', 'approved', 'held', 'denied', 'held', 'held-ask']);

  // an edit outside the held glob is untouched
  assert.equal(await handle({ ...edit, tool_input: { file_path: path.join(repo, 'src/auth/a.ts') } }, { dir }), null);
});

test('the hook script: stdin in, JSON out, exit 0 even on garbage', async () => {
  const dir = tmp('bus-script-');
  const script = fileURLToPath(new URL('../scripts/brain-companion-hook.mjs', import.meta.url));
  const run = (input) => new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: { ...process.env, BRAIN_COMPANION_STATE: path.join(dir, 'state.json') } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(input);
  });
  queueSteer(dir, SID, 'hello from the notch');
  const r = await run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /hello from the notch/);
  const bad = await run('not json');
  assert.equal(bad.code, 0);
  assert.equal(bad.out, '');
});

import { execFileSync } from 'node:child_process';
import { parseWorktrees, worktreesOf, createEngine, DEFAULTS } from '../scripts/brain-companion.mjs';
import { updateHoldRoots } from '../scripts/companion-bus.mjs';

test('worktree list parsing drops prunable entries', () => {
  const text = 'worktree /r/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/gone\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n\nworktree /r/wt\nHEAD 123\nbranch refs/heads/x\n';
  assert.deepEqual(parseWorktrees(text), ['/r/main', '/r/wt']);
});

test('a hold set in one checkout covers every worktree of the repo, including ones made later', async () => {
  const base = fs.realpathSync(tmp('bus-wt-'));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  const git = (args, cwd = main) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(['worktree', 'add', '-q', path.join(base, 'wt-a'), '-b', 'a']);

  const bus = path.join(base, 'bus');
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const r = spawnSyncNode([script, 'hold', 'src/billing/**', '--for', '30m', '--state', path.join(bus, 'state.json'), '--json'], main);
  const hold = JSON.parse(r).hold;
  assert.equal(fs.realpathSync(hold.repo), fs.realpathSync(path.join(main, '.git')));
  assert.deepEqual(hold.roots.map((p) => fs.realpathSync(p)).sort(), [main, path.join(base, 'wt-a')].sort());

  const inWt = path.join(base, 'wt-a', 'src', 'billing', 'invoice.ts');
  assert.ok(matchingHold(bus, inWt), 'the existing worktree is covered');
  assert.equal(matchingHold(bus, path.join(base, 'wt-a', 'src', 'auth', 'x.ts')), null, 'other paths are not');

  git(['worktree', 'add', '-q', path.join(base, 'wt-b'), '-b', 'b']);
  const later = path.join(base, 'wt-b', 'src', 'billing', 'invoice.ts');
  assert.equal(matchingHold(bus, later), null, 'a new worktree is not known yet');
  const io = { listProcesses: () => [], configDirsOf: () => new Map(), cwdsOf: () => new Map(), machineMemory: () => ({}) };
  createEngine({ roots: [path.join(base, 'none')], io, env: {}, dir: bus, opts: { ...DEFAULTS, holdRootsEveryMs: 0 } }).collect({ machine: true });
  assert.ok(matchingHold(bus, later), 'the engine adds it on its next machine scan');

  assert.equal(updateHoldRoots(bus, {}), false);
  assert.equal(worktreesOf(path.join(base, 'none')), null);
});

function spawnSyncNode(args, cwd) {
  return execFileSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
}

import { claimInbox, NOTE_TTL_MS, STALE_CLAIM_MS } from '../scripts/companion-bus.mjs';
import { fromSubagent } from '../scripts/brain-companion-hook.mjs';

test('a hook killed while it waits on a hold loses no note: notes are claimed after the decision', async () => {
  const dir = tmp('bus-kill-');
  const repo = path.join(dir, 'repo');
  addHold(dir, { glob: '**', root: repo, minutes: 30 });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}'); // an engine is writing, so the hook waits
  queueSteer(dir, SID, 'keep the rounding');
  const script = fileURLToPath(new URL('../scripts/brain-companion-hook.mjs', import.meta.url));
  const p = spawn(process.execPath, [script], { env: { ...process.env, BRAIN_COMPANION_STATE: path.join(dir, 'state.json'), BRAIN_COMPANION_HOLD_TIMEOUT_MS: '20000' } });
  p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.ts') }, cwd: repo }));
  await new Promise((r) => setTimeout(r, 700));
  p.kill('SIGKILL'); // Esc in Claude Code
  await new Promise((r) => p.on('close', r));
  assert.equal(peekInbox(dir, SID).length, 1, 'the note is still queued');
  assert.ok(!readRecentEvents(dir).some((e) => e.kind === 'steer-delivered'), 'nothing claims it was delivered');
});

test('stale claims are recovered, old notes expire, subagents never spend a note', async () => {
  const dir = tmp('bus-claims-');
  const now = Date.now();
  queueSteer(dir, SID, 'fresh', { now });
  const inbox = path.join(dir, 'inbox');
  const stale = path.join(inbox, `${SID}.jsonl.999.abc.claim`);
  fs.writeFileSync(stale, JSON.stringify({ id: 's-old-claim', text: 'from a killed hook', at: now - 60_000 }) + '\n');
  fs.utimesSync(stale, new Date(now - STALE_CLAIM_MS - 5000), new Date(now - STALE_CLAIM_MS - 5000));
  fs.appendFileSync(path.join(inbox, `${SID}.jsonl`), JSON.stringify({ id: 's-ancient', text: 'yesterday', at: now - NOTE_TTL_MS - 1000 }) + '\n');
  const fresh = path.join(inbox, `${SID}.jsonl.998.def.claim`);
  fs.writeFileSync(fresh, JSON.stringify({ id: 's-busy', text: 'another hook is delivering this', at: now }) + '\n');
  const r = claimInbox(dir, SID, now);
  assert.deepEqual(r.notes.map((n) => n.text), ['from a killed hook', 'fresh']);
  assert.deepEqual(r.expired.map((n) => n.text), ['yesterday']);
  assert.ok(fs.existsSync(fresh), "a young claim belongs to a live hook and is left alone");

  assert.equal(fromSubagent({ agent_id: 'x' }), true);
  assert.equal(fromSubagent({ transcript_path: '/p/abc/subagents/agent-1.jsonl' }), true);
  assert.equal(fromSubagent({ session_id: SID, transcript_path: `/p/${SID}.jsonl` }), false);
  queueSteer(dir, SID, 'for the main agent');
  const sub = await handle({ hook_event_name: 'PreToolUse', session_id: SID, agent_id: 'a1', tool_name: 'Read', tool_input: {} }, { dir });
  assert.equal(sub, null, 'a subagent gets no note');
  assert.equal(peekInbox(dir, SID).length, 1);
  const main = await handle({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Read', tool_input: {} }, { dir });
  assert.match(main.hookSpecificOutput.additionalContext, /for the main agent/);
});

test('glob shapes people type: a plain folder, braces, a leading slash', () => {
  const m = (g, p) => globToRegExp(g).test(p);
  assert.ok(m('src/billing', 'src/billing/a.ts'), 'a folder without a slash');
  assert.ok(m('src/billing', 'src/billing'), 'or the file itself');
  assert.ok(!m('src/billing', 'src/billingx/a.ts'));
  assert.ok(m('src/**/*.{ts,tsx}', 'src/a/b.tsx'));
  assert.ok(m('src/**/*.{ts,tsx}', 'src/b.ts'));
  assert.ok(!m('src/**/*.{ts,tsx}', 'src/b.js'));
  assert.ok(m('/src/billing/**', 'src/billing/x.ts'), 'a leading slash anchors at the root');
  assert.ok(m('{a,b}/x.ts', 'b/x.ts'));
  assert.doesNotThrow(() => globToRegExp('weird{open'), 'an unclosed brace does not throw');
});

test('a hold typed in a subfolder is relative to that subfolder', () => {
  const base = fs.realpathSync(tmp('bus-sub-'));
  execFileSync('git', ['init', '-q'], { cwd: base });
  fs.mkdirSync(path.join(base, 'packages', 'api'), { recursive: true });
  const bus = path.join(base, '.bus');
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const hold = JSON.parse(execFileSync(process.execPath, [script, '--state', path.join(bus, 'state.json'), '--json', 'hold', 'src/**'], { cwd: path.join(base, 'packages', 'api'), encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } })).hold;
  assert.equal(hold.glob, 'packages/api/src/**');
  assert.ok(matchingHold(bus, path.join(base, 'packages', 'api', 'src', 'a.ts')));
  assert.equal(matchingHold(bus, path.join(base, 'src', 'a.ts')), null);
  const rootHold = JSON.parse(execFileSync(process.execPath, [script, '--state', path.join(bus, 'state.json'), '--json', 'hold', '/docs'], { cwd: path.join(base, 'packages', 'api'), encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } })).hold;
  assert.equal(rootHold.glob, 'docs');
});

import { sweepBus } from '../scripts/companion-bus.mjs';

test('eight processes adding holds at once lose none of them', async () => {
  const dir = tmp('bus-lock-');
  const busMod = new URL('../scripts/companion-bus.mjs', import.meta.url).href;
  const code = `import(${JSON.stringify(busMod)}).then((b) => { for (let i = 0; i < 5; i++) b.addHold(process.argv[1], { glob: 'g' + process.pid + '-' + i, root: '/r', minutes: 30 }); });`;
  const procs = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', code, dir]));
  await Promise.all(procs.map((p) => new Promise((r) => p.on('close', r))));
  assert.equal(readHolds(dir).length, 40);
  assert.ok(!fs.existsSync(path.join(dir, 'holds.lock')), 'the lock is released');
});

test('the sweep removes answers nobody reads and presence of long-gone sessions', () => {
  const dir = tmp('bus-sweep-');
  const now = Date.now();
  fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'seen'), { recursive: true });
  const old = path.join(dir, 'answers', 'p-old.json'), fresh = path.join(dir, 'answers', 'p-new.json'), gone = path.join(dir, 'seen', 'sess-gone');
  for (const f of [old, fresh, gone]) fs.writeFileSync(f, '{}');
  fs.utimesSync(old, new Date(now - 11 * 60_000), new Date(now - 11 * 60_000));
  fs.utimesSync(gone, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
  assert.equal(sweepBus(dir, now), 2);
  assert.ok(fs.existsSync(fresh));
});

import { withHoldsLock, writeConfigFile as writeCfg } from '../scripts/companion-bus.mjs';

test('a stale lock that cannot be taken over ends the wait instead of spinning', () => {
  const dir = tmp('bus-stuck-');
  const lock = path.join(dir, 'holds.lock');
  fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date('2026-01-01'), new Date('2026-01-01'));
  const t = Date.now();
  assert.throws(() => withHoldsLock(dir, () => 1), /another process/);
  assert.ok(Date.now() - t < 3000);
});

test('a dangling settings link stays a link and its target gets the file', () => {
  const dir = tmp('bus-dangle-');
  const target = path.join(dir, 'dotfiles', 'claude', 'settings.local.json');
  const link = path.join(dir, 'settings.local.json');
  fs.symlinkSync(target, link);
  writeCfg(link, '{"a":1}\n');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
});
