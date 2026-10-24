// What fills the context: the base measured at the first request, the parts
// estimated from the transcript and scaled to the real remainder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextMap, kindOf, labelOf } from '../scripts/context-map.mjs';

const usage = (ctx) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: 10 });
const text = (n) => 'x'.repeat(n);

function session() {
  const m = createContextMap();
  m.feed({ type: 'user', message: { role: 'user', content: text(400) } }); // 100 est
  m.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test -- billing' } }], usage: usage(60_100) } });
  m.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: text(80_000) }] } }); // 20k est
  m.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/acme/src/billing/invoice.ts' } }] } });
  m.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: text(20_000) }] }] } }); // 5k est
  m.feed({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text(400)], hookName: 'PreToolUse:Edit' } });
  m.feed({ type: 'user', isSidechain: true, message: { content: text(99_999) } }); // a subagent's: not in this context
  return m;
}

test('the base is measured at the first request; the parts are scaled to the rest', () => {
  const snap = session().snapshot(110_000);
  assert.equal(snap.base, 60_000, 'first context 60,100 minus the 100 the prompt shows');
  const by = Object.fromEntries(snap.parts.map((p) => [p.kind, p.tokens]));
  // estimated: bash 20,000, read 5,000, you 100, assistant ~11, hooks 100 → scaled to 50,000
  assert.ok(snap.scale > 1.9 && snap.scale < 2.0, `scale ${snap.scale}`);
  assert.ok(Math.abs(by.bash - 20_000 * snap.scale) < 2);
  assert.equal(by.base, 60_000);
  assert.equal(snap.parts[0].kind, 'base', 'biggest first');
  assert.equal(snap.top[0].label, 'npm test -- billing');
  assert.equal(snap.top[1].label, 'billing/invoice.ts');
  assert.equal(snap.since, 'start');
});

test('a compaction starts the map over with its summary; the base stays', () => {
  const m = session();
  m.feed({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 110_000, postTokens: 9_000 } });
  m.feed({ type: 'user', message: { content: text(4_000) } });
  const snap = m.snapshot(70_000);
  assert.equal(snap.since, 'compaction');
  assert.deepEqual(snap.parts.map((p) => p.kind).sort(), ['base', 'summary', 'you']);
  assert.equal(snap.parts.find((p) => p.kind === 'summary').tokens, 9_000, 'the summary is measured: never scaled');
  assert.equal(snap.top.length, 0);
});

test('without a measured base, or with a factor that makes no sense, the estimates stay raw', () => {
  const m = createContextMap();
  m.feed({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 5_000 } }); // the tail starts after a compaction
  m.feed({ type: 'assistant', message: { content: [{ type: 'text', text: text(8_000) }], usage: usage(30_000) } });
  const snap = m.snapshot(30_000);
  assert.equal(snap.base, null);
  assert.equal(snap.scale, 1);
  const off = session().snapshot(1_000_000); // (1M − 60k) / 25k ≫ 4
  assert.equal(off.scale, 1);
});

test('kinds and labels', () => {
  assert.equal(kindOf('Read'), 'read');
  assert.equal(kindOf('Grep'), 'search');
  assert.equal(kindOf('mcp__project-brain__brain_recall'), 'mcp');
  assert.equal(kindOf('TodoWrite'), 'tools');
  assert.equal(labelOf('Bash', { command: 'npm   test\n-- billing' }), 'npm test -- billing');
  assert.equal(labelOf('mcp__x__search', {}), 'x search');
});
