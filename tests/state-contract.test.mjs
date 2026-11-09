// The state file is the contract between the engine and every shell (ADR 0036).
// This test has the real engine write a rich state (a session with a
// compaction and a hook injection, a hold, a held edit, events, a receipt)
// and compares its SHAPE with companion/Tests/Fixtures/engine-state.json —
// the file `swift run leanlamp-selftest` decodes. A renamed or retyped field
// fails here first; after regenerating the fixture the Swift self-test says
// whether the app still reads it.
//
//   UPDATE_STATE_FIXTURE=1 node --test tests/state-contract.test.mjs   (then: swift run leanlamp-selftest)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../scripts/brain-companion.mjs';
import { addHold, createPending, appendEvent } from '../scripts/companion-bus.mjs';
import { computeReceipt, receiptPath } from '../scripts/companion-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'companion', 'Tests', 'Fixtures', 'engine-state.json');
const SID = '5e55e55e-0000-4000-8000-00000000c0de';

function richState() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'state-contract-'));
  const root = path.join(home, 'projects');
  const dir = path.join(home, 'bus');
  fs.mkdirSync(path.join(root, '-work-acme'), { recursive: true });
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const base = { sessionId: SID, cwd: '/work/acme', version: '2.1.308', gitBranch: 'split-invoices' };
  const usage = (ctx) => ({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: ctx - 1002, output_tokens: 40 });
  const lines = [
    { ...base, type: 'user', timestamp: at(60_000), uuid: 'u1', message: { role: 'user', content: 'Split invoices without touching the public API' } },
    { ...base, type: 'assistant', timestamp: at(50_000), requestId: 'r1', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], usage: usage(240_000) } },
    { ...base, type: 'attachment', timestamp: at(45_000), uuid: 'x1', attachment: { type: 'hook_additional_context', content: ['Project Brain: run brain:search before editing billing'], hookName: 'PreToolUse:Bash', toolUseID: 't1' } },
    { ...base, type: 'system', subtype: 'compact_boundary', timestamp: at(40_000), uuid: 's1', compactMetadata: { trigger: 'auto', preTokens: 290_000, postTokens: 60_000, durationMs: 9000 } },
    { ...base, type: 'attachment', timestamp: at(39_000), uuid: 'x2', attachment: { type: 'hook_additional_context', content: ['## Brain: session state after compaction #1 (290k → 60k)\n- goal: split invoices'], hookName: 'SessionStart' } },
    { ...base, type: 'attachment', timestamp: at(31_000), uuid: 'x3', attachment: { type: 'hook_additional_context', content: ['Project Brain (ambient, deterministic) — before you edit:\n- src/billing/invoice.ts danger 6/10'], hookName: 'PreToolUse:Edit', toolUseID: 't2' } },
    { ...base, type: 'assistant', timestamp: at(30_000), requestId: 'r2', uuid: 'a2', message: { id: 'm2', role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/work/acme/src/billing/invoice.ts' } }], usage: usage(80_000) } }
  ];
  fs.writeFileSync(path.join(root, '-work-acme', `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  addHold(dir, { glob: 'src/billing/**', root: '/work/acme', minutes: 30, now });
  createPending(dir, { session: SID, cwd: '/work/acme', tool: 'Edit', file: '/work/acme/src/billing/invoice.ts', hold: 'h', glob: 'src/billing/**', root: '/work/acme', deadline: now + 40_000 });
  appendEvent(dir, { kind: 'steer-delivered', session: SID, id: 'n1', text: 'keep ROUND_HALF_EVEN', tool: 'Bash', queuedAt: now - 2000 });
  appendEvent(dir, { kind: 'approved', session: SID, id: 'p0', file: '/work/acme/src/billing/tax.ts', by: 'app' });
  fs.writeFileSync(receiptPath(dir), JSON.stringify(computeReceipt({ roots: [root], days: 14, now, windowFor: () => ({ limit: 300_000, source: 'settings' }) })));

  const state = createEngine({ roots: [root], dir }).collect({ machine: true, full: true });
  state.engine.statePath = path.join(dir, 'state.json');
  return state;
}

/** Key paths with value types; an array by the union of its elements (order does not matter); null fits any type. */
function shape(v, at = '$', out = new Map()) {
  const put = (t) => { if (!out.has(at) || out.get(at) === 'null') out.set(at, t); };
  if (v === null || v === undefined) { put('null'); return out; }
  if (Array.isArray(v)) { put('array'); for (const x of v) shape(x, `${at}[]`, out); return out; }
  if (typeof v === 'object') { put('object'); for (const k of Object.keys(v)) shape(v[k], `${at}.${k}`, out); return out; }
  put(typeof v);
  return out;
}

/**
 * The fixture ships with the code: no temp-folder ids, no numbers from the
 * machine that generated it. Same types, so the shape is unchanged.
 */
function neutral(state) {
  const tmp = path.dirname(path.dirname(state.engine.statePath));
  const text = JSON.stringify(state).split(tmp).join('/tmp/state-contract');
  const s = JSON.parse(text);
  s.engine.pid = 4242;
  const fake = { totalGb: 16, freePct: 40, pressure: 'normal', swapUsedGb: 0.5, agentProcesses: 3, agentRssGb: 0.9, orphans: 0, orphanMb: 0 };
  for (const k of Object.keys(s.machine || {})) if (k in fake && s.machine[k] !== null) s.machine[k] = fake[k];
  return s;
}

/** Paths whose keys come from data (project names, sources), not from the contract. */
const DATA_KEYED = [/\.bySource\.[^.]+/, /\.counts\./];
const comparable = (p) => !DATA_KEYED.some((re) => re.test(p));

test('the engine writes the state shape the app was last checked against', () => {
  const fresh = richState();
  if (process.env.UPDATE_STATE_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(neutral(fresh), null, 2) + '\n');
  }
  assert.ok(fs.existsSync(FIXTURE), `no fixture yet: UPDATE_STATE_FIXTURE=1 node --test ${path.relative(ROOT, fileURLToPath(import.meta.url))}`);
  const want = shape(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
  const got = shape(fresh);
  const drift = [];
  for (const [p, t] of got) if (comparable(p) && want.has(p) && want.get(p) !== t && t !== 'null' && want.get(p) !== 'null') drift.push(`${p}: ${want.get(p)} → ${t}`);
  for (const p of got.keys()) if (comparable(p) && !want.has(p)) drift.push(`new: ${p}`);
  for (const p of want.keys()) if (comparable(p) && !got.has(p)) drift.push(`gone: ${p}`);
  assert.deepEqual(drift, [], 'the state file changed shape — regenerate the fixture (UPDATE_STATE_FIXTURE=1) and run `swift run leanlamp-selftest` to see whether the app still reads it');
});

test('the rich state really carries every part the app shows', () => {
  const s = richState();
  assert.equal(s.sessions.length, 1);
  const x = s.sessions[0];
  assert.ok(x.ctx > 0 && x.limit > 0 && x.lastCompaction && x.injections && x.format);
  assert.deepEqual(Object.keys(x.injections.byKind).sort(), ['answer', 'hint', 'state'], 'all three kinds of injection');
  assert.equal(x.injections.byKind.hint.actionable, 1, 'only the hint is scored');
  assert.equal(x.injections.byKind.answer.actionable, 0);
  assert.equal(s.pending.length, 1);
  assert.equal(s.holds.length, 1);
  assert.ok(s.events.length >= 2);
  assert.ok(s.receipt && s.receipt.trim && s.format && s.machine);
});
