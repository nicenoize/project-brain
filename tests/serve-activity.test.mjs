/**
 * /api/activity — "what landed today, and who is working where?"
 *
 * The panel exists because measuring the Control Room showed the coordination
 * half empty on every repo we have: leases record INTENT, and intent only
 * exists once everyone agreed to declare it. Git already knows the FACT. So the
 * bar this has to clear is different from the other panels': it must be
 * informative on a repo where nobody has adopted anything, and it must never
 * render a blank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeActivity, areaOf, localDayStart, DEFAULT_RECENT_DAYS } from '../scripts/serve/activity.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-28T15:00:00Z');
const MIDNIGHT = Date.parse('2026-08-28T00:00:00Z');

const c = (hash, author, iso, subject, files) => ({ hash, author, dateIso: iso, subject, files });

test('areaOf: the area is the DIRECTORY, never the file', () => {
  // Taking two segments off the raw path made `scripts/brain-serve.mjs` its own
  // "area", so one person appeared to be working in three places at once.
  assert.equal(areaOf('scripts/brain-serve.mjs'), 'scripts');
  assert.equal(areaOf('scripts/serve/records.mjs'), 'scripts/serve');
  assert.equal(areaOf('ui/src/components/Board.jsx'), 'ui/src');
  assert.equal(areaOf('docs/a/b/c.md'), 'docs/a');
  // A top-level file is not evidence about where anyone works.
  assert.equal(areaOf('.gitignore'), '');
  assert.equal(areaOf('README.md'), '');
  assert.equal(areaOf(''), '');
  assert.equal(areaOf(null), '');
  // Build output tells you nothing about a person's attention.
  assert.equal(areaOf('node_modules/x/y.js'), '');
  assert.equal(areaOf('dist/bundle.js'), '');
});

test('summarizeActivity: today is what landed since the given midnight', () => {
  const commits = [
    c('a1', 'ana', '2026-08-28T09:00:00Z', 'feat: one', ['scripts/serve/a.mjs']),
    c('a2', 'ana', '2026-08-28T11:00:00Z', 'fix: two', ['scripts/serve/b.mjs', 'ui/src/x.jsx']),
    c('b1', 'ben', '2026-08-27T22:00:00Z', 'feat: yesterday', ['docs/a/x.md'])
  ];
  const r = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT });
  assert.equal(r.today.commits, 2);
  assert.equal(r.today.files, 3);
  assert.deepEqual(r.today.authors.map((a) => a.author), ['ana']);
  assert.deepEqual(r.today.authors[0].areas, ['scripts/serve', 'ui/src']);
  // Newest first, so the panel reads like a log.
  assert.deepEqual(r.today.subjects.map((s) => s.hash), ['a2', 'a1']);
  assert.equal(r.lastActiveDay, null, 'an active day needs no fallback');
});

test('summarizeActivity: merges are counted, never mistaken for work', () => {
  // A merge carries no files in `git log --name-only`. Left in, this repo
  // reported six commits by a person whose whole day was merging their own PRs.
  const commits = [
    c('m1', 'ben', '2026-08-28T10:00:00Z', 'Merge pull request #46', []),
    c('m2', 'ben', '2026-08-28T10:05:00Z', 'Merge pull request #45', []),
    c('a1', 'ana', '2026-08-28T09:00:00Z', 'feat: real work', ['scripts/serve/a.mjs'])
  ];
  const r = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT });
  assert.equal(r.today.commits, 1, 'merges must not inflate the day');
  assert.equal(r.today.merges, 2, 'and must not be hidden either');
  assert.deepEqual(r.today.authors.map((a) => a.author), ['ana']);
  assert.deepEqual(r.people.map((p) => p.author), ['ana'], 'a merger is not "working here"');
  assert.match(r.provenance.merges, /counted separately/);
});

test('summarizeActivity: a quiet day names the last day that was not', () => {
  // The whole point of this panel is that it is never blank. "Nothing today"
  // must still teach the reader something.
  const commits = [
    c('x1', 'ana', '2026-08-25T09:00:00Z', 'feat: last real day', ['scripts/a/x.mjs']),
    c('x2', 'ben', '2026-08-25T17:00:00Z', 'fix: same day', ['ui/src/y.jsx']),
    c('w1', 'ana', '2026-08-24T09:00:00Z', 'feat: before that', ['scripts/a/z.mjs'])
  ];
  const r = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT });
  assert.equal(r.today.commits, 0);
  assert.equal(r.lastActiveDay.date, '2026-08-25');
  assert.equal(r.lastActiveDay.commits, 2);
  assert.deepEqual(r.lastActiveDay.authors, ['ana', 'ben']);
  assert.ok(r.lastActiveDay.daysAgo >= 3);
});

test('summarizeActivity: the people view ranks by recency, areas by weight', () => {
  const commits = [
    c('a1', 'ana', '2026-08-27T09:00:00Z', 'x', ['scripts/serve/a.mjs']),
    c('a2', 'ana', '2026-08-27T10:00:00Z', 'x', ['scripts/serve/b.mjs']),
    c('a3', 'ana', '2026-08-26T10:00:00Z', 'x', ['ui/src/x.jsx']),
    c('b1', 'ben', '2026-08-28T12:00:00Z', 'x', ['docs/a/x.md'])
  ];
  const r = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT });
  // Most recently seen first: "who is here right now" is the question.
  assert.deepEqual(r.people.map((p) => p.author), ['ben', 'ana']);
  const ana = r.people.find((p) => p.author === 'ana');
  assert.deepEqual(ana.areas, [{ area: 'scripts/serve', commits: 2 }, { area: 'ui/src', commits: 1 }]);
  assert.equal(ana.commits, 3);
  assert.ok(ana.hoursAgo > 0);
});

test('summarizeActivity: two people in one area is the collision the board would have warned about', () => {
  const commits = [
    c('a1', 'ana', '2026-08-28T09:00:00Z', 'x', ['scripts/serve/a.mjs']),
    c('b1', 'ben', '2026-08-27T09:00:00Z', 'x', ['scripts/serve/b.mjs']),
    c('c1', 'cyd', '2026-08-26T09:00:00Z', 'x', ['ui/src/x.jsx'])
  ];
  const r = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT });
  assert.equal(r.collisions.length, 1, 'one shared area, one collision');
  assert.equal(r.collisions[0].area, 'scripts/serve');
  assert.deepEqual(r.collisions[0].authors.map((a) => a.author), ['ana', 'ben']);
  assert.equal(r.collisions[0].commits, 2);
  // One person alone in an area is not a collision, however busy they are.
  assert.ok(!r.collisions.some((x) => x.area === 'ui/src'));
});

test('summarizeActivity: the window bounds what can be seen, and says so', () => {
  const commits = [
    c('old', 'ana', '2026-07-01T09:00:00Z', 'x', ['scripts/a/x.mjs']),
    c('new', 'ben', '2026-08-27T09:00:00Z', 'x', ['scripts/a/y.mjs'])
  ];
  const r = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT, recentDays: 7 });
  assert.deepEqual(r.people.map((p) => p.author), ['ben'], 'the old commit is outside the window');
  assert.equal(r.window.days, 7);
  assert.equal(r.window.commits, 1);
  // A reader seeing zero must be able to tell "nothing happened" from "the
  // window did not reach that far".
  assert.equal(r.provenance.basis, 'measured');
  assert.match(r.provenance.source, /git log/);
  assert.equal(r.provenance.scanned, 2);
  assert.match(r.provenance.note, /\.mailmap/);

  const wide = summarizeActivity(commits, { nowMs: NOW, dayStartMs: MIDNIGHT, recentDays: 120 });
  assert.deepEqual(wide.people.map((p) => p.author).sort(), ['ana', 'ben']);
});

test('summarizeActivity: degenerate inputs never throw and never invent', () => {
  const empty = summarizeActivity([], { nowMs: NOW, dayStartMs: MIDNIGHT });
  assert.equal(empty.today.commits, 0);
  assert.equal(empty.lastActiveDay, null);
  assert.deepEqual(empty.people, []);
  assert.deepEqual(empty.collisions, []);
  // Unparseable dates are dropped, not coerced to "now".
  const junk = summarizeActivity(
    [c('j', 'ana', 'not-a-date', 'x', ['scripts/a/x.mjs'])],
    { nowMs: NOW, dayStartMs: MIDNIGHT }
  );
  assert.equal(junk.provenance.scanned, 0);
  assert.equal(junk.today.commits, 0);
  // The clock is required, never defaulted: a panel silently reporting "today"
  // against the wrong instant is worse than a failure.
  assert.throws(() => summarizeActivity([], {}), TypeError);
  assert.throws(() => summarizeActivity([], { nowMs: NOW }), TypeError);
});

test('localDayStart: midnight is local, and the offset is reported not assumed', () => {
  // Berlin in August is UTC+2, which getTimezoneOffset reports as -120.
  const berlin = localDayStart(Date.parse('2026-08-28T00:30:00Z'), -120);
  assert.equal(new Date(berlin.dayStartMs).toISOString(), '2026-08-27T22:00:00.000Z');
  assert.equal(berlin.offsetMs, 120 * 60_000);
  // UTC is the identity case.
  const utc = localDayStart(Date.parse('2026-08-28T00:30:00Z'), 0);
  assert.equal(new Date(utc.dayStartMs).toISOString(), '2026-08-28T00:00:00.000Z');
  // West of UTC: 00:30Z is still the previous evening locally.
  const ny = localDayStart(Date.parse('2026-08-28T00:30:00Z'), 240);
  assert.equal(new Date(ny.dayStartMs).toISOString(), '2026-08-27T04:00:00.000Z');
});

test('DEFAULT_RECENT_DAYS is a week — long enough to see a colleague, short enough to be current', () => {
  assert.equal(DEFAULT_RECENT_DAYS, 7);
});
