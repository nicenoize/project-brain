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

test('proxy verdict: only a real, mostly-compressible tool-output share pays', () => {
  const s = (fresh, tool, comp) => ({ usage: { freshInput: fresh }, toolOutput: { estTokens: tool, compressibleShare: comp } });
  assert.equal(proxyVerdict(s(280e6, 31e6, 0.17)).worth, false, 'the measured fleet: 11 % / 17 %');
  assert.equal(proxyVerdict(s(100e6, 40e6, 0.6)).worth, true, 'a log-heavy repo');
  assert.equal(proxyVerdict(s(100e6, 40e6, 0.2)).worth, false);
  assert.equal(proxyVerdict(s(0, 0, 0)).worth, false);
});
