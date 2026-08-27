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
 *   - parseLog(raw)        → [{hash, author, dateIso, subject, files}]
 *   - hotspots(commits)    → churn frequency with exponential recency decay
 *   - coChange(commits)    → directed "who changes A usually changes B" pairs
 *   - ownership(commits)   → per-file / per-path-prefix authors + bus factor
 *   - riskFactors(files)   → factors for a change-set (hotspot hits, missing
 *                            co-change partners) without aggregation.
 *   - riskScore(files)     → 0-10 change-risk score over weighted factors
 *                            (RISK_WEIGHTS are reviewable defaults, NOT truth —
 *                            validate them with calibrateRisk before trusting).
 *   - calibrateRisk(...)   → retrospective in-repo validation of the score
 *                            against the repo's own fix/revert history
 *                            (leakage-free prefix scoring + rank AUC).
 *   - fileHealth(commits)  → per-FILE 0-10 health/danger score (churn
 *                            percentile × co-change scatter × bus factor ×
 *                            fix density; FILE_HEALTH_WEIGHTS are reviewable
 *                            defaults — validate with calibrateFileHealth).
 *   - calibrateFileHealth  → leakage-free validation that today's file scores
 *                            predict near-future fixes (cut-point replay).
 *
 * Every result object is confidence-stamped with provenance
 * ({basis:'measured', source:'git-log', window:{commits,since,until}}) per the
 * Praktiken-Katalog. The thin CLI lives in brain-intel.mjs; log-parsing
 * conventions (US/RS separators, --FILES-- marker) mirror brain-why.mjs.
 *
 * Lease matching delegates to lease-overlap.mjs (itself pure), the single
 * canonical glob-overlap module — importing it keeps this file side-effect
 * free.
 */
import { targetMatchesFile, UnsupportedPatternError } from './lease-overlap.mjs';

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
  const pretty = `${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s--FILES--`;
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
 * @returns {Array<{hash: string, author: string, dateIso: string, subject: string, files: string[]}>}
 */
export function parseLog(rawGitLog) {
  const text = String(rawGitLog || '');
  if (!text.trim()) return [];
  const commits = [];
  for (const block of text.split(RECORD_SEP)) {
    const trimmed = block.replace(/^\s+/, '');
    if (!trimmed) continue;
    const [meta, filesPart = ''] = trimmed.split('--FILES--');
    const [hash = '', author = '', dateIso = '', subject = ''] = meta.split(FIELD_SEP);
    if (!hash.trim()) continue;
    const files = filesPart
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    commits.push({
      hash: hash.trim(),
      author: author.trim(),
      dateIso: dateIso.trim(),
      subject: subject.trim(),
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

// ---------------------------------------------------------------------------
// risk score — 0-10 aggregation over weighted factors
// ---------------------------------------------------------------------------

/**
 * REVIEWABLE DEFAULT weights — not calibrated truth. Per the Praktiken-Katalog
 * ("Kalibrierung statt Konstanten") these are starting priors to be validated
 * against real fix/revert history via calibrateRisk(); pass `weights` to
 * riskScore() to override them once calibration says otherwise. Rationale for
 * the defaults: hotspot churn is the strongest single defect predictor in the
 * literature, missing co-change partners are the most actionable signal,
 * blast radius and lease conflicts are situational amplifiers.
 */
export const RISK_WEIGHTS = Object.freeze({
  hotspotOverlap: 0.35,
  missingCoChange: 0.3,
  blastRadius: 0.2,
  leaseConflicts: 0.15
});

/** Saturation points: the raw value at which each factor maxes out at 1.0. */
export const RISK_SATURATION = Object.freeze({
  missingConfidenceSum: 2, // two full-confidence missing partners saturate
  blastDependents: 10, // ten downstream dependents saturate
  leaseConflicts: 2 // two overlapping leases saturate
});

/**
 * PURE. Does a lease target (exact path, directory prefix, or glob) cover a
 * file? Thin wrapper over the canonical lease-overlap.mjs semantics (strategy
 * M3: one implementation, one truth — brief and risk agree on what "leased"
 * means because they run the same code). Kept total for risk scoring:
 * unsupported/legacy targets never throw here, they simply don't match.
 */
export function leaseTargetMatches(target, file) {
  try {
    return targetMatchesFile(target, file);
  } catch (error) {
    if (error instanceof UnsupportedPatternError) return false;
    throw error;
  }
}

/**
 * PURE. 0-10 change-risk score for a change-set: weighted aggregation of
 *   - hotspot-overlap: best churn-decay percentile among touched files
 *     (rank 1 of N → 1.0; absent from the ranking → 0).
 *   - missing-co-change: summed confidence of usual partners NOT in the set,
 *     saturating at RISK_SATURATION.missingConfidenceSum.
 *   - blast-radius (only when provided): downstream dependents of touched
 *     files, saturating at RISK_SATURATION.blastDependents.
 *   - lease-conflicts (only when provided): touched files overlapping active
 *     leases, saturating at RISK_SATURATION.leaseConflicts.
 *
 * score = 10 × Σ(weight_i × raw_i) / Σ(weight_i over PROVIDED factors), one
 * decimal — omitted optional factors do not depress the score. Total function:
 * empty/missing history yields score contributions of 0 plus
 * reason: 'insufficient history'; the result is never NaN and always carries
 * its factors (no bare numbers). Deterministic: no clocks, sorted output.
 *
 * @param {string[]} files change-set paths (repo-relative)
 * @param {{
 *   hotspots?: object, coChange?: object,
 *   blastRadius?: {dependents: string[], source?: string},
 *   leases?: Array<{target: string, lockedBy?: string, until?: string, notes?: string}>,
 *   weights?: object
 * }} inputs
 */
export function riskScore(files, {
  hotspots: hotspotsResult,
  coChange: coChangeResult,
  blastRadius,
  leases,
  weights
} = {}) {
  const w = { ...RISK_WEIGHTS, ...(weights || {}) };
  const base = riskFactors(files, { hotspots: hotspotsResult, coChange: coChangeResult });
  const historyCommits = base.window.commits || 0;
  const fileSet = new Set(base.files);
  const factors = [];
  const pushFactor = (name, weight, raw, evidence, data) => {
    factors.push({
      name,
      weight,
      raw: round(raw, 4),
      contribution: round(weight * raw, 4),
      evidence,
      data
    });
  };

  // 1. hotspot-overlap: best churn percentile among touched files.
  const ranked = (hotspotsResult && hotspotsResult.files) || [];
  let hotspotRaw = 0;
  let topHit = null;
  for (const hit of base.hotspotHits) {
    const pct = ranked.length ? (ranked.length - hit.rank + 1) / ranked.length : 0;
    if (pct > hotspotRaw) { hotspotRaw = pct; topHit = hit; }
  }
  pushFactor(
    'hotspot-overlap', w.hotspotOverlap, hotspotRaw,
    topHit
      ? `${topHit.file} is churn rank #${topHit.rank} of ${ranked.length} ` +
        `(percentile ${round(hotspotRaw, 2)}); ${base.hotspotHits.length} touched hotspot(s)`
      : (historyCommits ? 'no touched file appears in the churn ranking' : 'insufficient history'),
    { hits: base.hotspotHits }
  );

  // 2. missing co-change partners: count × confidence, saturating.
  const confidenceSum = base.missingPartners.reduce((s, m) => s + m.confidence, 0);
  const missingRaw = Math.min(1, confidenceSum / RISK_SATURATION.missingConfidenceSum);
  const missingPreview = base.missingPartners.slice(0, 3)
    .map((m) => `${m.missing} (${Math.round(m.confidence * 100)}%)`).join(', ');
  pushFactor(
    'missing-co-change', w.missingCoChange, missingRaw,
    base.missingPartners.length
      ? `${base.missingPartners.length} usual partner(s) missing, ` +
        `summed confidence ${round(confidenceSum, 2)}: ${missingPreview}` +
        (base.missingPartners.length > 3 ? ', …' : '')
      : (historyCommits ? 'no usual co-change partners missing' : 'insufficient history'),
    { missingPartners: base.missingPartners }
  );

  // 3. blast radius — only when a dependency graph was provided.
  if (blastRadius && Array.isArray(blastRadius.dependents)) {
    const dependents = [...new Set(blastRadius.dependents)]
      .filter((d) => !fileSet.has(d))
      .sort(byString);
    const blastRaw = Math.min(1, dependents.length / RISK_SATURATION.blastDependents);
    const preview = dependents.slice(0, 3).join(', ');
    pushFactor(
      'blast-radius', w.blastRadius, blastRaw,
      dependents.length
        ? `${dependents.length} downstream dependent file(s): ${preview}` +
          (dependents.length > 3 ? ', …' : '')
        : 'no downstream dependents in the graph',
      { dependents, source: blastRadius.source || 'graph' }
    );
  }

  // 4. lease / workstream conflicts — only when lease state was provided.
  if (Array.isArray(leases)) {
    const conflicts = [];
    for (const lease of leases) {
      // Legacy lease rows may hold comma/space-separated target lists; split
      // exactly like brain-brief/brain-lease so all consumers agree per row.
      const targets = String(lease.target || '').split(/[,\s]+/).filter(Boolean);
      for (const target of targets) {
      for (const file of base.files) {
        if (leaseTargetMatches(target, file)) {
          conflicts.push({
            file,
            target: lease.target,
            lockedBy: lease.lockedBy || '',
            until: lease.until || ''
          });
        }
      }
      }
    }
    conflicts.sort((a, b) => byString(a.file, b.file) || byString(a.target, b.target));
    const leaseRaw = Math.min(1, conflicts.length / RISK_SATURATION.leaseConflicts);
    const first = conflicts[0];
    pushFactor(
      'lease-conflicts', w.leaseConflicts, leaseRaw,
      conflicts.length
        ? `${conflicts.length} touched file(s) overlap active lease(s), e.g. ${first.file} ` +
          `⊗ '${first.target}'${first.lockedBy ? ` held by ${first.lockedBy}` : ''}` +
          `${first.until ? ` until ${first.until}` : ''}`
        : 'no touched file overlaps an active lease',
      { conflicts }
    );
  }

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const weighted = factors.reduce((s, f) => s + f.weight * f.raw, 0);
  const score = totalWeight > 0 ? Number((10 * (weighted / totalWeight)).toFixed(1)) : 0;

  const result = {
    basis: 'measured',
    source: 'git-log',
    window: base.window,
    params: { weights: w, saturation: { ...RISK_SATURATION } },
    files: base.files,
    score,
    factors
  };
  if (!historyCommits) result.reason = 'insufficient history';
  return result;
}

// ---------------------------------------------------------------------------
// file health — per-file 0-10 danger score (our answer to "code health")
// ---------------------------------------------------------------------------

/**
 * REVIEWABLE DEFAULT weights for fileHealth() — not calibrated truth (same
 * discipline as RISK_WEIGHTS: "Kalibrierung statt Konstanten"). Validate them
 * against near-future fixes with calibrateFileHealth() before trusting the
 * ranking; pass `weights` to override. Rationale: churn is the strongest
 * single defect predictor, fix density is direct evidence of past breakage,
 * scatter (tangled coupling) and bus factor are structural amplifiers.
 */
export const FILE_HEALTH_WEIGHTS = Object.freeze({
  churnPercentile: 0.35,
  coChangeScatter: 0.2,
  busFactor: 0.2,
  fixDensity: 0.25
});

/** Saturation: distinct co-change partners at which scatter maxes out at 1.0. */
export const FILE_HEALTH_SATURATION = Object.freeze({
  scatterPartners: 8
});

/** A pair must have co-changed at least this often to count as a scatter partner. */
export const DEFAULT_SCATTER_SUPPORT = 2;
/** Below this many commits a file's score is flagged lowConfidence, not trusted. */
export const DEFAULT_MIN_HEALTH_COMMITS = 3;

/**
 * PURE. Per-file 0-10 health/danger score (10 = most dangerous), aggregated
 * from four git-history factors — every factor carries its raw value and a
 * human-readable evidence string (no bare numbers):
 *   - churn-percentile: the file's percentile in the hotspots() decay ranking
 *     (rank 1 of N → 1.0) — recent churn concentration.
 *   - co-change-scatter: distinct partner files it co-changes with (pairs with
 *     support ≥ DEFAULT_SCATTER_SUPPORT, bulk commits excluded), saturating at
 *     FILE_HEALTH_SATURATION.scatterPartners — tangled coupling.
 *   - bus-factor: 1 / busFactor of the file's ownership() — busFactor 1
 *     (single effective owner) → raw 1.0.
 *   - fix-density: share of the file's commits whose subject matches
 *     DEFECT_FIX_REGEX (bulk commits excluded from both counts, mirroring the
 *     coChange sweep-exclusion) — a file that keeps getting fixed keeps
 *     breaking.
 *
 * score = 10 × Σ(weight_i × raw_i) / Σ(weight_i), one decimal. Total function:
 * files with fewer than DEFAULT_MIN_HEALTH_COMMITS commits still get a score
 * but are flagged lowConfidence: true with reason 'insufficient history' —
 * honest flagging instead of fake precision. Deterministic: `now` is required
 * (never Date.now()), ordering is byte-stable (score desc, then byString).
 *
 * @param {Array<{hash, author, dateIso, subject, files}>} commits parseLog() output
 * @returns {{basis, source, window, params, files: Array<{file, score, commits,
 *   lastCommit, lowConfidence?, reason?, factors: Array<{name, weight, raw,
 *   contribution, evidence}>}>}}
 */
export function fileHealth(commits, {
  now,
  weights,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT
} = {}) {
  const nowMs = requireNow(now, 'fileHealth()');
  const w = { ...FILE_HEALTH_WEIGHTS, ...(weights || {}) };
  const totalWeight = w.churnPercentile + w.coChangeScatter + w.busFactor + w.fixDensity;

  const hs = hotspots(commits, { now: nowMs, halfLifeDays });
  const own = ownership(commits);
  const cc = coChange(commits, {
    minSupport: DEFAULT_SCATTER_SUPPORT,
    minConfidence: 0,
    maxFilesPerCommit
  });

  const ownByFile = new Map(own.files.map((f) => [f.path, f]));
  // Directed pairs are emitted both ways, so partners of f = all b with a === f.
  const partnersByFile = new Map();
  for (const p of cc.pairs) {
    const list = partnersByFile.get(p.a) || [];
    list.push(p.b);
    partnersByFile.set(p.a, list);
  }
  // Fix density excludes bulk commits from BOTH counts (same sweep-exclusion
  // rationale as coChange: a "fix: format everything" touching 40 files says
  // nothing about any single one of them).
  const fixCounts = new Map(); // file → {fixes, total}
  for (const c of commits) {
    const files = uniqueFiles(c.files);
    if (!files.length || files.length > maxFilesPerCommit) continue;
    const isFix = DEFECT_FIX_REGEX.test(c.subject || '');
    for (const f of files) {
      const entry = fixCounts.get(f) || { fixes: 0, total: 0 };
      entry.total += 1;
      if (isFix) entry.fixes += 1;
      fixCounts.set(f, entry);
    }
  }

  const ranked = hs.files;
  const files = ranked.map((hot, idx) => {
    const file = hot.file;
    const factors = [];
    const pushFactor = (name, weight, raw, evidence) => {
      factors.push({ name, weight, raw: round(raw, 4), contribution: round(weight * raw, 4), evidence });
    };

    // 1. churn-percentile: rank in the decay ranking.
    const rank = idx + 1;
    const churnRaw = ranked.length ? (ranked.length - rank + 1) / ranked.length : 0;
    pushFactor('churn-percentile', w.churnPercentile, churnRaw,
      `churn rank #${rank} of ${ranked.length} (percentile ${round(churnRaw, 2)})`);

    // 2. co-change-scatter: distinct recurring partners, saturating.
    const partners = [...(partnersByFile.get(file) || [])].sort(byString);
    const scatterRaw = Math.min(1, partners.length / FILE_HEALTH_SATURATION.scatterPartners);
    pushFactor('co-change-scatter', w.coChangeScatter, scatterRaw,
      partners.length
        ? `co-changes with ${partners.length} distinct partner(s) (≥${DEFAULT_SCATTER_SUPPORT}×): ` +
          partners.slice(0, 3).join(', ') + (partners.length > 3 ? ', …' : '')
        : 'no recurring co-change partners');

    // 3. bus-factor: 1/busFactor — single effective owner saturates at 1.0.
    const o = ownByFile.get(file);
    const bf = o ? o.busFactor : 0;
    const busRaw = bf > 0 ? 1 / bf : 0;
    const topAuthor = o && o.topAuthors[0];
    pushFactor('bus-factor', w.busFactor, busRaw,
      topAuthor
        ? `bus factor ${bf} — ${topAuthor.author} owns ${Math.round(topAuthor.share * 100)}% of ${o.commits} commits`
        : 'no ownership history');

    // 4. fix-density: how often does touching this file mean repairing it?
    const fc = fixCounts.get(file);
    const fixRaw = fc && fc.total ? fc.fixes / fc.total : 0;
    pushFactor('fix-density', w.fixDensity, fixRaw,
      fc && fc.total
        ? (fc.fixes
          ? `${fc.fixes} of ${fc.total} commits are fix/revert commits (${Math.round(fixRaw * 100)}%)`
          : `no fix-pattern commits in ${fc.total} commits`)
        : 'only bulk commits — fix density unknown');

    const weighted = factors.reduce((s, f) => s + f.weight * f.raw, 0);
    const score = totalWeight > 0 ? Number((10 * (weighted / totalWeight)).toFixed(1)) : 0;
    const entry = { file, score, commits: hot.commits, lastCommit: hot.lastCommit, factors };
    if (hot.commits < DEFAULT_MIN_HEALTH_COMMITS) {
      entry.lowConfidence = true;
      entry.reason = 'insufficient history';
    }
    return entry;
  });

  files.sort((a, b) => b.score - a.score || byString(a.file, b.file));

  return {
    ...provenanceOf(commits),
    params: {
      weights: w,
      saturation: { ...FILE_HEALTH_SATURATION },
      scatterSupport: DEFAULT_SCATTER_SUPPORT,
      minCommits: DEFAULT_MIN_HEALTH_COMMITS,
      halfLifeDays,
      maxFilesPerCommit,
      fixPattern: String(DEFECT_FIX_REGEX),
      now: new Date(nowMs).toISOString()
    },
    files
  };
}

// ---------------------------------------------------------------------------
// calibration — retrospective validation against the repo's own history
// ---------------------------------------------------------------------------

/**
 * Commit-subject heuristic for "this commit repairs something" — the labeling
 * signal for calibration. Mirrors the fix/hotfix branch conventions already
 * used in brain-guard.mjs/brain-route.mjs and the Closes/Fixes heuristic in
 * brain-why.mjs, extended with revert/regression.
 */
export const DEFECT_FIX_REGEX = /\b(fix(es|ed)?|hotfix|revert(s|ed)?|regression)\b/i;

/**
 * PURE. Rank-based ROC-AUC (Mann-Whitney U with average ranks for ties):
 * the probability that a random defective commit scores higher than a random
 * clean one. Returns null when one class is empty (AUC undefined).
 */
export function rankAuc(scores, labels) {
  const n = scores.length;
  const pos = labels.filter(Boolean).length;
  const neg = n - pos;
  if (!pos || !neg) return null;
  const order = scores.map((s, i) => ({ s, y: labels[i] ? 1 : 0 })).sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && order[j].s === order[i].s) j++;
    const avgRank = (i + 1 + j) / 2; // ranks i+1 … j share the average
    for (let k = i; k < j; k++) if (order[k].y) rankSumPos += avgRank;
    i = j;
  }
  return round((rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg), 4);
}

/**
 * PURE. Retrospective self-calibration of riskScore() against the repo's own
 * history. METHOD (and its honest limits):
 *   - Commits are ordered chronologically (dateIso, then hash — deterministic).
 *   - Skipped: merge commits (no files under --name-only) and bulk commits
 *     (> maxFilesPerCommit files — same sweep-exclusion as coChange).
 *   - Censored: commits younger than `horizonDays` relative to the newest
 *     commit in the log — their defect label cannot be observed yet.
 *   - Each remaining commit is scored with riskScore() computed ONLY from the
 *     strict chronological prefix before it (hotspots/coChange rebuilt per
 *     commit, `now` = the commit's own timestamp — zero leakage, zero clocks).
 *     Only the two git-history factors participate; blast radius and leases
 *     cannot be reconstructed historically and are omitted (the score
 *     normalizes over provided factors, so this is consistent).
 *   - Label: "defective" iff a later commit within `horizonDays` whose subject
 *     matches DEFECT_FIX_REGEX touches ≥1 of the same files.
 *   - Output: score-quantile vs defect-rate table + rank-based ROC-AUC.
 *
 * This is IN-REPO SELF-CALIBRATION, not a cross-repo benchmark: the fix
 * heuristic is a proxy label, and a repo validates the weights only against
 * its own past. Treat AUC ≥ 0.6 as the minimum bar before trusting --score.
 *
 * @param {Array<{hash, author, dateIso, subject, files}>} commits parseLog() output
 */
export function calibrateRisk(commits, {
  window = 300,
  horizonDays = 30,
  weights,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT,
  fixRegex = DEFECT_FIX_REGEX
} = {}) {
  const horizonMs = horizonDays * MS_PER_DAY;
  // Sort by epoch ms, not by ISO string: author dates keep per-author UTC
  // offsets, and lexical ISO order is not chronological across offsets.
  const chrono = commits
    .filter((c) => Number.isFinite(Date.parse(c.dateIso)))
    .sort((a, b) => Date.parse(a.dateIso) - Date.parse(b.dateIso) || byString(a.hash, b.hash));
  const lastMs = chrono.length ? Date.parse(chrono[chrono.length - 1].dateIso) : 0;
  const fixMeta = chrono.map((c) => ({
    ms: Date.parse(c.dateIso),
    files: new Set(uniqueFiles(c.files)),
    isFix: fixRegex.test(c.subject || '')
  }));

  let skippedMerge = 0;
  let skippedBulk = 0;
  let censored = 0;
  const eligible = [];
  for (let i = 0; i < chrono.length; i++) {
    const files = uniqueFiles(chrono[i].files);
    if (!files.length) { skippedMerge += 1; continue; }
    if (files.length > maxFilesPerCommit) { skippedBulk += 1; continue; }
    if (lastMs - fixMeta[i].ms < horizonMs) { censored += 1; continue; }
    eligible.push(i);
  }
  const selected = eligible.slice(-window); // most recent `window` labelable commits

  const rows = [];
  for (const i of selected) {
    const c = chrono[i];
    const files = uniqueFiles(c.files);
    // No leakage: signals come exclusively from commits strictly before c,
    // evaluated at c's own timestamp.
    const prefix = chrono.slice(0, i);
    const scored = riskScore(files, {
      hotspots: hotspots(prefix, { now: fixMeta[i].ms, halfLifeDays }),
      coChange: coChange(prefix, { maxFilesPerCommit }),
      weights
    });
    let defective = false;
    let fixedBy = null;
    for (let j = i + 1; j < chrono.length; j++) {
      if (fixMeta[j].ms - fixMeta[i].ms > horizonMs) break; // chrono-sorted → done
      if (!fixMeta[j].isFix) continue;
      if (files.some((f) => fixMeta[j].files.has(f))) {
        defective = true;
        fixedBy = chrono[j].hash;
        break;
      }
    }
    const row = {
      hash: c.hash,
      dateIso: c.dateIso,
      files: files.length,
      score: scored.score,
      defective,
      fixedBy
    };
    if (scored.reason) row.reason = scored.reason;
    rows.push(row);
  }

  const auc = rankAuc(rows.map((r) => r.score), rows.map((r) => r.defective));
  const defects = rows.filter((r) => r.defective).length;

  // Score-quantile vs defect-rate table (quartiles by score rank).
  const bins = 4;
  const sortedRows = [...rows].sort((a, b) => a.score - b.score || byString(a.hash, b.hash));
  const quantiles = [];
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * sortedRows.length) / bins);
    const end = Math.floor(((b + 1) * sortedRows.length) / bins);
    const slice = sortedRows.slice(start, end);
    if (!slice.length) continue;
    const defective = slice.filter((r) => r.defective).length;
    quantiles.push({
      quantile: `Q${b + 1}`,
      scoreMin: slice[0].score,
      scoreMax: slice[slice.length - 1].score,
      commits: slice.length,
      defective,
      defectRate: round(defective / slice.length, 4)
    });
  }

  let verdict;
  if (auc === null) {
    verdict = `AUC undefined over ${rows.length} commits (need both defective and clean commits ` +
      'in the window) — do NOT enable --score by default.';
  } else {
    const vsRandom = auc > 0.5 ? 'better than random' : 'not better than random';
    const gate = auc >= 0.6
      ? 'calibration gate (0.6) met — enabling --score by default is defensible'
      : 'do NOT enable --score by default below 0.6';
    verdict = `AUC ${auc.toFixed(2)} over ${rows.length} commits — weights ${vsRandom}; ${gate}.`;
  }

  return {
    ...provenanceOf(commits),
    method: 'in-repo retrospective self-calibration against this repo\'s own fix/revert ' +
      'history — a proxy label, NOT a cross-repo benchmark',
    params: {
      window,
      horizonDays,
      halfLifeDays,
      maxFilesPerCommit,
      fixPattern: String(fixRegex),
      weights: { ...RISK_WEIGHTS, ...(weights || {}) }
    },
    evaluated: rows.length,
    defective: defects,
    censored,
    skipped: { merge: skippedMerge, bulk: skippedBulk },
    quantiles,
    auc,
    verdict,
    commits: rows
  };
}

/**
 * PURE. Leakage-free validation of fileHealth(): do TODAY's scores predict
 * NEAR-FUTURE fixes? METHOD (and its honest limits):
 *   - Cut point T = `horizonDays` before the newest commit in the log.
 *   - Every file is scored by fileHealth() from commits ≤ T ONLY, evaluated
 *     at `now` = T (zero leakage, zero clocks). `window` > 0 limits that
 *     prefix to its most recent `window` commits (cost bound).
 *   - Label: a file is "defective" iff a commit AFTER T (i.e. within the
 *     horizon, by construction of the cut) whose subject matches `fixRegex`
 *     touches it.
 *   - No leakage by construction: a file first committed after T has no
 *     prefix history and is never scored.
 *   - Output: score-quartile vs fixed-rate table + rank-based ROC-AUC.
 *
 * This is IN-REPO SELF-CALIBRATION, not a cross-repo benchmark: the fix
 * heuristic is a proxy label, and a repo validates the weights only against
 * its own past. Treat AUC ≥ 0.6 as the minimum bar before trusting the
 * health ranking.
 *
 * @param {Array<{hash, author, dateIso, subject, files}>} commits parseLog() output
 */
export function calibrateFileHealth(commits, {
  window = 0,
  horizonDays = 30,
  weights,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT,
  fixRegex = DEFECT_FIX_REGEX
} = {}) {
  // Chronological order by epoch ms (not ISO strings — offsets vary), hash tiebreak.
  const chrono = commits
    .filter((c) => Number.isFinite(Date.parse(c.dateIso)))
    .sort((a, b) => Date.parse(a.dateIso) - Date.parse(b.dateIso) || byString(a.hash, b.hash));
  const lastMs = chrono.length ? Date.parse(chrono[chrono.length - 1].dateIso) : 0;
  const cutMs = lastMs - horizonDays * MS_PER_DAY;

  const prefixAll = chrono.filter((c) => Date.parse(c.dateIso) <= cutMs);
  const prefix = window > 0 ? prefixAll.slice(-window) : prefixAll;
  const future = chrono.filter((c) => Date.parse(c.dateIso) > cutMs);

  const health = chrono.length
    ? fileHealth(prefix, { now: cutMs, weights, halfLifeDays, maxFilesPerCommit })
    : { files: [] };

  // First fix commit after the cut per file (chrono order → earliest wins).
  const fixedBy = new Map();
  let futureFixCommits = 0;
  for (const c of future) {
    if (!fixRegex.test(c.subject || '')) continue;
    futureFixCommits += 1;
    for (const f of uniqueFiles(c.files)) {
      if (!fixedBy.has(f)) fixedBy.set(f, c.hash);
    }
  }

  const rows = health.files.map((f) => {
    const row = { file: f.file, score: f.score, commits: f.commits };
    if (f.lowConfidence) row.lowConfidence = true;
    row.defective = fixedBy.has(f.file);
    row.fixedBy = fixedBy.get(f.file) || null;
    return row;
  });

  const auc = rankAuc(rows.map((r) => r.score), rows.map((r) => r.defective));
  const defects = rows.filter((r) => r.defective).length;

  // Score-quartile vs fixed-rate table (quartiles by score rank).
  const bins = 4;
  const sortedRows = [...rows].sort((a, b) => a.score - b.score || byString(a.file, b.file));
  const quantiles = [];
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * sortedRows.length) / bins);
    const end = Math.floor(((b + 1) * sortedRows.length) / bins);
    const slice = sortedRows.slice(start, end);
    if (!slice.length) continue;
    const defective = slice.filter((r) => r.defective).length;
    quantiles.push({
      quantile: `Q${b + 1}`,
      scoreMin: slice[0].score,
      scoreMax: slice[slice.length - 1].score,
      files: slice.length,
      defective,
      defectRate: round(defective / slice.length, 4)
    });
  }

  let verdict;
  if (auc === null) {
    verdict = `AUC undefined over ${rows.length} files (need both fixed and clean files after ` +
      'the cut) — do NOT trust the health ranking yet.';
  } else {
    const vsRandom = auc > 0.5 ? 'better than random' : 'not better than random';
    const gate = auc >= 0.6
      ? 'calibration gate (0.6) met — the health ranking is defensible on this repo'
      : 'do NOT trust the health ranking below 0.6';
    verdict = `AUC ${auc.toFixed(2)} over ${rows.length} files — health score ${vsRandom} at ` +
      `predicting near-future fixes; ${gate}.`;
  }

  return {
    ...provenanceOf(commits),
    method: 'in-repo self-calibration: do today\'s file-health scores predict near-future ' +
      'fixes in this repo\'s own history — a proxy label, NOT a cross-repo benchmark',
    params: {
      window,
      horizonDays,
      halfLifeDays,
      maxFilesPerCommit,
      fixPattern: String(fixRegex),
      weights: { ...FILE_HEALTH_WEIGHTS, ...(weights || {}) },
      cut: chrono.length ? new Date(cutMs).toISOString() : null
    },
    evaluated: rows.length,
    defective: defects,
    futureCommits: future.length,
    futureFixCommits,
    quantiles,
    auc,
    verdict,
    files: rows
  };
}
