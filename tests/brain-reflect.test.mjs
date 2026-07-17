import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOMES,
  HALF_LIFE_DAYS,
  CORROBORATION_MIN,
  outcomePolarity,
  decayWeight,
  parseTs,
  normalizeEvent,
  scoreRecord,
  aggregate,
  renderLessons
} from '../scripts/brain-reflect.mjs';

const DAY = 86400000;
// Fixed injected "now" so every test is reproducible (never Date.now()).
const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function ev({ id = 'decisions/0001-foo.md', outcome, actor = 'a', source, note, ageMs = 0 }) {
  return { id, outcome, actor, source, note, ts: iso(ageMs) };
}

// ---------------------------------------------------------------------------
// polarity + decay (PURE primitives)
// ---------------------------------------------------------------------------

test('outcomePolarity: useful corroborates, dead_end/corrected refute', () => {
  assert.equal(outcomePolarity('useful'), 1);
  assert.equal(outcomePolarity('dead_end'), -1);
  assert.equal(outcomePolarity('corrected'), -1);
  assert.equal(outcomePolarity('nonsense'), 0);
});

test('decayWeight: 1 at age 0, 0.5 at one half-life, clamps future-dated', () => {
  assert.equal(decayWeight(0), 1);
  assert.ok(Math.abs(decayWeight(HALF_LIFE_DAYS * DAY) - 0.5) < 1e-9);
  assert.ok(Math.abs(decayWeight(2 * HALF_LIFE_DAYS * DAY) - 0.25) < 1e-9);
  assert.equal(decayWeight(-DAY), 1); // future events never weigh more than fresh
});

test('parseTs: valid ISO → ms, junk → null', () => {
  assert.equal(parseTs('2026-07-10T00:00:00.000Z'), NOW);
  assert.equal(parseTs('not-a-date'), null);
});

// ---------------------------------------------------------------------------
// normalizeEvent — the "well-formed event" gate
// ---------------------------------------------------------------------------

test('normalizeEvent: rejects missing id / bad outcome / bad ts, defaults actor', () => {
  assert.equal(normalizeEvent({ outcome: 'useful', ts: iso(0) }), null); // no id
  assert.equal(normalizeEvent({ id: 'x', outcome: 'meh', ts: iso(0) }), null); // bad outcome
  assert.equal(normalizeEvent({ id: 'x', outcome: 'useful', ts: 'nope' }), null); // bad ts
  const ok = normalizeEvent({ id: 'x', outcome: 'useful', ts: iso(0) });
  assert.equal(ok.actor, 'unknown');
  assert.equal(ok.source, null);
});

// ---------------------------------------------------------------------------
// corroboration gate — THE core acceptance criteria
// ---------------------------------------------------------------------------

test('1 useful outcome is NOT preferred (corroboration gate)', () => {
  const s = scoreRecord([normalizeEvent(ev({ outcome: 'useful', actor: 'a' }))], NOW);
  assert.equal(s.corroborations, 1);
  assert.equal(s.preferred, false);
  assert.equal(s.verdict, 'noted');
});

test('2+ independent useful outcomes ARE preferred', () => {
  const events = [
    ev({ outcome: 'useful', actor: 'alice' }),
    ev({ outcome: 'useful', actor: 'bob' })
  ].map(normalizeEvent);
  const s = scoreRecord(events, NOW);
  assert.equal(s.corroborations, 2);
  assert.equal(s.preferred, true);
  assert.equal(s.verdict, 'preferred');
  assert.ok(s.score > 0);
});

test('corroboration is INDEPENDENT: same actor twice counts once, not preferred', () => {
  const events = [
    ev({ outcome: 'useful', actor: 'alice' }),
    ev({ outcome: 'useful', actor: 'alice' })
  ].map(normalizeEvent);
  const s = scoreRecord(events, NOW);
  assert.equal(s.corroborations, 1);
  assert.equal(s.preferred, false);
});

test('CORROBORATION_MIN is 2', () => {
  assert.equal(CORROBORATION_MIN, 2);
});

// ---------------------------------------------------------------------------
// contested detection — flagged, recency-decided, never silent
// ---------------------------------------------------------------------------

test('a later corrected outcome marks a preferred record contested', () => {
  const events = [
    ev({ outcome: 'useful', actor: 'alice', ageMs: 3 * DAY }),
    ev({ outcome: 'useful', actor: 'bob', ageMs: 2 * DAY }),
    ev({ outcome: 'corrected', actor: 'carol', ageMs: 1 * DAY }) // most recent
  ].map(normalizeEvent);
  const s = scoreRecord(events, NOW);
  assert.equal(s.contested, true);
  assert.equal(s.preferred, false, 'contested can never be preferred');
  assert.equal(s.verdict, 'contested');
  // recency decides the FLAGGED direction, not silence
  assert.equal(s.recencyOutcome, 'corrected');
  assert.equal(s.recencyPolarity, -1);
});

test('recency direction can also flip positive when the newest event is useful', () => {
  const events = [
    ev({ outcome: 'dead_end', actor: 'alice', ageMs: 2 * DAY }),
    ev({ outcome: 'useful', actor: 'bob', ageMs: 1 * DAY }) // most recent
  ].map(normalizeEvent);
  const s = scoreRecord(events, NOW);
  assert.equal(s.contested, true);
  assert.equal(s.recencyOutcome, 'useful');
});

// ---------------------------------------------------------------------------
// time-decay affects the net score
// ---------------------------------------------------------------------------

test('an old refutation decays below a fresh corroboration', () => {
  const events = [
    ev({ outcome: 'dead_end', actor: 'alice', ageMs: 120 * DAY }), // 4 half-lives → ~0.0625
    ev({ outcome: 'useful', actor: 'bob', ageMs: 0 })              // fresh → 1.0
  ].map(normalizeEvent);
  const s = scoreRecord(events, NOW);
  assert.ok(s.score > 0, `expected net positive after decay, got ${s.score}`);
});

// ---------------------------------------------------------------------------
// aggregate + prune-on-missing-source
// ---------------------------------------------------------------------------

test('aggregate: a lesson citing a deleted source is pruned', () => {
  const raw = [
    ev({ id: 'decisions/gone.md', outcome: 'useful', actor: 'alice', source: 'decisions/gone.md' }),
    ev({ id: 'decisions/gone.md', outcome: 'useful', actor: 'bob', source: 'decisions/gone.md' }),
    ev({ id: 'decisions/live.md', outcome: 'useful', actor: 'alice', source: 'decisions/live.md' })
  ];
  const sourceExists = (s) => s === 'decisions/live.md';
  const agg = aggregate(raw, { now: NOW, sourceExists });
  assert.equal(agg.pruned.length, 1);
  assert.equal(agg.pruned[0].id, 'decisions/gone.md');
  assert.deepEqual(agg.lessons.map((l) => l.id), ['decisions/live.md']);
});

test('aggregate: a lesson with no known source is never pruned', () => {
  const raw = [ev({ id: 'x', outcome: 'useful', actor: 'a', source: undefined })];
  const agg = aggregate(raw, { now: NOW, sourceExists: () => false });
  assert.equal(agg.pruned.length, 0);
  assert.equal(agg.lessons.length, 1);
});

test('aggregate: malformed events are dropped, not fatal', () => {
  const raw = [
    { garbage: true },
    ev({ id: 'x', outcome: 'useful', actor: 'a' }),
    { id: 'y', outcome: 'bad', ts: iso(0) }
  ];
  const agg = aggregate(raw, { now: NOW, sourceExists: () => true });
  assert.equal(agg.events, 1);
  assert.equal(agg.lessons.length, 1);
});

// ---------------------------------------------------------------------------
// reproducibility — same inputs ⇒ byte-identical output
// ---------------------------------------------------------------------------

test('renderLessons is byte-identical for identical inputs (injected now)', () => {
  const raw = [
    ev({ id: 'decisions/a.md', outcome: 'useful', actor: 'alice', source: 'decisions/a.md' }),
    ev({ id: 'decisions/a.md', outcome: 'useful', actor: 'bob', source: 'decisions/a.md' }),
    ev({ id: 'decisions/b.md', outcome: 'dead_end', actor: 'carol', source: 'decisions/b.md' })
  ];
  const opts = { now: NOW, sourceExists: () => true };
  const out1 = renderLessons(aggregate(raw, opts), { now: NOW });
  const out2 = renderLessons(aggregate(raw, opts), { now: NOW });
  assert.equal(out1, out2);
  // event order must not change the output either (deterministic grouping/sort)
  const out3 = renderLessons(aggregate([...raw].reverse(), opts), { now: NOW });
  assert.equal(out1, out3);
  assert.match(out1, /type: lesson/);
  assert.match(out1, /## Preferred/);
});

test('OUTCOMES vocabulary is exactly the three documented tags', () => {
  assert.deepEqual(OUTCOMES, ['useful', 'dead_end', 'corrected']);
});
