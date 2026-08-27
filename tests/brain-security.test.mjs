/**
 * brain-security tests (scripts/brain-security.mjs).
 *
 * The product claim under test is REACHABILITY: an advisory that nothing
 * imports is not the same problem as one imported by twelve files. So the bulk
 * of this file is pure classification over a hand-built graph + external list
 * (scoped packages, subpath specifiers, builtins, URL specifiers), with no npm,
 * no network and no gitleaks anywhere near it.
 *
 * The other half is the no-leak guarantee. A security report that prints the
 * secret it found is the bug it claims to prevent, so a synthetic gitleaks
 * report carrying a fake secret is fed through BOTH the pure normalizer and the
 * real spawn path (a fake `gitleaks` binary), and the fake secret string is
 * asserted to appear NOWHERE in the result — not in the findings, not in a
 * reason, not anywhere in JSON.stringify of the whole report.
 *
 * Everything else is degradation and determinism: absent tools must exit 0 with
 * a reason, and identical inputs must produce byte-identical JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const {
  packageOfSpecifier,
  parseAuditReport,
  packageImporters,
  classifyAdvisories,
  normalizeGitleaksFindings,
  buildReport,
  runNpmAudit,
  runGitleaks,
  hasBin,
  securityReport,
  nextAction,
  vulnerabilityStatement,
  secretsStatement,
  REACHABILITY_NOTE,
  SECRET_SAFETY_NOTE,
  MAX_IMPORTERS
} = await import('../scripts/brain-security.mjs');

const SCRIPT = fileURLToPath(new URL('../scripts/brain-security.mjs', import.meta.url));

/** The fake secret that must never survive a round-trip through this module. */
const FAKE_SECRET = 'AKIAIOSFODNN7EXAMPLE-tHiSiSaFaKeSeCrEtVaLuE-9f2b';

// ---------------------------------------------------------------------------
// specifier → package name (the bridge from the graph to advisory names)
// ---------------------------------------------------------------------------

test('packageOfSpecifier: bare, scoped, subpath and scoped-subpath specifiers', () => {
  assert.equal(packageOfSpecifier('lodash'), 'lodash');
  assert.equal(packageOfSpecifier('lodash/merge'), 'lodash');
  assert.equal(packageOfSpecifier('lodash/fp/curry'), 'lodash');
  assert.equal(packageOfSpecifier('@xenova/transformers'), '@xenova/transformers');
  assert.equal(packageOfSpecifier('@xenova/transformers/dist/x.js'), '@xenova/transformers');
  assert.equal(packageOfSpecifier('@babel/core'), '@babel/core');
});

test('packageOfSpecifier: non-packages are null, never a guessed name', () => {
  for (const spec of [
    './local', '../up/one', '/abs/path', '#internal-import',
    'node:fs', 'node:fs/promises', 'fs', 'path', 'crypto',
    'https://esm.sh/lodash', 'data:text/javascript,1', 'file:///x.js',
    '@scope', '', '   ', null, undefined
  ]) {
    assert.equal(packageOfSpecifier(spec), null, `expected null for ${JSON.stringify(spec)}`);
  }
});

// ---------------------------------------------------------------------------
// reachability classification — THE product claim
// ---------------------------------------------------------------------------

/** Hand-built graph fixture: 4 files, a mix of scoped/subpath/relative specs. */
const FIXTURE_SOURCES = {
  'src/app.mjs': [
    "import merge from 'lodash/merge';",
    "import { pipeline } from '@xenova/transformers';",
    "import helper from './helper.mjs';",
    "import fs from 'node:fs';"
  ].join('\n'),
  'src/helper.mjs': [
    "import merge from 'lodash';",
    "const x = require('@scope/tool/sub/deep');"
  ].join('\n'),
  'src/quiet.mjs': "import './helper.mjs';\n",
  'src/notes.py': "import lodash\n"          // wrong family: must be ignored
};

/** The `external` list buildImportGraph would emit for the fixture above. */
const FIXTURE_EXTERNAL = [
  { spec: 'lodash/merge', count: 1 },
  { spec: '@xenova/transformers', count: 1 },
  { spec: 'lodash', count: 1 },
  { spec: '@scope/tool/sub/deep', count: 1 }
];

function fixtureRead(file) {
  if (!(file in FIXTURE_SOURCES)) throw new Error(`no such fixture file: ${file}`);
  return FIXTURE_SOURCES[file];
}

test('packageImporters: subpath + scoped specifiers collapse onto the package name', () => {
  const index = packageImporters({
    files: Object.keys(FIXTURE_SOURCES),
    readFile: fixtureRead,
    external: FIXTURE_EXTERNAL
  });
  assert.deepEqual(index.packages, ['@scope/tool', '@xenova/transformers', 'lodash']);
  // `lodash/merge` in app.mjs and bare `lodash` in helper.mjs are ONE package.
  assert.deepEqual(index.byPackage.lodash.files, ['src/app.mjs', 'src/helper.mjs']);
  assert.deepEqual(index.byPackage.lodash.specs, ['lodash', 'lodash/merge']);
  assert.deepEqual(index.byPackage['@scope/tool'].files, ['src/helper.mjs']);
  assert.deepEqual(index.byPackage['@xenova/transformers'].files, ['src/app.mjs']);
  // node:fs is a builtin and ./helper.mjs resolved internally → neither is a package.
  assert.ok(!('fs' in index.byPackage));
  // Only JS-family files are scanned for npm imports.
  assert.equal(index.filesScanned, 3);
});

test('packageImporters: a specifier that resolved INSIDE the repo is never a package', () => {
  // './helper.mjs' is absent from `external` because the graph resolved it.
  const index = packageImporters({
    files: ['src/quiet.mjs'],
    readFile: fixtureRead,
    external: FIXTURE_EXTERNAL
  });
  assert.deepEqual(index.packages, []);
});

test('packageImporters: an unreadable/unparseable file is skipped, never thrown', () => {
  const index = packageImporters({
    files: ['src/app.mjs', 'src/missing.mjs'],
    readFile: fixtureRead,
    external: FIXTURE_EXTERNAL
  });
  assert.equal(index.skipped, 1);
  assert.deepEqual(index.byPackage.lodash.files, ['src/app.mjs']);
});

test('classifyAdvisories: reachable vs transitive-only, with importing files', () => {
  const { byPackage } = packageImporters({
    files: Object.keys(FIXTURE_SOURCES),
    readFile: fixtureRead,
    external: FIXTURE_EXTERNAL
  });
  const advisories = [
    { package: 'lodash', severity: 'high', direct: true },
    { package: '@xenova/transformers', severity: 'critical', direct: true },
    { package: 'protobufjs', severity: 'critical', direct: false },
    { package: 'form-data', severity: 'moderate', direct: true }
  ];
  const r = classifyAdvisories({ advisories, byPackage, graphAvailable: true });

  assert.deepEqual(r.reachable.map((a) => a.package), ['@xenova/transformers', 'lodash']);
  assert.deepEqual(r.transitiveOnly.map((a) => a.package), ['protobufjs', 'form-data']);
  assert.deepEqual(r.unknown, []);

  const lodash = r.reachable.find((a) => a.package === 'lodash');
  assert.equal(lodash.reachability, 'reachable');
  assert.equal(lodash.importerCount, 2);
  assert.deepEqual(lodash.importers, ['src/app.mjs', 'src/helper.mjs']);
  assert.match(lodash.why, /imported by 2 scanned file\(s\)/);

  // A direct dependency nothing imports says so in words — that distinction is
  // the difference between "upgrade now" and "schedule it".
  const formData = r.transitiveOnly.find((a) => a.package === 'form-data');
  assert.equal(formData.reachability, 'transitive-only');
  assert.equal(formData.importerCount, 0);
  assert.match(formData.why, /declared as a direct dependency, but no scanned source file imports it/);
  const proto = r.transitiveOnly.find((a) => a.package === 'protobufjs');
  assert.match(proto.why, /pulled in by another dependency/);

  assert.deepEqual(r.counts, { critical: 2, high: 1, moderate: 1, low: 0 });
  assert.equal(r.total, 4);
});

test('classifyAdvisories: no graph → everything is `unknown`, never "clean"', () => {
  const r = classifyAdvisories({
    advisories: [{ package: 'lodash', severity: 'high', direct: true }],
    byPackage: {},
    graphAvailable: false
  });
  assert.deepEqual(r.reachable, []);
  assert.deepEqual(r.transitiveOnly, []);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].reachability, 'unknown');
  assert.match(r.unknown[0].why, /reachability was not determined/);
});

test('classifyAdvisories: importer list is capped, the COUNT stays exact', () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, '0')}.mjs`);
  const r = classifyAdvisories({
    advisories: [{ package: 'lodash', severity: 'high', direct: true }],
    byPackage: { lodash: { files, specs: ['lodash'] } },
    graphAvailable: true
  });
  assert.equal(r.reachable[0].importers.length, MAX_IMPORTERS);
  assert.equal(r.reachable[0].importerCount, 12);
  assert.match(r.reachable[0].why, /imported by 12 scanned file\(s\)/);
});

test('classifyAdvisories: deterministic ordering (severity, then importers, then name)', () => {
  const advisories = [
    { package: 'zeta', severity: 'low', direct: false },
    { package: 'alpha', severity: 'critical', direct: false },
    { package: 'beta', severity: 'critical', direct: false }
  ];
  const byPackage = { alpha: { files: ['a.mjs'], specs: ['alpha'] }, beta: { files: ['a.mjs', 'b.mjs'], specs: ['beta'] } };
  const r1 = classifyAdvisories({ advisories, byPackage, graphAvailable: true });
  const r2 = classifyAdvisories({ advisories: [...advisories].reverse(), byPackage, graphAvailable: true });
  // beta has more importers at equal severity → it leads.
  assert.deepEqual(r1.reachable.map((a) => a.package), ['beta', 'alpha']);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

// ---------------------------------------------------------------------------
// npm audit report parsing
// ---------------------------------------------------------------------------

const AUDIT_FIXTURE = {
  auditReportVersion: 2,
  vulnerabilities: {
    axios: {
      name: 'axios',
      severity: 'high',
      isDirect: false,
      via: [
        { source: 2, name: 'axios', title: 'Second advisory', url: 'https://example.test/b', severity: 'moderate', range: '<1' },
        { source: 1, name: 'axios', title: 'First advisory', url: 'https://example.test/a', severity: 'high', range: '<1' }
      ],
      effects: [],
      range: '>=1.0.0 <1.18.0',
      nodes: ['node_modules/axios'],
      fixAvailable: { name: 'axios', version: '1.18.0', isSemVerMajor: false }
    },
    '@xenova/transformers': {
      name: '@xenova/transformers',
      severity: 'critical',
      isDirect: true,
      via: ['onnxruntime-web', 'sharp'],
      effects: [],
      range: '>=1.4.3',
      nodes: ['node_modules/@xenova/transformers'],
      fixAvailable: true
    }
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 2 } }
};

test('parseAuditReport: one entry per vulnerable package, deterministic and normalized', () => {
  const r = parseAuditReport(AUDIT_FIXTURE);
  assert.equal(r.ok, true);
  assert.equal(r.reportVersion, 2);
  assert.deepEqual(r.advisories.map((a) => a.package), ['@xenova/transformers', 'axios']);
  assert.deepEqual(r.counts, { critical: 1, high: 1, moderate: 0, low: 0 });

  const axios = r.advisories.find((a) => a.package === 'axios');
  assert.equal(axios.direct, false);
  assert.equal(axios.range, '>=1.0.0 <1.18.0');
  assert.deepEqual(axios.fix, { available: true, name: 'axios', version: '1.18.0', semverMajor: false });
  // Advisory titles are severity-ordered, not registry-ordered.
  assert.deepEqual(axios.advisories.map((t) => t.title), ['First advisory', 'Second advisory']);

  const xen = r.advisories.find((a) => a.package === '@xenova/transformers');
  assert.equal(xen.direct, true);
  assert.deepEqual(xen.vulnerableVia, ['onnxruntime-web', 'sharp']);
  assert.deepEqual(xen.fix, { available: true, name: null, version: null, semverMajor: false });
});

test('parseAuditReport: unusable reports degrade with a reason, never throw', () => {
  for (const [input, pattern] of [
    [null, /no parseable JSON/],
    ['not an object', /no parseable JSON/],
    [{ error: { code: 'ENOLOCK', summary: 'no lock file' } }, /ENOLOCK.*no lock file/],
    [{ auditReportVersion: 1, advisories: {} }, /no `vulnerabilities` map/]
  ]) {
    const r = parseAuditReport(input);
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
    assert.deepEqual(r.advisories, []);
  }
});

// ---------------------------------------------------------------------------
// THE no-secret-value guarantee
// ---------------------------------------------------------------------------

/** A realistic gitleaks finding — with the match in every field it uses. */
const GITLEAKS_RAW = [
  {
    Description: 'AWS Access Key',
    StartLine: 42,
    EndLine: 42,
    File: 'config/settings.js',
    Commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    Match: `const key = "${FAKE_SECRET}"`,
    Secret: FAKE_SECRET,
    RuleID: 'aws-access-token',
    Entropy: 4.3125,
    Author: 'Someone Real',
    Email: 'someone@example.test',
    Tags: ['key', 'AWS', 'severity:high'],
    Fingerprint: `deadbeef:config/settings.js:aws-access-token:42`
  },
  {
    StartLine: 7,
    File: 'scripts/deploy.sh',
    Secret: FAKE_SECRET,
    RuleID: 'generic-api-key',
    Entropy: 3.9,
    Tags: []
  }
];

test('secrets: normalizeGitleaksFindings emits LOCATION ONLY — the value appears nowhere', () => {
  const r = normalizeGitleaksFindings(GITLEAKS_RAW);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(FAKE_SECRET), 'the secret value leaked into the normalized findings');
  assert.ok(!serialized.includes('someone@example.test'), 'author email leaked into the findings');
  assert.ok(!serialized.includes('Someone Real'), 'author name leaked into the findings');

  assert.equal(r.total, 2);
  assert.deepEqual(r.findings, [
    { file: 'config/settings.js', line: 42, rule: 'aws-access-token', severity: 'high', entropyNote: 'shannon entropy 4.31' },
    { file: 'scripts/deploy.sh', line: 7, rule: 'generic-api-key', severity: 'unknown', entropyNote: 'shannon entropy 3.90' }
  ]);
  // gitleaks assigns no severity of its own — 'unknown' is honest, 'high' would
  // be invented.
  assert.equal(r.findings[1].severity, 'unknown');
  // The whitelist is total: no key beyond the five allowed ones survives.
  for (const f of r.findings) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ['entropyNote', 'file', 'line', 'rule', 'severity']
    );
  }
});

test('secrets: the full report never carries the value, even through the real spawn path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-security-gitleaks-'));
  // A fake `gitleaks` binary that behaves like the real one: exit 1 on
  // findings, JSON report on stdout (the fallback path we support).
  const fake = path.join(dir, 'fake-gitleaks.mjs');
  fs.writeFileSync(fake,
    '#!/usr/bin/env node\n' +
    `process.stdout.write(${JSON.stringify(JSON.stringify(GITLEAKS_RAW))});\n` +
    'process.exit(1);\n');
  fs.chmodSync(fake, 0o755);

  try {
    const r = runGitleaks({
      root: dir,
      env: { BRAIN_SECURITY_GITLEAKS_BIN: fake }
    });
    assert.equal(r.ran, true, `gitleaks path did not run: ${r.reason}`);
    assert.equal(r.findings.length, 2);

    const report = buildReport({
      audit: { ran: false, reason: 'no package-lock.json' },
      reachability: { available: false, reason: 'not scanned' },
      secrets: r,
      now: 0
    });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(FAKE_SECRET), 'the secret value leaked into the security report');
    assert.ok(!serialized.includes('someone@example.test'), 'author email leaked into the security report');
    assert.match(report.secrets.statement, /gitleaks found 2 secret finding\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets: an unparseable gitleaks report never echoes the report body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-security-garbage-'));
  const fake = path.join(dir, 'fake-gitleaks.mjs');
  // Garbage on stdout that CONTAINS the secret — the reason must stay generic.
  fs.writeFileSync(fake,
    '#!/usr/bin/env node\n' +
    `process.stdout.write('not json ' + ${JSON.stringify(FAKE_SECRET)});\n`);
  fs.chmodSync(fake, 0o755);
  try {
    const r = runGitleaks({ root: dir, env: { BRAIN_SECURITY_GITLEAKS_BIN: fake } });
    assert.equal(r.ran, false);
    assert.ok(!JSON.stringify(r).includes(FAKE_SECRET), 'the failure path echoed the report body');
    assert.match(r.reason, /gitleaks/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// degradation — an absent scanner is "not scanned", never "clean"
// ---------------------------------------------------------------------------

test('degradation: npm audit is skipped without a lockfile, with a reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-security-nolock-'));
  try {
    const bare = runNpmAudit({ root: dir, env: {} });
    assert.equal(bare.ran, false);
    assert.match(bare.reason, /no package\.json/);

    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    const noLock = runNpmAudit({ root: dir, env: {} });
    assert.equal(noLock.ran, false);
    assert.match(noLock.reason, /no package-lock\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('degradation: kill switches report themselves (and never spawn)', () => {
  let spawned = 0;
  const spawn = () => { spawned += 1; return { status: 0, stdout: '', stderr: '' }; };
  const audit = runNpmAudit({ root: process.cwd(), env: { BRAIN_SECURITY_NPM_AUDIT: '0' }, spawn });
  assert.equal(audit.ran, false);
  assert.match(audit.reason, /BRAIN_SECURITY_NPM_AUDIT=0/);
  const leaks = runGitleaks({ root: process.cwd(), env: { BRAIN_SECURITY_GITLEAKS: '0' }, spawn });
  assert.equal(leaks.ran, false);
  assert.match(leaks.reason, /BRAIN_SECURITY_GITLEAKS=0/);
  assert.equal(spawned, 0);
});

test('degradation: gitleaks absent from PATH → reason, not a throw', () => {
  let spawned = 0;
  const spawn = () => { spawned += 1; return { status: 0, stdout: '', stderr: '' }; };
  // An empty PATH is the "not installed" case; the binary is never invoked.
  const r = runGitleaks({ root: process.cwd(), env: { PATH: '' }, spawn });
  assert.equal(r.ran, false);
  assert.match(r.reason, /gitleaks not installed/);
  assert.equal(spawned, 0);
  assert.equal(hasBin('gitleaks', { env: { PATH: '' } }), false);
  // A path that really does hold an executable resolves — proven with node itself.
  assert.equal(hasBin(path.basename(process.execPath), { env: { PATH: path.dirname(process.execPath) } }), true);
});

test('honesty: a scanner that did not run can never produce a clean bill of health', () => {
  const report = buildReport({
    audit: { ran: false, reason: 'no package-lock.json — npm audit needs a lockfile' },
    reachability: { available: false, reason: 'no scannable source' },
    secrets: { ran: false, reason: 'gitleaks not installed (set BRAIN_SECURITY_GITLEAKS_BIN to override)' },
    now: 0
  });
  assert.equal(report.claims.cleanBillOfHealth, false);
  assert.equal(report.claims.dependenciesScanned, false);
  assert.equal(report.claims.secretsScanned, false);
  assert.equal(report.vulnerabilities.degraded, true);
  assert.equal(report.secrets.degraded, true);
  // The distinction lives in the OUTPUT, in words: "not scanned" ≠ "none found".
  assert.match(report.secrets.statement, /secrets NOT scanned/);
  assert.match(report.secrets.statement, /not a clean bill of health/);
  assert.ok(!/no secrets found/i.test(report.secrets.statement));
  assert.match(report.vulnerabilities.statement, /dependencies NOT scanned/);
  // …and every tool reports whether it ran, with the reason when it did not.
  const tools = Object.fromEntries(report.provenance.tools.map((t) => [t.name, t]));
  assert.equal(tools['npm audit'].ran, false);
  assert.match(tools['npm audit'].reason, /package-lock/);
  assert.equal(tools.gitleaks.ran, false);
  assert.match(tools.gitleaks.reason, /not installed/);
  assert.equal(tools['import-scan'].ran, false);
  assert.equal(report.provenance.notes.reachability, REACHABILITY_NOTE);
  assert.equal(report.secrets.note, SECRET_SAFETY_NOTE);
});

test('honesty: "no secrets found" is sayable ONLY when gitleaks ran', () => {
  assert.match(secretsStatement({ ran: true, count: 0 }), /scanned this repository and found no secrets/);
  const absent = secretsStatement({ ran: false, reason: 'gitleaks not installed' });
  assert.ok(!/found no secrets/.test(absent));
  assert.match(absent, /NOT scanned/);
  assert.match(vulnerabilityStatement({ ran: true, total: 0 }), /found no known advisories/);
  assert.match(
    vulnerabilityStatement({ ran: true, total: 3, reachable: 1, transitiveOnly: 2 }),
    /3 vulnerable package\(s\): 1 reachable .*, 2 not imported/
  );
  assert.match(
    vulnerabilityStatement({ ran: true, total: 3, unknown: 3 }),
    /reachability could not be determined/
  );
});

test('honesty: a clean bill of health needs BOTH scanners to have run and found nothing', () => {
  const report = buildReport({
    audit: { ran: true, advisories: [], counts: { critical: 0, high: 0, moderate: 0, low: 0 } },
    reachability: { available: true, byPackage: {}, filesScanned: 0, skipped: 'no advisories to place — the import scan was not run' },
    secrets: { ran: true, findings: [], total: 0 },
    now: 0
  });
  assert.equal(report.claims.cleanBillOfHealth, true);
  assert.match(report.secrets.statement, /found no secrets/);
  // An empty byPackage that was never computed says so, instead of reading as
  // "we looked and found no importers".
  assert.match(report.vulnerabilities.reachability.skipped, /import scan was not run/);
});

// ---------------------------------------------------------------------------
// determinism + the assembled shape
// ---------------------------------------------------------------------------

test('determinism: identical inputs produce byte-identical JSON', () => {
  const inputs = () => ({
    audit: parseAuditReport(AUDIT_FIXTURE).ok
      ? { ran: true, advisories: parseAuditReport(AUDIT_FIXTURE).advisories }
      : null,
    reachability: {
      available: true,
      byPackage: packageImporters({
        files: Object.keys(FIXTURE_SOURCES), readFile: fixtureRead, external: FIXTURE_EXTERNAL
      }).byPackage,
      filesScanned: 3
    },
    secrets: normalizeGitleaksFindings(GITLEAKS_RAW).findings.length
      ? { ran: true, ...normalizeGitleaksFindings(GITLEAKS_RAW) }
      : null,
    now: 1_700_000_000_000
  });
  const a = JSON.stringify(buildReport(inputs()), null, 2);
  const b = JSON.stringify(buildReport(inputs()), null, 2);
  assert.equal(a, b);
  assert.ok(!a.includes(FAKE_SECRET));
});

test('report shape: the contract brain-serve renders against', () => {
  const audit = parseAuditReport(AUDIT_FIXTURE);
  const report = buildReport({
    audit: { ran: true, advisories: audit.advisories },
    reachability: {
      available: true,
      byPackage: packageImporters({
        files: Object.keys(FIXTURE_SOURCES), readFile: fixtureRead, external: FIXTURE_EXTERNAL
      }).byPackage,
      filesScanned: 3
    },
    secrets: { ran: true, findings: [], total: 0 },
    now: 0
  });
  assert.deepEqual(Object.keys(report).sort(), ['claims', 'provenance', 'scannedAt', 'secrets', 'vulnerabilities']);
  assert.equal(report.scannedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(report.vulnerabilities.counts, { critical: 1, high: 1, moderate: 0, low: 0 });
  // @xenova/transformers is imported by src/app.mjs; axios is not imported anywhere.
  assert.deepEqual(report.vulnerabilities.reachable.map((a) => a.package), ['@xenova/transformers']);
  assert.deepEqual(report.vulnerabilities.transitiveOnly.map((a) => a.package), ['axios']);
  assert.equal(report.vulnerabilities.reachability.importedPackages, 3);
  assert.match(nextAction(report), /fix the reachable ones first — start with @xenova\/transformers/);
});

test('nextAction: never scrambles when nothing is reachable, and flags unscanned secrets', () => {
  const noReach = buildReport({
    audit: { ran: true, advisories: [{ package: 'axios', severity: 'high', direct: false }] },
    reachability: { available: true, byPackage: {}, filesScanned: 3 },
    secrets: { ran: true, findings: [], total: 0 },
    now: 0
  });
  assert.match(nextAction(noReach), /schedule, do not scramble/);

  const noGitleaks = buildReport({
    audit: { ran: true, advisories: [] },
    reachability: { available: true, byPackage: {}, filesScanned: 0 },
    secrets: { ran: false, reason: 'gitleaks not installed' },
    now: 0
  });
  assert.match(nextAction(noGitleaks), /install gitleaks/);
});

// ---------------------------------------------------------------------------
// end-to-end: the CLI on an empty repo degrades and still exits 0
// ---------------------------------------------------------------------------

test('CLI: no lockfile + no gitleaks → exit 0, degraded JSON with reasons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-security-cli-'));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BRAIN_ROOT: dir,
        // Force the absent-tool path regardless of what is installed on this
        // machine — the assertion is about the DEGRADED contract.
        BRAIN_SECURITY_GITLEAKS: '0'
      }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.vulnerabilities.degraded, true);
    assert.match(report.vulnerabilities.reason, /package/);
    assert.equal(report.secrets.degraded, true);
    assert.match(report.secrets.reason, /BRAIN_SECURITY_GITLEAKS=0/);
    assert.equal(report.claims.cleanBillOfHealth, false);
    assert.deepEqual(report.secrets.findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --help exits 0 and never runs a scanner', () => {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(stdout, /Usage: brain-security\.mjs/);
  assert.match(stdout, /never as "clean"/);
});

test('securityReport: total — every scanner disabled still yields the full shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-security-total-'));
  try {
    const report = await securityReport({
      root: dir,
      now: 0,
      env: { BRAIN_SECURITY_NPM_AUDIT: '0', BRAIN_SECURITY_GITLEAKS: '0' }
    });
    assert.equal(report.scannedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(report.vulnerabilities.total, 0);
    assert.equal(report.claims.cleanBillOfHealth, false);
    assert.match(report.vulnerabilities.reason, /BRAIN_SECURITY_NPM_AUDIT=0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
