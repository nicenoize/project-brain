/**
 * serve/activity.mjs — /api/activity: "what landed today, and who is working where?"
 *
 * WHY THIS EXISTS. Measuring the Control Room panel by panel showed the half
 * that carries the product story — Board, LeaseBoard, AuditFeed, Fleet — empty
 * on every repo we have, while the code-intel panels carried 26 KB. Those
 * panels are not broken; they are waiting for an adoption that has not
 * happened. Leases record INTENT ("I am about to touch this"), and intent only
 * exists once everyone has agreed to declare it.
 *
 * Git already knows the FACT: who touched what, twenty minutes ago, with no
 * new habit from anybody. That is a weaker signal — it is the past, and it
 * cannot warn you before the edit — but it is never empty on an active repo,
 * it works on a colleague's repo you have no authority over, and on a
 * thirty-two-author workspace it answers "what are my colleagues doing" today
 * rather than after a rollout. Intent and fact are complements: this panel is
 * the one that always has something to say.
 *
 * The `collisions` block is the part that earns its place. Two people in the
 * same area inside one window is exactly what the lease board would have
 * warned about in advance — reported here after the fact, from evidence,
 * without asking anyone to adopt anything.
 *
 * PURE CORE. `summarizeActivity` takes commits and instants and returns the
 * whole answer; no clocks, no git, no fs. The endpoint supplies `nowMs` and the
 * local-midnight boundary, so "today" is testable and the daemon's timezone is
 * stated in the output instead of being assumed.
 *
 * COST. Zero extra git calls: it reads the same parsed-commit cache every intel
 * endpoint shares (serve/git.mjs, keyed by HEAD + window).
 */
import { sendJson } from './security.mjs';
import { cachedCommits, commitsSafe, DEFAULT_COMMIT_WINDOW } from './git.mjs';
import { liveMeta } from './records.mjs';

/** Days of history behind the "who is working where" view. */
export const DEFAULT_RECENT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** Rows we are willing to render; more than this is noise, not information. */
const MAX_PEOPLE = 12;
const MAX_AREAS_PER_PERSON = 5;
const MAX_COLLISIONS = 8;
const MAX_SUBJECTS = 12;

/** Directories that say nothing about WHERE someone is working. */
const AREA_NOISE = new Set(['', '.', 'node_modules', 'dist', 'build', 'coverage', 'vendor']);

/**
 * PURE. The working AREA a path belongs to: the first `depth` segments of its
 * DIRECTORY, never the file itself.
 *
 * Dropping the filename first is the whole trick. Taking two segments off the
 * raw path made `scripts/brain-serve.mjs` its own "area", so a person showed up
 * working in `scripts/serve`, `scripts/git-intel.mjs` and `scripts/brain-serve.mjs`
 * as if those were three places. Two directory levels is where "who else is in
 * here" is a useful question: `scripts/` alone lumps the repo together, a whole
 * path makes every commit its own island.
 *
 * A top-level file has no area and returns '' — it is not evidence about where
 * anyone is working.
 */
export function areaOf(file, depth = 2) {
  const parts = String(file || '').split('/').filter(Boolean);
  if (parts.length < 2) return '';
  if (AREA_NOISE.has(parts[0])) return '';
  return parts.slice(0, -1).slice(0, Math.max(1, depth)).join('/');
}

/** PURE. Byte-stable comparison — never localeCompare. */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** PURE. YYYY-MM-DD of an instant in a fixed offset, for day bucketing. */
function dayKey(ms, offsetMs) {
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

/**
 * PURE. Everything the panel shows, from commits and two instants.
 *
 * @param {Array<{hash,author,dateIso,subject,files}>} commits
 * @param {object} opts
 * @param {number} opts.nowMs        the instant "now"
 * @param {number} opts.dayStartMs   local midnight, computed by the caller
 * @param {number} [opts.offsetMs]   local offset, for day bucketing only
 * @param {number} [opts.recentDays] window behind the people view
 */
export function summarizeActivity(commits = [], opts = {}) {
  const nowMs = Number(opts.nowMs);
  const dayStartMs = Number(opts.dayStartMs);
  const offsetMs = Number.isFinite(opts.offsetMs) ? opts.offsetMs : 0;
  const recentDays = Math.max(1, Number(opts.recentDays) || DEFAULT_RECENT_DAYS);
  if (!Number.isFinite(nowMs) || !Number.isFinite(dayStartMs)) {
    throw new TypeError('summarizeActivity requires numeric nowMs and dayStartMs');
  }
  const windowStartMs = nowMs - recentDays * MS_PER_DAY;

  const dated = [];
  for (const c of commits) {
    const ms = Date.parse(c && c.dateIso);
    if (Number.isFinite(ms)) dated.push({ ...c, ms });
  }
  dated.sort((a, b) => b.ms - a.ms || byString(a.hash || '', b.hash || ''));

  // A merge carries no files in `git log --name-only`, so it contributes no
  // area and no evidence about where anyone worked — but it still lands in the
  // author column. Left in, this repo reported "6 commits today by <person>"
  // whose entire content was merging their own pull requests. Counted
  // separately rather than dropped: hiding them would understate the day.
  const isMerge = (c) => !(c.files || []).length;
  const todayAll = dated.filter((c) => c.ms >= dayStartMs && c.ms <= nowMs);
  const todayCommits = todayAll.filter((c) => !isMerge(c));
  const todayMerges = todayAll.length - todayCommits.length;
  const windowCommits = dated.filter((c) => c.ms >= windowStartMs && c.ms <= nowMs && !isMerge(c));

  // --- what landed today ---------------------------------------------------
  const todayFiles = new Set();
  const todayByAuthor = new Map();
  for (const c of todayCommits) {
    const author = String(c.author || 'unknown');
    if (!todayByAuthor.has(author)) todayByAuthor.set(author, { author, commits: 0, areas: new Map() });
    const row = todayByAuthor.get(author);
    row.commits += 1;
    for (const f of c.files || []) {
      todayFiles.add(f);
      const a = areaOf(f);
      if (a) row.areas.set(a, (row.areas.get(a) || 0) + 1);
    }
  }
  const today = {
    since: new Date(dayStartMs).toISOString(),
    commits: todayCommits.length,
    merges: todayMerges,
    files: todayFiles.size,
    authors: [...todayByAuthor.values()]
      .map((r) => ({
        author: r.author,
        commits: r.commits,
        // Ranked by how much was touched, like the people view — alphabetical
        // put `.impeccable` at the head of a day spent in `scripts/`.
        areas: [...r.areas.entries()]
          .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
          .slice(0, MAX_AREAS_PER_PERSON)
          .map(([area]) => area)
      }))
      .sort((a, b) => b.commits - a.commits || byString(a.author, b.author)),
    subjects: todayCommits.slice(0, MAX_SUBJECTS).map((c) => ({
      hash: String(c.hash || '').slice(0, 7),
      author: String(c.author || 'unknown'),
      subject: String(c.subject || '').slice(0, 120),
      at: new Date(c.ms).toISOString()
    }))
  };

  // A quiet day is a fact, not a blank panel: name the last day that DID have
  // commits, so the reader learns something either way.
  let lastActiveDay = null;
  const datedWork = dated.filter((c) => !isMerge(c));
  if (!todayCommits.length && datedWork.length) {
    const newest = datedWork[0];
    const key = dayKey(newest.ms, offsetMs);
    const sameDay = datedWork.filter((c) => dayKey(c.ms, offsetMs) === key);
    lastActiveDay = {
      date: key,
      commits: sameDay.length,
      daysAgo: Math.max(0, Math.floor((dayStartMs - newest.ms) / MS_PER_DAY) + 1),
      authors: [...new Set(sameDay.map((c) => String(c.author || 'unknown')))].sort(byString)
    };
  }

  // --- who is working where ------------------------------------------------
  const people = new Map();
  const areaAuthors = new Map();   // area → Map(author → {commits, lastMs})
  for (const c of windowCommits) {
    const author = String(c.author || 'unknown');
    if (!people.has(author)) people.set(author, { author, commits: 0, lastMs: 0, areas: new Map() });
    const p = people.get(author);
    p.commits += 1;
    if (c.ms > p.lastMs) p.lastMs = c.ms;
    for (const f of c.files || []) {
      const a = areaOf(f);
      if (!a) continue;
      p.areas.set(a, (p.areas.get(a) || 0) + 1);
      if (!areaAuthors.has(a)) areaAuthors.set(a, new Map());
      const m = areaAuthors.get(a);
      const prev = m.get(author) || { commits: 0, lastMs: 0 };
      m.set(author, { commits: prev.commits + 1, lastMs: Math.max(prev.lastMs, c.ms) });
    }
  }

  const peopleRows = [...people.values()]
    .sort((a, b) => b.lastMs - a.lastMs || b.commits - a.commits || byString(a.author, b.author))
    .slice(0, MAX_PEOPLE)
    .map((p) => ({
      author: p.author,
      commits: p.commits,
      lastSeen: new Date(p.lastMs).toISOString(),
      hoursAgo: Math.round(((nowMs - p.lastMs) / 3_600_000) * 10) / 10,
      areas: [...p.areas.entries()]
        .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
        .slice(0, MAX_AREAS_PER_PERSON)
        .map(([area, commits]) => ({ area, commits }))
    }));

  // The lease board's question, answered from evidence instead of intent.
  const collisions = [...areaAuthors.entries()]
    .filter(([, m]) => m.size > 1)
    .map(([area, m]) => ({
      area,
      authors: [...m.entries()]
        .sort((a, b) => b[1].lastMs - a[1].lastMs || byString(a[0], b[0]))
        .map(([author, v]) => ({ author, commits: v.commits, lastSeen: new Date(v.lastMs).toISOString() })),
      commits: [...m.values()].reduce((s, v) => s + v.commits, 0)
    }))
    .sort((a, b) => b.authors.length - a.authors.length || b.commits - a.commits || byString(a.area, b.area))
    .slice(0, MAX_COLLISIONS);

  return {
    today,
    lastActiveDay,
    people: peopleRows,
    collisions,
    window: {
      days: recentDays,
      from: new Date(windowStartMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      commits: windowCommits.length
    },
    // Stated, not assumed: "today" depends on a timezone and on how far back
    // the commit window reaches. A reader who sees zero must be able to tell
    // "nothing happened" from "the window did not go back far enough".
    provenance: {
      basis: 'measured',
      source: 'git log (same parsed-commit cache as the intel endpoints)',
      scanned: dated.length,
      truncated: dated.length >= (Number(opts.scannedLimit) || Infinity),
      merges: 'merge commits carry no files and are counted separately, never as work',
      note: 'authorship is what git recorded, not who was assigned; a rebase or ' +
        'squash re-dates the work under whoever pushed it. One human committing ' +
        'under two names appears as two people — fix it in .mailmap, which this ' +
        'reads through git, rather than guessing identities here.'
    }
  };
}

/**
 * PURE. Local midnight for an instant, given the offset minutes that
 * `Date.prototype.getTimezoneOffset` reports (positive WEST of UTC).
 */
export function localDayStart(nowMs, tzOffsetMinutes) {
  const offsetMs = -Number(tzOffsetMinutes || 0) * 60_000;
  const local = new Date(nowMs + offsetMs);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return { dayStartMs: midnightLocal - offsetMs, offsetMs };
}

/** GET /api/activity — today's landed work and who is where. */
export function apiActivity(api, res, url) {
  const days = Number(url && url.searchParams.get('days')) || DEFAULT_RECENT_DAYS;
  const limit = DEFAULT_COMMIT_WINDOW;
  let commits;
  try {
    commits = cachedCommits(api.root, { limit });
  } catch (error) {
    commits = commitsSafe(api.root);
    if (!commits.length) {
      sendJson(res, 200, {
        degraded: true,
        reason: `git log unavailable: ${(error && error.message) || error}`,
        ...liveMeta(api.root)
      });
      return;
    }
  }
  const nowMs = Date.now();
  const { dayStartMs, offsetMs } = localDayStart(nowMs, new Date(nowMs).getTimezoneOffset());
  const payload = summarizeActivity(commits, {
    nowMs, dayStartMs, offsetMs, recentDays: days, scannedLimit: limit
  });
  sendJson(res, 200, { ...payload, ...liveMeta(api.root) });
}
