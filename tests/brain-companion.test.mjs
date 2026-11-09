import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  describeInput, shortPath, modelWindow, createSessionFold, windowFor, createTailer, discoverRoots,
  liveTranscripts, sessionIdFromCommand, agentSessionRows, attachProcesses, machineFrom, buildState,
  renderText, createEngine, STATE_VERSION
} from '../scripts/brain-companion.mjs';

const T0 = Date.parse('2026-10-22T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const SID = '0beaff67-9520-4d36-a926-d4d2aefdafda';
const base = { sessionId: SID, cwd: '/Users/me/Coding/shop-app', gitBranch: 'main', version: '2.1.307' };
const usage = (ctx, out = 50) => ({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx - 1002, output_tokens: out });

function assistant(ms, { req, ctx, content, stop = 'tool_use', sidechain = false, model = 'claude-fable-5-1' }) {
  return { ...base, type: 'assistant', timestamp: iso(ms), requestId: req, isSidechain: sidechain, message: { model, id: `msg_${req}`, role: 'assistant', content, stop_reason: stop, usage: usage(ctx) } };
}

test('describeInput and shortPath keep the wall honest and short', () => {
  assert.equal(describeInput('Bash', { command: 'npm test -- billing\n&& echo done' }), 'npm test -- billing');
  assert.equal(describeInput('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(describeInput('Grep', { pattern: 'ROUND_HALF', path: '/x' }), 'ROUND_HALF');
  assert.equal(describeInput('Whatever', { n: 3, note: 'first string' }), 'first string');
  assert.equal(describeInput('Bash', null), '');
  assert.equal(shortPath('/Users/me/Coding/shop-app/src/a.ts', '/Users/me/Coding/shop-app'), 'src/a.ts');
  assert.equal(shortPath(path.join(os.homedir(), 'x', 'y.ts'), '/elsewhere'), '~/x/y.ts');
  assert.equal(modelWindow('claude-fable-5-1'), 1_000_000);
  assert.equal(modelWindow('claude-3-5-sonnet'), 200_000);
});

test('the fold follows one session: title, ctx from the last request, tool → thinking → waiting, compaction, idle', () => {
  const f = createSessionFold({ transcript: '/t/x.jsonl' });
  f.feed({ type: 'ai-title', aiTitle: 'Billing refactor', sessionId: SID });
  f.feed({ ...base, type: 'user', timestamp: iso(T0), message: { role: 'user', content: 'Split invoices from payments' } });
  let s = f.snapshot({ now: T0 + 1000 });
  assert.equal(s.title, 'Billing refactor');
  assert.equal(s.project, 'shop-app');
  assert.equal(s.state, 'thinking');
  assert.equal(s.ctx, 0);

  f.feed(assistant(T0 + 2000, { req: 'r1', ctx: 196_400, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test -- billing' } }] }));
  // the streamed duplicate of the same request must not count twice
  f.feed(assistant(T0 + 2100, { req: 'r1', ctx: 196_400, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test -- billing' } }] }));
  s = f.snapshot({ now: T0 + 3000, limit: 300_000, limitSource: 'settings' });
  assert.equal(s.ctx, 196_400);
  assert.equal(s.requests, 1);
  assert.equal(s.state, 'tool');
  assert.equal(s.label, 'Bash · npm test -- billing');
  assert.equal(s.ratio, 0.655);
  assert.equal(s.limit, 300_000);
  assert.equal(s.model, 'claude-fable-5-1');

  f.feed({ ...base, type: 'user', timestamp: iso(T0 + 5000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '41 passed' }] } });
  s = f.snapshot({ now: T0 + 6000 });
  assert.equal(s.state, 'thinking');

  f.feed(assistant(T0 + 8000, { req: 'r2', ctx: 198_900, stop: 'end_turn', content: [{ type: 'text', text: 'Rounding kept as ROUND_HALF_EVEN.' }] }));
  s = f.snapshot({ now: T0 + 9000 });
  assert.equal(s.state, 'waiting');
  assert.equal(s.label, 'waiting for you');
  assert.equal(s.ctx, 198_900);
  assert.equal(s.last.text, 'Rounding kept as ROUND_HALF_EVEN.');
  assert.equal(s.last.tool.name, 'Bash');

  // a prompt that never got an answer turns quiet, then idle
  f.feed({ ...base, type: 'user', timestamp: iso(T0 + 10_000), message: { role: 'user', content: 'go on' } });
  assert.equal(f.snapshot({ now: T0 + 10_000 + 4 * 60_000 }).state, 'quiet');
  assert.equal(f.snapshot({ now: T0 + 10_000 + 11 * 60_000 }).state, 'idle');
  assert.equal(f.snapshot({ now: T0 + 10_000 + 11 * 60_000 }).label, 'idle for 11 min');

  f.feed({ ...base, type: 'system', subtype: 'compact_boundary', timestamp: iso(T0 + 12_000), compactMetadata: { trigger: 'auto', preTokens: 291_000, postTokens: 57_200, durationMs: 12, precomputed: true } });
  s = f.snapshot({ now: T0 + 13_000 });
  assert.equal(s.compactions, 1);
  assert.equal(s.ctx, 57_200);
  assert.equal(s.lastCompaction.precomputed, true);
  assert.equal(s.limit, 300_000);
  assert.equal(s.limitSource, 'compaction');
  assert.equal(s.state, 'thinking');
});

test('burn rate is context growth per minute over the last two minutes; sidechain usage never counts', () => {
  const f = createSessionFold();
  f.feed(assistant(T0, { req: 'a', ctx: 100_000, content: [] }));
  f.feed(assistant(T0 + 60_000, { req: 'b', ctx: 112_000, content: [] }));
  f.feed(assistant(T0 + 120_000, { req: 'c', ctx: 124_000, content: [] }));
  f.feed(assistant(T0 + 121_000, { req: 'side', ctx: 900_000, content: [], sidechain: true }));
  const s = f.snapshot({ now: T0 + 125_000 });
  assert.equal(s.burnPerMin, 12_000);
  assert.equal(s.ctx, 124_000);
  assert.equal(s.requests, 3);
  // a window that is too short to judge, or stale samples, report 0
  const g = createSessionFold();
  g.feed(assistant(T0, { req: 'a', ctx: 100_000, content: [] }));
  g.feed(assistant(T0 + 5000, { req: 'b', ctx: 140_000, content: [] }));
  assert.equal(g.snapshot({ now: T0 + 6000 }).burnPerMin, 0);
  assert.equal(f.snapshot({ now: T0 + 20 * 60_000 }).burnPerMin, 0);
});

test('titles fall back from ai-title to the summary to the first prompt to the id', () => {
  const f = createSessionFold();
  f.feed({ ...base, type: 'user', timestamp: iso(T0), isMeta: true, message: { role: 'user', content: '<local-command-caveat>…' } });
  f.feed({ ...base, type: 'user', timestamp: iso(T0 + 1), message: { role: 'user', content: [{ type: 'text', text: '  Make the   island black ' }] } });
  assert.equal(f.snapshot({ now: T0 + 2 }).title, 'Make the island black');
  f.feed({ type: 'summary', summary: 'Island colours', sessionId: SID });
  assert.equal(f.snapshot({ now: T0 + 2 }).title, 'Island colours');
  f.feed({ type: 'ai-title', aiTitle: 'Notch island', sessionId: SID });
  assert.equal(f.snapshot({ now: T0 + 2 }).title, 'Notch island');
  const g = createSessionFold();
  g.feed({ ...base, type: 'user', timestamp: iso(T0), isMeta: true, message: { role: 'user', content: 'meta only' } });
  assert.equal(g.snapshot({ now: T0 }).title, SID.slice(0, 8));
});

test('windowFor reads the compaction mark from local, project, then user settings; else null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-win-'));
  const cwd = path.join(dir, 'repo');
  const user = path.join(dir, 'user');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  assert.equal(windowFor(cwd, { env: {}, configDir: user }), null);
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }));
  assert.deepEqual(windowFor(cwd, { env: {}, configDir: user }), { limit: 500_000, source: 'user settings' });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } }));
  assert.deepEqual(windowFor(cwd, { env: {}, configDir: user }), { limit: 300_000, source: 'settings' });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } }));
  assert.deepEqual(windowFor(cwd, { env: {}, configDir: user }), { limit: 250_000, source: 'settings.local' });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'not json');
  assert.deepEqual(windowFor(cwd, { env: {}, configDir: user }), { limit: 300_000, source: 'settings' });
  assert.deepEqual(windowFor(null, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }, configDir: path.join(dir, 'none') }), { limit: 100_000, source: 'env' });
});

test('the tailer reads only what is new, waits for a torn line, and restarts after truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-tail-'));
  const file = path.join(dir, 's.jsonl');
  const got = [];
  const t = createTailer(file);
  assert.equal(t.read((r) => got.push(r)), 0); // absent file: nothing, no throw
  fs.writeFileSync(file, '{"a":1}\n{"b":2,"text":"ü');
  assert.equal(t.read((r) => got.push(r)), 1);
  fs.appendFileSync(file, 'ber"}\nnot json\n');
  assert.equal(t.read((r) => got.push(r)), 1);
  assert.deepEqual(got, [{ a: 1 }, { b: 2, text: 'über' }]);
  assert.equal(t.read((r) => got.push(r)), 0);
  fs.writeFileSync(file, '{"c":3}\n');
  assert.equal(t.read((r) => got.push(r)), 1);
  assert.deepEqual(got[2], { c: 3 });
});

test('process rows: session ids from the command line, infrastructure filtered, attachment by id then by unique cwd', () => {
  assert.equal(sessionIdFromCommand(`claude --bg-pty-host x -- /v/2.1.304 --session-id ${SID} --fork-session`), SID);
  assert.equal(sessionIdFromCommand(`/Users/me/.local/bin/claude --resume /Users/me/.claude/projects/-x/${SID}.jsonl`), SID);
  assert.equal(sessionIdFromCommand(`claude --resume ${SID.toUpperCase()}`), SID);
  assert.equal(sessionIdFromCommand('claude'), null);
  const rows = [
    { pid: 1, ppid: 0, rssKb: 10, ageSec: 1, command: '/Users/me/.local/bin/claude daemon run --origin transient' },
    { pid: 2, ppid: 1, rssKb: 10, ageSec: 1, command: 'claude bg-pty-host --bg-pty-host /tmp/x.sock 200 50 -- /v --bg-spare' },
    { pid: 3, ppid: 9, rssKb: 204_800, ageSec: 1, command: `/Users/me/.local/bin/claude --resume ${SID}` },
    { pid: 4, ppid: 9, rssKb: 102_400, ageSec: 1, command: '/Users/me/.local/bin/claude' },
    { pid: 5, ppid: 9, rssKb: 102_400, ageSec: 1, command: '/Users/me/.local/bin/claude' },
    { pid: 6, ppid: 9, rssKb: 1, ageSec: 1, command: 'node mcp-server.js' }
  ];
  const agents = agentSessionRows(rows, new Set());
  assert.deepEqual(agents.map((r) => r.pid), [3, 4, 5]);
  const sessions = [
    { id: SID, cwd: '/a', pid: null, rssMb: null },
    { id: 'other', cwd: '/b', pid: null, rssMb: null },
    { id: 'c1', cwd: '/c', pid: null, rssMb: null },
    { id: 'c2', cwd: '/c', pid: null, rssMb: null }
  ];
  attachProcesses(sessions, agents, new Map([[4, '/b'], [5, '/c']]));
  assert.equal(sessions[0].pid, 3);
  assert.equal(sessions[0].rssMb, 200);
  assert.equal(sessions[1].pid, 4);
  assert.equal(sessions[2].pid, null, 'two live sessions in one cwd: nobody gets the pid');
  assert.equal(sessions[3].pid, null);
});

test('discoverRoots: configured, default, and every config dir a running session uses, once each', () => {
  const home = os.homedir();
  const roots = discoverRoots({ env: { CLAUDE_CONFIG_DIR: '/cfg/personal', BRAIN_TRANSCRIPT_ROOTS: '/extra/projects' }, processEnvDirs: ['/cfg/personal', '/cfg/work'] });
  assert.deepEqual(roots, ['/extra/projects', '/cfg/personal/projects', path.join(home, '.claude', 'projects'), '/cfg/work/projects']);
});

test('machine line and state envelope', () => {
  const m = machineFrom({ system: { totalGb: 24, freePct: 23, pressure: 'warn', swapUsedGb: 1.26 }, orphans: [{ pid: 1 }, { pid: 2 }] }, [{ rssKb: 2 ** 20 }, { rssKb: 2 ** 19 }]);
  assert.deepEqual(m, { totalGb: 24, freePct: 23, pressure: 'warn', swapUsedGb: 1.3, agentProcesses: 2, agentRssGb: 1.5, orphans: 2, orphanMb: 0 });
  assert.deepEqual(machineFrom(null), { totalGb: null, freePct: null, pressure: null, swapUsedGb: null, agentProcesses: 0, agentRssGb: 0, orphans: 0, orphanMb: 0 });
  assert.equal(machineFrom({ system: {}, orphans: [{ pid: 1, rssKb: 512_000 }, { pid: 2, rssKb: 512_000 }] }).orphanMb, 1000);
  assert.equal(machineFrom(null, [], { scanned: false }).orphans, null);
  const st = buildState({ sessions: [{ lastActivityMs: 1 }, { lastActivityMs: 5 }], machine: m, now: T0, roots: ['/r'] });
  assert.equal(st.v, STATE_VERSION);
  assert.equal(st.atMs, T0);
  assert.deepEqual(st.sessions.map((s) => s.lastActivityMs), [5, 1]);
});

function writeTranscript(root, project, id, records) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('the engine: live transcripts become sessions, subagent folders and stale files are skipped, PIDs attach, text renders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-root-'));
  const now = Date.now();
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } }));
  const b = { ...base, cwd };
  writeTranscript(root, '-repo', SID, [
    { type: 'ai-title', aiTitle: 'Billing refactor', sessionId: SID },
    { ...b, type: 'user', timestamp: iso(now - 20_000), message: { role: 'user', content: 'Split invoices' } },
    { ...b, type: 'assistant', timestamp: iso(now - 10_000), requestId: 'r1', message: { model: 'claude-fable-5-1', id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(cwd, 'src', 'billing.ts') } }], stop_reason: 'tool_use', usage: usage(196_400) } }
  ]);
  // a subagent transcript in a nested folder is not a session of its own
  writeTranscript(root, path.join('-repo', 'subagents'), 'agent-1', [{ ...b, type: 'assistant', timestamp: iso(now), requestId: 'x', message: { id: 'x', role: 'assistant', content: [], usage: usage(50_000) } }]);
  // a stale transcript is not on the wall, even when its mtime is fresh (idle sessions rewrite metadata)
  writeTranscript(root, '-old', 'ffffffff-0000-4000-8000-000000000000', [{ ...b, type: 'user', timestamp: iso(now - 9e7), message: { role: 'user', content: 'old' } }]);

  const io = {
    listProcesses: () => [
      { pid: 4242, ppid: 1, rssKb: 204_800, ageSec: 100, command: '/Users/me/.local/bin/claude' },
      { pid: 1, ppid: 0, rssKb: 1, ageSec: 1, command: 'claude daemon run' }
    ],
    configDirsOf: () => new Map(),
    cwdsOf: (pids) => new Map(pids.map((pid) => [pid, cwd])),
    machineMemory: () => ({ totalGb: 24, freePct: 40, pressure: 'normal', swapUsedGb: 0 })
  };
  const engine = createEngine({ roots: [root], io, env: {} });
  // the first tick alone reads only transcripts, so the first state is quick
  const quick = engine.collect();
  assert.equal(quick.sessions.length, 1);
  assert.equal(quick.sessions[0].pid, null);
  assert.equal(quick.machine.agentProcesses, null, 'not scanned yet: unknown, not 0');
  const state = engine.collect({ machine: true });
  assert.equal(state.sessions.length, 1);
  const s = state.sessions[0];
  assert.equal(s.title, 'Billing refactor');
  assert.equal(s.ctx, 196_400);
  assert.equal(s.limit, 300_000);
  assert.equal(s.limitSource, 'settings');
  assert.equal(s.state, 'tool');
  assert.equal(s.label, 'Read · src/billing.ts');
  assert.equal(s.pid, 4242);
  assert.equal(s.rssMb, 200);
  assert.equal(state.machine.agentProcesses, 1);
  assert.equal(state.machine.pressure, 'normal');
  assert.deepEqual(state.engine.roots, [root]);

  // the next tick sees only the new line
  fs.appendFileSync(path.join(root, '-repo', `${SID}.jsonl`), JSON.stringify({ ...b, type: 'user', timestamp: iso(now), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) + '\n');
  const again = engine.collect();
  assert.equal(again.sessions[0].state, 'thinking');

  const text = renderText(again);
  assert.match(text, /1 session \(1 live\)/);
  assert.match(text, /Billing refactor/);
  assert.match(text, /196k\/300k\s+65%\s+thinking/);
  assert.doesNotMatch(text, /thinking\s+.*thinking/, 'the state is said once');
  assert.match(renderText(again, { cli: 'leanlamp' }), /^leanlamp ·[\s\S]*monitor only \(leanlamp init\)/);
  assert.match(renderText(again, { cli: 'npm' }), /install-hooks\)/);
});

test('the CLI prints JSON for --json and never needs a brain in the cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-cli-'));
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--json', '--roots', root], { encoding: 'utf8', cwd: root, env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(r.stdout);
  assert.equal(state.v, STATE_VERSION);
  assert.deepEqual(state.sessions, []);
  const bad = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

import { resolveSession, parseMinutes, mergeHook, removeHook, busView, hookCommand, todayStats, startOfDay } from '../scripts/brain-companion.mjs';

const live = (id, title, project, state = 'tool') => ({ id, title, project, state });

test('resolveSession: id, id prefix, title word, project; live sessions first; ambiguity is an error', () => {
  const sessions = [
    live('aaaa1111-0000', 'Billing refactor', 'shop-app'),
    live('bbbb2222-0000', 'Timetable mobile', 'shop-app'),
    live('cccc3333-0000', 'Billing archive', 'old', 'idle')
  ];
  assert.equal(resolveSession('aaaa1111-0000', sessions).session.title, 'Billing refactor');
  assert.equal(resolveSession('bbbb', sessions).session.title, 'Timetable mobile');
  assert.equal(resolveSession('billing', sessions).session.title, 'Billing refactor', 'the live one wins over the idle one');
  assert.equal(resolveSession('archive', sessions).session.title, 'Billing archive');
  assert.match(resolveSession('shop-app', sessions).error, /matches 2 sessions/);
  assert.match(resolveSession('nope', sessions).error, /no session matches/);
  assert.match(resolveSession('', sessions).error, /name a session/);
});

test('parseMinutes', () => {
  assert.equal(parseMinutes('30m'), 30);
  assert.equal(parseMinutes('2h'), 120);
  assert.equal(parseMinutes('1d'), 1440);
  assert.equal(parseMinutes('45'), 45);
  assert.equal(parseMinutes(''), 30);
  assert.equal(parseMinutes('0'), 0);
  assert.equal(parseMinutes('forever'), 0);
  assert.throws(() => parseMinutes('soon'), /not a duration/);
});

test('mergeHook / removeHook: additive, idempotent, never touch other hooks', () => {
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook' }] }] }, model: 'x' };
  const cmd = hookCommand('/p/scripts/brain-companion-hook.mjs');
  const a = mergeHook(mine, cmd);
  assert.equal(a.added, 2);
  assert.equal(a.settings.model, 'x');
  assert.equal(a.settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(a.settings.hooks.PreToolUse[1], { matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 60 }] });
  assert.deepEqual(a.settings.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: cmd, timeout: 60 }] }]);
  assert.equal(mergeHook(a.settings, cmd).added, 0);
  assert.equal(mine.hooks.PreToolUse.length, 1, 'input not mutated');
  const r = removeHook(a.settings);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.settings, mine);
  assert.deepEqual(removeHook({}).settings, {});
});

test('busView: control, inbox and held per session; pending and events carry titles', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const sessions = [{ id: 'a', title: 'Billing', state: 'tool' }, { id: 'b', title: 'Docs', state: 'idle' }];
  const v = busView(sessions, {
    holds: [{ id: 'h1', glob: 'src/**', root: '/r/shop-app', until: now + 90_000 }],
    pending: [{ id: 'p1', session: 'a', tool: 'Edit', file: '/r/shop-app/src/x.ts', cwd: '/r/shop-app', at: now - 5000, deadline: now + 40_000, glob: 'src/**' }],
    events: [{ kind: 'held', session: 'a', at: now - 1000 }, { kind: 'old', session: 'a', at: now - 3600_000 }],
    inbox: { a: 2 },
    seen: { a: now - 60_000, b: now - 3 * 86400_000 },
    now
  });
  assert.equal(sessions[0].control, true);
  assert.equal(sessions[1].control, false);
  assert.equal(sessions[0].inbox, 2);
  assert.equal(sessions[0].held, 1);
  assert.deepEqual(v.holds[0], { id: 'h1', glob: 'src/**', root: '/r/shop-app', project: 'shop-app', worktrees: 1, until: now + 90_000, minutesLeft: 2, note: '' });
  assert.equal(v.pending[0].title, 'Billing');
  assert.equal(v.pending[0].shortFile, 'src/x.ts');
  assert.equal(v.pending[0].secondsLeft, 40);
  assert.deepEqual(v.events.map((e) => e.kind), ['held']);
  assert.equal(v.events[0].title, 'Billing');
});

test('the CLI acts: steer resolves a session, hold/release, approve, install-hooks into a given settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-act-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, atMs: Date.now(), sessions: [{ id: SID, title: 'Billing refactor', project: 'shop-app', state: 'tool', control: true }] }));
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args, '--state', stateFile, '--json'], { encoding: 'utf8', cwd: dir, env: { ...process.env, BRAIN_USAGE_LOG: '0', BRAIN_HOME: path.join(dir, 'brain-home') } });

  let r = run('steer', 'billing', 'keep', 'ROUND_HALF_EVEN');
  assert.equal(r.status, 0, r.stderr);
  const steer = JSON.parse(r.stdout);
  assert.equal(steer.session, SID);
  assert.equal(steer.note.text, 'keep ROUND_HALF_EVEN');
  assert.equal(fs.readFileSync(path.join(dir, 'inbox', `${SID}.jsonl`), 'utf8').split('\n').filter(Boolean).length, 1);
  r = run('steer', 'nothing-like-this', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no session matches/);

  r = run('hold', 'src/billing/**', '--for', '2h');
  assert.equal(r.status, 0, r.stderr);
  const hold = JSON.parse(r.stdout).hold;
  assert.equal(hold.glob, 'src/billing/**');
  assert.ok(hold.until > Date.now() + 119 * 60_000);
  r = run('hold', '--all', '--for', '0');
  assert.equal(JSON.parse(r.stdout).hold.root, null);
  r = run('release', '--all');
  assert.equal(JSON.parse(r.stdout).released, 2);

  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pending', 'p123.json'), JSON.stringify({ id: 'p123', tool: 'Edit', file: '/r/a.ts', at: Date.now(), deadline: Date.now() + 40_000 }));
  r = run('approve', 'p1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'answers', 'p123.json'), 'utf8')).decision, 'allow');
  assert.equal(run('deny', 'zzz').status, 1);

  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
  r = run('install-hooks', '--settings', settings, '--dry-run');
  assert.match(JSON.parse(r.stdout).text, /would add 2 hook entries/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'opus' });
  r = run('install-hooks', '--settings', settings);
  const installed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(installed.model, 'opus');
  assert.match(installed.hooks.PreToolUse[0].hooks[0].command, /brain-companion-hook\.mjs"$/);
  assert.ok(fs.readdirSync(path.join(dir, 'brain-home', 'backups')).some((f) => f.startsWith('hooks-')), 'the backup is with leanlamp, not next to the settings');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.bak-companion-')));
  r = run('uninstall-hooks', '--settings', settings);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'opus' });
});

import { createRangeReader, mergeHead, DEFAULTS } from '../scripts/brain-companion.mjs';

test('tail first, head later: the first state reads only the tail, the backfill makes totals exact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-tail-first-'));
  const now = Date.now();
  const b = { ...base, cwd: path.join(root, 'repo') };
  const recs = [{ ...b, type: 'user', timestamp: iso(now - 600_000), message: { role: 'user', content: 'Start the billing split' } }];
  let req = 0;
  const ask = (ms, ctx) => ({ ...b, type: 'assistant', timestamp: iso(ms), requestId: `r${++req}`, message: { model: 'claude-fable-5-1', id: `m${req}`, role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) }], stop_reason: 'end_turn', usage: usage(ctx) } });
  for (let i = 0; i < 60; i++) recs.push(ask(now - 590_000 + i * 1000, 100_000 + i * 1000));
  recs.push({ ...b, type: 'system', subtype: 'compact_boundary', timestamp: iso(now - 500_000), compactMetadata: { trigger: 'auto', preTokens: 290_000, postTokens: 50_000 } });
  for (let i = 0; i < 60; i++) recs.push(ask(now - 400_000 + i * 1000, 60_000 + i * 1000));
  recs.push({ ...b, type: 'system', subtype: 'compact_boundary', timestamp: iso(now - 300_000), compactMetadata: { trigger: 'auto', preTokens: 295_000, postTokens: 52_000 } });
  for (let i = 0; i < 20; i++) recs.push(ask(now - 200_000 + i * 1000, 70_000 + i * 1000));
  recs.push({ type: 'ai-title', aiTitle: 'Billing split', sessionId: SID });
  const file = writeTranscript(root, '-repo', SID, recs);
  const size = fs.statSync(file).size;
  const io = { listProcesses: () => [], configDirsOf: () => new Map(), cwdsOf: () => new Map(), machineMemory: () => ({}) };

  const exact = createEngine({ roots: [root], io, env: {}, opts: { ...DEFAULTS, tailBytes: 0 } }).collect().sessions[0];
  assert.equal(exact.compactions, 2);
  assert.equal(exact.requests, 140);

  const opts = { ...DEFAULTS, tailBytes: Math.floor(size / 5), backfillBytesPerTick: Math.floor(size / 4) };
  const engine = createEngine({ roots: [root], io, env: {}, opts });
  const first = engine.collect().sessions[0];
  assert.equal(first.ctx, exact.ctx, 'current numbers come from the tail at once');
  assert.equal(first.title, 'Billing split');
  assert.equal(first.state, exact.state);
  let s = first;
  for (let i = 0; i < 10 && s.partial; i++) s = engine.collect().sessions[0];
  assert.equal(s.partial, undefined, 'the backfill finishes within a few ticks');
  assert.equal(s.compactions, exact.compactions);
  assert.equal(s.requests, exact.requests);
  assert.equal(s.limit, exact.limit);
  assert.equal(s.startedMs, exact.startedMs);
});

test('range reader and mergeHead in isolation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-range-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n');
  const got = [];
  const r = createRangeReader(file, 16); // the first two lines exactly
  r.step((x) => got.push(x.a), 5);
  r.step((x) => got.push(x.a));
  assert.ok(r.done);
  assert.deepEqual(got, [1, 2]);
  const snap = { id: SID, title: SID.slice(0, 8), ctx: 100_000, limit: 1_000_000, limitSource: 'model', compactions: 1, requests: 10, outputTokens: 5, startedMs: 50 };
  const m = mergeHead(snap, { compactions: 3, requests: 90, outputTokens: 7, startedMs: 10, maxPreTokens: 291_000, firstPrompt: 'Hello  world' }, { done: false });
  assert.equal(m.compactions, 4);
  assert.equal(m.requests, 100);
  assert.equal(m.startedMs, 10);
  assert.equal(m.limit, 300_000);
  assert.equal(m.limitSource, 'compaction');
  assert.equal(m.title, 'Hello world');
  assert.equal(m.partial, true);
  assert.equal(mergeHead(snap, null), snap);
});

test('a transcript with only old messages is never backfilled and never keeps the engine busy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-stale-head-'));
  const old = Date.now() - 10 * 3600_000;
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push({ ...base, type: 'assistant', timestamp: iso(old + i), requestId: `r${i}`, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(300) }], usage: usage(100_000) } });
  writeTranscript(root, '-old', SID, lines); // fresh mtime, old messages
  const io = { listProcesses: () => [], configDirsOf: () => new Map(), cwdsOf: () => new Map(), machineMemory: () => ({}) };
  const engine = createEngine({ roots: [root], io, env: {}, opts: { ...DEFAULTS, tailBytes: 20_000 } });
  assert.equal(engine.collect().sessions.length, 0);
  assert.equal(engine.backfilling, false);
  assert.deepEqual(engine.liveDirs(), [path.join(root, '-old')]);
});

import { lightRecord, parseLine, headLineWanted, HUGE_LINE } from '../scripts/brain-companion.mjs';

test('huge lines are read light: ids, usage and tool calls without the payload', () => {
  const blob = 'A'.repeat(HUGE_LINE + 10);
  const user = JSON.stringify({ type: 'user', timestamp: iso(T0), sessionId: SID, cwd: '/r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu10', content: [{ type: 'image', source: { data: blob } }] }] } });
  const r = parseLine(user);
  assert.equal(r.type, 'user');
  assert.deepEqual(r.message.content, [{ type: 'tool_result', tool_use_id: 'tu10', content: '' }]);
  assert.equal(r.timestamp, iso(T0));
  const asst = JSON.stringify({ type: 'assistant', timestamp: iso(T0), sessionId: SID, requestId: 'req_7', message: { id: 'msg_7', model: 'claude-fable-5-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu10', name: 'Write', input: { content: blob } }], stop_reason: 'tool_use', usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 239_000, output_tokens: 9000 } } });
  const a = parseLine(asst);
  assert.equal(a.requestId, 'req_7');
  assert.equal(a.message.model, 'claude-fable-5-1');
  assert.deepEqual(a.message.content, [{ type: 'tool_use', id: 'tu10', name: 'Write', input: {} }]);
  assert.deepEqual(a.message.usage, { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 239_000, output_tokens: 9000 });
  const f = createSessionFold();
  f.feed(a);
  assert.equal(f.snapshot({ now: T0 + 1 }).ctx, 240_002);
  assert.equal(f.snapshot({ now: T0 + 1 }).state, 'tool');
  f.feed(r);
  assert.equal(f.snapshot({ now: T0 + 2 }).state, 'thinking');
  assert.equal(lightRecord('{"no":"type"}'), null);
  assert.equal(parseLine('{"type":"user","x":1}').x, 1, 'small lines parse normally');
  assert.ok(headLineWanted('{"type":"user","message":"hi"}'));
  assert.ok(!headLineWanted('{"type":"attachment","attachment":{"type":"file"}}'));
});

import { formatVerdict, formatSummary, compareVersions, TESTED_VERSIONS } from '../scripts/brain-companion.mjs';

test('format drift: missing usage or compaction metadata is caught, a newer version is only a note', () => {
  assert.equal(compareVersions('2.1.307', '2.1.296'), 1);
  assert.equal(compareVersions('2.1.30', '2.1.296'), -1);
  assert.equal(compareVersions('2.2', '2.1.999'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  const ok = formatVerdict({ assistant: 100, withUsage: 100, boundaries: 2, boundariesWithMeta: 2 }, TESTED_VERSIONS.max);
  assert.equal(ok.ok, true);
  assert.equal(ok.newerThanTested, false);
  const drift = formatVerdict({ assistant: 100, withUsage: 3, boundaries: 1, boundariesWithMeta: 0 }, '9.0.0');
  assert.equal(drift.ok, false);
  assert.equal(drift.issues.length, 2);
  assert.equal(drift.newerThanTested, true);
  assert.equal(formatVerdict({ assistant: 5, withUsage: 0, boundaries: 0, boundariesWithMeta: 0 }).ok, true, 'too few records to judge');

  const f = createSessionFold();
  for (let i = 0; i < 25; i++) f.feed({ ...base, type: 'assistant', timestamp: iso(T0 + i), requestId: `x${i}`, message: { id: `x${i}`, role: 'assistant', content: [] } });
  const snap = f.snapshot({ now: T0 + 30 });
  assert.equal(snap.format.ok, false);
  assert.equal(snap.format.version, '2.1.307');
  const sum = formatSummary([{ ...snap, title: 'drifted' }, { title: 'fine', format: ok }]);
  assert.equal(sum.ok, false);
  assert.deepEqual(sum.versions, [...new Set(['2.1.307', TESTED_VERSIONS.max])]);
  assert.equal(sum.issues[0].title, 'drifted');
});

test('steer notes are literal after --, short holds stay short, an ambiguous approve is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-literal-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ v: 1, atMs: Date.now(), sessions: [{ id: SID, title: 'Billing refactor', project: 'shop-app', state: 'tool', control: true }] }));
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--state', stateFile, '--json', ...args], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
  let r = run('steer', 'billing', '--', '--no-verify is fine here', '--help');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).note.text, '--no-verify is fine here --help');
  assert.equal(parseMinutes('0.4'), 1);
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  for (const id of ['pmvk1aaa', 'pmvk1bbb']) fs.writeFileSync(path.join(dir, 'pending', `${id}.json`), JSON.stringify({ id, tool: 'Edit', file: '/r/a.ts', at: Date.now(), deadline: Date.now() + 40_000 }));
  r = run('approve', 'pmvk1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /matches 2 held edits/);
  assert.equal(run('approve', 'pmvk1bbb').status, 0);
});

test('install-hooks repoints a hook at a dead path and writes through a symlinked settings file', () => {
  const cmd = hookCommand('/new/scripts/brain-companion-hook.mjs');
  const old = mergeHook({}, hookCommand('/gone/worktree/scripts/brain-companion-hook.mjs')).settings;
  const r = mergeHook(old, cmd);
  assert.equal(r.added, 0);
  assert.equal(r.updated, 2);
  assert.equal(r.settings.hooks.PreToolUse[0].hooks[0].command, cmd);
  assert.equal(mergeHook(r.settings, cmd).updated, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-link-'));
  const real = path.join(dir, 'dotfiles-settings.json');
  fs.writeFileSync(real, JSON.stringify({ model: 'opus' }), { mode: 0o600 });
  const link = path.join(dir, 'settings.json');
  fs.symlinkSync(real, link);
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [script, 'install-hooks', '--settings', link, '--json'], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0', BRAIN_HOME: path.join(path.dirname(link), 'brain-home') } });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays a link');
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).model, 'opus');
  assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.PreToolUse);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600, 'the mode is kept');
});

test('mergeHead: the ratio follows a context that came from the head; a request across the border counts once', () => {
  const head = createSessionFold();
  const tail = createSessionFold();
  const rec = (req, ctx) => ({ ...base, type: 'assistant', timestamp: iso(T0), requestId: req, message: { id: req, role: 'assistant', content: [], usage: usage(ctx) } });
  head.feed(rec('r1', 100_000)); head.feed(rec('r2', 280_100));
  tail.feed(rec('r2', 280_100)); // the streamed rest of r2, after the border
  tail.feed({ ...base, type: 'user', timestamp: iso(T0 + 1), message: { role: 'user', content: 'go' } });
  const snap = tail.snapshot({ now: T0 + 2, limit: 300_000, limitSource: 'settings' });
  const m = mergeHead(snap, head.state);
  assert.equal(m.requests, 2, 'r2 once');
  assert.equal(m.ctx, 280_100);
  assert.equal(m.ratio, 0.934);
  assert.equal(JSON.stringify(m).includes('_seen'), false);
});

test('mergeHead: a tail without any request borrows ctx from the head and gets a matching ratio', () => {
  const head = createSessionFold();
  head.feed({ ...base, type: 'assistant', timestamp: iso(T0), requestId: 'h1', message: { id: 'h1', role: 'assistant', content: [], usage: usage(280_100) } });
  const tail = createSessionFold();
  tail.feed({ ...base, type: 'user', timestamp: iso(T0 + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'big output' }] } });
  const snap = tail.snapshot({ now: T0 + 2, limit: 300_000, limitSource: 'settings' });
  assert.equal(snap.ctx, 0);
  const m = mergeHead(snap, head.state);
  assert.equal(m.ctx, 280_100);
  assert.equal(m.ratio, 0.934);
});

import { isEngineProcess } from '../scripts/brain-companion.mjs';

test('a stale engine.pid naming an unrelated process does not block a new engine', async () => {
  assert.equal(isEngineProcess(process.pid), false, 'this test runner is not an engine');
  assert.equal(isEngineProcess(999_999), false, 'no such process');
  const { spawn } = await import('node:child_process');
  const fake = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'brain-companion.mjs']);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(isEngineProcess(fake.pid), true);
  fake.kill();
});

import { checkSetup, renderCheck, timeHook } from '../scripts/brain-companion.mjs';

test('the setup check: a missing hook and a dead engine are ✗ with a fix, an installed hook is ✓', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
  const file = path.join(home, 'bus', 'state.json');
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, '{}');
  const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'check-roots-'))];
  const before = await checkSetup({ file, explicit: settings, cwd: home, roots, timing: false });
  assert.equal(before.ok, false);
  const byId = (r, id) => r.checks.filter((c) => c.id === id);
  assert.equal(byId(before, 'engine')[0].status, 'fail');
  assert.equal(byId(before, 'hook')[0].status, 'fail');
  assert.match(byId(before, 'hook')[0].fix, /leanlamp init/);
  assert.match(renderCheck(before), /✗ hook\s+not in/);

  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'install-hooks', '--settings', settings, '--state', file], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0', BRAIN_HOME: path.join(home, 'brain-home') } });
  assert.equal(r.status, 0, r.stderr);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, sessions: [], format: { ok: true, versions: [], issues: [] } }));
  const after = await checkSetup({ file, explicit: settings, cwd: home, roots, timing: false });
  assert.equal(byId(after, 'hook')[0].status, 'ok');
  assert.equal(byId(after, 'engine')[0].status, 'ok');
  assert.equal(after.checks.some((c) => c.status === 'fail'), false);
});

test('hook timing runs against a scratch bus and reports load', async () => {
  const t = await timeHook({ runs: 10, spawns: 3 });
  assert.ok(t.logicMs >= 0 && t.callMs > 0 && t.nodeStartMs > 0);
  assert.equal(typeof t.loaded, 'boolean');
});

test('todayStats counts since local midnight: compactions from the transcripts, the rest from the event log', () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  const t0 = new Date(2026, 9, 22, 0, 0).getTime();
  const yesterday = t0 - 60_000;
  const sessions = [
    { compactionLog: [{ atMs: yesterday, precomputed: false, durationMs: 50_000 }, { atMs: t0 + 1000, precomputed: true, durationMs: 400 }, { atMs: t0 + 2000, precomputed: false, durationMs: 9_400 }] },
    { compactionLog: [{ atMs: now - 1000, precomputed: false, durationMs: 2_200 }] },
    {} // an engine snapshot without the log
  ];
  const events = [
    { kind: 'held', at: yesterday },
    { kind: 'held', at: t0 + 10 }, { kind: 'approved', at: t0 + 20 },
    { kind: 'held', at: t0 + 30 }, { kind: 'held-ask', at: t0 + 40, why: 'timeout' }, // the same edit: counted once
    { kind: 'held-ask', at: t0 + 50, why: 'no engine' },
    { kind: 'denied', at: t0 + 60 }, { kind: 'steer-delivered', at: t0 + 70 }, { kind: 'steer', at: t0 + 65 },
    { kind: 'reclaimed', at: t0 + 80, mb: 310.4 }, { kind: 'reclaimed', at: t0 + 90, mb: 99.8 },
    { kind: 'approved', at: now + 60_000 } // the future does not count
  ];
  assert.deepEqual(todayStats({ sessions, events, now }), {
    sinceMs: t0, compactions: 3, prepared: 1, waitedSeconds: 12, held: 3, approved: 1, denied: 1, steered: 1, reclaimedMb: 410
  });
  assert.equal(startOfDay(now), t0);
  assert.equal(todayStats({ now }).compactions, 0, 'nothing yet is zeros, not an error');
});

test('a subagent compaction stays out of the live numbers, like the receipt', () => {
  const fold = createSessionFold();
  const at = new Date().toISOString();
  fold.feed({ type: 'system', subtype: 'compact_boundary', sessionId: 's', timestamp: at, compactMetadata: { trigger: 'auto', preTokens: 200_000, postTokens: 40_000, durationMs: 8000 } });
  fold.feed({ type: 'system', subtype: 'compact_boundary', sessionId: 's', timestamp: at, isSidechain: true, compactMetadata: { trigger: 'auto', preTokens: 90_000, postTokens: 20_000, durationMs: 5000 } });
  assert.equal(fold.snapshot().compactionLog.length, 1);
});
