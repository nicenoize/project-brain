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

// ---------------------------------------------------------------------------
// Calibration: was the decision right? (ADR 0033, step 2)
// ---------------------------------------------------------------------------

/** A fix/revert commit — the same proxy label calibrateFileHealth uses. */
const FIX_RE = /\b(fix(es|ed)?|hotfix|revert(s|ed)?|regression)\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What "the signal was right" means, per signal. A danger warning predicts
 * trouble: a fix touches the file soon. A co-change partner predicts the
 * change will spread: the partner file is committed soon, fix or not.
 */
export const SIGNAL_OUTCOMES = {
  // skipFirst: the first commit touching the file after the warning is the
  // change the agent was making. If that change is itself a fix, counting it
  // would let every bug-fixing session confirm its own warning.
  'answer.danger': { gated: true, horizonDays: 7, label: 'a LATER fix/revert touched the file', skipFirst: true, hit: (c) => FIX_RE.test(c.subject || '') },
  'answer.partner': { gated: false, horizonDays: 2, label: 'the partner file was committed', skipFirst: false, hit: () => true }
};

/** Minimum decisions per side before a rate is reported as evidence. */
export const MIN_CALIBRATION_N = 10;

function rate(pos, n) { return n ? pos / n : null; }

/**
 * PURE. Join decisions with what happened to their target afterwards.
 *
 * Each (signal, target, session) counts once: the first decision. A session
 * that edits one file ten times made one call about it, not ten. A decision
 * counts only once its horizon has fully passed (`now`), or recent decisions
 * would read as "nothing happened" when the answer isn't in yet.
 *
 * @param {object[]} decisions  .decisions.jsonl records
 * @param {{dateIso:string, subject:string, files:string[]}[]} commits
 * @returns per-signal { emitted, held, pending, lift, verdict, bins }
 */
export function calibrateDecisions(decisions = [], commits = [], { now = Date.now(), minN = MIN_CALIBRATION_N } = {}) {
  const firsts = new Map();
  for (const d of decisions) {
    if (!d || !SIGNAL_OUTCOMES[d.signal]) continue;
    const ts = Date.parse(d.ts);
    if (!Number.isFinite(ts)) continue;
    const key = `${d.signal}\u0000${d.target}\u0000${d.session}`;
    const prev = firsts.get(key);
    if (!prev || ts < prev.ts) firsts.set(key, { ...d, ts });
  }
  const dated = commits
    .map((c) => ({ ...c, at: Date.parse(c.dateIso) }))
    .filter((c) => Number.isFinite(c.at));

  const bySignal = new Map();
  for (const d of firsts.values()) {
    const spec = SIGNAL_OUTCOMES[d.signal];
    const end = d.ts + spec.horizonDays * DAY_MS;
    const s = bySignal.get(d.signal) || { signal: d.signal, outcome: spec.label, horizonDays: spec.horizonDays, pending: 0, rows: [] };
    if (end > now) { s.pending++; bySignal.set(d.signal, s); continue; }
    let touching = dated
      .filter((c) => c.at > d.ts && c.at <= end && (c.files || []).includes(d.target))
      .sort((a, b) => a.at - b.at);
    if (spec.skipFirst) touching = touching.slice(1);
    const hit = touching.some((c) => spec.hit(c));
    s.rows.push({ action: d.action, value: typeof d.value === 'number' ? d.value : null, hit });
    bySignal.set(d.signal, s);
  }

  const out = [];
  for (const s of bySignal.values()) {
    const side = (action) => {
      const rows = s.rows.filter((r) => r.action === action);
      const pos = rows.filter((r) => r.hit).length;
      return { n: rows.length, hits: pos, rate: rate(pos, rows.length) };
    };
    const emitted = side('emit');
    const held = side('log');
    const all = { n: s.rows.length, hits: s.rows.filter((r) => r.hit).length };
    const baseRate = rate(all.hits, all.n);
    const enough = emitted.n >= minN && held.n >= minN;
    const lift = enough && held.rate ? emitted.rate / held.rate : null;
    let verdict;
    if (!s.rows.length) verdict = `no resolved decisions yet (${s.pending} pending, horizon ${s.horizonDays}d)`;
    else if (!SIGNAL_OUTCOMES[s.signal].gated && emitted.n >= minN) verdict = `not gated yet: ${emitted.n} emitted, ${pct(emitted.rate)} right; choose a threshold from the value bins`;
    else if (!enough) verdict = `not enough evidence: ${emitted.n} emitted / ${held.n} held back, need ${minN} each`;
    else if (emitted.rate > held.rate) verdict = `emitted are right more often than held-back (${pct(emitted.rate)} vs ${pct(held.rate)}): the threshold separates`;
    else verdict = `emitted are NOT right more often than held-back (${pct(emitted.rate)} vs ${pct(held.rate)}): the threshold does not separate`;
    out.push({
      signal: s.signal, outcome: s.outcome, horizonDays: s.horizonDays, pending: s.pending,
      emitted, held, baseRate, lift, verdict, bins: valueBins(s.rows)
    });
  }
  return out.sort((a, b) => (a.signal < b.signal ? -1 : 1));
}

function pct(x) { return x === null ? 'n/a' : `${Math.round(x * 100)}%`; }

/**
 * PURE. Hit rate by value quartile, the raw material for a threshold. For a
 * signal that is not gated yet (co-change), this is how a cut-off gets chosen
 * from evidence instead of guessed.
 */
export function valueBins(rows, parts = 4) {
  const vals = rows.filter((r) => r.value !== null).sort((a, b) => a.value - b.value);
  if (vals.length < parts) return [];
  const bins = [];
  for (let i = 0; i < parts; i++) {
    const slice = vals.slice(Math.floor((i * vals.length) / parts), Math.floor(((i + 1) * vals.length) / parts));
    if (!slice.length) continue;
    const hits = slice.filter((r) => r.hit).length;
    bins.push({ min: slice[0].value, max: slice[slice.length - 1].value, n: slice.length, hits, rate: hits / slice.length });
  }
  return bins;
}
