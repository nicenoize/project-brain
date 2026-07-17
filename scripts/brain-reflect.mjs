/**
 * Outcome-tagged learning loop (issue #18) — close the loop the brain never had.
 *
 * The brain records findings / insights / explainers but never learns whether
 * they HELPED. `brain:reflect` adds that missing signal deterministically — NO
 * LLM, sidecar-only, reproducible.
 *
 *   brain:reflect record <record-id> --outcome useful|dead_end|corrected [--note ..]
 *       Appends an outcome EVENT to an append-only sidecar
 *       (.project-brain/reflect/outcomes.jsonl). NEVER mutates the original
 *       record — the record lives under its own recorder's dir; we only ever
 *       write beside it in the reflect/ sidecar (issue #20 discipline).
 *
 *   brain:reflect [report] [--json] [--if-stale]
 *       Deterministic aggregator over the event log:
 *         - time-decayed scoring (30-day half-life)
 *         - corroboration gate: >=2 INDEPENDENT (distinct-actor) corroborations
 *           before a record is "preferred"
 *         - contested detection: a record with BOTH positive and negative
 *           outcomes is FLAGGED contested (direction decided by recency), never
 *           silently resolved
 *         - auto-prune: a lesson whose cited source(s) have vanished is dropped
 *           (reuses the brain-explain.mjs#hashSource existence pattern)
 *       Writes a regenerable lessons digest to .project-brain/reflect/lessons.md
 *       (record type `lesson`, feeds the learn axis). `--if-stale` is a near-free
 *       no-op when the digest is newer than the event log.
 *
 * RANKING is explicitly OUT of scope: using outcome scores as a retrieval boost
 * is a ranking change and must clear the paired-bootstrap eval gate first. It
 * lives dormant behind BRAIN_REFLECT_BOOST (default OFF, not wired here) — a
 * separate, eval-gated step (see decisions/0027 + issue #18).
 *
 * All scoring is PURE + exported + unit-tested; aggregation is reproducible
 * (inject `now`, never sample it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  BRAIN_DIR,
  ensureDir,
  exists,
  takeFlag,
  takeOption
} from './common.mjs';

const REFLECT_DIR = path.join(BRAIN_DIR, 'reflect');
const OUTCOMES_LOG = path.join(REFLECT_DIR, 'outcomes.jsonl');
const LESSONS_FILE = path.join(REFLECT_DIR, 'lessons.md');

export const OUTCOMES = ['useful', 'dead_end', 'corrected'];
export const HALF_LIFE_DAYS = 30;
export const CORROBORATION_MIN = 2;
const DAY_MS = 86400000;

// --- PURE scoring core ------------------------------------------------------

/**
 * Polarity of an outcome. `useful` corroborates (+1); `dead_end` and `corrected`
 * refute (-1). Unknown → 0 (ignored by scoring). PURE.
 */
export function outcomePolarity(outcome) {
  if (outcome === 'useful') return 1;
  if (outcome === 'dead_end' || outcome === 'corrected') return -1;
  return 0;
}

/**
 * Time-decay weight of an event `ageMs` old under an exponential half-life.
 * 0.5^(days/halfLife): a fresh event weighs 1, one half-life old weighs 0.5.
 * Future-dated (negative age) is clamped to 1. PURE.
 */
export function decayWeight(ageMs, halfLifeDays = HALF_LIFE_DAYS) {
  const days = Math.max(0, Number(ageMs)) / DAY_MS;
  return Math.pow(0.5, days / halfLifeDays);
}

/** Parse an ISO timestamp to epoch ms, or null if unparseable. PURE. */
export function parseTs(ts) {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Validate + normalize one raw outcome event. Returns a clean event or null if
 * it is unusable (unknown outcome, no id, unparseable ts). PURE — the single
 * definition of "a well-formed event", shared by the reader and the tests.
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  if (!OUTCOMES.includes(raw.outcome)) return null;
  const tsMs = parseTs(raw.ts);
  if (tsMs === null) return null;
  return {
    id,
    outcome: raw.outcome,
    actor: (typeof raw.actor === 'string' && raw.actor.trim()) || 'unknown',
    source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    ts: raw.ts,
    tsMs
  };
}

/**
 * Score all events for a SINGLE record. Deterministic given `now` (epoch ms).
 * PURE — no I/O, no wall clock.
 *
 * @param {Array} events  normalized events (all sharing one id)
 * @param {number} now    injected epoch-ms "now"
 * @returns object with score, corroborations, contested flag, verdict, sources…
 */
export function scoreRecord(events, now) {
  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs || cmp(a.actor, b.actor));
  const positiveActors = new Set();
  const negativeActors = new Set();
  const sources = new Set();
  let score = 0;
  for (const ev of sorted) {
    const pol = outcomePolarity(ev.outcome);
    score += pol * decayWeight(now - ev.tsMs);
    if (pol > 0) positiveActors.add(ev.actor);
    else if (pol < 0) negativeActors.add(ev.actor);
    if (ev.source) sources.add(ev.source);
  }
  const hasPositive = positiveActors.size > 0;
  const hasNegative = negativeActors.size > 0;
  const contested = hasPositive && hasNegative;
  // Independent corroborations = distinct actors that reported `useful`.
  const corroborations = positiveActors.size;
  const last = sorted[sorted.length - 1];
  // `preferred` is gated: not contested, enough independent corroboration, and a
  // net-positive decayed score.
  const preferred = !contested && corroborations >= CORROBORATION_MIN && score > 0;

  let verdict;
  if (contested) verdict = 'contested';
  else if (preferred) verdict = 'preferred';
  else if (score > 0) verdict = 'noted';        // positive but under-corroborated
  else if (score < 0) verdict = 'discouraged';
  else verdict = 'neutral';

  return {
    id: sorted[0].id,
    score: round(score),
    corroborations,
    positives: positiveActors.size,
    negatives: negativeActors.size,
    count: sorted.length,
    contested,
    preferred,
    verdict,
    // For a contested record, recency decides the FLAGGED direction (not silence).
    recencyOutcome: last.outcome,
    recencyPolarity: outcomePolarity(last.outcome),
    lastTs: last.ts,
    sources: [...sources].sort(cmp)
  };
}

/**
 * Aggregate an event log into scored lessons + a prune list. Deterministic
 * given `now` and `sourceExists`. PURE.
 *
 * A lesson is PRUNED when it cited at least one source and ALL of its cited
 * sources have vanished (`sourceExists` → false) — the record it reflected on is
 * gone, so the accumulated outcome signal is orphaned. Lessons with no known
 * source are never pruned (nothing to verify), matching the explainer null-hash
 * stance.
 *
 * @param {Array} rawEvents            raw event objects (unvalidated)
 * @param {object} opts
 * @param {number} opts.now            injected epoch-ms
 * @param {(src:string)=>boolean} opts.sourceExists  source existence predicate
 */
export function aggregate(rawEvents, { now, sourceExists = () => true } = {}) {
  const events = [];
  for (const raw of rawEvents || []) {
    const ev = normalizeEvent(raw);
    if (ev) events.push(ev);
  }
  const byId = new Map();
  for (const ev of events) {
    if (!byId.has(ev.id)) byId.set(ev.id, []);
    byId.get(ev.id).push(ev);
  }
  const lessons = [];
  const pruned = [];
  for (const [, group] of byId) {
    const scored = scoreRecord(group, now);
    const knownSources = scored.sources;
    const orphaned = knownSources.length > 0 && knownSources.every((s) => !sourceExists(s));
    if (orphaned) {
      pruned.push({ id: scored.id, sources: knownSources });
    } else {
      lessons.push(scored);
    }
  }
  // Total, deterministic order: strongest signal first, id is the unique tiebreak.
  lessons.sort((a, b) => b.score - a.score || b.corroborations - a.corroborations || cmp(a.id, b.id));
  pruned.sort((a, b) => cmp(a.id, b.id));
  return { events: events.length, lessons, pruned };
}

/**
 * Render an aggregation to the lessons digest markdown. Deterministic given the
 * same `aggregation` + injected `now` (frontmatter timestamp is the ONLY clock
 * input, and it is injected — same inputs ⇒ byte-identical output). PURE.
 */
export function renderLessons(aggregation, { now } = {}) {
  const generated = new Date(now).toISOString();
  const { lessons, pruned } = aggregation;
  const preferred = lessons.filter((l) => l.verdict === 'preferred');
  const contested = lessons.filter((l) => l.verdict === 'contested');
  const discouraged = lessons.filter((l) => l.verdict === 'discouraged');
  const noted = lessons.filter((l) => l.verdict === 'noted' || l.verdict === 'neutral');

  const lines = [];
  lines.push('---');
  lines.push('type: lesson');
  lines.push('title: Reflect lessons — outcome-tagged learning summary');
  lines.push('layer: derived');
  lines.push('module: reflect');
  lines.push(`generated: ${generated}`);
  lines.push(`records: ${lessons.length}`);
  lines.push('---');
  lines.push('');
  lines.push('# Reflect lessons');
  lines.push('');
  lines.push('_Regenerated from `.project-brain/reflect/outcomes.jsonl` by `brain:reflect`.');
  lines.push('Deterministic: no LLM, no ranking change. See decisions/0027._');
  lines.push('');

  section(lines, 'Preferred', preferred, (l) =>
    `${l.id} — score ${l.score}, ${l.corroborations} independent corroborations`);
  section(lines, 'Contested (flagged, recency-decided)', contested, (l) =>
    `${l.id} — most recent: ${l.recencyOutcome} (score ${l.score}, +${l.positives}/-${l.negatives})`);
  section(lines, 'Discouraged', discouraged, (l) =>
    `${l.id} — score ${l.score} (${l.negatives} refuting)`);
  section(lines, 'Noted (under-corroborated)', noted, (l) =>
    `${l.id} — score ${l.score}, ${l.corroborations}/${CORROBORATION_MIN} corroborations`);

  if (pruned.length) {
    lines.push('## Pruned (cited source vanished)');
    lines.push('');
    for (const p of pruned) lines.push(`- ${p.id} — sources gone: ${p.sources.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\s*$/, '') + '\n';
}

function section(lines, heading, items, fmt) {
  lines.push(`## ${heading}`);
  lines.push('');
  if (!items.length) {
    lines.push('_none_');
  } else {
    for (const it of items) lines.push(`- ${fmt(it)}`);
  }
  lines.push('');
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function round(n) { return Math.round(n * 1e6) / 1e6; }

// --- I/O layer (impure, thin) ----------------------------------------------

/** Read + parse the JSONL event log, skipping malformed/blank lines. */
export function readOutcomes(logPath = OUTCOMES_LOG) {
  if (!exists(logPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip a corrupt line, keep the rest */ }
  }
  return out;
}

/** Current on-disk existence of a repo-relative source path. Mirrors hashSource's resolve. */
function sourceExistsOnDisk(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  return exists(abs);
}

/** Is `outPath` fresh w.r.t. `inPath`? (exists AND mtime >= inPath's). */
function outputFresh(outPath, inPath) {
  try {
    if (!exists(outPath)) return false;
    if (!exists(inPath)) return true; // no inputs → nothing to regenerate
    return fs.statSync(outPath).mtimeMs >= fs.statSync(inPath).mtimeMs;
  } catch {
    return false;
  }
}

// --- CLI --------------------------------------------------------------------

function usage() {
  return [
    'Usage:',
    '  npm run brain:reflect -- record <record-id> --outcome useful|dead_end|corrected [--note "..."] [--actor X] [--source path]',
    '  npm run brain:reflect -- [report] [--json] [--if-stale]'
  ].join('\n');
}

function cmdRecord(args) {
  const outcome = (takeOption(args, '--outcome') || '').trim();
  const note = takeOption(args, '--note') || '';
  const actor = (takeOption(args, '--actor') || process.env.BRAIN_ACTOR || 'unknown').trim() || 'unknown';
  let source = takeOption(args, '--source');
  const id = (args.find((a) => !a.startsWith('-')) || '').trim();

  if (!id) {
    process.stderr.write('[brain:reflect] record requires a <record-id>\n');
    process.exit(1);
  }
  if (!OUTCOMES.includes(outcome)) {
    process.stderr.write(`[brain:reflect] --outcome must be one of: ${OUTCOMES.join(', ')}\n`);
    process.exit(1);
  }
  // Resolve the cited source for later prune-on-missing. Explicit --source wins;
  // otherwise, if the record-id is itself an on-disk path, cite it.
  if (!source && sourceExistsOnDisk(id)) source = id;

  const event = {
    id,
    outcome,
    actor,
    source: source || null,
    note,
    ts: new Date().toISOString()
  };
  ensureDir(REFLECT_DIR);
  fs.appendFileSync(OUTCOMES_LOG, JSON.stringify(event) + '\n');
  process.stdout.write(`Recorded ${outcome} for ${id} (actor: ${actor})\n`);
}

function cmdReport(args) {
  const json = takeFlag(args, '--json');
  const ifStale = takeFlag(args, '--if-stale');

  if (ifStale && outputFresh(LESSONS_FILE, OUTCOMES_LOG)) {
    process.stderr.write('[brain:reflect] lessons up to date (--if-stale no-op).\n');
    return;
  }

  const now = Date.now();
  const agg = aggregate(readOutcomes(), { now, sourceExists: sourceExistsOnDisk });
  ensureDir(REFLECT_DIR);
  fs.writeFileSync(LESSONS_FILE, renderLessons(agg, { now }));

  if (json) {
    process.stdout.write(JSON.stringify(agg, null, 2) + '\n');
    return;
  }
  const preferred = agg.lessons.filter((l) => l.verdict === 'preferred').length;
  const contested = agg.lessons.filter((l) => l.verdict === 'contested').length;
  process.stdout.write(
    `Reflected ${agg.events} outcome(s) → ${agg.lessons.length} lesson(s) ` +
    `(${preferred} preferred, ${contested} contested, ${agg.pruned.length} pruned).\n` +
    `Wrote ${path.relative(ROOT, LESSONS_FILE)}\n`
  );
}

function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  if (help) { console.log(usage()); process.exit(0); }

  // Default (no subcommand, or an explicit `report`) → aggregate.
  const sub = args[0] === 'record' || args[0] === 'report' ? args.shift() : 'report';

  try {
    if (sub === 'record') return cmdRecord(args);
    return cmdReport(args);
  } catch (error) {
    process.stderr.write(`[brain:reflect] ${error.message || error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
