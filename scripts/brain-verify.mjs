/**
 * Drift detector: flags curated brain docs that have fallen out of sync
 * with the code they describe. Read-only — reports, never mutates.
 *
 * Two signals, both computed purely over indexed store records so they are
 * deterministic and testable:
 *
 *   1. symbol-drift  — a decision/module/feature doc references a code
 *      symbol (in backticks) that no longer exists in any indexed code
 *      record. Catches ADRs that name a function/class that was renamed
 *      or deleted. Complements `brain:link-check` (paths) with symbols.
 *
 *   2. stale-summary — a module/feature summary is older than the newest
 *      code file it summarizes by more than --stale-days. Catches summaries
 *      that drifted behind the code under them.
 *
 * Stale context is worse than no context: it confidently misleads the
 * agent. Default output is warnings on stderr + a report on stdout; pass
 * `--strict` to exit non-zero when findings exist (for CI / hooks).
 *
 * Limitations (reported, not hidden): symbol extraction only judges against
 * languages the indexer extracts symbols for (TS/JS today). When no code
 * symbols are indexed, symbol-drift auto-skips rather than crying wolf.
 */
import { takeFlag, takeOption } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';

const DOC_TYPES = new Set(['decision', 'module', 'feature']);
const SUMMARY_TYPES = new Set(['module-summary', 'feature-summary']);

// Backticked tokens that are common prose/tooling, not code symbols we own.
const SYMBOL_STOPWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'main', 'develop', 'npm', 'node',
  'git', 'json', 'yaml', 'todo', 'fixme', 'readme', 'http', 'https', 'url',
  'api', 'id', 'ok', 'env', 'cli', 'ci', 'md'
]);

/** Pull identifier-like tokens out of backtick spans in a doc body. */
export function extractDocSymbols(text) {
  const out = new Set();
  const spanRe = /`([^`]+)`/g;
  let m;
  while ((m = spanRe.exec(String(text || ''))) !== null) {
    const raw = m[1].trim();
    if (!raw || /\s/.test(raw)) continue;          // multi-word → not a bare symbol
    if (/[\\/]/.test(raw)) continue;               // paths → brain:link-check owns these
    const hadParens = /\(\)?$/.test(raw);
    const token = raw.replace(/\(\)?$/, '').replace(/[.,;:]+$/, '');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) continue;
    if (token.length < 3) continue;
    if (/^[A-Z0-9_]+$/.test(token)) continue;      // ALL_CAPS → likely env var / constant
    if (SYMBOL_STOPWORDS.has(token.toLowerCase())) continue;
    // Require a code-ish shape: CamelCase, snake_case, PascalCase, or call form.
    const codeish =
      /[a-z][A-Z]/.test(token) ||
      /_/.test(token) ||
      /^[A-Z][a-z]/.test(token) ||
      hadParens;
    if (!codeish) continue;
    out.add(token);
  }
  return [...out];
}

function normalizeSymbol(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_$]/g, '');
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Set of every identifier that still appears in indexed code: declared and
 * exported symbols, cross-file references, imports, and every identifier
 * token in the code body. The drift signal we want is "this name appears
 * nowhere in the code anymore" — a strong rename/deletion signal — so we
 * compare against the full identifier surface, not just top-level exports.
 * (Comparing against declared symbols alone floods false positives: object
 * fields, class methods, and option keys are real code, just not exports.)
 */
export function liveSymbolSet(records) {
  const set = new Set();
  for (const record of records) {
    if (record.type !== 'code') continue;
    for (const symbol of record.symbols || []) set.add(normalizeSymbol(symbol));
    for (const symbol of record.exportedSymbols || []) set.add(normalizeSymbol(symbol));
    for (const ref of record.references || []) set.add(normalizeSymbol(ref));
    for (const imp of record.imports || []) set.add(normalizeSymbol(imp));
    const text = String(record.text || '');
    const matches = text.match(IDENT_RE);
    if (matches) for (const ident of matches) set.add(normalizeSymbol(ident));
  }
  return set;
}

/**
 * Find brain docs naming a code symbol that no longer appears anywhere in
 * indexed code. Returns [] (skipped) when no code is indexed at all — we
 * cannot judge absence without a baseline.
 */
export function findSymbolDrift(records, opts = {}) {
  const live = opts.liveSymbols || liveSymbolSet(records);
  if (!live.size) return [];
  const seenPerFile = new Map();
  const findings = [];
  for (const record of records) {
    if (record.isSummary) continue;
    const isDoc = DOC_TYPES.has(record.type) ||
      /^\.project-brain\/(decisions|modules|features)\//.test(String(record.file || ''));
    if (!isDoc) continue;
    for (const token of extractDocSymbols(record.text)) {
      if (live.has(normalizeSymbol(token))) continue;
      const key = `${record.file}::${token}`;
      if (seenPerFile.has(key)) continue;
      seenPerFile.set(key, true);
      findings.push({
        kind: 'symbol-drift',
        file: record.file,
        symbol: token,
        type: record.type,
        confidence: 'medium',
        detail: `\`${token}\` referenced in ${record.file} is not a declared/exported symbol in any indexed code record`
      });
    }
  }
  return findings;
}

function recordMs(record) {
  const t = Date.parse(String(record.mtime || '').trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Find module/feature summaries older than their newest underlying code file
 * by more than staleDays. `now` is injectable for deterministic tests.
 */
export function findStaleSummaries(records, opts = {}) {
  const staleDays = Number(opts.staleDays ?? 14);
  const now = Number(opts.now ?? Date.now());
  const dayMs = 86400000;
  const findings = [];

  // Index newest code mtime per module and per feature.
  const newestByModule = new Map();
  const newestByFeature = new Map();
  for (const record of records) {
    if (record.type !== 'code' || record.isSummary) continue;
    const ms = recordMs(record);
    if (ms == null) continue;
    if (record.module) newestByModule.set(record.module, Math.max(newestByModule.get(record.module) || 0, ms));
    if (record.feature) newestByFeature.set(record.feature, Math.max(newestByFeature.get(record.feature) || 0, ms));
  }

  for (const record of records) {
    if (!SUMMARY_TYPES.has(record.type)) continue;
    const summaryMs = recordMs(record);
    if (summaryMs == null) continue;
    const key = record.type === 'module-summary' ? record.module : record.feature;
    if (!key) continue;
    const newest = record.type === 'module-summary' ? newestByModule.get(key) : newestByFeature.get(key);
    if (!newest) continue;
    const lagDays = (newest - summaryMs) / dayMs;
    if (lagDays <= staleDays) continue;
    findings.push({
      kind: 'stale-summary',
      file: record.file,
      summaryType: record.type,
      key,
      lagDays: Math.round(lagDays * 10) / 10,
      ageDays: Math.round(((now - summaryMs) / dayMs) * 10) / 10,
      confidence: 'high',
      detail: `${record.type} for "${key}" is ~${Math.round(lagDays)}d behind its newest code file — re-summarize`
    });
  }
  return findings;
}

export function runVerify(records, opts = {}) {
  const symbolDrift = opts.symbolDrift === false ? [] : findSymbolDrift(records, opts);
  const staleSummaries = findStaleSummaries(records, opts);
  const findings = [...staleSummaries, ...symbolDrift];
  return {
    ok: findings.length === 0,
    counts: { staleSummary: staleSummaries.length, symbolDrift: symbolDrift.length, total: findings.length },
    findings,
    symbolDriftChecked: opts.symbolDrift !== false && liveSymbolSet(records).size > 0
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    console.log('Usage: npm run brain:verify -- [--stale-days N] [--no-symbol-drift] [--strict] [--json]');
    console.log('Env: BRAIN_DRIFT_STALE_DAYS (default 14).');
    process.exit(0);
  }
  const strict = takeFlag(args, '--strict');
  const jsonOut = takeFlag(args, '--json');
  const symbolDrift = !takeFlag(args, '--no-symbol-drift');
  const staleDays = Number(takeOption(args, '--stale-days') || process.env.BRAIN_DRIFT_STALE_DAYS || 14);

  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const records = await store.getAll();
  await store.close();

  const report = runVerify(records, { staleDays, symbolDrift });

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (report.ok) {
      console.log('Project Brain drift check passed — no stale summaries or symbol drift detected.');
    } else {
      console.log(`# Brain drift: ${report.counts.total} finding(s)\n`);
      for (const f of report.findings) {
        const tag = f.kind === 'stale-summary' ? 'STALE' : 'DRIFT';
        console.warn(`[${tag}] ${f.detail}`);
      }
    }
    if (symbolDrift && !report.symbolDriftChecked) {
      console.warn('\nNote: symbol-drift skipped — no code symbols indexed (only TS/JS symbols are extracted today). Run brain:index over code, or ignore for non-JS repos.');
    }
  }

  process.exit(strict && !report.ok ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[brain:verify] ${error.message || error}\n`);
    process.exit(1);
  });
}
