/**
 * git-intel.mjs — language-agnostic git-intelligence core (strategy M2.5, ADR 0028).
 *
 * PURE library: importing this module has zero side effects (no argv parsing,
 * no fs/git access, no clocks). Every function takes parsed inputs and — where
 * time matters — an explicit `now`; Date.now() is never called here, so the
 * same inputs always produce byte-identical outputs (Praktiken-Katalog:
 * "Determinismus als getesteter Vertrag").
 *
 * Signals (all derived from a single `git log --name-only` stream):
 *   - parseLog(raw)        → [{hash, author, dateIso, files}]
 *   - hotspots(commits)    → churn frequency with exponential recency decay
 *   - coChange(commits)    → directed "who changes A usually changes B" pairs
 *   - ownership(commits)   → per-file / per-path-prefix authors + bus factor
 *   - riskFactors(files)   → factors for a change-set (hotspot hits, missing
 *                            co-change partners). Factors only — no 0-10
 *                            aggregation yet; calibration against real
 *                            revert/fix history comes later per the plan.
 *
 * Every result object is confidence-stamped with provenance
 * ({basis:'measured', source:'git-log', window:{commits,since,until}}) per the
 * Praktiken-Katalog. The thin CLI lives in brain-intel.mjs; log-parsing
 * conventions (US/RS separators, --FILES-- marker) mirror brain-why.mjs.
 */

// Unit/record-separator control chars: safe field/record delimiters for a
// `git log --pretty` format because commit metadata never contains them.
const FIELD_SEP = '\x1f'; // US — between fields of one commit
const RECORD_SEP = '\x1e'; // RS — between commits

const MS_PER_DAY = 86_400_000;

export const DEFAULT_HALF_LIFE_DAYS = 90;
export const DEFAULT_MIN_SUPPORT = 3;
export const DEFAULT_MIN_CONFIDENCE = 0.4;
// Commits touching more files than this are excluded from co-change stats:
// merge/format/rename sweeps pair everything with everything and poison the
// signal. Parameterized so callers can tune it.
export const DEFAULT_MAX_FILES_PER_COMMIT = 30;
const TOP_AUTHORS = 5;

// ---------------------------------------------------------------------------
// git log format + parsing
// ---------------------------------------------------------------------------

/**
 * PURE. Build the `git log` argv that produces the stream parseLog() reads.
 * `since` may be a rev (→ `<rev>..HEAD`) or an ISO-ish date (→ `--since=`).
 */
export function gitLogArgs({ limit, since } = {}) {
  const pretty = `${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%aI--FILES--`;
  const args = ['log', `--pretty=format:${pretty}`, '--name-only', '--no-color'];
  if (limit && Number(limit) > 0) args.push(`-n${Number(limit)}`);
  if (since) {
    if (/^\d{4}(-\d{2}(-\d{2})?)?([ T].*)?$/.test(since)) args.push(`--since=${since}`);
    else args.push(`${since}..HEAD`);
  }
  return args;
}

/**
 * PURE. Parse the delimited `git log --name-only` stream from gitLogArgs()
 * into commit records. Merge commits (no file list under --name-only) come
 * through with files: [] and are harmless downstream.
 *
 * @returns {Array<{hash: string, author: string, dateIso: string, files: string[]}>}
 */
export function parseLog(rawGitLog) {
  const text = String(rawGitLog || '');
  if (!text.trim()) return [];
  const commits = [];
  for (const block of text.split(RECORD_SEP)) {
    const trimmed = block.replace(/^\s+/, '');
    if (!trimmed) continue;
    const [meta, filesPart = ''] = trimmed.split('--FILES--');
    const [hash = '', author = '', dateIso = ''] = meta.split(FIELD_SEP);
    if (!hash.trim()) continue;
    const files = filesPart
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    commits.push({
      hash: hash.trim(),
      author: author.trim(),
      dateIso: dateIso.trim(),
      files
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// shared helpers (all PURE)
// ---------------------------------------------------------------------------

/** Provenance stamp for a commit window (Praktiken-Katalog: confidence stamping). */
export function provenanceOf(commits = []) {
  let since = '';
  let until = '';
  for (const c of commits) {
    if (!c.dateIso) continue;
    if (!since || c.dateIso < since) since = c.dateIso;
    if (!until || c.dateIso > until) until = c.dateIso;
  }
  return {
    basis: 'measured',
    source: 'git-log',
    window: { commits: commits.length, since: since || null, until: until || null }
  };
}

/** Coerce `now` (epoch ms or ISO string) or throw — pure fns never call Date.now(). */
function requireNow(now, fn) {
  const ms = typeof now === 'number' ? now : Date.parse(String(now ?? ''));
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${fn}: \`now\` is required (epoch ms or ISO string); pure functions never call Date.now()`);
  }
  return ms;
}

function round(n, digits) {
  return Number(n.toFixed(digits));
}

/** Deterministic string compare (byte order — NOT localeCompare, which is locale-dependent). */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueFiles(files = []) {
  return [...new Set(files)];
}

// ---------------------------------------------------------------------------
// hotspots — churn × recency decay
// ---------------------------------------------------------------------------

/**
 * PURE. Per-file churn score with exponential recency decay: each commit
 * touching the file contributes 0.5^(ageDays / halfLifeDays), so a commit
 * `halfLifeDays` old counts half as much as one made "now". Deterministic
 * given `now` (required — epoch ms or ISO string).
 *
 * @returns {{basis, source, window, params, files: Array<{file, score, commits, lastCommit}>}}
 */
export function hotspots(commits, { now, halfLifeDays = DEFAULT_HALF_LIFE_DAYS } = {}) {
  const nowMs = requireNow(now, 'hotspots()');
  const perFile = new Map();
  for (const c of commits) {
    const t = Date.parse(c.dateIso);
    // Unparseable date → no recency weight, but the raw count still registers.
    const ageDays = Number.isFinite(t) ? Math.max(0, (nowMs - t) / MS_PER_DAY) : Infinity;
    const weight = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / halfLifeDays) : 0;
    for (const file of uniqueFiles(c.files)) {
      const entry = perFile.get(file) || { file, score: 0, commits: 0, lastCommit: '' };
      entry.score += weight;
      entry.commits += 1;
      if (c.dateIso && c.dateIso > entry.lastCommit) entry.lastCommit = c.dateIso;
      perFile.set(file, entry);
    }
  }
  const files = [...perFile.values()]
    .map((e) => ({ ...e, score: round(e.score, 6) }))
    .sort((a, b) => b.score - a.score || b.commits - a.commits || byString(a.file, b.file));
  return {
    ...provenanceOf(commits),
    params: { halfLifeDays, now: new Date(nowMs).toISOString() },
    files
  };
}

// ---------------------------------------------------------------------------
// co-change — association rules between files
// ---------------------------------------------------------------------------

/**
 * PURE. Directed co-change pairs: {a, b, together, confidence} where
 * confidence = P(b | a) = together / commits(a). Both directions are emitted
 * when they clear the thresholds (P(b|a) and P(a|b) differ). Commits touching
 * more than `maxFilesPerCommit` files are excluded entirely (counts and pairs)
 * so merge/format sweeps cannot poison the signal.
 *
 * @returns {{basis, source, window, params, skippedLargeCommits, pairs}}
 */
export function coChange(commits, {
  minSupport = DEFAULT_MIN_SUPPORT,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT
} = {}) {
  const fileCounts = new Map();
  const pairCounts = new Map(); // 'a\0b' with a < b → count
  let skippedLargeCommits = 0;
  for (const c of commits) {
    const files = uniqueFiles(c.files);
    if (!files.length) continue;
    if (files.length > maxFilesPerCommit) { skippedLargeCommits += 1; continue; }
    for (const f of files) fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
    const sorted = [...files].sort(byString);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const pairs = [];
  for (const [key, together] of pairCounts) {
    if (together < minSupport) continue;
    const [x, y] = key.split('\0');
    for (const [a, b] of [[x, y], [y, x]]) {
      const confidence = together / fileCounts.get(a);
      if (confidence < minConfidence) continue;
      pairs.push({ a, b, together, confidence: round(confidence, 4) });
    }
  }
  pairs.sort((p, q) =>
    q.confidence - p.confidence || q.together - p.together || byString(p.a, q.a) || byString(p.b, q.b));
  return {
    ...provenanceOf(commits),
    params: { minSupport, minConfidence, maxFilesPerCommit },
    skippedLargeCommits,
    pairs
  };
}

// ---------------------------------------------------------------------------
// ownership — authors + bus factor
// ---------------------------------------------------------------------------

/**
 * PURE. Bus factor over an author→count map: the smallest number of authors
 * that together cover >= 50% of the commits.
 */
export function busFactorOf(authorCounts) {
  const counts = [...authorCounts.values()].sort((a, b) => b - a);
  const total = counts.reduce((s, n) => s + n, 0);
  if (!total) return 0;
  let covered = 0;
  for (let i = 0; i < counts.length; i++) {
    covered += counts[i];
    if (covered * 2 >= total) return i + 1;
  }
  return counts.length;
}

function ownershipEntry(pathKey, authorCounts) {
  const commits = [...authorCounts.values()].reduce((s, n) => s + n, 0);
  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
    .slice(0, TOP_AUTHORS)
    .map(([author, n]) => ({ author, commits: n, share: round(n / commits, 4) }));
  return { path: pathKey, commits, topAuthors, busFactor: busFactorOf(authorCounts) };
}

/** All ancestor directory prefixes of a path ('a/b/c.js' → ['a', 'a/b']); root files → ['.']. */
function prefixesOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return ['.'];
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * PURE. Per-file and per-path-prefix ownership: top authors with commit share
 * and the bus factor (smallest #authors covering >= 50% of commits). Prefix
 * stats count each (commit, prefix) once, however many files the commit
 * touched under that prefix.
 *
 * @returns {{basis, source, window, files: [...], prefixes: [...]}}
 */
export function ownership(commits) {
  const byFile = new Map(); // file → Map(author → commits)
  const byPrefix = new Map(); // prefix → Map(author → commits)
  for (const c of commits) {
    const author = c.author || '(unknown)';
    const files = uniqueFiles(c.files);
    const seenPrefixes = new Set();
    for (const file of files) {
      const m = byFile.get(file) || new Map();
      m.set(author, (m.get(author) || 0) + 1);
      byFile.set(file, m);
      for (const prefix of prefixesOf(file)) seenPrefixes.add(prefix);
    }
    for (const prefix of seenPrefixes) {
      const m = byPrefix.get(prefix) || new Map();
      m.set(author, (m.get(author) || 0) + 1);
      byPrefix.set(prefix, m);
    }
  }
  const toEntries = (map) => [...map.entries()]
    .map(([key, counts]) => ownershipEntry(key, counts))
    .sort((a, b) => b.commits - a.commits || byString(a.path, b.path));
  return {
    ...provenanceOf(commits),
    files: toEntries(byFile),
    prefixes: toEntries(byPrefix)
  };
}

// ---------------------------------------------------------------------------
// risk factors — seed of the change-risk score (factors only, no aggregation)
// ---------------------------------------------------------------------------

/**
 * PURE. For a change-set, report git-history risk factors:
 *   - hotspotHits: touched files that appear in the hotspot ranking (with rank).
 *   - missingPartners: usual co-change partners of touched files that are NOT
 *     in the set — one entry per missing file, keeping the strongest
 *     (changed → missing) association.
 *
 * Deliberately factors-only: no 0-10 score. Weights get calibrated against
 * real revert/fix history later (Praktiken-Katalog: "Kalibrierung statt
 * Konstanten"), not hand-tuned here.
 *
 * @param {string[]} files change-set paths (repo-relative)
 * @param {{hotspots?: object, coChange?: object}} signals outputs of hotspots()/coChange()
 */
export function riskFactors(files, { hotspots: hotspotsResult, coChange: coChangeResult } = {}) {
  const set = new Set(files);
  const rankedFiles = (hotspotsResult && hotspotsResult.files) || [];
  const hotspotHits = [];
  rankedFiles.forEach((e, i) => {
    if (set.has(e.file)) hotspotHits.push({ file: e.file, rank: i + 1, score: e.score, commits: e.commits });
  });

  const pairs = (coChangeResult && coChangeResult.pairs) || [];
  const missingByFile = new Map(); // missing file → strongest association
  for (const p of pairs) {
    if (!set.has(p.a) || set.has(p.b)) continue;
    const prev = missingByFile.get(p.b);
    if (!prev || p.confidence > prev.confidence ||
        (p.confidence === prev.confidence && p.together > prev.together)) {
      missingByFile.set(p.b, { missing: p.b, changed: p.a, together: p.together, confidence: p.confidence });
    }
  }
  const missingPartners = [...missingByFile.values()]
    .sort((a, b) => b.confidence - a.confidence || b.together - a.together || byString(a.missing, b.missing));

  const window = (hotspotsResult && hotspotsResult.window) ||
    (coChangeResult && coChangeResult.window) ||
    { commits: 0, since: null, until: null };
  return {
    basis: 'measured',
    source: 'git-log',
    window,
    files: [...set].sort(byString),
    hotspotHits,
    missingPartners
  };
}
