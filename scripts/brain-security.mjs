/**
 * brain-security — dependency advisories WITH reachability, plus secret
 * locations. Invoked as `project-brain x security [--json]`.
 *
 * WHY THIS EXISTS. Every competitor ships CVE scanning and secret detection;
 * the thing they all sell hardest is *reachability* — "is this vulnerable
 * package actually reachable from your code?". We already own a multi-language
 * import graph (import-graph.mjs), so reachability is the one part of this
 * space we can answer honestly and for free: an advisory that nothing imports
 * is simply not the same problem as one imported by twelve files, and saying
 * so IS the product.
 *
 * >>> WHAT "REACHABLE" MEANS HERE — read this before quoting a number. <<<
 * Reachability is PACKAGE-level, not function-level. `reachable` means some
 * scanned source file statically imports the vulnerable package. It does NOT
 * mean the vulnerable code path executes, and `transitive-only` does NOT mean
 * safe: the scanner behind it is a regex/line scanner (see import-graph.mjs's
 * SCAN_NOTE), so dynamic `require(base + name)`, bundler aliases, package.json
 * script usage and config-file usage are all invisible. Both labels are
 * evidence for triage ORDER, never a verdict.
 *
 * HONESTY RULES (product rules, not nice-to-haves — they live in the OUTPUT,
 * not just in this comment):
 *   1. The report always states which tools actually ran and which were absent
 *      (`provenance.tools`, and a per-section `statement`).
 *   2. "No secrets found" is sayable ONLY when gitleaks ran. Otherwise the
 *      report says "gitleaks not installed — secrets NOT scanned", and
 *      `claims.cleanBillOfHealth` stays false.
 *   3. The report NEVER contains a secret value. Only {file, line, rule,
 *      severity, entropyNote} survive normalization — the gitleaks fields that
 *      carry the match (`Secret`, `Match`, `Author`, `Email`) are dropped by a
 *      whitelist, not by a blacklist. A security report that leaks the secret
 *      into a log or a browser is the bug it claims to prevent. Even the
 *      failure paths obey this: an unparseable gitleaks report yields a generic
 *      reason string, never an excerpt of the report.
 *
 * NO NEW DEPENDENCIES, every external tool OPTIONAL and degrading cleanly:
 * `npm audit` runs only when a package-lock.json exists; `gitleaks` runs only
 * when the binary is on PATH. Absence is a degraded result with a `reason` —
 * never a throw, never a non-zero exit.
 *
 * Kill switches / overrides (env):
 *   BRAIN_SECURITY_NPM_AUDIT=0        skip npm audit entirely
 *   BRAIN_SECURITY_GITLEAKS=0         skip gitleaks entirely
 *   BRAIN_SECURITY_NPM_BIN=<path>     npm binary override
 *   BRAIN_SECURITY_GITLEAKS_BIN=<p>   gitleaks binary override
 *   BRAIN_SECURITY_TIMEOUT_MS=<n>     per-tool timeout (default 180000)
 *
 * The pure core (packageOfSpecifier / parseAuditReport / packageImporters /
 * classifyAdvisories / normalizeGitleaksFindings / buildReport) has no clocks,
 * no fs and no child processes, so the same inputs always produce byte-
 * identical output. `securityReport()` is the thin I/O wrapper; brain-serve.mjs
 * imports it for GET /api/security. The isMain guard keeps importing this
 * module side-effect-free.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { ROOT, takeFlag } from './common.mjs';
import { buildImportGraph, parseImports, langOf, familyOf, SCAN_NOTE } from './import-graph.mjs';

/** The caveat that must travel with every reachability verdict. */
export const REACHABILITY_NOTE =
  'Reachability is PACKAGE-level, not function-level: `reachable` means some scanned source file ' +
  'statically imports the vulnerable package — NOT that the vulnerable code path executes. ' +
  '`transitive-only` means no scanned file imports it; it does NOT mean safe. The import scan is a ' +
  'regex/line scanner, so dynamic requires, bundler aliases, package.json script usage and ' +
  'config-file usage are invisible. Use these labels to order triage, never as a verdict.';

/** The rule that governs what a secret finding may contain. */
export const SECRET_SAFETY_NOTE =
  'Secret findings carry LOCATION ONLY (file, line, rule). The matched value is never read into ' +
  'this report, never logged and never returned by the API — a security report that leaks the ' +
  'secret is the bug it claims to prevent.';

/** Max importing files listed per reachable advisory (the count is always exact). */
export const MAX_IMPORTERS = 5;
const MAX_SECRET_FINDINGS = 500;
const MAX_ADVISORY_TITLES = 5;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Severity order for deterministic ranking (unknown sorts last). */
const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 });

/** Source extensions whose imports can name an npm package. */
const JS_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;
const JS_SOURCE_GLOB = '**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}';

/** Directories never scanned (mirrors brain-graph-scan / brain-serve). */
const IGNORE_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.gocache|__pycache__|\.venv|\.tox|target|\.worktrees)(\/|$)/;
const IGNORE_GLOBS = [
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.gocache', '__pycache__', '.venv', '.tox', 'target', '.worktrees'
].flatMap((d) => [`**/${d}`, `**/${d}/**`]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Node builtins reachable without the `node:` prefix — never npm packages. */
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

/** Deterministic byte-order compare (NEVER localeCompare — locale-dependent). */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function severityOf(value) {
  const s = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, s) ? s : 'unknown';
}

function emptyCounts() {
  return { critical: 0, high: 0, moderate: 0, low: 0 };
}

// ---------------------------------------------------------------------------
// pure: specifier → npm package name
// ---------------------------------------------------------------------------

/**
 * PURE. The npm package an import specifier names, or null when the specifier
 * is not an npm package at all.
 *
 *   'lodash'              → 'lodash'
 *   'lodash/merge'        → 'lodash'          (subpath import)
 *   '@scope/pkg'          → '@scope/pkg'      (scoped)
 *   '@scope/pkg/dist/x'   → '@scope/pkg'      (scoped subpath)
 *   './local' '../x' '/a' → null              (relative/absolute)
 *   'node:fs' 'fs'        → null              (builtin, with or without prefix)
 *   '#internal'           → null              (package imports map)
 *   'https://…' 'data:…'  → null              (URL specifier)
 *   '@scope'              → null              (a scope alone is not a package)
 */
export function packageOfSpecifier(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (s.startsWith('.') || s.startsWith('/') || s.startsWith('\\')) return null;
  if (s.startsWith('#')) return null;
  // Any scheme (node:, bun:, http:, data:, file:) — checked before splitting so
  // 'node:fs/promises' cannot survive as the package 'node:fs'.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return null;
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return null;
  let name;
  if (parts[0].startsWith('@')) {
    if (parts.length < 2) return null;
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = parts[0];
  }
  if (BUILTINS.has(name)) return null;
  // npm's own name grammar, loosened only for the legacy uppercase packages.
  if (!/^(?:@[A-Za-z0-9\-._~]+\/)?[A-Za-z0-9\-._~]+$/.test(name)) return null;
  return name;
}

// ---------------------------------------------------------------------------
// pure: npm audit JSON → advisories
// ---------------------------------------------------------------------------

/**
 * PURE. Normalize an `npm audit --json` report (auditReportVersion 2) into a
 * deterministic advisory list — one entry per vulnerable PACKAGE, which is how
 * npm itself reports and how `metadata.vulnerabilities` counts.
 *
 * Never throws: an unusable report becomes {ok:false, reason} so the caller can
 * degrade with an explanation instead of pretending the tree is clean.
 *
 * @param {object} raw parsed JSON (NOT a string)
 * @returns {{ok, advisories, counts, reportVersion, reason}}
 */
export function parseAuditReport(raw) {
  const fail = (reason) => ({ ok: false, advisories: [], counts: emptyCounts(), reportVersion: null, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('npm audit produced no parseable JSON report');
  }
  if (raw.error) {
    const code = String(raw.error.code || '').trim();
    const summary = String(raw.error.summary || '').trim();
    return fail(`npm audit reported an error${code ? ` (${code})` : ''}${summary ? `: ${summary}` : ''}`);
  }
  const vulns = raw.vulnerabilities;
  if (!vulns || typeof vulns !== 'object' || Array.isArray(vulns)) {
    return fail('npm audit JSON has no `vulnerabilities` map (unsupported audit report version)');
  }
  const advisories = [];
  for (const key of Object.keys(vulns).sort(byString)) {
    const entry = vulns[key];
    if (!entry || typeof entry !== 'object') continue;
    const pkg = String(entry.name || key);
    const titles = [];
    const viaPackages = new Set();
    for (const via of Array.isArray(entry.via) ? entry.via : []) {
      if (typeof via === 'string') {
        if (via.trim()) viaPackages.add(via.trim());
        continue;
      }
      if (!via || typeof via !== 'object') continue;
      titles.push({
        title: String(via.title || '').trim(),
        url: String(via.url || '').trim(),
        severity: severityOf(via.severity),
        range: String(via.range || '').trim()
      });
    }
    titles.sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byString(a.url, b.url) || byString(a.title, b.title));
    advisories.push({
      package: pkg,
      severity: severityOf(entry.severity),
      direct: entry.isDirect === true,
      range: String(entry.range || '').trim(),
      fix: normalizeFix(entry.fixAvailable),
      advisories: dedupeTitles(titles).slice(0, MAX_ADVISORY_TITLES),
      advisoryCount: dedupeTitles(titles).length,
      // Vulnerable dependencies this package pulls in — npm's string `via`
      // entries. Kept because they explain WHY a package with no advisory of
      // its own is listed at all.
      vulnerableVia: [...viaPackages].sort(byString)
    });
  }
  advisories.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || byString(a.package, b.package));
  const counts = emptyCounts();
  for (const a of advisories) {
    if (Object.prototype.hasOwnProperty.call(counts, a.severity)) counts[a.severity] += 1;
  }
  return {
    ok: true,
    advisories,
    counts,
    reportVersion: Number.isFinite(raw.auditReportVersion) ? raw.auditReportVersion : null,
    reason: null
  };
}

function dedupeTitles(titles) {
  const seen = new Set();
  const out = [];
  for (const t of titles) {
    const key = `${t.url}\0${t.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function normalizeFix(fixAvailable) {
  if (fixAvailable === true) return { available: true, name: null, version: null, semverMajor: false };
  if (!fixAvailable || typeof fixAvailable !== 'object') return { available: false, name: null, version: null, semverMajor: false };
  return {
    available: true,
    name: String(fixAvailable.name || '') || null,
    version: String(fixAvailable.version || '') || null,
    semverMajor: fixAvailable.isSemVerMajor === true
  };
}

// ---------------------------------------------------------------------------
// pure: import graph → which npm packages the repo actually imports
// ---------------------------------------------------------------------------

/**
 * PURE (given an injected `readFile`). Attribute every UNRESOLVED import
 * specifier to an npm package and to the files that import it.
 *
 * The bridge from graph to package names is the graph's own `external` list:
 * a specifier lands there precisely because it did not resolve to a file
 * inside the repo, which is the honest definition of "this names a package".
 * Relative imports, tsconfig aliases and Go/Python/Ruby locals therefore can
 * never be mistaken for npm packages, because they never appear in `external`.
 *
 * TOTAL: a file that fails to read or parse is skipped, never thrown.
 *
 * @param {{files: string[], readFile: (f: string) => string,
 *          external: Array<{spec: string}>|Set<string>}} input
 * @returns {{byPackage: object, packages: string[], filesScanned: number, skipped: number}}
 */
export function packageImporters(input = {}) {
  const readFile = typeof input.readFile === 'function' ? input.readFile : () => { throw new Error('no readFile'); };
  const externalSet = input.external instanceof Set
    ? input.external
    : new Set((input.external || []).map((e) => (typeof e === 'string' ? e : String(e && e.spec || ''))).filter(Boolean));
  const files = [...new Set((input.files || []).map((f) => normPath(f)))]
    .filter((f) => JS_EXT_RE.test(f))
    .sort(byString);

  const acc = new Map(); // pkg → {files:Set, specs:Set}
  let filesScanned = 0;
  let skipped = 0;
  for (const file of files) {
    const family = familyOf(langOf(file));
    if (family !== 'js') continue;
    let source;
    try {
      source = readFile(file);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof source !== 'string') { skipped += 1; continue; }
    filesScanned += 1;
    let imports;
    try {
      imports = parseImports(source, { file });
    } catch {
      skipped += 1;
      continue;
    }
    for (const imp of imports) {
      if (!externalSet.has(imp.spec)) continue; // resolved inside the repo → not a package
      const pkg = packageOfSpecifier(imp.spec);
      if (!pkg) continue;
      if (!acc.has(pkg)) acc.set(pkg, { files: new Set(), specs: new Set() });
      acc.get(pkg).files.add(file);
      acc.get(pkg).specs.add(imp.spec);
    }
  }

  const byPackage = {};
  for (const pkg of [...acc.keys()].sort(byString)) {
    const entry = acc.get(pkg);
    byPackage[pkg] = {
      files: [...entry.files].sort(byString),
      specs: [...entry.specs].sort(byString)
    };
  }
  return { byPackage, packages: Object.keys(byPackage), filesScanned, skipped };
}

// ---------------------------------------------------------------------------
// pure: advisory × import graph → reachability
// ---------------------------------------------------------------------------

/**
 * PURE. Split advisories into `reachable` (some scanned file imports the
 * package), `transitiveOnly` (no scanned file imports it) and `unknown` (there
 * was no graph to ask — no lockfile, no scannable source, scan disabled).
 *
 * THIS IS THE PRODUCT. An advisory nothing imports is not the same problem as
 * one imported by twelve files, and the `why` string on every finding says
 * which of those it is, in words, with the number in it.
 *
 * @param {{advisories: object[], byPackage: object, graphAvailable: boolean,
 *          maxImporters?: number}} input
 * @returns {{reachable, transitiveOnly, unknown, counts, total}}
 */
export function classifyAdvisories(input = {}) {
  const advisories = Array.isArray(input.advisories) ? input.advisories : [];
  const byPackage = input.byPackage && typeof input.byPackage === 'object' ? input.byPackage : {};
  const graphAvailable = input.graphAvailable !== false;
  const cap = Number.isFinite(input.maxImporters) && input.maxImporters > 0
    ? Math.floor(input.maxImporters)
    : MAX_IMPORTERS;

  const reachable = [];
  const transitiveOnly = [];
  const unknown = [];

  for (const adv of advisories) {
    if (!adv || typeof adv !== 'object') continue;
    const base = { ...adv, severity: severityOf(adv.severity) };
    if (!graphAvailable) {
      unknown.push({
        ...base,
        reachability: 'unknown',
        importers: [],
        importerCount: 0,
        specifiers: [],
        why: 'no import graph available — reachability was not determined'
      });
      continue;
    }
    const entry = byPackage[base.package];
    const importers = entry && Array.isArray(entry.files) ? entry.files : [];
    if (importers.length) {
      reachable.push({
        ...base,
        reachability: 'reachable',
        importers: importers.slice(0, cap),
        importerCount: importers.length,
        specifiers: (entry.specs || []).slice(0, cap),
        why: `imported by ${importers.length} scanned file(s)`
      });
    } else {
      transitiveOnly.push({
        ...base,
        reachability: 'transitive-only',
        importers: [],
        importerCount: 0,
        specifiers: [],
        why: base.direct
          ? 'declared as a direct dependency, but no scanned source file imports it'
          : 'no scanned source file imports it — pulled in by another dependency'
      });
    }
  }

  const rank = (a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (b.importerCount || 0) - (a.importerCount || 0) ||
    byString(a.package, b.package);
  reachable.sort(rank);
  transitiveOnly.sort(rank);
  unknown.sort(rank);

  const counts = emptyCounts();
  for (const a of [...reachable, ...transitiveOnly, ...unknown]) {
    if (Object.prototype.hasOwnProperty.call(counts, a.severity)) counts[a.severity] += 1;
  }
  return {
    reachable,
    transitiveOnly,
    unknown,
    counts,
    total: reachable.length + transitiveOnly.length + unknown.length
  };
}

// ---------------------------------------------------------------------------
// pure: gitleaks report → LOCATION-ONLY findings
// ---------------------------------------------------------------------------

/**
 * PURE. Normalize a gitleaks JSON report to {file, line, rule, severity,
 * entropyNote?} — a WHITELIST, deliberately not a blacklist.
 *
 * gitleaks findings carry `Secret`, `Match`, `Author` and `Email`; none of them
 * may ever leave this function. Because the output object is CONSTRUCTED from
 * named fields rather than filtered from the input, a future gitleaks field
 * cannot leak by default — the failure mode of a blacklist.
 *
 * gitleaks does not assign a severity, so `severity` is read from a
 * `severity:<level>` tag when the ruleset provides one and is otherwise the
 * honest 'unknown' — never an invented 'high'.
 */
export function normalizeGitleaksFindings(raw, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : MAX_SECRET_FINDINGS;
  const list = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.findings) ? raw.findings : []);
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const file = normPath(f.File ?? f.file ?? '');
    const lineRaw = Number(f.StartLine ?? f.startLine ?? f.line ?? 0);
    const line = Number.isFinite(lineRaw) && lineRaw > 0 ? Math.floor(lineRaw) : null;
    const rule = String(f.RuleID ?? f.ruleID ?? f.rule_id ?? f.rule ?? '').trim() || 'unknown-rule';
    const finding = { file, line, rule, severity: severityFromTags(f.Tags ?? f.tags) };
    const entropy = Number(f.Entropy ?? f.entropy);
    if (Number.isFinite(entropy) && entropy > 0) finding.entropyNote = `shannon entropy ${entropy.toFixed(2)}`;
    out.push(finding);
  }
  out.sort((a, b) =>
    byString(a.file, b.file) || (a.line || 0) - (b.line || 0) || byString(a.rule, b.rule));
  const seen = new Set();
  const deduped = out.filter((f) => {
    const key = `${f.file}\0${f.line}\0${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { findings: deduped.slice(0, limit), total: deduped.length, truncated: deduped.length > limit };
}

function severityFromTags(tags) {
  for (const tag of Array.isArray(tags) ? tags : []) {
    const m = /^severity:\s*(\w+)$/i.exec(String(tag || '').trim());
    if (m) return severityOf(m[1]);
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// pure: assemble the report (the honesty lives here)
// ---------------------------------------------------------------------------

/**
 * PURE. Assemble the final report shape from already-collected raw inputs.
 * Deterministic given `now` — no clocks, no fs, no processes.
 *
 * @param {{audit: {ran, reason, advisories, counts},
 *          reachability: {available, reason, byPackage, filesScanned, note?},
 *          secrets: {ran, reason, findings, total?, truncated?},
 *          now?: number, maxImporters?: number}} input
 */
export function buildReport(input = {}) {
  const audit = input.audit || {};
  const reach = input.reachability || {};
  const secretsIn = input.secrets || {};
  const now = Number.isFinite(input.now) ? input.now : 0;

  const auditRan = audit.ran === true;
  const graphAvailable = auditRan && reach.available === true;
  const classified = classifyAdvisories({
    advisories: auditRan ? (audit.advisories || []) : [],
    byPackage: reach.byPackage || {},
    graphAvailable,
    maxImporters: input.maxImporters
  });

  const secretsRan = secretsIn.ran === true;
  const secretFindings = secretsRan ? (secretsIn.findings || []) : [];

  const vulnerabilities = {
    reachable: classified.reachable,
    transitiveOnly: classified.transitiveOnly,
    unknown: classified.unknown,
    counts: classified.counts,
    total: classified.total,
    degraded: !auditRan,
    reason: auditRan ? null : (audit.reason || 'npm audit did not run'),
    scanned: auditRan,
    statement: vulnerabilityStatement({
      ran: auditRan,
      reason: audit.reason,
      total: classified.total,
      reachable: classified.reachable.length,
      transitiveOnly: classified.transitiveOnly.length,
      unknown: classified.unknown.length
    }),
    reachability: {
      available: graphAvailable,
      degraded: !graphAvailable,
      reason: graphAvailable ? null : (reach.reason || 'import graph unavailable — reachability not determined'),
      filesScanned: Number.isFinite(reach.filesScanned) ? reach.filesScanned : 0,
      importedPackages: Object.keys(reach.byPackage || {}).length,
      maxImportersListed: Number.isFinite(input.maxImporters) && input.maxImporters > 0
        ? Math.floor(input.maxImporters)
        : MAX_IMPORTERS,
      // Set when the import scan was deliberately not run because there was
      // nothing to place — an empty `byPackage` must never read as "we looked
      // and found no importers".
      skipped: reach.skipped ? String(reach.skipped) : null,
      note: REACHABILITY_NOTE
    }
  };

  const secrets = {
    findings: secretFindings,
    total: secretsRan ? (Number.isFinite(secretsIn.total) ? secretsIn.total : secretFindings.length) : 0,
    truncated: secretsRan ? secretsIn.truncated === true : false,
    degraded: !secretsRan,
    reason: secretsRan ? null : (secretsIn.reason || 'gitleaks did not run'),
    scanned: secretsRan,
    statement: secretsStatement({ ran: secretsRan, reason: secretsIn.reason, count: secretFindings.length }),
    note: SECRET_SAFETY_NOTE
  };

  return {
    vulnerabilities,
    secrets,
    // The distinction lives in the DATA, not only in the docs: a scanner that
    // did not run can never produce a clean bill of health.
    claims: {
      dependenciesScanned: auditRan,
      reachabilityDetermined: graphAvailable,
      secretsScanned: secretsRan,
      cleanBillOfHealth: auditRan && secretsRan && classified.total === 0 && secretFindings.length === 0,
      caveat: 'cleanBillOfHealth is true only when EVERY scanner ran and found nothing. ' +
        'A false value with degraded sections means "not scanned", which is not the same as "clean".'
    },
    provenance: {
      basis: 'measured',
      source: 'npm-audit advisories ⊕ import-scan reachability ⊕ gitleaks secrets',
      tools: [
        { name: 'npm audit', purpose: 'dependency advisories', ran: auditRan, reason: auditRan ? null : (audit.reason || null) },
        { name: 'import-scan', purpose: 'reachability', ran: graphAvailable, reason: graphAvailable ? null : (reach.reason || null) },
        { name: 'gitleaks', purpose: 'secret detection', ran: secretsRan, reason: secretsRan ? null : (secretsIn.reason || null) }
      ],
      notes: { reachability: REACHABILITY_NOTE, secrets: SECRET_SAFETY_NOTE, scanner: SCAN_NOTE }
    },
    scannedAt: new Date(now).toISOString()
  };
}

/** PURE. The one sentence about dependencies that is safe to quote. */
export function vulnerabilityStatement({ ran, reason, total = 0, reachable = 0, transitiveOnly = 0, unknown = 0 }) {
  if (!ran) {
    return `npm audit did not run (${reason || 'unavailable'}) — dependencies NOT scanned. ` +
      'This is not a clean bill of health.';
  }
  if (!total) return 'npm audit ran and found no known advisories in the dependency tree.';
  if (unknown) {
    return `npm audit found ${total} vulnerable package(s); reachability could not be determined ` +
      '(no import graph), so none of them is known to be imported or unimported.';
  }
  return `npm audit found ${total} vulnerable package(s): ${reachable} reachable ` +
    `(imported by scanned source), ${transitiveOnly} not imported by any scanned file.`;
}

/** PURE. "No secrets found" is sayable ONLY when gitleaks actually ran. */
export function secretsStatement({ ran, reason, count = 0 }) {
  if (!ran) {
    return `${reason || 'gitleaks did not run'} — secrets NOT scanned. This is not a clean bill of health; ` +
      'no claim is made about whether this repository contains secrets.';
  }
  if (!count) return 'gitleaks scanned this repository and found no secrets.';
  return `gitleaks found ${count} secret finding(s). Locations only — the matched values are never ` +
    'included in this report.';
}

// ---------------------------------------------------------------------------
// I/O: external tools (every one optional, every absence a reason)
// ---------------------------------------------------------------------------

function envBin(env, name, fallback) {
  const v = env[`BRAIN_SECURITY_${name}_BIN`];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

/**
 * True when `name` resolves to an executable on PATH (or an explicit *_BIN
 * override exists). A direct PATH walk rather than `command -v` through a
 * shell: no child process, no shell quoting, and nothing for a hostile PATH
 * entry to interpret — a probe inside a security tool must not itself be an
 * execution surface.
 */
export function hasBin(name, { env = process.env } = {}) {
  const override = env[`BRAIN_SECURITY_${String(name).toUpperCase()}_BIN`];
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
  const n = Number(env.BRAIN_SECURITY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

/**
 * Run `npm audit --json`. Only when a package-lock.json exists — without a
 * lockfile npm audit either errors or silently audits nothing, and a silent
 * nothing is exactly the false all-clear this module exists to prevent.
 *
 * Never throws → {ran:false, reason} on every failure path.
 */
export function runNpmAudit({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  if (env.BRAIN_SECURITY_NPM_AUDIT === '0') {
    return { ran: false, reason: 'npm audit disabled via BRAIN_SECURITY_NPM_AUDIT=0' };
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    return { ran: false, reason: 'no package.json in this repo — no npm dependency tree to audit' };
  }
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
    return {
      ran: false,
      reason: 'no package-lock.json — npm audit needs a lockfile to resolve the dependency tree ' +
        '(run `npm install` to create one)'
    };
  }
  const bin = envBin(env, 'NPM', 'npm');
  let r;
  try {
    r = spawn(bin, ['audit', '--json'], {
      cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env)
    });
  } catch (error) {
    return { ran: false, reason: `npm audit could not be started: ${error.code || error.message || error}` };
  }
  if (!r || r.error) {
    const code = r && r.error ? (r.error.code || r.error.message) : 'unknown error';
    return { ran: false, reason: `npm audit could not be started: ${code}` };
  }
  // npm audit exits non-zero WHEN IT FINDS VULNERABILITIES — a non-zero status
  // with parseable JSON is a successful run, not a failure.
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout || '');
  } catch {
    return {
      ran: false,
      reason: `npm audit produced no parseable JSON (exit ${r.status ?? 'null'})` +
        (r.signal ? ` after signal ${r.signal}` : '')
    };
  }
  const normalized = parseAuditReport(parsed);
  if (!normalized.ok) return { ran: false, reason: normalized.reason };
  return { ran: true, reason: null, advisories: normalized.advisories, counts: normalized.counts, reportVersion: normalized.reportVersion };
}

/**
 * Run `gitleaks detect` when the binary exists. We never bundle or install it.
 *
 * `--redact` is passed so gitleaks itself never writes the matched value into
 * its report — defense in depth behind normalizeGitleaksFindings's whitelist.
 * The report is written to a temp file (`--report-path`) and parsed from there,
 * with stdout as a fallback for gitleaks builds that stream the report instead.
 *
 * SAFETY: no failure path may echo the report body. A report that fails to
 * parse could contain unredacted secrets, so the reason is generic by design.
 */
export function runGitleaks({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  if (env.BRAIN_SECURITY_GITLEAKS === '0') {
    return { ran: false, reason: 'gitleaks disabled via BRAIN_SECURITY_GITLEAKS=0' };
  }
  if (!hasBin('gitleaks', { env })) {
    return {
      ran: false,
      reason: 'gitleaks not installed (set BRAIN_SECURITY_GITLEAKS_BIN to override)'
    };
  }
  const bin = envBin(env, 'GITLEAKS', 'gitleaks');
  const reportPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'brain-security-')),
    'gitleaks-report.json'
  );
  let r;
  try {
    r = spawn(bin, [
      'detect', '--no-banner', '--redact',
      '--report-format', 'json', '--report-path', reportPath
    ], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs(env) });
  } catch (error) {
    cleanupReport(reportPath);
    return { ran: false, reason: `gitleaks could not be started: ${error.code || error.message || error}` };
  }
  if (!r || r.error) {
    cleanupReport(reportPath);
    const code = r && r.error ? (r.error.code || r.error.message) : 'unknown error';
    return { ran: false, reason: `gitleaks could not be started: ${code}` };
  }
  let raw = null;
  let sawReport = false;
  try {
    if (fs.existsSync(reportPath)) {
      sawReport = true;
      const text = fs.readFileSync(reportPath, 'utf8').trim();
      raw = text ? JSON.parse(text) : [];
    }
  } catch {
    raw = null; // NEVER include the body in a reason — it may be unredacted.
  }
  if (raw === null && r.stdout && r.stdout.trim()) {
    try { raw = JSON.parse(r.stdout); sawReport = true; } catch { raw = null; }
  }
  cleanupReport(reportPath);
  if (raw === null) {
    return {
      ran: false,
      reason: sawReport
        ? 'gitleaks report was not parseable JSON (report withheld — it may contain unredacted values)'
        : `gitleaks wrote no report (exit ${r.status ?? 'null'})`
    };
  }
  const normalized = normalizeGitleaksFindings(raw);
  return { ran: true, reason: null, ...normalized };
}

function cleanupReport(reportPath) {
  try { fs.rmSync(path.dirname(reportPath), { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// I/O: source discovery + reachability
// ---------------------------------------------------------------------------

/**
 * Tracked + untracked-but-not-ignored JS/TS files, straight from git — the same
 * discovery brain-graph-scan and brain-serve use, and for the same reason:
 * `git ls-files` is instant and honours .gitignore, so node_modules is never
 * walked. Returns null when `root` is not itself a git work tree.
 */
function gitSourceFiles(root, spawn = spawnSync) {
  const top = spawn('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.error || top.status !== 0) return null;
  if (path.resolve(String(top.stdout || '').trim()) !== path.resolve(root)) return null;
  const r = spawn('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter((f) => f && JS_EXT_RE.test(f));
}

async function globSourceFiles(root) {
  try {
    const { default: fg } = await import('fast-glob');
    return await fg([JS_SOURCE_GLOB], {
      cwd: root, dot: false, onlyFiles: true, followSymbolicLinks: false, ignore: IGNORE_GLOBS
    });
  } catch {
    return [];
  }
}

async function discoverSourceFiles(root, spawn = spawnSync) {
  const listed = gitSourceFiles(root, spawn) ?? (await globSourceFiles(root));
  return [...new Set(listed.map((f) => normPath(f)))]
    .filter((f) => !IGNORE_DIR_RE.test(f))
    .sort(byString);
}

/**
 * Build the package→importers index for `root`. Never throws:
 * {available:false, reason} is the honest degradation, and the caller then
 * classifies every advisory as `unknown` rather than guessing.
 */
export async function reachabilityFor({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  if (env.BRAIN_IMPORT_GRAPH === '0') {
    return { available: false, reason: 'import graph disabled via BRAIN_IMPORT_GRAPH=0', byPackage: {}, filesScanned: 0 };
  }
  try {
    const files = await discoverSourceFiles(root, spawn);
    if (!files.length) {
      return {
        available: false,
        reason: 'no scannable JavaScript/TypeScript source files found — reachability not determined',
        byPackage: {},
        filesScanned: 0
      };
    }
    const cache = new Map();
    const readFile = (rel) => {
      if (cache.has(rel)) return cache.get(rel);
      const abs = path.join(root, rel);
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`too large (${stat.size} bytes)`);
      const text = fs.readFileSync(abs, 'utf8');
      cache.set(rel, text);
      return text;
    };
    // The graph's `external` list is the bridge: a specifier lands there
    // precisely because it did NOT resolve inside the repo.
    const graph = buildImportGraph({ files, readFile });
    const index = packageImporters({ files, readFile, external: graph.external });
    return {
      available: true,
      reason: null,
      byPackage: index.byPackage,
      filesScanned: index.filesScanned,
      externalSpecifiers: graph.external.length
    };
  } catch (error) {
    return {
      available: false,
      reason: `import scan failed: ${error.message || error}`,
      byPackage: {},
      filesScanned: 0
    };
  }
}

// ---------------------------------------------------------------------------
// the whole report (thin I/O wrapper over the pure core)
// ---------------------------------------------------------------------------

/**
 * Dependency advisories with reachability + secret locations for `root`.
 * TOTAL: no path throws; every absent tool becomes a degraded section with a
 * reason. `now` is injectable so callers (and tests) control the timestamp.
 */
export async function securityReport({ root = ROOT, now = Date.now(), env = process.env, spawn = spawnSync, maxImporters = MAX_IMPORTERS } = {}) {
  const audit = runNpmAudit({ root, env, spawn });
  // Reachability is only meaningful when there are advisories to place. The
  // scan is skipped (and honestly labelled) when the audit produced nothing.
  const reachability = audit.ran && (audit.advisories || []).length
    ? await reachabilityFor({ root, env, spawn })
    : {
      available: audit.ran,
      reason: audit.ran ? null : audit.reason,
      byPackage: {},
      filesScanned: 0,
      skipped: audit.ran ? 'no advisories to place — the import scan was not run' : null
    };
  const secrets = runGitleaks({ root, env, spawn });
  return buildReport({ audit, reachability, secrets, now, maxImporters });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Usage: brain-security.mjs [--json]',
    '',
    'Dependency advisories WITH reachability (is the vulnerable package actually',
    'imported by your code?) plus secret LOCATIONS. Every external tool is optional:',
    'npm audit runs only with a package-lock.json, gitleaks only when installed —',
    'an absent scanner is reported as "not scanned", never as "clean".',
    '',
    'Flags:',
    '  --json   Parseable JSON on stdout, nothing else.',
    '',
    'Env:',
    '  BRAIN_SECURITY_NPM_AUDIT=0      skip npm audit',
    '  BRAIN_SECURITY_GITLEAKS=0       skip gitleaks',
    '  BRAIN_SECURITY_GITLEAKS_BIN=…   gitleaks binary override',
    '  BRAIN_SECURITY_TIMEOUT_MS=…     per-tool timeout (default 180000)',
    '',
    'Exit code is always 0: this is a report, not a gate. The blocking gate is',
    '`brain:guard` with BRAIN_GUARD_SECURITY=1.'
  ].join('\n');
}

function out(text) { process.stdout.write(text + '\n'); }

function severityTag(sev) {
  return String(sev || 'unknown').toUpperCase().padEnd(8);
}

function printHuman(report) {
  out('Security report');
  out('');
  out('Tools:');
  for (const t of report.provenance.tools) {
    out(`  ${t.ran ? 'ran    ' : 'ABSENT '} ${t.name} (${t.purpose})${t.ran ? '' : ` — ${t.reason}`}`);
  }
  out('');

  const v = report.vulnerabilities;
  out('Dependencies');
  out(`  ${v.statement}`);
  if (v.reachable.length) {
    out('');
    out('  REACHABLE — some file in this repo imports the vulnerable package:');
    for (const a of v.reachable) {
      out(`    ${severityTag(a.severity)} ${a.package}${a.range ? ` (${a.range})` : ''} — ${a.why}`);
      for (const f of a.importers) out(`             ${f}`);
      if (a.importerCount > a.importers.length) {
        out(`             …and ${a.importerCount - a.importers.length} more`);
      }
      if (a.fix && a.fix.available) {
        out(`             fix: ${a.fix.name || a.package}@${a.fix.version || 'latest'}${a.fix.semverMajor ? ' (semver-major)' : ''}`);
      }
    }
  }
  if (v.transitiveOnly.length) {
    out('');
    out('  NOT IMPORTED — no scanned file imports these (triage after the reachable ones):');
    for (const a of v.transitiveOnly) {
      out(`    ${severityTag(a.severity)} ${a.package}${a.range ? ` (${a.range})` : ''} — ${a.why}`);
    }
  }
  if (v.unknown.length) {
    out('');
    out(`  UNKNOWN reachability (${v.reachability.reason}):`);
    for (const a of v.unknown) out(`    ${severityTag(a.severity)} ${a.package}`);
  }
  if (v.scanned) {
    out('');
    out(`  counts: critical ${v.counts.critical} · high ${v.counts.high} · moderate ${v.counts.moderate} · low ${v.counts.low}`);
    if (v.reachability.available) {
      out(`  reachability from ${v.reachability.filesScanned} scanned file(s), ${v.reachability.importedPackages} imported package(s)`);
    }
  }

  out('');
  out('Secrets');
  out(`  ${report.secrets.statement}`);
  for (const f of report.secrets.findings) {
    out(`    ${severityTag(f.severity)} ${f.file}:${f.line ?? '?'} — ${f.rule}${f.entropyNote ? ` (${f.entropyNote})` : ''}`);
  }
  if (report.secrets.truncated) out(`    …${report.secrets.total - report.secrets.findings.length} more not shown`);

  out('');
  out(`Reachability caveat: ${REACHABILITY_NOTE}`);
  out('');
  out(`Next: ${nextAction(report)}`);
}

/** PURE. One concrete next action — "kein Score ohne Aktion". */
export function nextAction(report) {
  const v = report.vulnerabilities;
  if (v.reachable.length) {
    const top = v.reachable[0];
    return `fix the reachable ones first — start with ${top.package} (${top.severity}, ${top.why})` +
      (top.fix && top.fix.available ? `; \`npm audit fix\` offers ${top.fix.name || top.package}@${top.fix.version}` : '');
  }
  if (!report.secrets.scanned) {
    return 'install gitleaks (`brew install gitleaks`) — secrets were NOT scanned, so this report says nothing about them';
  }
  if (!v.scanned) return `dependencies were NOT scanned (${v.reason}) — resolve that before trusting this report`;
  if (v.transitiveOnly.length) {
    return `no reachable advisory; ${v.transitiveOnly.length} package(s) are only pulled in transitively — schedule, do not scramble`;
  }
  if (report.secrets.findings.length) return `rotate the ${report.secrets.findings.length} secret(s) listed above, then purge them from history`;
  return 'nothing actionable found by the scanners that ran — re-run after the next dependency bump';
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    out(usage());
    process.exit(0);
  }
  const json = takeFlag(args, '--json');
  const report = await securityReport({ root: ROOT });
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);
  // Always 0: a report that exits non-zero when a scanner is missing teaches
  // people to disable it. The blocking gate is brain:guard.
  process.exit(0);
}

// Only run the CLI when invoked directly; importing for unit tests (and for
// brain-serve's /api/security) must not parse argv or spawn anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[brain:security] ${error.message || error}\n`);
    process.exit(1);
  });
}
