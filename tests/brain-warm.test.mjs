import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, foldRecords, parseChunk, renderWarm, snapshot } from '../scripts/brain-warm.mjs';
import { BUDGETS } from '../scripts/footprint.mjs';
import { autoCompactWindowOptIn, mergeEnv } from '../scripts/setup-claude-settings.mjs';

const user = (content, extra = {}) => ({ type: 'user', message: { content }, ...extra });
const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, is_error = false) => user([{ type: 'tool_result', tool_use_id: id, content, is_error }]);
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('goal is the first real ask; injected and tool records are not asks', () => {
  const s = foldRecords(emptyState('s'), [
    user('<command-name>/model</command-name>'),
    user('<system-reminder>x</system-reminder>'),
    user('Bau das Login neu', { cwd: '/repo', gitBranch: 'feat/login' }),
    result('t1', 'ok'),
    user('summary', { isCompactSummary: true }),
    user([{ type: 'text', text: 'und teste es' }])
  ]);
  assert.equal(s.goal, 'Bau das Login neu');
  assert.deepEqual(s.asks, ['Bau das Login neu', 'und teste es']);
  assert.equal(s.cwd, '/repo');
  assert.equal(s.branch, 'feat/login');
});

test('files, ranges, checks and tags are folded; only real checks count', () => {
  const s = foldRecords(emptyState('s'), [
    tool('a', 'Read', { file_path: '/repo/src/a.ts', offset: 100, limit: 50 }),
    tool('b', 'Edit', { file_path: '/repo/src/a.ts' }),
    tool('c', 'Bash', { command: 'npm test 2>&1 | tail -5' }),
    result('c', 'Exit code 1\nfailing'),
    tool('d', 'Bash', { command: "cat > x.ts <<'TS'\nvitest run" }), // heredoc mentioning vitest
    result('d', ''),
    tool('e', 'Bash', { command: 'sed -i "" x.ts && CI=1 npx vitest run lib' }),
    result('e', 'ok'),
    tool('f', 'Bash', { command: 'npm test' }),
    result('f', 'pass'),
    say('Done.\n## Decided: keep the old API\n## Followup: migrate callers')
  ]);
  assert.deepEqual(s.files['/repo/src/a.ts'], { edits: 1, reads: 1, last: 2, ranges: ['100-149'] });
  // npm test failed, then passed: one entry, latest result wins.
  assert.deepEqual(s.checks.map((c) => [c.cmd, c.ok]), [['CI=1 npx vitest run lib', true], ['npm test', true]]);
  assert.deepEqual(s.tags.Decided, ['keep the old API']);
  assert.deepEqual(s.tags.Followup, ['migrate callers']);
  assert.equal(s.lastAgent.startsWith('Done.'), true);
});

test('compaction boundaries are recorded with their token counts', () => {
  const s = foldRecords(emptyState('s'), [
    { type: 'system', subtype: 'compact_boundary', timestamp: 't', compactMetadata: { trigger: 'auto', preTokens: 967030, postTokens: 23293 } }
  ]);
  assert.deepEqual(s.compactions, [{ trigger: 'auto', preTokens: 967030, postTokens: 23293, ts: 't' }]);
  assert.match(renderWarm(s), /after compaction #1 \(967k → 23k\)/);
});

test('parseChunk leaves a half-written last line for the next read', () => {
  const { records, consumed } = parseChunk('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
  assert.equal(consumed, Buffer.byteLength('{"a":1}\n{"b":2}\n'));
});

test('render stays inside the budget, drops whole sections, keeps the pointer', () => {
  const s = emptyState('s');
  s.goal = 'g'.repeat(500);
  s.lastAgent = 'x'.repeat(1200);
  for (let i = 0; i < 40; i++) s.files[`/r/f${i}-${'p'.repeat(150)}.ts`] = { edits: 1, reads: 0, last: i, ranges: [] };
  s.cwd = '/r';
  const out = renderWarm(s, { budgetBytes: 2500, transcriptPath: '/t.jsonl' });
  assert.ok(Buffer.byteLength(out) <= 2500, `${Buffer.byteLength(out)} B`);
  assert.match(out, /brain_recall.*\(t\.jsonl\)\.$/);
  assert.match(out, /Goal/);
  assert.doesNotMatch(out, /Files edited/); // would not fit — dropped whole, not cut
  assert.ok(BUDGETS.warmBytes < 10000, 'host caps additionalContext at 10,000 characters');
});

test('reads outside the project and images are not work state', () => {
  const s = emptyState('s');
  s.cwd = '/repo';
  s.goal = 'g';
  s.files = {
    '/repo/src/a.ts': { edits: 0, reads: 1, last: 3, ranges: [] },
    '/Users/x/.claude/plugins/doc.md': { edits: 0, reads: 1, last: 2, ranges: [] },
    '/repo/shot.png': { edits: 0, reads: 1, last: 1, ranges: [] }
  };
  const out = renderWarm(s);
  assert.match(out, /Files read:\*\* src\/a\.ts$/m);
  assert.doesNotMatch(out, /plugins|shot\.png/);
});

test('snapshot is incremental: a second run reads only what was appended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
  const t = path.join(dir, 't.jsonl');
  fs.writeFileSync(t, JSON.stringify(user('first ask')) + '\n' + '{"partial":');
  const s1 = snapshot({ sessionId: 's', transcriptPath: t, dir });
  assert.equal(s1.goal, 'first ask');
  const off = s1.offset;
  fs.appendFileSync(t, '1}\n' + JSON.stringify(user('second ask')) + '\n');
  const s2 = snapshot({ sessionId: 's', transcriptPath: t, dir });
  assert.ok(s2.offset > off);
  assert.deepEqual(s2.asks, ['first ask', 'second ask']);
  // Rewritten (shorter) transcript: start over instead of reading garbage.
  fs.writeFileSync(t, JSON.stringify(user('new')) + '\n');
  assert.deepEqual(snapshot({ sessionId: 's', transcriptPath: t, dir }).asks, ['new']);
  assert.equal(snapshot({ sessionId: 's', transcriptPath: path.join(dir, 'missing'), dir }), null);
});

test('auto-compact window: opt-in only, default 300k, out-of-range refused', () => {
  assert.equal(autoCompactWindowOptIn([], {}), null);
  assert.equal(autoCompactWindowOptIn(['--auto-compact-window'], {}), 300000);
  assert.equal(autoCompactWindowOptIn(['--auto-compact-window=200000'], {}), 200000);
  assert.equal(autoCompactWindowOptIn([], { PROJECT_BRAIN_AUTO_COMPACT_WINDOW: '1' }), 300000);
  assert.equal(autoCompactWindowOptIn([], { PROJECT_BRAIN_AUTO_COMPACT_WINDOW: '0' }), null);
  assert.equal(autoCompactWindowOptIn([], { PROJECT_BRAIN_AUTO_COMPACT_WINDOW: '50000' }), null);
});

test('env merge is additive and never overwrites the developer', () => {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' };
  assert.equal(mergeEnv(env, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 300000, BRAIN_USAGE_LOG: '1' }), 1);
  assert.deepEqual(env, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', BRAIN_USAGE_LOG: '1' });
});

import { upsertCompactInstructions, COMPACT_BLOCK, COMPACT_BEGIN, COMPACT_END } from '../scripts/setup-claude-settings.mjs';

test('compact instructions: added once, refreshed in place, nothing outside touched', () => {
  const user = '# My project\n\nMy own rules.\n';
  const a = upsertCompactInstructions(user);
  assert.equal(a.status, 'added');
  assert.ok(a.text.startsWith(user));
  assert.match(a.text, /## Compact Instructions/);
  assert.equal(upsertCompactInstructions(a.text).status, 'unchanged');

  const old = a.text.replace('Keep:', 'Keep (old wording):') + '\nMore of my rules.\n';
  const b = upsertCompactInstructions(old);
  assert.equal(b.status, 'updated');
  assert.ok(b.text.startsWith(user) && b.text.endsWith('\nMore of my rules.\n'));
  assert.equal(b.text.split(COMPACT_BEGIN).length, 2, 'exactly one block');

  // A hand-damaged block (end marker deleted) is left for the human.
  const damaged = user + COMPACT_BEGIN + '\n## Compact Instructions\n';
  assert.deepEqual(upsertCompactInstructions(damaged), { text: damaged, status: 'unchanged' });
  assert.equal(upsertCompactInstructions('').text, COMPACT_BLOCK + '\n');
  assert.ok(Buffer.byteLength(COMPACT_BLOCK) < 800, 'CLAUDE.md rides along with every request');
  assert.ok(COMPACT_BLOCK.endsWith(COMPACT_END));
});

import { isBoundary, lastContextTokens, shouldNudge, nudgeText } from '../scripts/brain-warm.mjs';

test('boundaries: finished units of work, at the start of a shell segment', () => {
  for (const c of ['git commit -m "x"', 'git add -A && git commit -q -F -', 'git push -u origin feat', 'gh pr create --title t', 'gh pr merge 79 --merge', 'npm run brain:close']) {
    assert.equal(isBoundary(c), true, c);
  }
  for (const c of ['git status', 'echo "then git push"', 'git log --grep "git commit"', 'gh pr view 3', '']) {
    assert.equal(isBoundary(c), false, c);
  }
});

test('nudge: only above 150k, once per boundary, again after 50k more', () => {
  assert.equal(shouldNudge(120_000, 0), false);
  assert.equal(shouldNudge(180_000, 0), true);
  assert.equal(shouldNudge(200_000, 180_000), false);
  assert.equal(shouldNudge(231_000, 180_000), true);
  assert.equal(shouldNudge(160_000, 400_000), true, 'context shrank (compacted) and grew past the mark again');
  assert.match(nudgeText(231_000), /≈ 231k tokens/);
});

test('context size is read from the latest usage record', () => {
  const rec = (n) => ({ type: 'assistant', message: { usage: { input_tokens: 1, cache_creation_input_tokens: n, cache_read_input_tokens: 100 } } });
  assert.equal(lastContextTokens([rec(10), { type: 'user' }, rec(20), { type: 'system' }]), 121);
  assert.equal(lastContextTokens([]), 0);
});

import { explorationShaped, shouldSuggestDelegate } from '../scripts/brain-warm.mjs';

test('exploration-shaped prompts are recognised; change requests are not', () => {
  for (const p of ['wo wird der Login-Token validiert?', 'Wie funktioniert das Caching hier?', 'finde alle Stellen mit fetchUser', 'where is the rate limiter configured', 'how does the sync pipeline work', 'which files touch billing?']) {
    assert.equal(explorationShaped(p), true, p);
  }
  for (const p of ['bau den Login neu', 'fix the failing test', 'wo ist der Bug? bitte fixe ihn', 'commit and push', 'ja bitte', '']) {
    assert.equal(explorationShaped(p), false, p);
  }
});

test('delegate suggestion: only with a large context, at most once per 20 calls', () => {
  const q = 'wo wird der Token validiert?';
  assert.equal(shouldSuggestDelegate(q, 80_000, { calls: 0 }), false);
  assert.equal(shouldSuggestDelegate(q, 150_000, { calls: 5 }), true);
  assert.equal(shouldSuggestDelegate(q, 150_000, { calls: 15, delegate: { lastAtCall: 5 } }), false);
  assert.equal(shouldSuggestDelegate(q, 150_000, { calls: 25, delegate: { lastAtCall: 5 } }), true);
});

test('acceptance: an Agent call within 3 calls of a suggestion counts as followed', () => {
  const s = emptyState('s');
  s.delegate = { suggested: 1, followed: 0, openAtCall: 0 };
  foldRecords(s, [tool('a', 'Read', { file_path: '/x' }), tool('b', 'Agent', { prompt: 'find' })]);
  assert.equal(s.delegate.followed, 1);
  s.delegate.openAtCall = s.calls;
  foldRecords(s, [1, 2, 3, 4].map((i) => tool(`r${i}`, 'Read', { file_path: `/y${i}` })).concat([tool('z', 'Agent', {})]));
  assert.equal(s.delegate.followed, 1, 'too late to count');
});
