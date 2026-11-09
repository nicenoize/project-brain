import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContent,
  projectSlug,
  emptyReport,
  addTranscript,
  summarize
} from '../scripts/brain-tokens.mjs';

test('projectSlug mirrors Claude Code: every non-alphanumeric becomes "-"', () => {
  assert.equal(projectSlug('/Users/a/Coding/project-brain'), '-Users-a-Coding-project-brain');
  assert.equal(projectSlug('/Users/a/.superset/worktrees/x'), '-Users-a--superset-worktrees-x');
});

test('classifyContent recognises the shapes a coding agent actually reads', () => {
  assert.equal(classifyContent('{"a":1,"b":[1,2]}'), 'json');
  assert.equal(classifyContent('<html><body><div>x</div></body></html>'), 'html');
  assert.equal(classifyContent('src/a.ts:12:  const x = 1\nsrc/b.ts:40:  return y\nsrc/c.ts:7:import z'), 'search');
  assert.equal(classifyContent('diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-old line\n+new line'), 'diff');
  assert.equal(classifyContent('✔ parses input (1.2ms)\n✔ rejects junk (0.4ms)\nℹ tests 2\nℹ pass 2'), 'log');
  assert.equal(classifyContent('2026-10-12T10:00:01Z INFO start\n2026-10-12T10:00:02Z WARN slow'), 'log');
  // SQL, test bodies and Read's gutter all count as code — keyword lists missed these.
  assert.equal(classifyContent('-- migration\nCREATE TABLE t (\n  id int primary key\n);'), 'code');
  assert.equal(classifyContent("    it.each([\n      ['en', en],\n    ])('%s', (_n, d) => {\n      expect(d).toBe(1)\n    })"), 'code');
  assert.equal(classifyContent('     1\tconst a = 1;\n     2\tconst b = a + 1;'), 'code');
  assert.equal(classifyContent('The quick brown fox jumps over the lazy dog.\nIt was a fine day.'), 'prose');
  assert.equal(classifyContent(''), 'prose');
});

function assistant(requestId, usage, content = []) {
  return { type: 'assistant', requestId, timestamp: '2026-10-12T10:00:00Z', message: { id: requestId, usage, content } };
}
function toolResult(id, content) {
  return { type: 'user', timestamp: '2026-10-12T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } };
}

test('usage is counted once per request, not once per content-block record', () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
  const records = [
    assistant('req_1', usage, [{ type: 'thinking' }]),
    assistant('req_1', usage, [{ type: 'text', text: 'hi' }]),
    assistant('req_1', usage, [{ type: 'tool_use', id: 'tu_1', name: 'Bash' }])
  ];
  const s = summarize(addTranscript(emptyReport(), records));
  assert.equal(s.requests, 1);
  assert.deepEqual(
    { input: s.usage.input, cacheWrite: s.usage.cacheWrite, cacheRead: s.usage.cacheRead, output: s.usage.output },
    { input: 10, cacheWrite: 100, cacheRead: 1000, output: 5 }
  );
  assert.equal(s.cacheHitRatio, Math.round((1000 / 1110) * 1000) / 1000);
  assert.equal(s.context.p50, 1110);
});

test('tool output is attributed to the tool that produced it and split by kind', () => {
  const records = [
    assistant('r1', { input_tokens: 1, output_tokens: 1 }, [
      { type: 'tool_use', id: 'a', name: 'Bash' },
      { type: 'tool_use', id: 'b', name: 'Read' }
    ]),
    toolResult('a', '{"k":"' + 'x'.repeat(396) + '"}'), // 404 chars of json
    toolResult('b', [{ type: 'text', text: 'plain words only here' }])
  ];
  const s = summarize(addTranscript(emptyReport(), records));
  const bash = s.tools.find((t) => t.name === 'Bash');
  const read = s.tools.find((t) => t.name === 'Read');
  assert.equal(bash.dominantKind, 'json');
  assert.equal(bash.compressibleShare, 1);
  assert.equal(read.dominantKind, 'prose');
  assert.equal(read.compressibleShare, 0);
  assert.equal(s.toolOutput.byKind.json, 101);
});

test('records older than the window are ignored; empty transcripts add no session', () => {
  const old = { ...assistant('old', { input_tokens: 999 }), timestamp: '2020-01-01T00:00:00Z' };
  const r = addTranscript(emptyReport(), [old], { sinceMs: Date.parse('2026-01-01') });
  assert.equal(r.requests, 0);
  assert.equal(r.sessions, 0);
});

import { proxyVerdict } from '../scripts/brain-tokens.mjs';

test('proxy verdict is a range over what requests re-read, not once-counted output', () => {
  const v = (reread) => proxyVerdict({ reread });
  const fleet = v({ other: 0.52, code: 0.318, prose: 0.068, html: 0.058, search: 0.019, log: 0.006, json: 0.005, diff: 0.005 });
  assert.equal(fleet.worth, true, 'the measured fleet: worth an A/B');
  assert.ok(fleet.low > 0.08 && fleet.low < 0.11, String(fleet.low));
  assert.ok(fleet.high > 0.24 && fleet.high < 0.28, String(fleet.high));
  assert.equal(v({ other: 0.9, prose: 0.1 }).worth, false);
  assert.equal(v({}).worth, false);
});

test('re-read weighting: output counts once per later request, and compaction resets it', () => {
  const req = (id) => ({ type: 'assistant', requestId: id, timestamp: '2026-10-12T10:00:00Z', message: { id, usage: { input_tokens: 1 }, content: [] } });
  const res = { type: 'user', timestamp: '2026-10-12T10:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"a":1}' }] } };
  const s = summarize(addTranscript(emptyReport(), [res, req('1'), req('2'), { type: 'system', subtype: 'compact_boundary' }, req('3')]));
  assert.equal(s.reread.json, 1, 'only json was live, read by two requests, then compacted away');
});

import { readTarget, editFailureReason, foldLoss, REREAD_WINDOW_CALLS } from '../scripts/brain-tokens.mjs';

test('readTarget: Read and shell reads (cat/head/sed -n/nl) name their file', () => {
  assert.equal(readTarget('Read', { file_path: '/r/a.ts' }), '/r/a.ts');
  assert.equal(readTarget('Bash', { command: "sed -n '1,80p' scripts/brain-ps.mjs" }), 'scripts/brain-ps.mjs');
  assert.equal(readTarget('Bash', { command: 'cd x && cat src/app.tsx | head -20' }), 'src/app.tsx');
  assert.equal(readTarget('Bash', { command: 'head -n 40 README.md' }), 'README.md');
  assert.equal(readTarget('Bash', { command: 'npm test' }), null);
  assert.equal(readTarget('Edit', { file_path: '/r/a.ts' }), null);
});

test('edit failures: content failures apart from blocks and bad input', () => {
  assert.equal(editFailureReason('<tool_use_error>String to replace not found in file.'), 'no-match');
  assert.equal(editFailureReason('File has been modified since read'), 'stale');
  assert.equal(editFailureReason('Found 2 matches of the string to replace, but replace_all is false.'), 'ambiguous');
  assert.equal(editFailureReason('The server-side auto mode classifier gave no verdict'), 'blocked');
  assert.equal(editFailureReason('Subagents should return findings as text, not write report files.'), 'blocked');
  assert.equal(editFailureReason('InputValidationError: The required parameter `new_string` is missing'), 'invalid-input');
});

test('loss guards: re-reads after a compaction count only for files read before it', () => {
  const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, content, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  const rep = { loss: { compactions: 0, droppedTokens: 0, rereadCalls: 0, rereadChars: 0 }, edits: { total: 0, failed: 0, reasons: {} } };
  foldLoss(rep, [
    call('a', 'Read', { file_path: '/r/a.ts' }), res('a', 'x'.repeat(400)),
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 300000, postTokens: 30000 } },
    call('b', 'Bash', { command: 'cat /r/a.ts' }), res('b', 'y'.repeat(800)), // re-read: known before
    call('c', 'Read', { file_path: '/r/new.ts' }), res('c', 'z'.repeat(800)), // first read: not a re-read
    call('d', 'Edit', { file_path: '/r/a.ts' }), res('d', 'String to replace not found in file.', true),
    call('e', 'Edit', { file_path: '/r/a.ts' }), res('e', 'ok')
  ]);
  assert.deepEqual(rep.loss, { compactions: 1, droppedTokens: 270000, rereadCalls: 1, rereadChars: 800 });
  assert.deepEqual(rep.edits, { total: 2, failed: 1, reasons: { 'no-match': 1 } });
  // Outside the window of 50 calls, a re-read no longer counts against the compaction.
  const rep2 = { loss: { compactions: 0, droppedTokens: 0, rereadCalls: 0, rereadChars: 0 }, edits: { total: 0, failed: 0, reasons: {} } };
  const filler = Array.from({ length: REREAD_WINDOW_CALLS + 1 }, (_, i) => call(`f${i}`, 'Bash', { command: 'ls' }));
  foldLoss(rep2, [call('a', 'Read', { file_path: '/r/a.ts' }), { type: 'system', subtype: 'compact_boundary', compactMetadata: {} }, ...filler, call('z', 'Read', { file_path: '/r/a.ts' }), res('z', 'late')]);
  assert.equal(rep2.loss.rereadCalls, 0);
});

function at(rec, iso) { return { ...rec, timestamp: iso }; }
const boundary = (iso, meta = {}) => ({ type: 'system', subtype: 'compact_boundary', timestamp: iso, compactMetadata: { trigger: 'auto', preTokens: 300_000, postTokens: 50_000, ...meta } });

test('addTranscript: untilMs closes the window; earlier records still set the clocks', async () => {
  const { addTranscript: add, emptyReport: empty, summarize: sum } = await import('../scripts/brain-tokens.mjs');
  const u = (cw) => ({ input_tokens: 1, cache_creation_input_tokens: cw, cache_read_input_tokens: 100, output_tokens: 1 });
  const records = [
    at(assistant('a', u(10)), '2026-10-01T10:00:00Z'),
    at(assistant('b', u(20)), '2026-10-02T10:00:00Z'),
    at(assistant('c', u(40)), '2026-10-03T10:00:00Z')
  ];
  const s = sum(add(empty(), records, { sinceMs: Date.parse('2026-10-02T00:00:00Z'), untilMs: Date.parse('2026-10-03T00:00:00Z') }));
  assert.equal(s.requests, 1);
  assert.equal(s.usage.cacheWrite, 20);
  // 'b' follows 'a' by a day: the cache had expired, so its write counts as after a pause.
  assert.equal(s.writes.afterPause, 20);
});

test('cache writes are attributed to their cause: compaction, pause, new content', async () => {
  const { addTranscript: add, emptyReport: empty, summarize: sum } = await import('../scripts/brain-tokens.mjs');
  const u = (cw) => ({ input_tokens: 0, cache_creation_input_tokens: cw, cache_read_input_tokens: 0, output_tokens: 0 });
  const records = [
    at(assistant('r1', u(1000)), '2026-10-12T10:00:00Z'),
    boundary('2026-10-12T10:01:00Z', { precomputed: true, durationMs: 10 }),
    at(assistant('r2', u(50_000)), '2026-10-12T10:01:05Z'),
    at(assistant('r3', u(300)), '2026-10-12T10:02:00Z'),
    at(assistant('r4', u(60_000)), '2026-10-12T12:00:00Z')
  ];
  const s = sum(add(empty(), records));
  assert.equal(s.requests, 4);
  assert.deepEqual(
    { c: s.writes.afterCompaction * 4, p: s.writes.afterPause * 4, n: s.writes.steady * 4 },
    { c: 50_000, p: 60_000, n: 1300 }
  );
  assert.equal(s.compaction.count, 1);
  assert.equal(s.compaction.precomputedShare, 1);
  assert.equal(s.compaction.avgWaitSeconds, 0.01);
});

test('cost per request weighs usage by list-price ratios', async () => {
  const { addTranscript: add, emptyReport: empty, summarize: sum, COST_WEIGHTS } = await import('../scripts/brain-tokens.mjs');
  assert.deepEqual({ ...COST_WEIGHTS }, { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 5 });
  const s = sum(add(empty(), [assistant('x', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 })]));
  // 10 + 0.1·1000 + 2·100 + 5·20 = 410; input side drops the 100 of output.
  assert.equal(s.cost.perRequest, 410);
  assert.equal(s.cost.inputSidePerRequest, 310);
  assert.equal(s.context.mean, 1110);
});

test('compareSummaries: relative deltas for amounts, points for shares, unknown stays unknown', async () => {
  const { addTranscript: add, emptyReport: empty, summarize: sum, compareSummaries } = await import('../scripts/brain-tokens.mjs');
  const big = sum(add(empty(), [assistant('b', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 600_000, output_tokens: 0 })]));
  const small = sum(add(empty(), [assistant('s', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 300_000, output_tokens: 0 })]));
  const rows = Object.fromEntries(compareSummaries(big, small).map((r) => [r.key, r]));
  assert.equal(rows.ctxMean.delta, -0.5);
  assert.equal(rows.ctxMean.better, true);
  assert.equal(rows.over500k.delta, -1, 'a share moves by points: 100 % → 0 %');
  assert.equal(rows.requests.delta, null, 'window lengths differ, so request counts get no delta');
  assert.equal(rows.compactionWait.before, null);
  assert.equal(rows.compactionWait.delta, null);
});

test('--compare --until closes the after window, so a published comparison stays reproducible', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-until-'));
  fs.mkdirSync(path.join(root, '-r-app'));
  const rec = (iso, id) => JSON.stringify({ type: 'assistant', timestamp: iso, requestId: id, message: { id, usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 10 } } });
  fs.writeFileSync(path.join(root, '-r-app', 's.jsonl'), [rec('2026-10-10T10:00:00Z', 'a'), rec('2026-10-14T10:00:00Z', 'b'), rec('2026-10-25T10:00:00Z', 'c')].join('\n') + '\n');
  const script = fileURLToPath(new URL('../scripts/brain-tokens.mjs', import.meta.url));
  const run = (...extra) => {
    const r = spawnSync(process.execPath, [script, '--compare', '2026-10-12', '--all-projects', '--root', root, '--json', ...extra], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(run().after.requests, 2, 'open-ended: everything since the cut');
  const fixed = run('--until', '2026-10-21');
  assert.equal(fixed.after.requests, 1, 'the request after --until is left out');
  assert.match(fixed.scope, /until 2026-10-21/);
  const bad = spawnSync(process.execPath, [script, '--compare', '2026-10-12', '--until', '2026-10-01', '--root', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1, '--until before the cut is refused');
});
