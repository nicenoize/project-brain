import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRegistry, treeMb, parkVerdict, resumeCommand, buildCard, renderCard, pick, pidReused,
  foldTranscript, listParked, unpark, parkedDir
} from '../scripts/sessions.mjs';
import { emptyState } from '../scripts/brain-warm.mjs';

const reg = { pid: 42, sessionId: 'abc-123', cwd: '/w/app', name: 'app-1', status: 'idle', kind: 'interactive', startedAt: 1000, statusUpdatedAt: 2000 };

test('parseRegistry keeps interactive sessions and drops background helpers', () => {
  const s = parseRegistry(reg, '/h/.claude');
  assert.equal(s.pid, 42);
  assert.equal(s.sessionId, 'abc-123');
  assert.equal(s.configDir, '/h/.claude');
  assert.equal(parseRegistry({ ...reg, kind: 'bg' }, '/h'), null);
  assert.equal(parseRegistry({ pid: 1 }, '/h'), null);
  assert.equal(parseRegistry(null, '/h'), null);
});

test('treeMb counts the session and every helper it started', () => {
  const rows = [
    { pid: 42, ppid: 1, rssKb: 100 * 1024 },
    { pid: 50, ppid: 42, rssKb: 30 * 1024 },
    { pid: 51, ppid: 50, rssKb: 20 * 1024 },
    { pid: 60, ppid: 1, rssKb: 999 * 1024 }
  ];
  assert.deepEqual(treeMb(rows, 42), { own: 100, children: 50, total: 150, helpers: 2 });
  assert.equal(treeMb(rows, 42, 300).total, 350, 'the measured footprint replaces the RSS of the session itself');
});

test('parkVerdict never parks a working session, this session, or one without a transcript', () => {
  const now = 10 * 3600_000;
  const quiet = { pid: 42, status: 'idle', lastMessageMs: now - 3 * 3600_000 };
  assert.equal(parkVerdict(quiet, { now }).park, true);
  assert.equal(parkVerdict({ ...quiet, status: 'busy' }, { now }).why, 'working');
  assert.equal(parkVerdict({ ...quiet, status: 'shell' }, { now }).park, false);
  assert.equal(parkVerdict(quiet, { now, ancestors: new Set([42]) }).why, 'this session');
  assert.equal(parkVerdict({ ...quiet, lastMessageMs: null }, { now }).why, 'no transcript');
  assert.equal(parkVerdict({ ...quiet, lastMessageMs: now - 60_000 }, { now }).why, 'recent');
});

test('pidReused: a process younger than the session it claims is someone else', () => {
  const now = 100 * 3600_000;
  const s = { pid: 42, startedAt: now - 5 * 3600_000 };
  assert.equal(pidReused(s, [{ pid: 42, ageSec: 5 * 3600 }], now), false);
  assert.equal(pidReused(s, [{ pid: 42, ageSec: 60 }], now), true);
  assert.equal(pidReused(s, [], now), false);
});

test('resumeCommand names the config dir only when it is not the default', () => {
  const home = '/Users/me';
  assert.equal(resumeCommand({ cwd: '/Users/me/app', sessionId: 'abc', configDir: '/Users/me/.claude' }, { home }), 'cd ~/app && claude --resume abc');
  assert.equal(
    resumeCommand({ cwd: '/Users/me/my app', sessionId: 'abc', configDir: '/Users/me/.claude-personal' }, { home }),
    "cd '~/my app' && CLAUDE_CONFIG_DIR=~/.claude-personal claude --resume abc"
  );
});

test('buildCard keeps what the session was about and renderCard shows it with the way back', () => {
  const state = emptyState('abc-123');
  state.goal = 'build the export';
  state.asks = ['build the export', 'and the csv too'];
  state.lastAgent = 'Export done, CSV half way.';
  state.branch = 'feature/export';
  state.files = { '/w/app/src/export.ts': { edits: 2, reads: 1, last: 5, ranges: [] }, '/w/app/README.md': { edits: 0, reads: 1, last: 6, ranges: [] } };
  const card = buildCard(parseRegistry(reg, '/h/.claude'), state, { now: 5000, mb: 321 });
  assert.equal(card.goal, 'build the export');
  assert.deepEqual(card.asks, ['and the csv too']);
  assert.deepEqual(card.edited, ['src/export.ts']);
  assert.equal(card.freedMb, 321);
  const text = renderCard(card, { now: 5000 });
  assert.match(text, /asked: build the export/);
  assert.match(text, /last ask: and the csv too/);
  assert.match(text, /edited: src\/export.ts/);
  assert.match(text, /claude --resume abc-123/);
});

test('pick matches by pid, id prefix, then a word of the name or project', () => {
  const list = [
    { pid: 1, sessionId: 'aaa111', name: 'vinyl-reel-42', cwd: '/w/vinyl-reel' },
    { pid: 2, sessionId: 'bbb222', name: 'shop-app-3', cwd: '/w/shop-app' }
  ];
  assert.deepEqual(pick(list, '2').map((s) => s.pid), [2]);
  assert.deepEqual(pick(list, 'aaa').map((s) => s.pid), [1]);
  assert.deepEqual(pick(list, 'shop').map((s) => s.pid), [2]);
  assert.deepEqual(pick(list, ''), []);
});

test('foldTranscript reads the first ask from the head and the state from the tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const file = path.join(dir, 't.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { content: 'first ask' } },
    { type: 'assistant', timestamp: '2026-10-01T10:01:00Z', message: { content: [{ type: 'text', text: 'working on it' }] } },
    { type: 'artifact-autoreact-ledger', sessionId: 'x' }
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const { state, lastMessageMs } = foldTranscript(file);
  assert.equal(state.goal, 'first ask');
  assert.equal(state.lastAgent, 'working on it');
  assert.equal(lastMessageMs, Date.parse('2026-10-01T10:01:00Z'), 'bookkeeping records are not activity');
  assert.equal(foldTranscript(path.join(dir, 'missing.jsonl')).lastMessageMs, null);
});

test('listParked reads cards newest first; unpark drops one', () => {
  const env = { BRAIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'brainhome-')) };
  const dir = parkedDir(env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', parkedAt: 1 }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ sessionId: 'b', parkedAt: 2 }));
  fs.writeFileSync(path.join(dir, 'torn.json'), '{');
  assert.deepEqual(listParked({ env }).map((c) => c.sessionId), ['b', 'a']);
  assert.equal(unpark('a', { env }), true);
  assert.deepEqual(listParked({ env }).map((c) => c.sessionId), ['b']);
});

test('scratchpadOwner and findStrays: servers an agent started from its scratchpad belong to that session', async () => {
  const { scratchpadOwner, findStrays } = await import('../scripts/sessions.mjs');
  const id = '2ff8f575-f866-4a28-bf53-7aa20400bdcf';
  assert.equal(scratchpadOwner(`python -m http.server 8791 --directory /private/tmp/claude-501/-Users-me-app/${id}/scratchpad/mockups`), id);
  assert.equal(scratchpadOwner('/Users/me/app'), null);
  const rows = [
    { pid: 10, ppid: 1, rssKb: 4096, ageSec: 99, command: `python -m http.server --directory /tmp/claude-501/p/${id}/scratchpad` },
    { pid: 11, ppid: 10, rssKb: 1024, ageSec: 99, command: 'python worker' },
    { pid: 12, ppid: 1, rssKb: 1024, ageSec: 9, command: 'vite' },
    { pid: 13, ppid: 1, rssKb: 1024, ageSec: 9, command: '/Users/me/.local/bin/claude' }
  ];
  const cwds = new Map([[11, `/tmp/claude-501/p/${id}/scratchpad`], [12, '/Users/me/app'], [13, `/tmp/claude-501/p/${id}/scratchpad`]]);
  const s = findStrays(rows, cwds);
  assert.deepEqual(s.map((x) => x.pid), [10], 'the child rides along with its parent; the session itself is no stray');
  assert.equal(s[0].owner, id);
  assert.equal(s[0].mb, 4);
});

test('leftovers: BRAIN_SCRATCH_ROOT keeps a run to its own folder', async () => {
  const { leftovers } = await import('../scripts/sessions.mjs');
  const id = '00000000-0000-4000-8000-0000000000aa';
  const rows = [
    { pid: 20, ppid: 1, rssKb: 1024, ageSec: 9, command: `sleep 60 /t/home/claude-501/p/${id}/scratchpad` },
    { pid: 21, ppid: 1, rssKb: 1024, ageSec: 9, command: `python -m http.server /private/tmp/claude-501/p/${id}/scratchpad` }
  ];
  const got = leftovers({ env: { BRAIN_SCRATCH_ROOT: '/t/home', BRAIN_LEFTOVER_MIN_AGE_SEC: '0' }, rows, sessions: [], cwds: new Map() });
  assert.deepEqual(got.map((x) => x.pid), [20]);
  assert.equal(leftovers({ env: { BRAIN_LEFTOVER_MIN_AGE_SEC: '0' }, rows, sessions: [], cwds: new Map() }).length, 2);
  assert.equal(leftovers({ env: {}, rows, sessions: [], cwds: new Map() }).length, 0, 'younger than an hour: not surely left behind');
  const resumed = [...rows, { pid: 30, ppid: 1, rssKb: 1, ageSec: 9, command: `claude --resume ${id}` }];
  assert.equal(leftovers({ env: { BRAIN_LEFTOVER_MIN_AGE_SEC: '0' }, rows: resumed, sessions: [], cwds: new Map() }).length, 0, 'its session runs under a config dir we do not know');
});
