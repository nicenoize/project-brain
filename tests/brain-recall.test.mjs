import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseQuery, createMatcher, renderRecall, recall, callText, resolveTranscript } from '../scripts/brain-recall.mjs';

const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const boundary = { type: 'system', subtype: 'compact_boundary' };

test('parseQuery: lowercase terms, quoted phrases stay whole, 1-char noise dropped', () => {
  assert.deepEqual(parseQuery('Login "rate limit" x 429'), ['login', 'rate limit', '429']);
  assert.deepEqual(parseQuery(''), []);
});

test('all terms must match; more recent hits rank first; compacted hits are labelled', () => {
  const m = createMatcher('timeout redis');
  for (const r of [
    call('a', 'Bash', { command: 'redis-cli ping' }),
    result('a', 'Error: connect timeout to redis at 6379'),
    boundary,
    call('b', 'Read', { file_path: '/r/cache.ts' }),
    result('b', 'const REDIS_TIMEOUT = 500 // redis timeout in ms'),
    result('zz', 'timeout only')
  ]) m.feed(r);
  const res = m.results();
  assert.equal(res.total, 2);
  assert.equal(res.compactions, 1);
  assert.equal(res.hits[0].tool, 'Read');
  assert.equal(res.hits[0].compacted, false);
  assert.equal(res.hits[1].tool, 'Bash');
  assert.equal(res.hits[1].compacted, true);
  assert.match(renderRecall(res), /call #1 · result of Bash · before a compaction/);
});

test('a recall never finds itself', () => {
  const m = createMatcher('needle');
  m.feed(call('r', 'Bash', { command: 'npm run brain:recall -- "needle"' }));
  m.feed(result('r', 'recall: 1 match for "needle"'));
  m.feed(call('s', 'mcp__project-brain__brain_recall', { query: 'needle' }));
  assert.equal(m.results().total, 0);
});

test('calls are searched as written: the command, the path and its new text', () => {
  assert.equal(callText('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(callText('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }), '/a.ts\ny');
  assert.equal(callText('Other', { a: 1 }), '{"a":1}');
});

test('render keeps whole hits inside the byte budget', () => {
  const m = createMatcher('big');
  for (let i = 0; i < 10; i++) m.feed(result(`t${i}`, 'big '.repeat(500)));
  const out = renderRecall(m.results(), { budgetBytes: 1500 });
  assert.ok(Buffer.byteLength(out) <= 1500);
  assert.match(out, /^recall: 10 matches/);
});

test('streams a real file; resolves only transcripts of this project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
  const dir = path.join(root, '-repo');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(file, [call('a', 'Bash', { command: 'make deploy' }), result('a', 'deploy failed: quota')].map((r) => JSON.stringify(r)).join('\n') + '\n{torn');
  const res = await recall('quota', { file });
  assert.equal(res.total, 1);
  assert.equal(resolveTranscript(null, { root, cwd: '/repo' }), file);
  assert.equal(resolveTranscript('abc', { root, cwd: '/repo' }), file);
  assert.equal(resolveTranscript('../../etc/passwd', { root, cwd: '/repo' }), null);
  assert.equal(resolveTranscript(null, { root, cwd: '/elsewhere' }), null);
});
