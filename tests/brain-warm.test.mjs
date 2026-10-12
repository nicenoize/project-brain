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
  assert.match(out, /grep -n '<term>' \/t\.jsonl$/);
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
