import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { foldTranscript, summarizeTrim, mergeTrim, summarizeBus, computeReceipt, forEachLine, transcriptsSince } from '../scripts/companion-receipt.mjs';
import { renderReceipt } from '../scripts/brain-companion.mjs';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ask = (ms, req, ctx, extra = {}) => JSON.stringify({ type: 'assistant', cwd: '/r/shop-app', timestamp: iso(ms), requestId: req, message: { id: `m-${req}`, usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx - 1002 } }, ...extra });
const compact = (ms, meta) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', cwd: '/r/shop-app', timestamp: iso(ms), compactMetadata: meta });

test('the fold counts each request once, skips subagents and old records, splits compactions by kind', () => {
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/r/shop-app', timestamp: iso(T0 - 10), message: { content: 'hi' } }),
    ask(T0 - 86_400_000 * 20, 'old', 900_000),
    ask(T0, 'a', 100_000),
    ask(T0 + 1, 'a', 100_000),
    ask(T0 + 2, 'b', 600_000),
    ask(T0 + 3, 'c', 300_000, { isSidechain: true }),
    compact(T0 + 4, { trigger: 'auto', preTokens: 600_000, postTokens: 50_000, precomputed: true, durationMs: 10 }),
    compact(T0 + 5, { trigger: 'auto', preTokens: 300_000, postTokens: 40_000, durationMs: 46_000 }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: true, cwd: '/r/shop-app', timestamp: iso(T0 + 6), compactMetadata: { trigger: 'auto', preTokens: 150_000, postTokens: 20_000, precomputed: true, durationMs: 5 } }),
    'not json "usage"'
  ];
  const by = foldTranscript(lines, { sinceMs: T0 - 86_400_000 });
  assert.deepEqual([...by.keys()], ['shop-app']);
  const s = summarizeTrim(by.get('shop-app'));
  assert.equal(s.requests, 2);
  assert.equal(s.sessions, 1);
  assert.equal(s.contextP50, 600_000);
  assert.equal(s.contextMax, 600_000);
  assert.equal(s.shareAbove500k, 0.857);
  assert.equal(s.compactions, 2);
  assert.equal(s.precomputedShare, 0.5);
  assert.equal(s.avgWaitSeconds, 46);
  assert.equal(s.medianWaitSeconds, 46, 'the receipt shows the median');
});

test('merge and the bus summary', () => {
  const a = foldTranscript([ask(T0, 'a', 100_000)]).get('shop-app');
  const b = foldTranscript([ask(T0, 'b', 300_000)]).get('shop-app');
  const m = summarizeTrim(mergeTrim([a, b]));
  assert.equal(m.requests, 2);
  assert.equal(m.sessions, 2);
  const bus = summarizeBus([
    { kind: 'held', at: T0 }, { kind: 'approved', at: T0, by: 'app' }, { kind: 'approved', at: T0, by: 'cli' }, { kind: 'denied', at: T0 },
    { kind: 'held-ask', at: T0 }, { kind: 'steer-delivered', at: T0 + 4000, queuedAt: T0 }, { kind: 'steer-delivered', at: T0 + 2000, queuedAt: T0 },
    { kind: 'steer-delivered', at: T0 - 99e9 }
  ], { sinceMs: T0 - 1000 });
  assert.deepEqual(bus.guard, { held: 1, approved: 2, approvedFromNotch: 1, denied: 1, handedBack: 1 });
  assert.equal(bus.steer.delivered, 2);
  assert.equal(bus.steer.medianWaitSeconds, 4);
});

test('lines stream across chunk borders, and only recent transcripts are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-lines-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'one\ntwo\nthree');
  const got = [];
  forEachLine(file, (l) => got.push(l));
  assert.deepEqual(got, ['one', 'two', 'three']);
  forEachLine(path.join(dir, 'missing.jsonl'), () => assert.fail('no lines from a missing file'));
  const old = path.join(dir, 'p', 'old.jsonl');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '');
  fs.utimesSync(old, new Date(T0 - 99e9), new Date(T0 - 99e9));
  assert.deepEqual(transcriptsSince([dir], T0).map((f) => path.basename(f)), ['a.jsonl']);
});

test('computeReceipt end to end, and the CLI prints it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-root-'));
  const now = Date.now();
  fs.mkdirSync(path.join(root, '-r-shop-app'), { recursive: true });
  fs.writeFileSync(path.join(root, '-r-shop-app', 's1.jsonl'), [ask(now - 60_000, 'a', 200_000), ask(now - 30_000, 'b', 250_000)].join('\n') + '\n');
  const rec = computeReceipt({ roots: [root], days: 14, now, windowFor: () => ({ limit: 300_000, source: 'settings' }) });
  assert.equal(rec.trim.requests, 2);
  assert.equal(rec.projects[0].project, 'shop-app');
  assert.equal(rec.projects[0].window, 300_000);
  assert.equal(rec.source.transcripts, 1);
  assert.match(renderReceipt(rec), /TRIM\s+context per request\s+median 250k/);

  const state = path.join(root, 'bus', 'state.json');
  const script = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'receipt', '--days', '3', '--write', '--json', '--roots', root, '--state', state], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).days, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'bus', 'receipt.json'), 'utf8')).trim.requests, 2);

  // as the app's Recompute and the engine's hourly refresh call it: no --days at all
  fs.rmSync(path.join(root, 'bus', 'receipt.json'));
  const plain = spawnSync(process.execPath, [script, 'receipt', '--write', '--roots', root, '--state', state], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'bus', 'receipt.json'), 'utf8')).days, 14);
});

test('an assistant turn that mentions hook_additional_context still counts as a request', () => {
  const quote = JSON.stringify({ type: 'assistant', cwd: '/r/shop-app', timestamp: iso(T0), requestId: 'q1', message: { id: 'm-q1', content: [{ type: 'text', text: 'the transcript has hook_additional_context records' }], usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 99_000 } } });
  const inj = JSON.stringify({ type: 'attachment', cwd: '/r/shop-app', timestamp: iso(T0), attachment: { type: 'hook_additional_context', content: ['Project Brain: use brain:search'], hookName: 'PreToolUse:Bash' } });
  const by = foldTranscript([ask(T0, 'a', 100_000), quote, inj]);
  const acc = by.get('shop-app');
  assert.equal(summarizeTrim(acc).requests, 2);
  assert.equal(acc.injections[0].count, 1);
});
