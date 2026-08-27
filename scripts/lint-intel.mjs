/**
 * lint-intel — CONSUME the linters that already exist, then RANK their findings
 * by whether they sit where a change actually hurts. Invoked directly
 * (`node scripts/lint-intel.mjs`); a `brain-lint.mjs` shim can expose it as
 * `project-brain x lint` without this file changing.
 *
 * WHY THIS EXISTS — and why it is deliberately NOT another linter.
 * Competing tools ship dozens of hand-built structural detectors. We do not
 * re-derive them, for two reasons. First, the empirical basis is thin: the
 * canonical complexity-vs-defects correlations are weak (cyclomatic complexity
 * vs defects, Kendall τ ≈ 0.06 in Shepperd/Ince-style replications), so a
 * hand-rolled detector suite buys a lot of noise for very little signal.
 * Second, ESLint, Ruff, golangci-lint, Clippy and PHPStan already encode
 * decades of language-specific work, they are installed in most repos, and
 * they all speak SARIF. Writing detector #50 adds nothing. What nobody ships
 * is the layer above: a linter emits 400 undifferentiated findings and leaves
 * you to guess; we say which six matter, because those six sit in a
 * churn-hotspot that 76 files import while somebody else holds a lease on it.
 *
 * >>> WHAT THE RANK IS AND IS NOT — read this before quoting a number. <<<
 * `weight` is 0-10 SITUATIONAL EXPOSURE, not defect probability and not
 * severity. It answers "if this file breaks, how far does it travel and how
 * likely am I to be standing in it?" — nothing about whether the rule is
 * correct. A high-weight `note` can outrank a low-weight `error`, on purpose:
 * the tool ranks by rule taxonomy, we rank by blast radius. Both orderings are
 * evidence for triage, never a verdict, and the tool's own level is kept on
 * every row so you can always fall back to it.
 *
 * >>> THE WEIGHTS ARE NOT CALIBRATED. <<<
 * LINT_RANK_WEIGHTS are REVIEWABLE DEFAULTS — priors chosen for defensible
 * reasons (churn is the strongest single defect correlate in the literature;
 * dependents are the measured blast radius; a foreign lease is a coordination
 * cost you pay today), NOT numbers validated against outcomes. Run
 * calibrateLintRank() before trusting the ordering; it reports AUC against the
 * repo's own near-future fix history AND against a severity-only baseline, so
 * "does this add anything over the tool's own ordering?" is a measured number
 * rather than a claim. On most repos the honest answer will be "too few
 * findings to say" — the calibration reports that instead of inventing a
 * number.
 *
 * HONESTY RULES (they live in the OUTPUT, not just in this comment — same
 * discipline as brain-security.mjs):
 *   1. The report always states which tools ran and which were absent and why
 *      (`tools[]`, `provenance.tools[].ran/reason`).
 *   2. "No lint findings" is sayable ONLY when at least one tool actually ran.
 *      With nothing run, `claims.cleanBillOfHealth` stays false and the
 *      statement says NOT SCANNED — an absent linter is not a clean repo.
 *   3. Findings are WHITELIST-CONSTRUCTED from named SARIF fields, never
 *      spread from the raw object, so a tool-specific extra field (a code
 *      snippet, an environment dump, a credential in `properties`) cannot ride
 *      into the report by default — the failure mode of a blacklist. Even the
 *      fingerprint is computed by us rather than read from
 *      `partialFingerprints`, so no tool-controlled string reaches the output
 *      except the message text, which IS the finding.
 *   4. A file with no git history gets a stated "insufficient history" note and
 *      its history factors are OMITTED (the weight normalizes over the factors
 *      actually present) rather than being scored 0 — unknown is not safe.
 *
 * NO NEW DEPENDENCIES; every external tool OPTIONAL and degrading with a
 * reason, never a throw and never a non-zero exit. `--sarif <path>` accepts any
 * tool's SARIF from your own CI, so the ranking works even when we run nothing.
 *
 * Kill switches / overrides (env):
 *   BRAIN_LINT_ESLINT=0 | RUFF=0 | GOLANGCI=0 | CLIPPY=0 | PHPSTAN=0
 *   BRAIN_LINT_<TOOL>_BIN=<path>     binary override (also makes hasBin true)
 *   BRAIN_LINT_TIMEOUT_MS=<n>        per-tool timeout (default 180000)
 *   BRAIN_LINT_COMMITS=<n>           git history window for ranking (default 500)
 *
 * The pure core (parseSarif / normalizeEslintJson / normalizePhpstanJson /
 * rankFindings / buildLintReport / calibrateLintRank) has no clocks, no fs and
 * no child processes: same inputs → byte-identical output. `lintReport()` is
 * the thin I/O wrapper. The isMain guard keeps importing this module
 * side-effect-free.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, takeFlag, takeOption } from './common.mjs';
import { ACTIVE_STATE, activeStateJson } from './active-state.mjs';
import {
  gitLogArgs,
  parseLog,
  hotspots,
  fileHealth,
  rankAuc,
  provenanceOf,
  DEFECT_FIX_REGEX,
  DEFAULT_HALF_LIFE_DAYS
} from './git-intel.mjs';
import { buildImportGraph, dependents, SCAN_NOTE } from './import-graph.mjs';
import { targetMatchesFile, UnsupportedPatternError } from './lease-overlap.mjs';

// ---------------------------------------------------------------------------
// the sentences that must travel with the numbers
// ---------------------------------------------------------------------------

/** What the rank means — stamped onto every report. */
export const RANK_NOTE =
  '`weight` is 0-10 SITUATIONAL EXPOSURE, not defect probability and not severity: how far this ' +
  'file\'s breakage travels (dependents), how often it is being changed (churn), how often it has ' +
  'to be repaired (fix density), whether someone else is in it right now (lease) — plus the tool\'s ' +
  'own level as one factor among several. A high-weight note can outrank a low-weight error on ' +
  'purpose. Use it to order triage, never as a verdict on the rule.';

/** The calibration status of the weights — stamped onto every report. */
export const WEIGHTS_NOT_CALIBRATED_NOTE =
  'LINT_RANK_WEIGHTS are REVIEWABLE DEFAULTS, not calibrated truth. Nothing here has been ' +
  'validated against outcomes yet. Run `--calibrate` to measure whether the ranking predicts ' +
  'near-future fixes on THIS repo and whether it beats ordering by the tool\'s own severity; ' +
  'until then treat the ordering as a hypothesis.';

/** What SARIF ingestion does and does not carry through. */
export const SARIF_SAFETY_NOTE =
  'Findings are whitelist-CONSTRUCTED from named SARIF fields (tool, ruleId, level, message, ' +
  'file, startLine, endLine); the raw result object is never spread, and the fingerprint is ' +
  'computed here rather than read from the tool, so no tool-controlled string reaches this report ' +
  'except the message text — which is the finding itself.';

/** The rule that keeps an absent linter from reading as a clean repo. */
export const NOT_SCANNED_NOTE =
  'A linter that did not run makes NO claim about the code it did not read. "0 findings" is ' +
  'sayable only when at least one tool actually ran; otherwise this report says NOT SCANNED.';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FINDINGS = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 500;
export const DEFAULT_LIMIT = 20;
export const DEFAULT_COMMIT_WINDOW = 500;
export const DEFAULT_HORIZON_DAYS = 30;

/** Normalized levels. SARIF's `none` collapses into `note` (both are advisory). */
const LEVEL_RANK = Object.freeze({ error: 0, warning: 1, note: 2 });
const LEVELS = Object.freeze(['error', 'warning', 'note']);

/** Directories never scanned for the ranking inputs (mirrors brain-security). */
const IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees)(\/|$)/;
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rb|php|rs)$/i;

/** ESLint flat + legacy config filenames — the "is ESLint configured here?" probe. */
const ESLINT_CONFIG_FILES = Object.freeze([
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  'eslint.config.mts', 'eslint.config.cts',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'
]);

/** Every tool this module knows how to invoke, in deterministic order. */
export const TOOL_NAMES = Object.freeze(['eslint', 'ruff', 'golangci-lint', 'clippy', 'phpstan']);

// ---------------------------------------------------------------------------
// ranking weights — REVIEWABLE DEFAULTS, NOT CALIBRATED
// ---------------------------------------------------------------------------

/**
 * REVIEWABLE DEFAULT weights for rankFindings() — starting priors, NOT
 * calibrated truth (same discipline as RISK_WEIGHTS / FILE_HEALTH_WEIGHTS in
 * git-intel.mjs: "Kalibrierung statt Konstanten"). Nothing below has been
 * validated against outcomes; calibrateLintRank() is how a repo finds out
 * whether they order anything better than the tool's own severity does.
 *
 * Rationale for the defaults, so they can be argued with:
 *   - churn (0.30): recent change concentration is the strongest single defect
 *     correlate in the empirical literature, and it is the one input that says
 *     "you are going to be in this file again soon".
 *   - dependents (0.25): the measured blast radius. A finding in a file 76
 *     files import is not the same finding as one in a leaf script. This is the
 *     factor nobody else has, because it needs an import graph.
 *   - severity (0.20): the tool's own judgment. Weighted, not ignored — an
 *     ESLint error is genuinely more likely to be a real bug than a style note
 *     — but deliberately not dominant, since severity is exactly the ordering
 *     that already failed to make 400 findings triageable.
 *   - fix density (0.15): a file that keeps getting repaired keeps breaking.
 *     Direct evidence, not a proxy.
 *   - foreign lease (0.10): the smallest weight because it is the most
 *     transient — but a nonzero one, because a finding in a file somebody else
 *     is editing right now is a coordination problem today, not next sprint.
 */
export const LINT_RANK_WEIGHTS = Object.freeze({
  churn: 0.3,
  dependents: 0.25,
  severity: 0.2,
  fixDensity: 0.15,
  foreignLease: 0.1
});

/** Saturation points: the raw value at which each factor maxes out at 1.0. */
export const LINT_RANK_SATURATION = Object.freeze({
  // 25 transitive dependents is already "everything downstream of this breaks".
  dependents: 25
});

/** Tool level → raw severity contribution. */
export const LEVEL_RAW = Object.freeze({ error: 1, warning: 0.5, note: 0.2 });

// ---------------------------------------------------------------------------
// tiny pure helpers
// ---------------------------------------------------------------------------

/** Deterministic byte-order compare (NEVER localeCompare — locale-dependent). */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(n, digits) {
  return Number(n.toFixed(digits));
}

function normPath(p) {
  return String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function levelOf(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s === 'error') return 'error';
  if (s === 'warning') return 'warning';
  if (s === 'note' || s === 'none') return 'note';
  return null;
}

function clampInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function emptyLevelCounts() {
  return { error: 0, warning: 0, note: 0 };
}

/**
 * PURE. Our OWN stable identity for a finding. Deliberately NOT the tool's
 * `partialFingerprints`: that is a tool-controlled string, and letting one into
 * the report would defeat the whitelist the rest of this module maintains.
 */
export function fingerprintOf({ tool = '', ruleId = '', file = '', startLine = null, message = '' } = {}) {
  return crypto
    .createHash('sha256')
    .update(`${tool}\x1f${ruleId}\x1f${file}\x1f${startLine == null ? '' : startLine}\x1f${message}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * PURE. Deterministic ordering for findings BEFORE ranking: file, line, rule,
 * fingerprint. Ranking re-sorts by weight and falls back to this.
 */
function byLocation(a, b) {
  const rank = (f) => (Object.prototype.hasOwnProperty.call(LEVEL_RANK, f.level) ? LEVEL_RANK[f.level] : LEVELS.length);
  return byString(a.file || '', b.file || '') ||
    (a.startLine || 0) - (b.startLine || 0) ||
    rank(a) - rank(b) ||
    byString(a.ruleId || '', b.ruleId || '') ||
    byString(a.fingerprint || '', b.fingerprint || '');
}

/**
 * PURE. A SARIF artifact URI → repo-relative path. Handles `file://` URIs,
 * absolute paths under `root`, percent-encoding and `./` prefixes. An absolute
 * path OUTSIDE the root is kept verbatim (honest: we cannot place it, and
 * silently rewriting it would invent a repo file that does not exist).
 */
export function relativizeUri(uri, { root = '' } = {}) {
  let raw = String(uri == null ? '' : uri).trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      raw = raw.replace(/^file:\/\/(localhost)?/i, '');
    }
  }
  try {
    if (/%[0-9a-fA-F]{2}/.test(raw)) raw = decodeURIComponent(raw);
  } catch { /* keep the encoded form rather than throwing */ }
  raw = raw.replace(/\\/g, '/');
  const rootNorm = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (rootNorm && (raw === rootNorm || raw.startsWith(`${rootNorm}/`))) {
    raw = raw.slice(rootNorm.length + 1);
  }
  return raw.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// pure: SARIF 2.1.0 → normalized findings (whitelist, never a spread)
// ---------------------------------------------------------------------------

/**
 * PURE. Parse a SARIF 2.1.0 log into normalized findings:
 *   {tool, ruleId, level, message, file, startLine, endLine, fingerprint}
 *
 * SARIF is the reason this module can be tool-agnostic: ESLint (via
 * @microsoft/eslint-formatter-sarif), Ruff, golangci-lint, Clippy (via
 * clippy-sarif), Semgrep and CodeQL all emit it, so "consume what exists"
 * costs one parser rather than one integration per tool.
 *
 * TOLERANT BY CONSTRUCTION — this parser never throws:
 *   - a non-object log, or one without a `runs` array → {ok:false, reason}
 *   - a malformed run (not an object, no `results` array) → SKIPPED with a
 *     counted reason in `skippedRuns`, the other runs still parse
 *   - a malformed result inside a good run → skipped, counted in
 *     `skippedResults`
 *   - missing OPTIONAL fields degrade: no region → startLine null; no location
 *     → file '' (the finding survives, and ranking flags it as unplaceable);
 *     no message → ''; no ruleId → resolved via `ruleIndex` into the run's rule
 *     table, else 'unknown-rule'
 *   - missing `level` follows the SARIF default chain: result.level →
 *     rule.defaultConfiguration.level → 'warning'
 *
 * WHITELIST: the output object is CONSTRUCTED from named fields. The raw result
 * is never spread, and tool-specific extras (`properties`, `fixes`, `snippet`,
 * `partialFingerprints`) are dropped by construction, so a future SARIF
 * producer cannot leak a code snippet or a credential into this report.
 *
 * @param {object} raw parsed SARIF JSON (NOT a string)
 * @param {{root?: string, limit?: number, source?: string}} opts
 * @returns {{ok, findings, runs, skippedRuns, skippedResults, truncated, total, reason}}
 */
export function parseSarif(raw, opts = {}) {
  const limit = clampInt(opts.limit, MAX_FINDINGS);
  const root = opts.root || '';
  const fail = (reason) => ({
    ok: false, findings: [], runs: 0, skippedRuns: [], skippedResults: 0,
    truncated: false, total: 0, reason
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('not a SARIF log object');
  }
  if (!Array.isArray(raw.runs)) {
    return fail('SARIF log has no `runs` array (not SARIF 2.1.0?)');
  }

  const findings = [];
  const skippedRuns = [];
  let skippedResults = 0;
  let runs = 0;

  raw.runs.forEach((run, index) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      skippedRuns.push({ index, reason: 'run is not an object' });
      return;
    }
    if (!Array.isArray(run.results)) {
      skippedRuns.push({ index, reason: 'run has no `results` array' });
      return;
    }
    runs += 1;
    const driver = run.tool && run.tool.driver && typeof run.tool.driver === 'object' ? run.tool.driver : null;
    const toolName = String((driver && driver.name) || opts.source || 'unknown-tool').trim() || 'unknown-tool';
    const rules = driver && Array.isArray(driver.rules) ? driver.rules : [];

    for (const result of run.results) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        skippedResults += 1;
        continue;
      }
      const ruleIndex = Number(result.ruleIndex);
      const rule = Number.isInteger(ruleIndex) && ruleIndex >= 0 && ruleIndex < rules.length
        ? rules[ruleIndex]
        : null;
      const ruleId = String(result.ruleId || (rule && rule.id) || '').trim() || 'unknown-rule';
      // SARIF §3.27.10 default chain: result.level, then the rule's configured
      // default, then 'warning'. Never invent an 'error'.
      const level = levelOf(result.level) ||
        levelOf(rule && rule.defaultConfiguration && rule.defaultConfiguration.level) ||
        'warning';
      const message = String((result.message && result.message.text) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);

      const loc = Array.isArray(result.locations) ? result.locations.find((l) => l && typeof l === 'object') : null;
      const phys = loc && loc.physicalLocation && typeof loc.physicalLocation === 'object'
        ? loc.physicalLocation
        : null;
      const artifact = phys && phys.artifactLocation && typeof phys.artifactLocation === 'object'
        ? phys.artifactLocation
        : null;
      const file = normPath(relativizeUri(artifact && artifact.uri, { root }));
      const region = phys && phys.region && typeof phys.region === 'object' ? phys.region : null;
      const startLine = clampInt(region && region.startLine, null);
      const endLineRaw = clampInt(region && region.endLine, null);
      const endLine = endLineRaw && startLine && endLineRaw < startLine ? startLine : endLineRaw;

      // WHITELIST — constructed, never spread.
      const finding = {
        tool: toolName,
        ruleId,
        level,
        message,
        file,
        startLine,
        endLine,
        fingerprint: ''
      };
      finding.fingerprint = fingerprintOf(finding);
      findings.push(finding);
    }
  });

  findings.sort(byLocation);
  const deduped = dedupeFindings(findings);
  return {
    ok: true,
    findings: deduped.slice(0, limit),
    runs,
    skippedRuns,
    skippedResults,
    truncated: deduped.length > limit,
    total: deduped.length,
    reason: null
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    out.push(f);
  }
  return out;
}

/**
 * PURE. Normalize `eslint -f json` output into the same finding shape, for the
 * (common) case where @microsoft/eslint-formatter-sarif is not installed. Same
 * whitelist discipline: `source`, `fix`, `suggestions` and `output` — the
 * ESLint fields that carry actual code — are dropped by construction.
 *
 * ESLint severity: 2 → error, 1 → warning, 0 → note (an "off" rule that still
 * reported is advisory).
 */
export function normalizeEslintJson(raw, opts = {}) {
  const limit = clampInt(opts.limit, MAX_FINDINGS);
  const root = opts.root || '';
  if (!Array.isArray(raw)) {
    return { ok: false, findings: [], total: 0, truncated: false, skippedResults: 0, reason: 'eslint JSON is not an array of file results' };
  }
  const findings = [];
  let skippedResults = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { skippedResults += 1; continue; }
    const file = normPath(relativizeUri(entry.filePath, { root }));
    for (const m of Array.isArray(entry.messages) ? entry.messages : []) {
      if (!m || typeof m !== 'object') { skippedResults += 1; continue; }
      const sev = Number(m.severity);
      const level = sev === 2 ? 'error' : sev === 1 ? 'warning' : 'note';
      const finding = {
        tool: 'eslint',
        ruleId: String(m.ruleId || '').trim() || 'unknown-rule',
        level,
        message: String(m.message || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS),
        file,
        startLine: clampInt(m.line, null),
        endLine: clampInt(m.endLine, null),
        fingerprint: ''
      };
      finding.fingerprint = fingerprintOf(finding);
      findings.push(finding);
    }
  }
  findings.sort(byLocation);
  const deduped = dedupeFindings(findings);
  return {
    ok: true,
    findings: deduped.slice(0, limit),
    total: deduped.length,
    truncated: deduped.length > limit,
    skippedResults,
    reason: null
  };
}

/**
 * PURE. Normalize `phpstan analyse --error-format=json`. PHPStan's SARIF
 * support is version-dependent, so we read the JSON shape we can rely on and
 * normalize it ourselves — same whitelist, same finding shape. PHPStan reports
 * no severity levels, so everything is 'error' (that is what PHPStan calls
 * them) rather than an invented gradation.
 */
export function normalizePhpstanJson(raw, opts = {}) {
  const limit = clampInt(opts.limit, MAX_FINDINGS);
  const root = opts.root || '';
  if (!raw || typeof raw !== 'object' || !raw.files || typeof raw.files !== 'object') {
    return { ok: false, findings: [], total: 0, truncated: false, skippedResults: 0, reason: 'phpstan JSON has no `files` map' };
  }
  const findings = [];
  let skippedResults = 0;
  for (const key of Object.keys(raw.files).sort(byString)) {
    const entry = raw.files[key];
    if (!entry || typeof entry !== 'object') { skippedResults += 1; continue; }
    const file = normPath(relativizeUri(key, { root }));
    for (const m of Array.isArray(entry.messages) ? entry.messages : []) {
      if (!m || typeof m !== 'object') { skippedResults += 1; continue; }
      const finding = {
        tool: 'phpstan',
        ruleId: String(m.identifier || '').trim() || 'unknown-rule',
        level: 'error',
        message: String(m.message || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS),
        file,
        startLine: clampInt(m.line, null),
        endLine: null,
        fingerprint: ''
      };
      finding.fingerprint = fingerprintOf(finding);
      findings.push(finding);
    }
  }
  findings.sort(byLocation);
  const deduped = dedupeFindings(findings);
  return {
    ok: true,
    findings: deduped.slice(0, limit),
    total: deduped.length,
    truncated: deduped.length > limit,
    skippedResults,
    reason: null
  };
}

// ---------------------------------------------------------------------------
// pure: THE RANKING LAYER — this is the product
// ---------------------------------------------------------------------------

/**
 * PURE. Does a lease target (exact path, directory prefix, or glob) cover a
 * file? Thin wrapper over the canonical lease-overlap.mjs semantics, kept total
 * for ranking: an unsupported/legacy target never throws here, it simply does
 * not match (identical to git-intel's leaseTargetMatches).
 */
export function leaseTargetMatches(target, file) {
  try {
    return targetMatchesFile(target, file);
  } catch (error) {
    if (error instanceof UnsupportedPatternError) return false;
    throw error;
  }
}

/** PURE. Transitive dependents per file, computed once per distinct file. */
function dependentsIndex(graph, files) {
  const out = new Map();
  if (!graph || !Array.isArray(graph.edges) || !graph.edges.length) return out;
  const known = new Set((graph.nodes || []).map((n) => n && n.file));
  for (const file of files) {
    if (!known.has(file)) continue;
    out.set(file, dependents(graph, file).dependents);
  }
  return out;
}

/** PURE. file → {fixes, total, raw} from a fileHealth() result. */
function fixDensityIndex(health) {
  const out = new Map();
  for (const entry of (health && health.files) || []) {
    if (!entry || !entry.file) continue;
    const factor = (entry.factors || []).find((f) => f && f.name === 'fix-density');
    if (!factor) continue;
    out.set(entry.file, { raw: Number(factor.raw) || 0, evidence: String(factor.evidence || '') });
  }
  return out;
}

/**
 * PURE. THE PRODUCT: rank linter findings by whether they sit where a change
 * actually hurts. Every finding gains
 *
 *   {weight, reasons: [{kind, message}], factors: [...], lowConfidence?, reason?}
 *
 * and the list sorts by weight desc. Every reason carries its numbers, because
 * a rank without its receipt is just a different opinion.
 *
 * FACTORS (each contributes ONLY when its input was supplied — a call with no
 * signals at all produces severity-only ordering, which is exactly the honest
 * degradation):
 *   - churn        `hotspots`: the file's percentile in the churn-decay ranking
 *                  (rank 1 of N → 1.0).
 *   - dependents   `graph`: transitive dependents (import-graph blast radius),
 *                  saturating at LINT_RANK_SATURATION.dependents.
 *   - severity     the tool's own level, via LEVEL_RAW. Always present.
 *   - fixDensity   `health`: the file's fix-density factor from fileHealth().
 *   - foreignLease `leases`: 1.0 when an ACTIVE lease held by somebody other
 *                  than `self` covers the file, else 0.
 *
 * weight = 10 × Σ(w_i × raw_i) / Σ(w_i over PRESENT factors), one decimal —
 * omitted factors never depress a finding, exactly like riskScore().
 *
 * INSUFFICIENT HISTORY: when history signals were supplied but this file does
 * not appear in them (new file, never committed), the history factors are
 * OMITTED and the row is flagged {lowConfidence: true, reason: 'insufficient
 * history'} with a stated reason — never scored 0, because "we do not know" is
 * not "safe". Same for a finding with no file location.
 *
 * @param {Array} findings parseSarif()/normalize*() output
 * @param {{hotspots?, graph?, leases?, health?, now?, weights?, self?}} signals
 * @returns {{basis, source, params, available, degraded, reason, inputs, findings}}
 */
export function rankFindings(findings, signals = {}) {
  const w = { ...LINT_RANK_WEIGHTS, ...(signals.weights || {}) };
  const list = Array.isArray(findings) ? findings : [];

  const hotspotsResult = signals.hotspots && Array.isArray(signals.hotspots.files) ? signals.hotspots : null;
  const graph = signals.graph && Array.isArray(signals.graph.nodes) && Array.isArray(signals.graph.edges)
    ? signals.graph
    : null;
  const health = signals.health && Array.isArray(signals.health.files) ? signals.health : null;
  const leases = Array.isArray(signals.leases) ? signals.leases : null;
  const nowMs = Number.isFinite(signals.now) ? signals.now : Date.parse(String(signals.now ?? ''));
  const self = String(signals.self || '').trim();

  // Rank lookup for churn percentile.
  const churnRank = new Map();
  const churnTotal = hotspotsResult ? hotspotsResult.files.length : 0;
  if (hotspotsResult) {
    hotspotsResult.files.forEach((entry, i) => {
      if (entry && entry.file) churnRank.set(entry.file, { rank: i + 1, commits: entry.commits, score: entry.score });
    });
  }

  const distinctFiles = [...new Set(list.map((f) => f.file).filter(Boolean))].sort(byString);
  const depIndex = dependentsIndex(graph, distinctFiles);
  const fixIndex = fixDensityIndex(health);

  // Active, foreign leases only. An expired `until` drops the lease; an
  // unparseable one is KEPT (fail toward caution, exactly like brain-intel).
  const activeLeases = (leases || []).filter((l) => {
    if (!l || !l.target) return false;
    const until = Date.parse(l.until);
    if (Number.isFinite(until) && Number.isFinite(nowMs) && until < nowMs) return false;
    if (self && String(l.lockedBy || '').trim() === self) return false;
    return true;
  });

  const ranked = list.map((raw) => {
    const finding = {
      tool: raw.tool,
      ruleId: raw.ruleId,
      level: raw.level,
      message: raw.message,
      file: raw.file,
      startLine: raw.startLine === undefined ? null : raw.startLine,
      endLine: raw.endLine === undefined ? null : raw.endLine,
      fingerprint: raw.fingerprint || fingerprintOf(raw)
    };
    const factors = [];
    const reasons = [];
    const pushFactor = (name, weight, rawValue, kind, message) => {
      factors.push({ name, weight, raw: round(rawValue, 4), contribution: round(weight * rawValue, 4) });
      if (message) reasons.push({ kind, message });
    };

    const placeable = Boolean(finding.file);
    const inHistory = placeable && churnRank.has(finding.file);

    // 1. severity — always present, it is the one input we never lack.
    pushFactor('severity', w.severity, LEVEL_RAW[finding.level] ?? LEVEL_RAW.note, 'severity',
      `${finding.tool} reports this as ${finding.level} (${finding.ruleId})`);

    // 2. churn percentile — only when hotspots were supplied AND this file has
    //    history. A file absent from the ranking gets no churn factor at all.
    if (hotspotsResult && inHistory) {
      const hit = churnRank.get(finding.file);
      const pct = churnTotal ? (churnTotal - hit.rank + 1) / churnTotal : 0;
      pushFactor('churn', w.churn, pct, 'churn',
        `churn rank #${hit.rank} of ${churnTotal} (percentile ${round(pct, 2)}), ` +
        `${hit.commits} commit(s) in the window`);
    }

    // 3. dependents — the blast radius nobody else measures.
    if (graph && placeable) {
      const deps = depIndex.get(finding.file);
      if (deps && deps.length) {
        const direct = deps.filter((d) => d.depth === 1).length;
        const rawDeps = Math.min(1, deps.length / LINT_RANK_SATURATION.dependents);
        pushFactor('dependents', w.dependents, rawDeps, 'dependents',
          `${deps.length} file(s) transitively import this (${direct} directly); ` +
          `saturates at ${LINT_RANK_SATURATION.dependents}`);
      } else if (deps) {
        // MEASURED zero: the file is in the graph and nothing imports it.
        pushFactor('dependents', w.dependents, 0, 'dependents',
          'no file in the import graph imports this — a leaf as far as the scan can see');
      } else {
        // NOT measured: the file is outside the scanned graph (wrong language,
        // ignored directory, unreadable). Omitting beats scoring an unknown 0.
        reasons.push({
          kind: 'insufficient-data',
          message: `${finding.file} is not in the import graph (unscanned language or ignored path) — ` +
            'the dependents factor was OMITTED rather than scored 0'
        });
      }
    }

    // 4. fix density — only when fileHealth was supplied AND measured this file.
    if (health && placeable && fixIndex.has(finding.file)) {
      const fx = fixIndex.get(finding.file);
      pushFactor('fixDensity', w.fixDensity, fx.raw, 'fix-density', fx.evidence);
    }

    // 5. foreign active lease — somebody else is in this file right now.
    if (leases && placeable) {
      const hits = [];
      for (const lease of activeLeases) {
        // Legacy lease rows may hold comma/space-separated target lists; split
        // exactly like brain-brief/brain-lease/git-intel so all consumers agree.
        for (const target of String(lease.target || '').split(/[,\s]+/).filter(Boolean)) {
          if (leaseTargetMatches(target, finding.file)) {
            hits.push({ target: lease.target, lockedBy: lease.lockedBy || '', until: lease.until || '' });
            break;
          }
        }
      }
      const first = hits[0];
      pushFactor('foreignLease', w.foreignLease, hits.length ? 1 : 0, 'lease',
        first
          ? `active lease '${first.target}'${first.lockedBy ? ` held by ${first.lockedBy}` : ''}` +
            `${first.until ? ` until ${first.until}` : ''} covers this file — coordinate before editing`
          : null);
    }

    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    const weighted = factors.reduce((s, f) => s + f.weight * f.raw, 0);
    finding.weight = totalWeight > 0 ? Number((10 * (weighted / totalWeight)).toFixed(1)) : 0;
    finding.factors = factors;
    finding.reasons = reasons;

    if (!placeable) {
      finding.lowConfidence = true;
      finding.reason = 'no file location in the SARIF result — ranked on severity alone';
      reasons.push({ kind: 'insufficient-data', message: finding.reason });
    } else if (hotspotsResult && !inHistory) {
      finding.lowConfidence = true;
      finding.reason = 'insufficient history';
      reasons.push({
        kind: 'insufficient-history',
        message: `no commit touching ${finding.file} in the ${churnTotal ? 'analysed' : 'empty'} history ` +
          'window — churn and fix-density were OMITTED rather than scored 0 (unknown is not safe)'
      });
    } else if (!hotspotsResult) {
      reasons.push({
        kind: 'insufficient-data',
        message: 'no git history supplied — this ordering is severity-plus-structure only'
      });
    }
    return finding;
  });

  ranked.sort((a, b) => b.weight - a.weight || byLocation(a, b));

  const inputs = {
    hotspots: Boolean(hotspotsResult),
    graph: Boolean(graph),
    health: Boolean(health),
    leases: Boolean(leases),
    activeForeignLeases: activeLeases.length
  };
  const available = Boolean(hotspotsResult || graph || health || leases);
  return {
    basis: 'measured',
    source: 'lint-findings ⊕ git-history ⊕ import-graph ⊕ leases',
    available,
    degraded: !available,
    reason: available ? null : 'no ranking signals supplied — findings are ordered by tool severity only',
    inputs,
    params: {
      weights: w,
      saturation: { ...LINT_RANK_SATURATION },
      levelRaw: { ...LEVEL_RAW },
      churnRankedFiles: churnTotal,
      graphNodes: graph ? graph.nodes.length : 0
    },
    notes: { rank: RANK_NOTE, calibration: WEIGHTS_NOT_CALIBRATED_NOTE },
    findings: ranked
  };
}

// ---------------------------------------------------------------------------
// pure: report assembly (the honesty lives here)
// ---------------------------------------------------------------------------

/**
 * PURE. Assemble the report from already-collected inputs. Deterministic given
 * `now` — no clocks, no fs, no processes.
 *
 * @param {{tools: Array<{name, purpose?, ran, reason, findings?, source?}>,
 *          ranking: object, now?: number, limit?: number}} input
 */
export function buildLintReport(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : 0;
  const limit = clampInt(input.limit, DEFAULT_LIMIT);
  const tools = (Array.isArray(input.tools) ? input.tools : []).map((t) => ({
    name: String(t.name || 'unknown'),
    purpose: String(t.purpose || 'lint'),
    ran: t.ran === true,
    reason: t.ran === true ? null : String(t.reason || 'did not run'),
    findings: t.ran === true ? clampInt(t.findings, 0) || 0 : 0,
    source: t.source ? String(t.source) : null
  })).sort((a, b) => byString(a.name, b.name));

  const ranking = input.ranking || rankFindings([], {});
  const all = ranking.findings || [];
  const anyToolRan = tools.some((t) => t.ran);
  const counts = emptyLevelCounts();
  for (const f of all) if (Object.prototype.hasOwnProperty.call(counts, f.level)) counts[f.level] += 1;

  return {
    findings: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
    limit,
    counts,
    tools,
    statement: lintStatement({ anyToolRan, tools, total: all.length, ranking }),
    ranking: {
      available: ranking.available === true,
      degraded: ranking.degraded === true,
      reason: ranking.reason || null,
      inputs: ranking.inputs || {},
      params: ranking.params || {},
      note: RANK_NOTE,
      calibration: WEIGHTS_NOT_CALIBRATED_NOTE
    },
    // The distinction lives in the DATA, not only in the prose: a linter that
    // did not run can never produce a clean bill of health.
    claims: {
      anyToolRan,
      toolsRan: tools.filter((t) => t.ran).map((t) => t.name),
      toolsAbsent: tools.filter((t) => !t.ran).map((t) => t.name),
      rankingCalibrated: false,
      cleanBillOfHealth: anyToolRan && all.length === 0,
      caveat: 'cleanBillOfHealth is true only when at least one linter actually ran and reported ' +
        'nothing. False with every tool absent means "not scanned", which is not the same as ' +
        '"clean". rankingCalibrated is false until calibrateLintRank() says otherwise on this repo.'
    },
    provenance: {
      basis: 'measured',
      source: 'external linters (SARIF) ⊕ git-history churn/fix-density ⊕ import-graph blast radius ⊕ leases',
      tools: tools.map((t) => ({ name: t.name, purpose: t.purpose, ran: t.ran, reason: t.reason })),
      notes: {
        rank: RANK_NOTE,
        weights: WEIGHTS_NOT_CALIBRATED_NOTE,
        sarif: SARIF_SAFETY_NOTE,
        notScanned: NOT_SCANNED_NOTE,
        scanner: SCAN_NOTE
      }
    },
    scannedAt: new Date(now).toISOString()
  };
}

/** PURE. The one sentence about lint coverage that is safe to quote. */
export function lintStatement({ anyToolRan, tools = [], total = 0, ranking }) {
  if (!anyToolRan) {
    const absent = tools.map((t) => `${t.name} (${t.reason})`).join('; ');
    return 'NO linter ran — this repository was NOT scanned, and this report makes no claim about ' +
      `whether it is clean. ${absent ? `Absent: ${absent}. ` : ''}` +
      'Feed any tool\'s SARIF with --sarif <path> to get the ranking without installing anything.';
  }
  const ran = tools.filter((t) => t.ran).map((t) => t.name).join(', ');
  if (!total) return `${ran} ran and reported no findings.`;
  const rankNote = ranking && ranking.available
    ? 'ranked by situational exposure (churn × dependents × lease × fix density × severity)'
    : 'ordered by tool severity only — no ranking signals were available';
  return `${ran} reported ${total} finding(s), ${rankNote}.`;
}

/** PURE. One concrete next action — "kein Score ohne Aktion". */
export function nextAction(report) {
  if (!report.claims.anyToolRan) {
    const eslint = report.tools.find((t) => t.name === 'eslint');
    return 'no linter ran, so nothing was checked — install one your language already uses ' +
      `(${eslint && eslint.reason ? `eslint: ${eslint.reason}` : 'e.g. eslint, ruff, golangci-lint'}), ` +
      'or pass an existing CI report with --sarif <path>';
  }
  if (!report.total) return 'the linters that ran found nothing — re-run after the next change; no action needed';
  const top = report.findings[0];
  if (!top) return 'findings exist but none survived the filter — widen --tool or --limit';
  const why = (top.reasons || []).filter((r) => r.kind !== 'severity').map((r) => r.message)[0];
  const where = `${top.file || '(no file)'}${top.startLine ? `:${top.startLine}` : ''}`;
  return `start at ${where} (${top.ruleId}, weight ${top.weight})` +
    (why ? ` — ${why}` : '') +
    (report.ranking.available
      ? '; then run --calibrate to check the ordering beats plain severity on this repo'
      : '; ranking signals were unavailable, so this is severity order — treat it as untriaged');
}

// ---------------------------------------------------------------------------
// pure: calibration hook — a QUESTION, not a claim
// ---------------------------------------------------------------------------

/**
 * The caveat that MUST travel with any lint-rank calibration.
 * The history factors are rebuilt from the pre-cut prefix, so they are
 * leakage-free by construction. The FINDINGS are not: they were produced by a
 * linter run against the CURRENT working tree, because reconstructing what the
 * linter would have said at the cut point would mean checking out history and
 * re-running every tool. A file repaired after the cut is therefore linted
 * AFTER its repair, which biases the result in an unknown direction. Read the
 * numbers as an upper bound on a hypothesis, not as a validated score.
 */
export const LINT_CALIBRATION_CAVEAT =
  'findings are measured on the CURRENT working tree, not reconstructed at the cut point (that ' +
  'would require checking out history and re-running every linter), so files edited after the cut ' +
  'are linted post-edit. The git-history factors have no such leak. Treat the AUC as an upper ' +
  'bound, and treat a small `evaluated` count as no answer at all.';

/**
 * PURE. In-repo self-calibration of the lint ranking, in the same shape as
 * calibrateFileHealth(): does a HIGH rank predict that the file gets a fix
 * commit inside the horizon?
 *
 * METHOD (and its honest limits):
 *   - Cut point T = `horizonDays` before the newest commit in the log.
 *   - Findings are grouped to FILES (the label is per-file: a file either gets
 *     a fix commit after T or it does not), and each file is represented by its
 *     highest-weight finding — the row a human would actually triage.
 *   - Files are ranked with rankFindings() using history from commits ≤ T ONLY,
 *     evaluated at now = T. Zero leakage on the history side, zero clocks.
 *   - Label: a file is "defective" iff a commit AFTER T whose subject matches
 *     `fixRegex` touches it.
 *   - Output: rank-quartile vs fixed-rate table + rank-based ROC-AUC, next to
 *     a SEVERITY-ONLY baseline AUC. The delta is the whole question — if
 *     ordering by the tool's own level does just as well, the ranking layer is
 *     not earning its keep on this repo, and the verdict says so.
 *
 * IN-REPO SELF-CALIBRATION, NOT A CROSS-REPO BENCHMARK: the fix-commit
 * heuristic is a proxy label, and a repo only validates against its own past.
 * Expect "too few findings to say" on small repos — that is reported honestly
 * rather than dressed up as a number.
 *
 * @param {Array} findings normalized findings (parseSarif output)
 * @param {Array} commits parseLog() output
 */
export function calibrateLintRank(findings, commits, {
  horizonDays = DEFAULT_HORIZON_DAYS,
  window = 0,
  weights,
  graph,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  fixRegex = DEFECT_FIX_REGEX,
  minEvaluated = 20
} = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const log = Array.isArray(commits) ? commits : [];
  const MS_PER_DAY = 86_400_000;

  const chrono = log
    .filter((c) => c && Number.isFinite(Date.parse(c.dateIso)))
    .sort((a, b) => Date.parse(a.dateIso) - Date.parse(b.dateIso) || byString(a.hash, b.hash));
  const lastMs = chrono.length ? Date.parse(chrono[chrono.length - 1].dateIso) : 0;
  const cutMs = lastMs - horizonDays * MS_PER_DAY;
  const prefixAll = chrono.filter((c) => Date.parse(c.dateIso) <= cutMs);
  const prefix = window > 0 ? prefixAll.slice(-window) : prefixAll;
  const future = chrono.filter((c) => Date.parse(c.dateIso) > cutMs);

  // Signals from the pre-cut prefix ONLY.
  const hs = chrono.length ? hotspots(prefix, { now: cutMs, halfLifeDays }) : null;
  const health = chrono.length ? fileHealth(prefix, { now: cutMs, halfLifeDays }) : null;
  const ranked = rankFindings(list, { hotspots: hs, health, graph, now: cutMs, weights });

  // One row per FILE: the highest-weight finding represents it.
  const byFile = new Map();
  for (const f of ranked.findings) {
    if (!f.file) continue;
    const prev = byFile.get(f.file);
    if (!prev || f.weight > prev.weight) byFile.set(f.file, f);
  }

  const fixedBy = new Map();
  let futureFixCommits = 0;
  for (const c of future) {
    if (!fixRegex.test(c.subject || '')) continue;
    futureFixCommits += 1;
    for (const f of [...new Set(c.files || [])]) if (!fixedBy.has(f)) fixedBy.set(f, c.hash);
  }

  const perFileCount = new Map();
  for (const f of ranked.findings) {
    if (!f.file) continue;
    perFileCount.set(f.file, (perFileCount.get(f.file) || 0) + 1);
  }

  const rows = [...byFile.keys()].sort(byString).map((file) => {
    const f = byFile.get(file);
    const row = {
      file,
      weight: f.weight,
      level: f.level,
      severityRank: LEVEL_RAW[f.level] ?? LEVEL_RAW.note,
      findings: perFileCount.get(file) || 0,
      defective: fixedBy.has(file),
      fixedBy: fixedBy.get(file) || null
    };
    if (f.lowConfidence) row.lowConfidence = true;
    return row;
  });

  const auc = rankAuc(rows.map((r) => r.weight), rows.map((r) => r.defective));
  const severityAuc = rankAuc(rows.map((r) => r.severityRank), rows.map((r) => r.defective));
  const delta = auc !== null && severityAuc !== null ? round(auc - severityAuc, 4) : null;
  const defects = rows.filter((r) => r.defective).length;

  // Rank-quartile vs fixed-rate table.
  const bins = 4;
  const sorted = [...rows].sort((a, b) => a.weight - b.weight || byString(a.file, b.file));
  const quantiles = [];
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * sorted.length) / bins);
    const end = Math.floor(((b + 1) * sorted.length) / bins);
    const slice = sorted.slice(start, end);
    if (!slice.length) continue;
    const defective = slice.filter((r) => r.defective).length;
    quantiles.push({
      quantile: `Q${b + 1}`,
      weightMin: slice[0].weight,
      weightMax: slice[slice.length - 1].weight,
      files: slice.length,
      defective,
      defectRate: round(defective / slice.length, 4)
    });
  }

  let verdict;
  if (!rows.length) {
    verdict = 'no findings could be placed on a file with git history — nothing to calibrate. ' +
      'This is the expected outcome on a repo with no linter configured; it is not a passing grade.';
  } else if (auc === null) {
    verdict = `AUC undefined over ${rows.length} file(s): the window contains only ` +
      `${defects ? 'defective' : 'clean'} files, so the two classes needed for an AUC do not both ` +
      'exist. Too few findings to say anything — do NOT read the ordering as validated.';
  } else if (rows.length < minEvaluated) {
    verdict = `AUC ${auc.toFixed(2)} over only ${rows.length} file(s) (below the ${minEvaluated}-file ` +
      'floor this function considers reportable) — statistically meaningless. Too few findings to ' +
      'say; the number is printed for transparency, not for use.';
  } else {
    const vsRandom = auc > 0.5 ? 'better than random' : 'not better than random';
    const gate = auc >= 0.6
      ? 'calibration gate (0.6) met — the ranking is defensible on this repo'
      : 'below the 0.6 gate — do NOT trust the ranking yet';
    verdict = `AUC ${auc.toFixed(2)} over ${rows.length} file(s) — the rank is ${vsRandom} at ` +
      `predicting near-future fixes; ${gate}.`;
    if (delta !== null) {
      const sign = delta > 0 ? '+' : '';
      // A delta over a baseline that is ITSELF at-or-below chance is not
      // evidence of anything: beating a coin flip by 0.05 while also losing to
      // the coin flip is noise, and calling it "adds information" would be the
      // exact overclaim this module exists to avoid.
      const helps = auc < 0.5
        ? 'but BOTH orderings are at or below chance here, so the delta is noise, not evidence — ' +
          'neither ranking is usable on this repo yet'
        : (delta > 0.02
          ? 'the ranking ADDS information over the tool\'s own severity ordering'
          : (delta < -0.02
            ? 'the ranking is WORSE than plain severity here — fall back to the tool\'s ordering'
            : 'the ranking adds nothing measurable over plain severity here'));
      verdict += ` Severity-only baseline AUC ${severityAuc.toFixed(2)} (${sign}${delta.toFixed(2)}) — ${helps}.`;
    }
    if (defects < minEvaluated / 2) {
      verdict += ` Only ${defects} of ${rows.length} file(s) were fixed inside the horizon, so the ` +
        'estimate rests on a handful of positives and will move a lot with one more commit — ' +
        'read it as "too few outcomes to say", not as a measurement.';
    }
  }

  return {
    ...provenanceOf(log),
    method: 'in-repo self-calibration: do today\'s lint ranks predict near-future fixes in this ' +
      'repo\'s own history — a proxy label, NOT a cross-repo benchmark',
    params: {
      horizonDays,
      window,
      halfLifeDays,
      minEvaluated,
      fixPattern: String(fixRegex),
      weights: { ...LINT_RANK_WEIGHTS, ...(weights || {}) },
      cut: chrono.length ? new Date(cutMs).toISOString() : null
    },
    evaluated: rows.length,
    findingsConsidered: list.length,
    defective: defects,
    futureCommits: future.length,
    futureFixCommits,
    quantiles,
    auc,
    severityOnlyAuc: severityAuc,
    delta,
    caveat: LINT_CALIBRATION_CAVEAT,
    verdict,
    files: rows
  };
}

// ---------------------------------------------------------------------------
// I/O: tool probing (every one optional, every absence a reason)
// ---------------------------------------------------------------------------

function envKey(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function envBin(env, name, fallback) {
  const v = env[`BRAIN_LINT_${envKey(name)}_BIN`];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

/**
 * True when `name` resolves to an executable on PATH (or an explicit *_BIN
 * override exists). A direct PATH walk rather than `command -v` through a
 * shell: no child process, no shell quoting, nothing for a hostile PATH entry
 * to interpret. Same probe as brain-security.hasBin, different env prefix.
 */
export function hasBin(name, { env = process.env } = {}) {
  const override = env[`BRAIN_LINT_${envKey(name)}_BIN`];
  if (override && String(override).trim()) return true;
  const raw = String(env.PATH || env.Path || '');
  if (!raw) return false;
  const exts = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch { /* not here — keep walking */ }
    }
  }
  return false;
}

function timeoutMs(env) {
  return clampInt(env.BRAIN_LINT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

function disabled(env, name) {
  return env[`BRAIN_LINT_${envKey(name)}`] === '0';
}

/** Files tracked (or untracked-but-not-ignored) in `root`, from git. null outside a work tree. */
function gitFiles(root, spawn) {
  const r = spawn('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER
  });
  if (!r || r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').map((f) => f.trim()).filter(Boolean);
}

/** Does the repo contain at least one file matching `re`? */
function hasFilesMatching(files, re) {
  return Array.isArray(files) && files.some((f) => re.test(f));
}

function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? JSON.parse(text) : null;
}

function parseJsonSafe(text) {
  try {
    const trimmed = String(text || '').trim();
    return trimmed ? JSON.parse(trimmed) : null;
  } catch {
    return null;
  }
}

/** Wrap a spawn so a throw becomes a degraded result rather than an exception. */
function spawnSafe(spawn, bin, args, opts) {
  try {
    const r = spawn(bin, args, opts);
    if (!r) return { ok: false, reason: `${bin} produced no result` };
    if (r.error) return { ok: false, reason: `${bin} could not be started: ${r.error.code || r.error.message}` };
    return { ok: true, result: r };
  } catch (error) {
    return { ok: false, reason: `${bin} could not be started: ${error.code || error.message || error}` };
  }
}

// ---------------------------------------------------------------------------
// I/O: the runners
// ---------------------------------------------------------------------------

/**
 * ESLint, but only when the repo actually configures it — running ESLint on a
 * repo with no config produces either a crash or a meaningless default lint,
 * and both would be dishonest input to a ranking.
 *
 * SARIF first (`-f @microsoft/eslint-formatter-sarif`, resolvable via
 * `npx --no-install`), `-f json` normalized by us as the fallback. Never
 * installs anything: `--no-install` means an absent formatter degrades to the
 * JSON path instead of pulling a package off the network mid-report.
 */
export function runEslint({ root = ROOT, env = process.env, spawn = spawnSync, files = null } = {}) {
  const name = 'eslint';
  if (disabled(env, 'ESLINT')) return { name, ran: false, reason: 'disabled via BRAIN_LINT_ESLINT=0' };
  const configs = ESLINT_CONFIG_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  let configured = configs.length > 0;
  if (!configured) {
    try {
      const pkg = readJsonFile(path.join(root, 'package.json'));
      configured = Boolean(pkg && pkg.eslintConfig);
    } catch { /* no package.json, or unreadable — not configured */ }
  }
  if (!configured) {
    return { name, ran: false, reason: 'no ESLint config in this repo (eslint.config.* / .eslintrc* / package.json#eslintConfig) — ESLint was NOT run' };
  }
  if (!hasFilesMatching(files, /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i)) {
    return { name, ran: false, reason: 'no JavaScript/TypeScript files found to lint' };
  }
  const useSarif = env.BRAIN_LINT_ESLINT_FORMAT !== 'json' &&
    resolvableFormatter(root, spawn, env);
  const bin = envBin(env, 'ESLINT', 'npx');
  const prefix = bin === 'npx' ? ['--no-install', 'eslint'] : [];
  const args = useSarif
    ? [...prefix, '.', '-f', '@microsoft/eslint-formatter-sarif']
    : [...prefix, '.', '-f', 'json'];
  const spawned = spawnSafe(spawn, bin, args, {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env)
  });
  if (!spawned.ok) return { name, ran: false, reason: spawned.reason };
  // ESLint exits 1 WHEN IT FINDS PROBLEMS — non-zero with parseable output is a
  // successful run, not a failure. Exit 2 is a real error.
  const parsed = parseJsonSafe(spawned.result.stdout);
  if (parsed === null) {
    return {
      name,
      ran: false,
      reason: `eslint produced no parseable ${useSarif ? 'SARIF' : 'JSON'} (exit ${spawned.result.status ?? 'null'})`
    };
  }
  const normalized = useSarif
    ? parseSarif(parsed, { root, source: 'eslint' })
    : normalizeEslintJson(parsed, { root });
  if (!normalized.ok) return { name, ran: false, reason: `eslint output unusable: ${normalized.reason}` };
  return {
    name,
    ran: true,
    reason: null,
    source: useSarif ? 'eslint --format sarif' : 'eslint --format json (normalized here)',
    findings: normalized.findings
  };
}

/** Can `@microsoft/eslint-formatter-sarif` be resolved without installing it? */
function resolvableFormatter(root, spawn, env) {
  for (const dir of ['node_modules/@microsoft/eslint-formatter-sarif']) {
    if (fs.existsSync(path.join(root, dir))) return true;
  }
  const r = spawnSafe(spawn, envBin(env, 'NODE', process.execPath),
    ['-e', 'require.resolve("@microsoft/eslint-formatter-sarif")'],
    { cwd: root, encoding: 'utf8', timeout: 20_000 });
  return r.ok && r.result.status === 0;
}

/** Ruff — only with the binary AND at least one Python file. Native SARIF. */
export function runRuff({ root = ROOT, env = process.env, spawn = spawnSync, files = null } = {}) {
  const name = 'ruff';
  if (disabled(env, 'RUFF')) return { name, ran: false, reason: 'disabled via BRAIN_LINT_RUFF=0' };
  if (!hasBin('ruff', { env })) return { name, ran: false, reason: 'ruff not installed (set BRAIN_LINT_RUFF_BIN to override)' };
  if (!hasFilesMatching(files, /\.pyi?$/i)) return { name, ran: false, reason: 'no Python files in this repo — nothing for ruff to check' };
  const spawned = spawnSafe(spawn, envBin(env, 'RUFF', 'ruff'), ['check', '--output-format', 'sarif', '.'], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env)
  });
  if (!spawned.ok) return { name, ran: false, reason: spawned.reason };
  const parsed = parseJsonSafe(spawned.result.stdout);
  if (parsed === null) {
    return { name, ran: false, reason: `ruff produced no parseable SARIF (exit ${spawned.result.status ?? 'null'})` };
  }
  const normalized = parseSarif(parsed, { root, source: 'ruff' });
  if (!normalized.ok) return { name, ran: false, reason: `ruff SARIF unusable: ${normalized.reason}` };
  return { name, ran: true, reason: null, source: 'ruff check --output-format sarif', findings: normalized.findings };
}

/** golangci-lint — only with the binary AND at least one Go file. */
export function runGolangciLint({ root = ROOT, env = process.env, spawn = spawnSync, files = null } = {}) {
  const name = 'golangci-lint';
  if (disabled(env, 'GOLANGCI')) return { name, ran: false, reason: 'disabled via BRAIN_LINT_GOLANGCI=0' };
  if (!hasBin('golangci-lint', { env })) {
    return { name, ran: false, reason: 'golangci-lint not installed (set BRAIN_LINT_GOLANGCI_LINT_BIN to override)' };
  }
  if (!hasFilesMatching(files, /\.go$/i)) return { name, ran: false, reason: 'no Go files in this repo — nothing for golangci-lint to check' };
  const spawned = spawnSafe(spawn, envBin(env, 'GOLANGCI_LINT', 'golangci-lint'),
    ['run', '--out-format', 'sarif', './...'], {
      cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env)
    });
  if (!spawned.ok) return { name, ran: false, reason: spawned.reason };
  const parsed = parseJsonSafe(spawned.result.stdout);
  if (parsed === null) {
    return {
      name,
      ran: false,
      // golangci-lint renamed the flag across major versions; say so instead of
      // guessing, so the operator knows what to check.
      reason: `golangci-lint produced no parseable SARIF (exit ${spawned.result.status ?? 'null'}) — ` +
        'older/newer versions spell the flag differently (--out-format vs --output.sarif.path); ' +
        'emit SARIF in CI and pass it with --sarif instead'
    };
  }
  const normalized = parseSarif(parsed, { root, source: 'golangci-lint' });
  if (!normalized.ok) return { name, ran: false, reason: `golangci-lint SARIF unusable: ${normalized.reason}` };
  return { name, ran: true, reason: null, source: 'golangci-lint run --out-format sarif', findings: normalized.findings };
}

/**
 * Clippy — only with Cargo.toml AND cargo AND clippy-sarif. `cargo clippy` has
 * no native SARIF output, so the JSON diagnostics are piped through
 * `clippy-sarif` via spawn `input` (no shell, no pipe operator). Absent
 * converter → degraded with a reason that names the missing piece.
 */
export function runClippy({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  const name = 'clippy';
  if (disabled(env, 'CLIPPY')) return { name, ran: false, reason: 'disabled via BRAIN_LINT_CLIPPY=0' };
  if (!fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return { name, ran: false, reason: 'no Cargo.toml in this repo — not a Rust crate' };
  }
  if (!hasBin('cargo', { env })) return { name, ran: false, reason: 'cargo not installed' };
  if (!hasBin('clippy-sarif', { env })) {
    return {
      name,
      ran: false,
      reason: 'clippy-sarif not installed — `cargo clippy` has no native SARIF output ' +
        '(`cargo install clippy-sarif`), or emit SARIF in CI and pass it with --sarif'
    };
  }
  const clippy = spawnSafe(spawn, envBin(env, 'CARGO', 'cargo'),
    ['clippy', '--message-format=json', '--quiet'], {
      cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env)
    });
  if (!clippy.ok) return { name, ran: false, reason: clippy.reason };
  const converted = spawnSafe(spawn, envBin(env, 'CLIPPY_SARIF', 'clippy-sarif'), [], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env),
    input: clippy.result.stdout || ''
  });
  if (!converted.ok) return { name, ran: false, reason: converted.reason };
  const parsed = parseJsonSafe(converted.result.stdout);
  if (parsed === null) {
    return { name, ran: false, reason: `clippy-sarif produced no parseable SARIF (exit ${converted.result.status ?? 'null'})` };
  }
  const normalized = parseSarif(parsed, { root, source: 'clippy' });
  if (!normalized.ok) return { name, ran: false, reason: `clippy SARIF unusable: ${normalized.reason}` };
  return { name, ran: true, reason: null, source: 'cargo clippy | clippy-sarif', findings: normalized.findings };
}

/**
 * PHPStan — only with composer.json AND the binary (PATH or vendor/bin).
 * `--error-format=json` rather than sarif: PHPStan's SARIF formatter is
 * version-dependent, and normalizing a shape we can rely on beats guessing at a
 * flag that may not exist.
 */
export function runPhpstan({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  const name = 'phpstan';
  if (disabled(env, 'PHPSTAN')) return { name, ran: false, reason: 'disabled via BRAIN_LINT_PHPSTAN=0' };
  if (!fs.existsSync(path.join(root, 'composer.json'))) {
    return { name, ran: false, reason: 'no composer.json in this repo — not a PHP project' };
  }
  const vendorBin = path.join(root, 'vendor', 'bin', 'phpstan');
  const bin = env.BRAIN_LINT_PHPSTAN_BIN || (fs.existsSync(vendorBin) ? vendorBin : (hasBin('phpstan', { env }) ? 'phpstan' : null));
  if (!bin) return { name, ran: false, reason: 'phpstan not installed (neither on PATH nor at vendor/bin/phpstan)' };
  const spawned = spawnSafe(spawn, bin, ['analyse', '--no-progress', '--error-format=json'], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env)
  });
  if (!spawned.ok) return { name, ran: false, reason: spawned.reason };
  const parsed = parseJsonSafe(spawned.result.stdout);
  if (parsed === null) {
    return { name, ran: false, reason: `phpstan produced no parseable JSON (exit ${spawned.result.status ?? 'null'}) — a phpstan.neon config is usually required` };
  }
  const normalized = normalizePhpstanJson(parsed, { root });
  if (!normalized.ok) return { name, ran: false, reason: `phpstan output unusable: ${normalized.reason}` };
  return { name, ran: true, reason: null, source: 'phpstan analyse --error-format=json (normalized here)', findings: normalized.findings };
}

/**
 * Read SARIF files the user already has (their CI, their tool, their run). The
 * point of the `--sarif` escape hatch: the ranking works without us executing
 * anything at all, which is the honest position for a tool that claims to
 * CONSUME linters rather than be one.
 */
export function readSarifFiles(paths, { root = ROOT } = {}) {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    const name = `sarif:${normPath(p)}`;
    let raw;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_BUFFER) { out.push({ name, ran: false, reason: `SARIF file exceeds the ${MAX_BUFFER}-byte cap` }); continue; }
      raw = readJsonFile(abs);
    } catch (error) {
      out.push({ name, ran: false, reason: `could not read ${normPath(p)}: ${error.code || error.message || error}` });
      continue;
    }
    const parsed = parseSarif(raw, { root, source: normPath(p) });
    if (!parsed.ok) { out.push({ name, ran: false, reason: `${normPath(p)}: ${parsed.reason}` }); continue; }
    out.push({
      name,
      ran: true,
      reason: null,
      source: `--sarif ${normPath(p)}`,
      findings: parsed.findings,
      skippedRuns: parsed.skippedRuns,
      skippedResults: parsed.skippedResults
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// I/O: ranking inputs (git history, import graph, leases)
// ---------------------------------------------------------------------------

/** Read leases from active_state.md. Read-only: null when absent (never creates). */
export function readLeasesSafe() {
  try {
    if (!fs.existsSync(ACTIVE_STATE)) return null;
    return activeStateJson().leases.filter((l) => l && l.target);
  } catch {
    return null;
  }
}

/**
 * Build every ranking signal we can for `root`. Never throws: each signal is
 * independently degradable, and rankFindings simply omits the factors whose
 * input is null.
 */
export function rankingSignals({
  root = ROOT, now = Date.now(), env = process.env, spawn = spawnSync, files = null, commitWindow
} = {}) {
  const limit = clampInt(commitWindow, clampInt(env.BRAIN_LINT_COMMITS, DEFAULT_COMMIT_WINDOW));
  const notes = [];
  let commits = [];
  try {
    const r = spawn('git', gitLogArgs({ limit }), { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (!r || r.error || r.status !== 0) {
      notes.push('git log unavailable — churn and fix-density factors omitted');
    } else {
      commits = parseLog(r.stdout || '');
    }
  } catch {
    notes.push('git log failed — churn and fix-density factors omitted');
  }

  // A saturated window is not a full history. `--commits 500` on a repo that
  // moves fast covers weeks, not the life of the code, so churn ranks are
  // computed over a slice the reader never chose — and the tool used to say
  // nothing about it. Found in the field: a team ranked 476 ESLint findings,
  // got a thin ranking, and only discovered why by trying --commits 3000.
  // Saying which SPAN was covered is the honest form: "500 commits" means
  // nothing without knowing whether that is a month or a decade.
  if (commits.length >= limit && commits.length > 1) {
    const stamps = commits
      .map((c) => Date.parse(c.dateIso))
      .filter((n) => Number.isFinite(n));
    if (stamps.length > 1) {
      const days = Math.max(1, Math.round((Math.max(...stamps) - Math.min(...stamps)) / 86_400_000));
      notes.push(
        `history window SATURATED: ranked over the newest ${limit} commit(s), which cover ` +
        `only the last ~${days} day(s) of this repo. Files older than that carry no churn ` +
        'or fix-density signal. Widen with --commits <n> (or BRAIN_LINT_COMMITS) if the ' +
        'ranking looks thin.'
      );
    }
  }

  let hs = null;
  let health = null;
  if (commits.length) {
    try {
      hs = hotspots(commits, { now });
      health = fileHealth(commits, { now });
    } catch {
      notes.push('git history could not be summarized — churn and fix-density factors omitted');
      hs = null;
      health = null;
    }
  } else if (!notes.length) {
    notes.push('no commits in the history window — churn and fix-density factors omitted');
  }

  let graph = null;
  try {
    // Discover here when the caller did not already pay for `git ls-files`.
    const discovered = files || gitFiles(root, spawn) || [];
    const sources = [...new Set(discovered.map(normPath))]
      .filter((f) => SOURCE_EXT_RE.test(f) && !IGNORE_DIR_RE.test(f))
      .sort(byString);
    if (sources.length) {
      const memo = new Map();
      const readFile = (rel) => {
        if (memo.has(rel)) {
          const cached = memo.get(rel);
          if (cached instanceof Error) throw cached;
          return cached;
        }
        try {
          const abs = path.join(root, rel);
          if (fs.statSync(abs).size > MAX_FILE_BYTES) throw new Error('file exceeds the 2MB scan cap');
          const text = fs.readFileSync(abs, 'utf8');
          memo.set(rel, text);
          return text;
        } catch (error) {
          memo.set(rel, error);
          throw error;
        }
      };
      graph = buildImportGraph({ files: sources, readFile });
    } else {
      notes.push('no scannable source files — the dependents factor is omitted');
    }
  } catch {
    notes.push('import graph could not be built — the dependents factor is omitted');
    graph = null;
  }

  const leases = readLeasesSafe();
  if (!leases) notes.push('no .project-brain/active_state.md — the lease factor is omitted');

  return {
    commits,
    hotspots: hs,
    health,
    graph,
    leases,
    now,
    self: String(env.BRAIN_ACTOR || '').trim(),
    notes
  };
}

// ---------------------------------------------------------------------------
// the whole report (thin I/O wrapper over the pure core)
// ---------------------------------------------------------------------------

/**
 * Ranked lint findings for `root`. TOTAL: no path throws; every absent tool is
 * a degraded entry with a reason, and nothing is ever claimed clean that was
 * not read.
 */
export function lintReport({
  root = ROOT,
  now = Date.now(),
  env = process.env,
  spawn = spawnSync,
  sarifPaths = [],
  tool = '',
  limit = DEFAULT_LIMIT,
  weights,
  commitWindow,
  signals: injectedSignals = null
} = {}) {
  const wanted = String(tool || '').trim().toLowerCase();
  const files = gitFiles(root, spawn);
  const runners = [
    ['eslint', () => runEslint({ root, env, spawn, files })],
    ['ruff', () => runRuff({ root, env, spawn, files })],
    ['golangci-lint', () => runGolangciLint({ root, env, spawn, files })],
    ['clippy', () => runClippy({ root, env, spawn })],
    ['phpstan', () => runPhpstan({ root, env, spawn })]
  ];

  const results = [];
  for (const [name, run] of runners) {
    if (wanted && wanted !== name) {
      results.push({ name, ran: false, reason: `not selected (--tool ${wanted})` });
      continue;
    }
    results.push(run());
  }
  for (const entry of readSarifFiles(sarifPaths, { root })) results.push(entry);

  const findings = [];
  for (const r of results) if (r.ran) findings.push(...(r.findings || []));
  const deduped = dedupeFindings([...findings].sort(byLocation));

  // Signals are injectable so a caller that also calibrates (the CLI) pays for
  // one `git log` + one import graph, not two.
  const signals = injectedSignals || rankingSignals({ root, now, env, spawn, files, commitWindow });
  const ranking = rankFindings(deduped, {
    hotspots: signals.hotspots,
    graph: signals.graph,
    health: signals.health,
    leases: signals.leases,
    now,
    self: signals.self,
    weights
  });

  const report = buildLintReport({
    tools: results.map((r) => ({
      name: r.name,
      purpose: r.name.startsWith('sarif:') ? 'external SARIF' : 'lint',
      ran: r.ran,
      reason: r.reason,
      findings: r.ran ? (r.findings || []).length : 0,
      source: r.source
    })),
    ranking,
    now,
    limit
  });
  report.ranking.signalNotes = signals.notes;
  report.commits = signals.commits.length;
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: lint-intel.mjs [--json] [--limit N] [--tool <name>] [--sarif <path>]…',
    '                      [--calibrate] [--horizon-days N] [--commits N]',
    '',
    'CONSUME the linters you already run, then RANK their findings by whether they',
    'sit where a change actually hurts: churn hotspot × transitive dependents ×',
    'foreign lease × fix density × the tool\'s own severity. We do not ship',
    'detectors — ESLint/Ruff/golangci-lint/Clippy/PHPStan already have them, and',
    'they all speak SARIF.',
    '',
    'Flags:',
    '  --json            Parseable JSON on stdout, nothing else.',
    '  --limit N         Findings to print (default ' + DEFAULT_LIMIT + '). The count is always exact.',
    '  --tool <name>     Run only one of: ' + TOOL_NAMES.join(', ') + '.',
    '  --sarif <path>    Ingest a SARIF 2.1.0 file you already have (repeatable).',
    '                    With --sarif nothing is executed — bring your CI\'s report.',
    '  --calibrate       Ask whether the ranking predicts near-future fixes on THIS',
    '                    repo, next to a severity-only baseline. Expect "too few',
    '                    findings to say" on small repos; that is the honest answer.',
    '  --horizon-days N  Calibration horizon (default ' + DEFAULT_HORIZON_DAYS + ').',
    '  --commits N       Git history window for ranking (default ' + DEFAULT_COMMIT_WINDOW + ').',
    '',
    'Env:',
    '  BRAIN_LINT_ESLINT=0 | RUFF=0 | GOLANGCI=0 | CLIPPY=0 | PHPSTAN=0   skip a tool',
    '  BRAIN_LINT_<TOOL>_BIN=…    binary override',
    '  BRAIN_LINT_TIMEOUT_MS=…    per-tool timeout (default ' + DEFAULT_TIMEOUT_MS + ')',
    '',
    'THE WEIGHTS ARE NOT CALIBRATED. LINT_RANK_WEIGHTS are reviewable defaults, not',
    'validated numbers. Exit code is always 0: this is a report, not a gate.'
  ].join('\n');
}

function out(text) { process.stdout.write(text + '\n'); }

function levelTag(level) {
  return String(level || 'note').toUpperCase().padEnd(7);
}

function printHuman(report) {
  out('Lint intelligence — findings ranked by where they hurt');
  out('');
  out('Tools:');
  for (const t of report.tools) {
    out(`  ${t.ran ? 'ran    ' : 'ABSENT '} ${t.name}${t.ran ? ` — ${t.findings} finding(s) via ${t.source}` : ` — ${t.reason}`}`);
  }
  out('');
  out(`  ${report.statement}`);

  out('');
  out('Ranking inputs:');
  const i = report.ranking.inputs || {};
  out(`  churn/fix-density: ${i.hotspots ? 'yes' : 'NO'} · import graph: ${i.graph ? `yes (${report.ranking.params.graphNodes} nodes)` : 'NO'} · ` +
    `leases: ${i.leases ? `yes (${i.activeForeignLeases} active foreign)` : 'NO'}`);
  for (const note of report.ranking.signalNotes || []) out(`  · ${note}`);

  if (report.findings.length) {
    out('');
    out(`Top ${report.findings.length} of ${report.total} finding(s):`);
    report.findings.forEach((f, idx) => {
      out('');
      out(`  ${String(idx + 1).padStart(2)}. weight ${String(f.weight).padStart(4)}  ${levelTag(f.level)} ${f.ruleId}  ${f.file || '(no file)'}${f.startLine ? `:${f.startLine}` : ''}`);
      out(`      ${f.message || '(no message)'}`);
      for (const r of f.reasons) out(`      · ${r.kind}: ${r.message}`);
      if (f.lowConfidence) out(`      ! low confidence: ${f.reason}`);
    });
    if (report.truncated) out(`\n  …${report.total - report.findings.length} more not shown (--limit)`);
  }

  out('');
  out(`counts: error ${report.counts.error} · warning ${report.counts.warning} · note ${report.counts.note}`);
  out('');
  out(`Rank caveat: ${RANK_NOTE}`);
  out(`Calibration: ${WEIGHTS_NOT_CALIBRATED_NOTE}`);
  if (!report.claims.anyToolRan) out(`Coverage: ${NOT_SCANNED_NOTE}`);
  out('');
  out(`Next: ${nextAction(report)}`);
}

function printCalibration(cal) {
  out('Lint-rank calibration (in-repo self-calibration, NOT a cross-repo benchmark)');
  out('');
  out(`  method:   ${cal.method}`);
  out(`  cut:      ${cal.params.cut || '(no commits)'} (horizon ${cal.params.horizonDays}d)`);
  out(`  findings: ${cal.findingsConsidered} considered → ${cal.evaluated} file(s) evaluated, ${cal.defective} later fixed`);
  if (cal.quantiles.length) {
    out('');
    out('  quantile  weight range     files  fixed  rate');
    for (const q of cal.quantiles) {
      out(`  ${q.quantile}        ${String(q.weightMin).padStart(4)} – ${String(q.weightMax).padStart(4)}    ` +
        `${String(q.files).padStart(5)}  ${String(q.defective).padStart(5)}  ${q.defectRate}`);
    }
  }
  out('');
  out(`  AUC (rank):          ${cal.auc === null ? 'undefined' : cal.auc}`);
  out(`  AUC (severity only): ${cal.severityOnlyAuc === null ? 'undefined' : cal.severityOnlyAuc}`);
  out(`  delta:               ${cal.delta === null ? 'n/a' : cal.delta}`);
  out('');
  out(`  ${cal.verdict}`);
  out('');
  out(`  Caveat: ${cal.caveat}`);
}

export function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    out(usage());
    process.exit(0);
  }
  const json = takeFlag(args, '--json');
  const calibrate = takeFlag(args, '--calibrate');
  const limit = clampInt(takeOption(args, '--limit'), DEFAULT_LIMIT);
  const commitWindow = clampInt(takeOption(args, '--commits'), DEFAULT_COMMIT_WINDOW);
  const horizonDays = clampInt(takeOption(args, '--horizon-days'), DEFAULT_HORIZON_DAYS);
  const tool = takeOption(args, '--tool');
  const sarifPaths = [];
  for (;;) {
    const p = takeOption(args, '--sarif');
    if (!p) break;
    sarifPaths.push(p);
  }

  const now = Date.now();
  // One signal build, shared by the report and the calibration.
  const signals = rankingSignals({ root: ROOT, now, commitWindow });
  // When calibrating, keep the FULL ranked list (calibration must see every
  // finding, not the display slice) and trim only for printing.
  const report = lintReport({
    root: ROOT, now, sarifPaths, tool, commitWindow, signals,
    limit: calibrate ? MAX_FINDINGS : limit
  });

  if (!calibrate) {
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printHuman(report);
    process.exit(0);
  }

  // Calibration reads the ranked findings; the fields it needs are the
  // whitelist ones, which survive ranking untouched.
  const cal = calibrateLintRank(report.findings, signals.commits, {
    horizonDays,
    graph: signals.graph
  });
  const full = report.findings;
  report.findings = full.slice(0, limit);
  report.truncated = full.length > limit;
  report.limit = limit;

  if (json) process.stdout.write(JSON.stringify({ report, calibration: cal }, null, 2) + '\n');
  else {
    printHuman(report);
    out('');
    printCalibration(cal);
  }
  process.exit(0);
}

// Only run the CLI when invoked directly; importing for unit tests (and for a
// future /api/lint endpoint) must not parse argv or spawn anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[brain:lint] ${error.message || error}\n`);
    process.exit(1);
  }
}
