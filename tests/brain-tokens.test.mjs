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
