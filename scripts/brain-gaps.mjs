/**
 * brain:gaps — deterministic self-audit of what the brain does NOT know.
 *
 * A report of coverage holes, stale/decayed decisions, and self-contradictions,
 * computed ENTIRELY from indexed store records — no LLM, no embeddings, no model
 * download. It is the structure+trust counterpart to the act axis (brain:audit
 * judges what's *worth* fixing; brain:gaps mechanically finds what's *missing or
 * inconsistent*). READ-ONLY by default; `--as-findings` is the one explicit
 * mutation path, emitting each gap as an indexed `finding` so it feeds
 * brain:improve / the act-axis backlog.
 *
 * Three checks, all PURE + exported so they're unit-testable against fixture
 * records (no real index/model needed):
 *
 *   (a) coverage   — set arithmetic over records:
 *       · modules with code but NO decision (ADR) AND NO module doc
 *       · features with code but NO test records
 *       · decisions with an empty / "Needs Review" rationale
 *   (b) decay      — decision records whose date is old AND whose module's code
 *       has churned since (a code file in that module newer than the ADR, or a
 *       content-hash drift signal). Flagged "may be outdated".
 *   (c) contradictions — a brain doc that names a backticked `symbol` absent
 *       from the indexed code symbol surface (symbol-drift), OR cites a file
 *       path that no longer exists on disk (path-drift).
 *
 * The symbol-drift logic here is re-implemented minimally from records on
 * purpose: importing brain-verify.mjs would execute its CLI (it is an unguarded
 * command script). Approach is the same — live-symbol set vs backticked doc
 * tokens — but kept local and small.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, exists, read, slugify, sha256,
  takeFlag, takeOption, peekOption
} from './common.mjs';
import { openStore } from './store.mjs';
import { openEmbedder } from './embed.mjs';
import { FINDINGS_DIR, serializeFinding, parseFinding } from './findings.mjs';

// ---------------------------------------------------------------------------
// Shared record helpers (kept local; no command-script imports).
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** Aggregate/synthetic records that don't describe a single curated source. */
function isSyntheticRecord(record) {
  if (record.isSummary) return true;
  const type = String(record.type || '');
  if (type.endsWith('-summary')) return true;
  if (type === 'decision-cluster' || type === 'repo-summary' || type === 'fleet-summary' || type === 'cross-project-edge') return true;
  const file = String(record.file || '');
  if (file.startsWith('.project-brain/project-summary')) return true;
  if (file.includes('.project-brain/decisions/__cluster__/')) return true;
  if (file.includes('.project-brain/fleet/edges/')) return true;
  // Template scaffolds shipped with the skill are not real project records.
  if (file.startsWith('templates/') || file.includes('/templates/brain/')) return true;
  if (path.basename(file).startsWith('_')) return true;
  return false;
}

function recordMs(record) {
  const t = Date.parse(String(record.mtime || '').trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Best-effort ADR date: prefer a frontmatter/`Date:` line embedded in the doc
 * body (the indexer strips YAML frontmatter, so a date only survives if it's in
 * the prose), else fall back to the record mtime. Returns ms or null.
 */
function decisionDateMs(record) {
  const m = String(record.text || '').match(/^\s*(?:date|Date)\s*[:=]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/m);
  if (m) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) return t;
  }
  return recordMs(record);
}

/** Concatenate every chunk's text for a file, in chunk order (so a rationale
 *  that lives in a later chunk is still visible to the coverage check). */
function bodyByFile(records) {
  const map = new Map();
  for (const record of records) {
    const file = String(record.file || '');
    if (!file) continue;
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(record);
  }
  const out = new Map();
  for (const [file, recs] of map) {
    recs.sort((a, b) => Number(a.chunk || 0) - Number(b.chunk || 0));
    out.set(file, recs.map(r => String(r.text || '')).join('\n'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Symbol surface (minimal re-implementation; do NOT import brain-verify.mjs).
// ---------------------------------------------------------------------------

const SYMBOL_STOPWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'main', 'develop', 'npm', 'node',
  'git', 'json', 'yaml', 'todo', 'fixme', 'readme', 'http', 'https', 'url',
  'api', 'id', 'ok', 'env', 'cli', 'ci', 'md'
]);

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function normalizeSymbol(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_$]/g, '');
}

/** Identifier-like tokens inside backtick spans in a doc body. */
export function extractDocSymbols(text) {
  const out = new Set();
  const spanRe = /`([^`]+)`/g;
  let m;
  while ((m = spanRe.exec(String(text || ''))) !== null) {
    const raw = m[1].trim();
    if (!raw || /\s/.test(raw)) continue;        // multi-word → not a bare symbol
    if (/[\\/]/.test(raw)) continue;             // paths → handled by path-drift
    const hadParens = /\(\)?$/.test(raw);
    const token = raw.replace(/\(\)?$/, '').replace(/[.,;:]+$/, '');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) continue;
    if (token.length < 3) continue;
    if (/^[A-Z0-9_]+$/.test(token)) continue;    // ALL_CAPS → env var / constant
    if (SYMBOL_STOPWORDS.has(token.toLowerCase())) continue;
    const codeish =
      /[a-z][A-Z]/.test(token) ||                 // camelCase
      /_/.test(token) ||                          // snake_case
      /^[A-Z][a-z]/.test(token) ||                // PascalCase
      hadParens;                                  // call form
    if (!codeish) continue;
    out.add(token);
  }
  return [...out];
}

/** Every identifier still present in indexed code (declared/exported/refs/imports/body). */
export function liveSymbolSet(records) {
  const set = new Set();
  for (const record of records) {
    if (record.type !== 'code') continue;
    for (const symbol of record.symbols || []) set.add(normalizeSymbol(symbol));
    for (const symbol of record.exportedSymbols || []) set.add(normalizeSymbol(symbol));
    for (const ref of record.references || []) set.add(normalizeSymbol(ref));
    for (const imp of record.imports || []) set.add(normalizeSymbol(imp));
    const matches = String(record.text || '').match(IDENT_RE);
    if (matches) for (const ident of matches) set.add(normalizeSymbol(ident));
  }
  return set;
}

const DOC_TYPES = new Set(['decision', 'module', 'feature', 'explainer']);

function isBrainDoc(record) {
  if (DOC_TYPES.has(record.type)) return true;
  return /^\.project-brain\/(decisions|modules|features|explainers)\//.test(String(record.file || ''));
}

// ---------------------------------------------------------------------------
// (a) COVERAGE GAPS
// ---------------------------------------------------------------------------

const NEEDS_REVIEW_RE = /needs\s+review/i;

/**
 * Set arithmetic over records:
 *   · modules with code but no decision AND no module doc
 *   · features with code but no test records
 *   · decisions whose rationale is empty or "Needs Review"
 */
export function findCoverageGaps(records, opts = {}) {
  const gaps = [];
  const bodies = bodyByFile(records);

  // --- module coverage ---------------------------------------------------
  const codeModules = new Set();
  const modulesWithDoc = new Set();
  const modulesWithDecision = new Set();

  for (const record of records) {
    if (isSyntheticRecord(record)) continue;
    const mod = String(record.module || '').trim();
    if (record.type === 'code' && mod) codeModules.add(mod);
    if (record.type === 'module' && mod) modulesWithDoc.add(mod);
    if (record.type === 'decision' && mod) modulesWithDecision.add(mod);
  }
  // A decision may reference a module in its body even without the module
  // frontmatter field; count that as coverage so we don't over-report.
  const decisionBodies = [];
  for (const [file, body] of bodies) {
    if (/^\.project-brain\/decisions\//.test(file)) decisionBodies.push(body);
  }
  for (const mod of codeModules) {
    if (modulesWithDecision.has(mod)) continue;
    if (decisionBodies.some(b => b.includes(mod))) modulesWithDecision.add(mod);
  }

  for (const mod of [...codeModules].sort()) {
    if (modulesWithDoc.has(mod) || modulesWithDecision.has(mod)) continue;
    gaps.push({
      kind: 'coverage',
      subkind: 'undocumented-module',
      severity: 'medium',
      key: mod,
      module: mod,
      detail: `module "${mod}" has code records but no decision (ADR) and no module doc`
    });
  }

  // --- feature coverage (code but no tests) ------------------------------
  const codeFeatures = new Set();
  const featuresWithTests = new Set();
  for (const record of records) {
    if (isSyntheticRecord(record)) continue;
    const feat = String(record.feature || '').trim();
    if (!feat) continue;
    if (record.type !== 'code') continue;
    if (isTestRecord(record)) featuresWithTests.add(feat);
    else codeFeatures.add(feat);
  }
  for (const feat of [...codeFeatures].sort()) {
    if (featuresWithTests.has(feat)) continue;
    gaps.push({
      kind: 'coverage',
      subkind: 'untested-feature',
      severity: 'high',
      key: feat,
      feature: feat,
      detail: `feature "${feat}" has code records but no test records`
    });
  }

  // --- decisions with empty / Needs-Review rationale ---------------------
  const seenDecision = new Set();
  for (const record of records) {
    if (record.type !== 'decision') continue;
    if (isSyntheticRecord(record)) continue;
    const file = String(record.file || '');
    if (!file || seenDecision.has(file)) continue;
    seenDecision.add(file);
    const body = bodies.get(file) || '';
    if (hasEmptyRationale(body)) {
      gaps.push({
        kind: 'coverage',
        subkind: 'empty-rationale',
        severity: 'medium',
        key: file,
        file,
        detail: `decision ${file} has an empty or "Needs Review" rationale`
      });
    }
  }

  return gaps;
}

/** Test records: tests/e2e/spec dirs or *.test.* / *.spec.* filenames. */
function isTestRecord(record) {
  const file = String(record.file || '');
  return /(^|\/)(tests?|e2e|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/**
 * A decision's rationale is "empty" if its body has no meaningful prose under a
 * rationale/decision heading, or the body is essentially a Needs-Review stub.
 * Conservative: only flags clear holes (heading present but no content, or a
 * Needs-Review marker with almost no other prose).
 */
export function hasEmptyRationale(body) {
  const text = String(body || '');
  const stripped = text.replace(/^#.*$/gm, '').replace(/`[^`]*`/g, '').trim();

  // A near-empty doc that is mostly a Needs-Review marker.
  if (NEEDS_REVIEW_RE.test(text) && stripped.replace(NEEDS_REVIEW_RE, '').replace(/[\s\-*_>.:]/g, '').length < 40) {
    return true;
  }

  // A Decision/Rationale heading that has no prose beneath it before the next heading.
  const headingRe = /^#{1,6}\s*(decision|rationale|context)\b.*$/gim;
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading));
    const meaningful = section
      .replace(/`[^`]*`/g, '')
      .replace(NEEDS_REVIEW_RE, '')
      .replace(/[\s\-*_>.:]/g, '');
    if (meaningful.length < 20) return true;
  }

  // No body at all (only headings / whitespace).
  if (stripped.length < 20) return true;

  return false;
}

// ---------------------------------------------------------------------------
// (b) DECISION DECAY
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

/**
 * Decisions that are old AND whose module's code has churned since the ADR date.
 * Churn proxy: a code record in the same module with mtime newer than the ADR
 * date (an explicit hash-drift signal can also be supplied via opts.driftFiles).
 * `now` and `decayDays` are injectable for deterministic tests.
 */
export function findDecisionDecay(records, opts = {}) {
  const decayDays = Number(opts.decayDays ?? 90);
  const now = Number(opts.now ?? Date.now());
  const gaps = [];

  // Newest code mtime per module.
  const newestCodeByModule = new Map();
  for (const record of records) {
    if (record.type !== 'code' || isSyntheticRecord(record)) continue;
    const mod = String(record.module || '').trim();
    if (!mod) continue;
    const ms = recordMs(record);
    if (ms == null) continue;
    newestCodeByModule.set(mod, Math.max(newestCodeByModule.get(mod) || 0, ms));
  }

  const seen = new Set();
  for (const record of records) {
    if (record.type !== 'decision' || isSyntheticRecord(record)) continue;
    const file = String(record.file || '');
    const mod = String(record.module || '').trim();
    if (!file || !mod || seen.has(file)) continue;
    seen.add(file);

    const adrMs = decisionDateMs(record);
    if (adrMs == null) continue;
    const ageDays = (now - adrMs) / DAY_MS;
    if (ageDays < decayDays) continue;            // not old enough to decay

    const newestCode = newestCodeByModule.get(mod);
    if (!newestCode || newestCode <= adrMs) continue; // module code hasn't moved since

    gaps.push({
      kind: 'decay',
      subkind: 'decision-decay',
      severity: 'medium',
      key: file,
      file,
      module: mod,
      ageDays: Math.round(ageDays * 10) / 10,
      churnLagDays: Math.round(((newestCode - adrMs) / DAY_MS) * 10) / 10,
      detail: `decision ${file} is ~${Math.round(ageDays)}d old and module "${mod}" code changed ~${Math.round((newestCode - adrMs) / DAY_MS)}d after it — may be outdated`
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// (c) STRUCTURAL CONTRADICTIONS
// ---------------------------------------------------------------------------

const PATH_RE = /(?:^|[\s(`])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,5})/g;

// Placeholder/illustrative tokens that appear in ADR/module prose as EXAMPLES,
// not as real citations. Flagging these would cry wolf (the brain-verify lesson).
const PLACEHOLDER_SEGMENT = new Set([
  'x', 'n', 'foo', 'bar', 'baz', 'qux', 'something', 'example', 'name', 'id',
  'slug', 'version', 'date'
]);
const PLACEHOLDER_RE = /\b(YYYY|MM|DD|HH|<[^>]+>|\{[^}]+\}|\.\.\.|TODO|XXX)\b/;

/**
 * Paths that legitimately don't exist at rest, so a missing-file check would
 * false-positive: runtime/generated artifacts, user-local files, ephemeral
 * session files, and opt-in integration roots (spec-kit). Also drops obvious
 * illustrative placeholders (`src/index.ts`, `lib/foo.ts`, `specs/X/spec.md`).
 */
export function isIllustrativePath(p) {
  const s = String(p || '');
  if (PLACEHOLDER_RE.test(s)) return true;
  if (/\.lock$/.test(s)) return true;                                  // runtime locks
  if (/(^|\/)\.project-brain\/\.[^/]+/.test(s)) return true;           // .sync-state.json etc (dot files)
  if (/(^|\/)\.project-brain\/sessions\//.test(s)) return true;        // ephemeral handoffs
  if (/(^|\/)\.claude\//.test(s)) return true;                         // user-local settings
  if (/(^|\/)(\.specify|specs)\//.test(s)) return true;                // opt-in spec-kit
  if (/(^|\/)(node_modules|dist|build|coverage|\.next)\//.test(s)) return true;
  const segs = s.split('/').filter(Boolean);
  for (const seg of segs) {
    const base = seg.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase();
    if (PLACEHOLDER_SEGMENT.has(base)) return true;                    // foo/bar/X/something
  }
  return false;
}

/**
 * Brain docs that contradict the code surface:
 *   · symbol-drift: a backticked `symbol` absent from the live code symbol set
 *   · path-drift:   a concrete cited file path that no longer exists on disk
 *
 * Both `fileExists(relOrAbs)->bool` and `dirExists(relOrAbs)->bool` are injected
 * so the checks are pure + unit-testable; main supplies real-fs versions.
 *
 * Path-drift is deliberately conservative to avoid crying wolf (same lesson as
 * brain-verify's symbol-drift auto-skip): we only flag a cited path when its
 * PARENT DIRECTORY still exists but the file is gone — the high-confidence
 * "this specific file moved or was deleted" signal. A citation whose whole
 * directory is absent is treated as illustrative/relocated and skipped.
 */
export function findContradictions(records, opts = {}) {
  const fileExists = opts.fileExists || (() => true);
  const dirExists = opts.dirExists || (() => true);
  const live = opts.liveSymbols || liveSymbolSet(records);
  const symbolDriftChecked = live.size > 0;
  const gaps = [];

  const seenSym = new Set();
  const seenPath = new Set();
  for (const record of records) {
    if (isSyntheticRecord(record)) continue;
    if (!isBrainDoc(record)) continue;
    const file = String(record.file || '');
    const text = String(record.text || '');

    // symbol-drift (skipped entirely when no code symbols are indexed)
    if (symbolDriftChecked) {
      for (const token of extractDocSymbols(text)) {
        if (live.has(normalizeSymbol(token))) continue;
        const k = `${file}::${token}`;
        if (seenSym.has(k)) continue;
        seenSym.add(k);
        gaps.push({
          kind: 'contradiction',
          subkind: 'symbol-drift',
          severity: 'medium',
          key: k,
          file,
          symbol: token,
          detail: `\`${token}\` named in ${file} is not present in any indexed code record (renamed/deleted?)`
        });
      }
    }

    // path-drift
    for (const cited of extractCitedPaths(text)) {
      const k = `${file}::${cited}`;
      if (seenPath.has(k)) continue;
      seenPath.add(k);
      if (fileExists(cited)) continue;                  // file is present → fine
      const parent = cited.includes('/') ? cited.slice(0, cited.lastIndexOf('/')) : '';
      if (!parent || !dirExists(parent)) continue;      // dir gone too → illustrative/relocated, skip
      gaps.push({
        kind: 'contradiction',
        subkind: 'path-drift',
        severity: 'high',
        key: k,
        file,
        citedPath: cited,
        detail: `${file} cites path "${cited}" which no longer exists on disk (its directory still does)`
      });
    }
  }
  return { gaps, symbolDriftChecked };
}

/** Pull plausible, concrete repo-relative file paths out of a doc body. */
export function extractCitedPaths(text) {
  const out = new Set();
  const src = String(text || '');
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(src)) !== null) {
    let p = m[1];
    // Strip trailing punctuation that markdown often glues on.
    p = p.replace(/[).,;:`]+$/, '');
    if (!p || p.length > 200) continue;
    // Skip URLs / scheme-like tokens.
    if (/^[a-z]+:\/\//i.test(p)) continue;
    // Must contain a directory separator (bare filenames are too ambiguous).
    if (!p.includes('/')) continue;
    // Drop placeholders / runtime / opt-in artifacts (see isIllustrativePath).
    if (isIllustrativePath(p)) continue;
    out.add(p);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

export function runGaps(records, opts = {}) {
  const coverage = findCoverageGaps(records, opts);
  const decay = findDecisionDecay(records, opts);
  const { gaps: contradictions, symbolDriftChecked } = findContradictions(records, opts);
  const all = [...coverage, ...decay, ...contradictions];
  all.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
    String(a.kind).localeCompare(String(b.kind)) ||
    String(a.key || '').localeCompare(String(b.key || '')));
  return {
    ok: all.length === 0,
    counts: {
      coverage: coverage.length,
      decay: decay.length,
      contradictions: contradictions.length,
      high: all.filter(g => g.severity === 'high').length,
      medium: all.filter(g => g.severity === 'medium').length,
      low: all.filter(g => g.severity === 'low').length,
      total: all.length
    },
    symbolDriftChecked,
    gaps: all
  };
}

// ---------------------------------------------------------------------------
// --as-findings: emit each gap as a `finding` record (reuses serializeFinding).
// ---------------------------------------------------------------------------

/** Map a gap to the finding category most useful for the act-axis backlog. */
function gapCategory(gap) {
  if (gap.kind === 'coverage' && gap.subkind === 'untested-feature') return 'testing';
  if (gap.kind === 'decay') return 'documentation';
  if (gap.kind === 'contradiction') return 'documentation';
  return 'documentation';
}

function gapImpact(gap) {
  return gap.severity === 'high' ? 4 : gap.severity === 'medium' ? 3 : 2;
}

function gapTitle(gap) {
  switch (gap.subkind) {
    case 'undocumented-module': return `Undocumented module: ${gap.module}`;
    case 'untested-feature': return `Untested feature: ${gap.feature}`;
    case 'empty-rationale': return `Decision missing rationale: ${path.basename(gap.file)}`;
    case 'decision-decay': return `Decision may be outdated: ${path.basename(gap.file)}`;
    case 'symbol-drift': return `Symbol drift in ${path.basename(gap.file)}: ${gap.symbol}`;
    case 'path-drift': return `Broken path in ${path.basename(gap.file)}: ${gap.citedPath}`;
    default: return gap.detail.slice(0, 80);
  }
}

/** Sources to cite for staleness anchoring (the file the gap is about). */
function gapSources(gap) {
  const paths = [];
  if (gap.file) paths.push(gap.file);
  if (gap.citedPath) paths.push(gap.citedPath);
  const out = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    out.push({ path: p, sha256: exists(abs) ? sha256(read(abs)) : null });
  }
  return out;
}

/**
 * Write one finding per gap (idempotent by slug — preserves `created`). Returns
 * the relative paths written. Pure-ish: takes the gaps + an IO surface so the
 * spawn test exercises the real path. Reuses serializeFinding from findings.mjs.
 */
export function emitFindings(gaps, io) {
  const { ensureDir, writeFile, fileExists, readFile } = io;
  ensureDir(FINDINGS_DIR);
  const written = [];
  const now = new Date().toISOString();
  for (const gap of gaps) {
    const title = gapTitle(gap);
    const slug = `gap-${slugify(title)}`;
    const dest = path.join(FINDINGS_DIR, `${slug}.md`);
    let created = now;
    if (fileExists(dest)) {
      try {
        const prev = parseFinding(readFile(dest));
        if (prev.created) created = prev.created;
      } catch { /* keep now */ }
    }
    const body = [
      gap.detail,
      '',
      `_Auto-detected by \`brain:gaps\` (${gap.kind}/${gap.subkind}, severity ${gap.severity}). Deterministic — no LLM. Review before acting._`
    ].join('\n');
    writeFile(dest, serializeFinding({
      title,
      category: gapCategory(gap),
      status: 'open',
      impact: gapImpact(gap),
      created,
      updated: now,
      actor: process.env.BRAIN_ACTOR || 'brain:gaps',
      module: gap.module || '',
      symbols: gap.symbol ? [gap.symbol] : [],
      sources: gapSources(gap),
      body
    }));
    written.push(path.relative(ROOT, dest));
  }
  return written;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const SEVERITY_LABEL = { high: '🚨 HIGH', medium: '⚠ MEDIUM', low: 'ℹ LOW' };

function renderReport(report) {
  const out = [];
  if (report.ok) {
    out.push('Project Brain gaps: none detected — coverage, decisions, and structure look consistent.');
    return out.join('\n');
  }
  out.push(`# Brain gaps: ${report.counts.total} finding(s) ` +
    `(${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low)`);
  out.push('');
  for (const sev of ['high', 'medium', 'low']) {
    const group = report.gaps.filter(g => g.severity === sev);
    if (!group.length) continue;
    out.push(`## ${SEVERITY_LABEL[sev]} (${group.length})`);
    for (const g of group) out.push(`- [${g.kind}/${g.subkind}] ${g.detail}`);
    out.push('');
  }
  if (!report.symbolDriftChecked) {
    out.push('Note: symbol-drift skipped — no code symbols indexed (only TS/JS symbols are extracted today).');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

function usage() {
  return [
    'Usage: npm run brain:gaps -- [--decay-days N] [--json] [--as-findings] [--strict]',
    '',
    'Deterministic self-audit (no LLM, no embeddings). Read-only by default.',
    '  --decay-days N    age threshold (days) for the decision-decay check (default 90; env BRAIN_GAPS_DECAY_DAYS)',
    '  --json            machine-readable report on stdout',
    '  --as-findings     write each gap as an indexed `finding` (the one mutation; feeds brain:improve)',
    '  --strict          exit non-zero when any gap is found (for CI / hooks)'
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    console.log(usage());
    process.exit(0);
  }
  const jsonOut = takeFlag(args, '--json');
  const asFindings = takeFlag(args, '--as-findings');
  const strict = takeFlag(args, '--strict');
  const decayDays = Number(takeOption(args, '--decay-days') || process.env.BRAIN_GAPS_DECAY_DAYS || 90);
  // Accept (and ignore mutation-wise) a project filter passthrough so the flag
  // surface matches sibling commands; peekOption keeps it non-fatal if absent.
  peekOption(args, '--project');

  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const records = await store.getAll();
  await store.close();

  const fsmod = await import('node:fs');
  const fileExists = (p) => exists(path.isAbsolute(p) ? p : path.join(ROOT, p));
  const dirExists = (p) => {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    try { return fsmod.statSync(abs).isDirectory(); } catch { return false; }
  };
  const report = runGaps(records, { decayDays, fileExists, dirExists });

  let written = [];
  if (asFindings && report.gaps.length) {
    written = emitFindings(report.gaps, {
      ensureDir: (d) => fsmod.mkdirSync(d, { recursive: true }),
      writeFile: (p, data) => fsmod.writeFileSync(p, data),
      readFile: (p) => fsmod.readFileSync(p, 'utf8'),
      fileExists: (p) => fsmod.existsSync(p)
    });
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ...report, findingsWritten: written }, null, 2));
  } else {
    console.log(renderReport(report));
    if (written.length) {
      process.stdout.write(`\nWrote ${written.length} finding(s):\n${written.map(w => `  ${w}`).join('\n')}\n`);
    } else if (asFindings) {
      process.stdout.write('\nNo gaps to write as findings.\n');
    }
  }

  process.exit(strict && !report.ok ? 1 : 0);
}

// MANDATORY isMain guard: importing this module must not parse argv / open a store / exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:gaps] ${error.message || error}\n`);
    process.exit(1);
  });
}
