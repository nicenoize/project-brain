import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateDanger, dangerEmitMin, DANGER_EMIT_MIN, decisionRecord, logDecisions } from '../scripts/decision.mjs';
import { buildAnswer } from '../scripts/brain-answer.mjs';

test('gateDanger: emits only at or above the calibrated score, never on thin history', () => {
  assert.equal(gateDanger({ score: 6, lowConfidence: false }).action, 'emit');
  assert.equal(gateDanger({ score: 9.6 }).action, 'emit');
  assert.equal(gateDanger({ score: 5.9 }).action, 'log');
  assert.equal(gateDanger({ score: 8, lowConfidence: true }).action, 'log');
  assert.equal(gateDanger(null).action, 'log');
  assert.equal(gateDanger({ score: 1 }, 0).action, 'emit', 'threshold 0 restores always-warn');
});

test('dangerEmitMin: env override, garbage falls back to the calibrated default', () => {
  assert.equal(dangerEmitMin({}), DANGER_EMIT_MIN);
  assert.equal(dangerEmitMin({ BRAIN_ANSWER_DANGER_MIN: '7.5' }), 7.5);
  assert.equal(dangerEmitMin({ BRAIN_ANSWER_DANGER_MIN: '0' }), 0);
  assert.equal(dangerEmitMin({ BRAIN_ANSWER_DANGER_MIN: 'high' }), DANGER_EMIT_MIN);
  assert.equal(dangerEmitMin({ BRAIN_ANSWER_DANGER_MIN: '-1' }), DANGER_EMIT_MIN);
});

const health = (file, score, extra = {}) => ({ file, score, commits: 20, lowConfidence: false,
  factors: [{ name: 'churn', contribution: 1, evidence: 'churn p90' }], ...extra });

test('buildAnswer with a gate: a low danger score is held back and recorded, a high one shown', () => {
  const low = buildAnswer({ files: ['a.mjs'], health: [health('a.mjs', 3.2)], gate: { dangerMin: 6 } }, { budgetBytes: 700 });
  assert.ok(!low.lines.some(l => l.startsWith('danger:')), 'below the threshold → not injected');
  assert.deepEqual(low.decisions.map(d => [d.signal, d.target, d.action]), [['answer.danger', 'a.mjs', 'log']]);

  const high = buildAnswer({ files: ['a.mjs'], health: [health('a.mjs', 7.1)], gate: { dangerMin: 6 } }, { budgetBytes: 700 });
  assert.ok(high.lines.some(l => l.startsWith('danger: a.mjs 7.1/10')));
  assert.equal(high.decisions[0].action, 'emit');
});

test('buildAnswer without a gate (the CLI): everything is shown, nothing recorded', () => {
  const a = buildAnswer({ files: ['a.mjs'], health: [health('a.mjs', 3.2)] }, { budgetBytes: 700 });
  assert.ok(a.lines.some(l => l.startsWith('danger: a.mjs 3.2/10')));
  assert.deepEqual(a.decisions, []);
});

test('buildAnswer: an emitted decision the budget dropped is recorded as held back', () => {
  const pairs = [{ a: 'a.mjs', b: 'b.mjs', confidence: 0.8, together: 5 }];
  const a = buildAnswer({ files: ['a.mjs'], health: [health('a.mjs', 7)], pairs, gate: { dangerMin: 6 } }, { budgetBytes: 40 });
  const partner = a.decisions.find(d => d.signal === 'answer.partner');
  assert.ok(!a.sections.partners, 'the budget dropped the co-change section');
  assert.equal(partner.action, 'log');
  assert.match(partner.reason, /dropped by budget/);
});

test('logDecisions: appends records, silent under the test runner unless forced, off with 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-decisions-'));
  const log = path.join(dir, '.decisions.jsonl');
  const rec = decisionRecord({ signal: 'answer.danger', target: 'a.mjs', value: 7, action: 'emit', threshold: 6, ts: '2026-09-23T00:00:00Z' });
  assert.equal(logDecisions([rec], log, { NODE_TEST_CONTEXT: 'child' }), 0);
  assert.equal(logDecisions([rec], log, { BRAIN_DECISION_LOG: '0' }), 0);
  assert.equal(logDecisions([rec, rec], log, { BRAIN_DECISION_LOG: '1' }), 2);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines[0], { ts: '2026-09-23T00:00:00Z', signal: 'answer.danger', target: 'a.mjs', value: 7,
    action: 'emit', threshold: 6, reason: '', session: '' });
});
