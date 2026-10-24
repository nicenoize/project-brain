import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf, namedCommands, callRuns, createInjectionTracker, mergeInjectionSummaries, FOLLOW_WINDOW } from '../scripts/companion-injections.mjs';
import { createSessionFold, slimInjections } from '../scripts/brain-companion.mjs';

const T = Date.parse('2026-10-22T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const inject = (ms, text, hookName = 'PreToolUse:Bash') => ({ type: 'attachment', timestamp: iso(ms), attachment: { type: 'hook_additional_context', content: [text], hookName, hookEvent: hookName.split(':')[0] } });
const call = (ms, name, input, extra = {}) => ({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'tool_use', id: `t${ms}`, name, input }] }, ...extra });

test('sources and named commands', () => {
  assert.equal(sourceOf('Project Brain: this looks like a raw code search…'), 'brain');
  assert.equal(sourceOf('## Brain: session state after compaction #3'), 'brain');
  assert.equal(sourceOf('Note from the user, sent from the companion while you were working'), 'companion');
  assert.equal(sourceOf('[impeccable@1] Design hook scanned …'), 'other');
  assert.deepEqual(namedCommands('use `npm run brain:search -- "x"` (or brain:ask), or the MCP tool brain_why'), ['search', 'ask', 'why']);
  assert.deepEqual(namedCommands('nothing here'), []);
  assert.equal(callRuns({ name: 'Bash', input: { command: 'npm run brain:search -- billing' } }, ['search']), 'search');
  assert.equal(callRuns({ name: 'mcp__project-brain__brain_why', input: {} }, ['why']), 'why');
  assert.equal(callRuns({ name: 'Bash', input: { command: 'node scripts/brain-radar.mjs' } }, ['radar']), 'radar');
  assert.equal(callRuns({ name: 'Bash', input: { command: 'grep -r x' } }, ['search']), null);
});

test('followed within five calls, missed after, other sources never scored', () => {
  const t = createInjectionTracker();
  t.record(inject(T, 'Project Brain: use `npm run brain:search -- "<terms>"` instead of grep'));
  t.record(call(T + 1, 'Bash', { command: 'grep -r invoice src' }));
  t.record(call(T + 2, 'Bash', { command: 'npm run brain:search -- invoice' }));
  t.record(inject(T + 3, 'Project Brain (ambient) — before you edit: next: brain:radar'));
  for (let i = 0; i < FOLLOW_WINDOW; i++) t.record(call(T + 4 + i, 'Read', { file_path: `/r/${i}.ts` }));
  t.record(call(T + 20, 'Bash', { command: 'npm run brain:radar' })); // too late
  t.record(inject(T + 21, '[impeccable@1] scanned a.tsx', 'PostToolUse:Write'));
  t.record(call(T + 22, 'Bash', { command: 'npm run brain:radar' }, { isSidechain: true }));
  const s = t.summary();
  assert.equal(s.count, 3);
  assert.equal(s.bySource.brain.count, 2);
  assert.equal(s.bySource.brain.actionable, 2);
  assert.equal(s.bySource.brain.followed, 1);
  assert.equal(s.bySource.brain.followedShare, 0.5);
  assert.equal(s.bySource.other.actionable, 0);
  assert.deepEqual(s.last.map((i) => i.followed), ['search', false, null]);
  assert.deepEqual(Object.keys(s.byEvent), ['brain · PreToolUse', 'other · PostToolUse']);
  const m = mergeInjectionSummaries([s, s, null]);
  assert.equal(m.count, 6);
  assert.equal(m.bySource.brain.followedShare, 0.5);
});

test('the session fold carries what the agent got, slim', () => {
  const f = createSessionFold();
  f.feed({ type: 'user', sessionId: 'a', cwd: '/r', timestamp: iso(T), message: { role: 'user', content: 'go' } });
  f.feed(inject(T + 1, 'Project Brain: about to read a source file directly. brain:search finds it faster. ' + 'x'.repeat(400), 'PreToolUse:Read'));
  const snap = f.snapshot({ now: T + 2 });
  assert.equal(snap.injections.count, 1);
  assert.equal(snap.injections.bySource.brain.count, 1);
  assert.equal(snap.injections.last[0].text.length, 280);
  assert.equal(snap.injections.last[0].event, 'PreToolUse:Read');
  assert.equal(slimInjections({ count: 0 }), null);
});

test('merging a full summary with a slim one (the state shape) never yields NaN or null numbers', () => {
  const t = createInjectionTracker();
  t.record(inject(T, 'Project Brain: use brain:search'));
  const full = t.summary();
  const slim = slimInjections(full);
  const m = mergeInjectionSummaries([full, slim]);
  assert.equal(m.count, 2);
  assert.ok(Number.isFinite(m.chars) && Number.isFinite(m.estTokens), JSON.stringify(m));
  for (const b of Object.values(m.bySource)) for (const v of [b.count, b.chars, b.estTokens, b.actionable, b.followed]) assert.ok(Number.isFinite(v));
  assert.ok(!JSON.stringify(m).includes('null') || m.bySource.brain.followedShare === null);
});

import { kindOf } from '../scripts/companion-injections.mjs';

test('only hints are scored: a warm snapshot or an answer that mentions a command is not a hint', () => {
  assert.equal(kindOf('## Brain: session state after compaction #3 (269k → 72k)\n- next: brain:warm show'), 'state');
  assert.equal(kindOf('Project Brain (ambient, deterministic) — before you edit:\n- run brain:why first'), 'answer');
  assert.equal(kindOf('Project Brain: this looks like a raw code search. A fresh semantic index exists: brain:search'), 'hint');
  assert.equal(kindOf('Project Brain routing (auto-surfaced) — next steps'), 'hint');
  const t = createInjectionTracker();
  const att = (text, hookName) => ({ type: 'attachment', timestamp: new Date().toISOString(), attachment: { type: 'hook_additional_context', content: [text], hookName } });
  t.record(att('## Brain: session state after compaction\n- brain:warm show', 'SessionStart'));
  t.record(att('Project Brain (ambient, deterministic) — before you edit:\n- brain:why', 'PreToolUse:Edit'));
  t.record(att('Project Brain: raw search; try brain:search', 'PreToolUse:Bash'));
  const s = t.summary();
  assert.equal(s.bySource.brain.count, 3);
  assert.equal(s.bySource.brain.actionable, 1, 'one of three asks for a command');
  assert.deepEqual(Object.fromEntries(Object.entries(s.byKind).map(([k, v]) => [k, v.actionable])), { state: 0, answer: 0, hint: 1 });
});
