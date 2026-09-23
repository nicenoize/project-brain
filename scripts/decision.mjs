/**
 * Brain signals as typed decisions with a threshold (ADR 0033).
 *
 * An ambient hook used to inject whatever it found. Every signal it computes is
 * now a decision with a value, a threshold and an action:
 *
 *   emit    — above the threshold: the agent sees it
 *   log     — computed but below the threshold: only recorded
 *
 * Every decision, emitted or not, is recorded in `.project-brain/.decisions.jsonl`
 * (local, gitignored, capped like the usage ledger). That record is what lets a
 * threshold be calibrated later from outcomes instead of guessed: both what
 * was said AND what was held back, so the precision of either side can be
 * measured against what happened to the file next.
 *
 * Deterministic: the same inputs give the same decision. No LLM.
 */
import path from 'node:path';
import { BRAIN_DIR, appendUsageRecord } from './common.mjs';

export const DECISIONS_LOG = path.join(BRAIN_DIR, '.decisions.jsonl');

/**
 * Minimum file-health score before the answer hook warns about danger.
 *
 * Measured, not chosen (club-ops, 657 files, health-calibrate --commits 2000
 * --horizon-days 7, AUC 0.74): the share of files that needed a fix in the
 * following week, by score quartile, was 4% (<1.6), 10% (1.6-4.6), 15%
 * (4.6-5.9) and 35% (>=6), against a base rate of 16%. Below 6 a warning is no
 * better than saying nothing about a random file. Override:
 * BRAIN_ANSWER_DANGER_MIN (0 restores the old always-warn behaviour).
 */
export const DANGER_EMIT_MIN = 6;

/** PURE. The danger threshold in force. */
export function dangerEmitMin(env = process.env) {
  const raw = env && env.BRAIN_ANSWER_DANGER_MIN;
  if (raw === undefined || raw === '') return DANGER_EMIT_MIN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DANGER_EMIT_MIN;
}

/**
 * PURE. Gate a danger reading. Thin history (`lowConfidence`) never emits:
 * the calibration above is over files with history, and a score computed
 * from a handful of commits is not the score it measured.
 *
 * @returns {{action: 'emit'|'log', reason: string}}
 */
export function gateDanger(danger, emitMin = DANGER_EMIT_MIN) {
  if (!danger) return { action: 'log', reason: 'no history' };
  if (danger.lowConfidence) return { action: 'log', reason: 'thin history' };
  if (!(Number(danger.score) >= emitMin)) return { action: 'log', reason: `score ${danger.score} < ${emitMin}` };
  return { action: 'emit', reason: `score ${danger.score} >= ${emitMin}` };
}

/** PURE. One decision record — the log line shape. */
export function decisionRecord({ signal, target, value, action, threshold = null, reason = '', session = '', ts }) {
  return {
    ts: ts || new Date().toISOString(),
    signal: String(signal),
    target: String(target || ''),
    value: value === undefined ? null : value,
    action,
    threshold,
    reason: String(reason || ''),
    session: String(session || '')
  };
}

/**
 * Append decisions to the log. Fail-silent (a hook must never break on its own
 * bookkeeping); off with BRAIN_DECISION_LOG=0 and under the test runner.
 */
export function logDecisions(records = [], logPath = DECISIONS_LOG, env = process.env) {
  if (env.BRAIN_DECISION_LOG === '0') return 0;
  if (env.BRAIN_DECISION_LOG !== '1' && env.NODE_TEST_CONTEXT) return 0;
  let n = 0;
  for (const r of records) if (appendUsageRecord(r, logPath)) n++;
  return n;
}
