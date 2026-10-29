import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { terms, similarity, entryFrom, ingest, loadEntries, search, decide, libDir } from '../scripts/brain-mobbin.mjs';

const NAME = 'mcp__claude_ai_Mobbin__search_screens';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobbin-'));
  const proj = path.join(home, 'projects', '-Users-me-notar');
  fs.mkdirSync(path.join(proj, 's1', 'tool-results'), { recursive: true });
  const img = path.join(proj, 's1', 'tool-results', 'mcp-claude_ai_Mobbin-blob-1.webp');
  fs.writeFileSync(img, 'RIFF');
  const body = { query: 'required documents checklist screen in a mortgage app', screens: [{ id: 'sc1', app_name: 'Wise', mobbin_url: 'https://mobbin.com/screens/sc1', platform: 'ios' }] };
  const lines = [
    { type: 'assistant', timestamp: '2026-10-26T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: NAME, input: { platform: 'ios', query: body.query, limit: 8 } }] } },
    { type: 'user', timestamp: '2026-10-26T10:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
      { type: 'image', source: { type: 'base64', data: 'x' } },
      { type: 'text', text: `[Image: source: ${img}]` },
      { type: 'text', text: JSON.stringify(body) }
    ] }] } }
  ];
  const file = path.join(proj, 's1.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { env: { BRAIN_HOME: path.join(home, 'bh'), BRAIN_MOBBIN_TRANSCRIPTS: path.join(home, 'projects') }, file };
}

test('terms and similarity: the same question in other words is close, a different one is not', () => {
  assert.deepEqual(terms('Required documents checklist screen in a mortgage app'), ['required', 'document', 'checklist', 'mortgage']);
  assert.equal(similarity('documents checklist for a mortgage', 'required documents checklist screen in a mortgage app'), 0.75);
  assert.ok(similarity('identity verification with ID document scan', 'task inbox with due dates') < 0.1);
});

test('entryFrom keeps the query, the apps with their links and the screenshot paths', () => {
  const e = entryFrom({ id: 'tu', name: NAME, input: { platform: 'ios', query: 'q' } }, { content: [
    { type: 'text', text: '[Image: source: /x/a.webp]' },
    { type: 'text', text: JSON.stringify({ flows: [{ id: 'f', name: 'Verifying identity', app_name: 'Chime', mobbin_url: 'u', screen_count: 13 }] }) }
  ] });
  assert.equal(e.tool, 'search_screens');
  assert.deepEqual(e.items, [{ id: 'f', name: 'Verifying identity', app: 'Chime', url: 'u', screens: 13 }]);
  assert.deepEqual(e.sources, ['/x/a.webp']);
  assert.equal(entryFrom({ id: 't', name: NAME, input: {} }, { is_error: true, content: [{ type: 'text', text: '{}' }] }), null);
});

test('ingest reads each transcript once, copies the screenshots, and picks up only what was appended', () => {
  const { env, file } = fixture();
  assert.equal(ingest({ env }).length, 1);
  const [e] = loadEntries(env);
  assert.equal(e.project, 'notar');
  assert.ok(fs.existsSync(e.images[0]) && e.images[0].startsWith(libDir(env)));
  assert.equal(ingest({ env }).length, 0, 'nothing new');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi mobbin' } }) + '\n');
  assert.equal(ingest({ env }).length, 0);
  assert.equal(search(loadEntries(env), 'mortgage documents checklist')[0].entry.id, 'tu1');
});

test('decide: a close search is answered locally once; the same call again goes to Mobbin', () => {
  const { env } = fixture();
  ingest({ env });
  const payload = { session_id: 's', tool_name: NAME, tool_input: { platform: 'ios', query: 'documents checklist for a mortgage' } };
  const out = decide(payload, { env, now: 1000 });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Wise — https:\/\/mobbin.com\/screens\/sc1/);
  assert.equal(decide(payload, { env, now: 2000 }), null, 'the repeat goes through');
  assert.equal(decide({ ...payload, tool_input: { platform: 'android', query: payload.tool_input.query } }, { env }), null, 'other platform');
  assert.equal(decide({ ...payload, tool_input: { query: 'music player lyrics' } }, { env }), null, 'nothing close');
  assert.equal(decide({ ...payload, tool_name: 'mcp__claude_ai_Mobbin__save_content' }, { env }), null, 'only searches');
  assert.equal(decide(payload, { env: { ...env, BRAIN_MOBBIN_LOCAL: '0' } }), null, 'switch off');
});
