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

import { calibrateDecisions, valueBins } from '../scripts/decision.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const dec = (signal, target, action, value, session, at = T0) =>
  ({ ts: iso(at), signal, target, value, action, threshold: 6, reason: '', session });
const commit = (at, subject, files) => ({ dateIso: iso(at), subject, files });

test('calibrateDecisions: danger counts a LATER fix, not the change being made', () => {
  const decisions = [dec('answer.danger', 'a.mjs', 'emit', 8, 's1'), dec('answer.danger', 'b.mjs', 'emit', 8, 's1')];
  const commits = [
    commit(T0 + 1 * DAY, 'fix: the bug the agent was fixing', ['a.mjs']),   // the edit itself
    commit(T0 + 1 * DAY, 'feat: something', ['b.mjs']),                     // the edit itself
    commit(T0 + 3 * DAY, 'fix: it broke again', ['b.mjs'])                  // a later fix
  ];
  const [danger] = calibrateDecisions(decisions, commits, { now: T0 + 30 * DAY, minN: 1 });
  assert.equal(danger.emitted.n, 2);
  assert.equal(danger.emitted.hits, 1, 'only b.mjs needed a later fix');
});

test('calibrateDecisions: one call per (signal, target, session); pending until the horizon passes', () => {
  const decisions = [
    dec('answer.danger', 'a.mjs', 'emit', 8, 's1'),
    dec('answer.danger', 'a.mjs', 'emit', 8, 's1', T0 + 1000),            // same session → same call
    dec('answer.danger', 'c.mjs', 'log', 3, 's2', T0 + 29 * DAY)           // horizon not over at now
  ];
  const [danger] = calibrateDecisions(decisions, [], { now: T0 + 30 * DAY, minN: 1 });
  assert.equal(danger.emitted.n, 1);
  assert.equal(danger.held.n, 0);
  assert.equal(danger.pending, 1);
});

test('calibrateDecisions: separates when emitted are right more often than held back', () => {
  const decisions = [];
  const commits = [];
  for (let i = 0; i < 10; i++) {
    decisions.push(dec('answer.danger', `hot${i}.mjs`, 'emit', 8, `s${i}`));
    commits.push(commit(T0 + DAY, 'feat: edit', [`hot${i}.mjs`]));
    if (i < 6) commits.push(commit(T0 + 2 * DAY, 'fix: again', [`hot${i}.mjs`]));
    decisions.push(dec('answer.danger', `cold${i}.mjs`, 'log', 2, `s${i}`));
    commits.push(commit(T0 + DAY, 'feat: edit', [`cold${i}.mjs`]));
    if (i < 1) commits.push(commit(T0 + 2 * DAY, 'fix: once', [`cold${i}.mjs`]));
  }
  const [danger] = calibrateDecisions(decisions, commits, { now: T0 + 30 * DAY });
  assert.equal(danger.emitted.rate, 0.6);
  assert.equal(danger.held.rate, 0.1);
  assert.ok(Math.abs(danger.lift - 6) < 1e-9);
  assert.match(danger.verdict, /separates/);
});

test('calibrateDecisions: an ungated signal says so and yields value bins', () => {
  const decisions = [];
  const commits = [];
  for (let i = 0; i < 12; i++) {
    const conf = 0.1 + i * 0.07;
    decisions.push(dec('answer.partner', `p${i}.mjs`, 'emit', conf, `s${i}`));
    if (conf > 0.5) commits.push(commit(T0 + DAY, 'feat: together', [`p${i}.mjs`]));
  }
  const [partner] = calibrateDecisions(decisions, commits, { now: T0 + 30 * DAY });
  assert.match(partner.verdict, /not gated yet/);
  assert.equal(partner.bins.length, 4);
  assert.equal(partner.bins[0].rate, 0, 'low confidence partners were not co-committed');
  assert.equal(partner.bins[3].rate, 1);
});

test('valueBins: too few values → no bins', () => {
  assert.deepEqual(valueBins([{ value: 1, hit: true }]), []);
});
