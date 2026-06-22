import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { radarFor, radarScan, symbolsDefinedIn } from '../scripts/brain-radar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const RADAR_SCRIPT = path.join(scriptsDir, 'brain-radar.mjs');

// ---------------------------------------------------------------------------
// Fixture records (store.getAll() shape — only fields radarFor reads).
// ---------------------------------------------------------------------------

function codeRec(file, extra = {}) {
  return { type: 'code', file, module: '', project: '', symbols: [], exportedSymbols: [], isSummary: false, ...extra };
}
function decisionRec(file, module, heading = '') {
  return { type: 'decision', file, module, heading, decision: path.basename(file, '.md') };
}
function edgeRec(edgeFrom, edgeTo, edgeKind = 'http-client', edgeConfidence = 'high') {
  return { type: 'cross-project-edge', file: `.project-brain/fleet/edges/${edgeFrom}-${edgeTo}.md`, edgeFrom, edgeTo, edgeKind, edgeConfidence };
}

// ---------------------------------------------------------------------------
// radarFor — leases
// ---------------------------------------------------------------------------

test('radarFor: a lease held by someone else is a conflict', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    leases: [{ target: 'scripts/retrieval.mjs', lockedBy: 'codex-b', until: 'PR-7' }]
  });
  assert.equal(r.leases.length, 1);
  assert.equal(r.leases[0].severity, 'conflict');
  assert.equal(r.leases[0].lockedBy, 'codex-b');
  assert.equal(r.hasConflict, true);
});

test('radarFor: a lease I hold is a warning, not a conflict', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    leases: [{ target: 'scripts/retrieval.mjs', lockedBy: 'me' }],
    actor: 'me'
  });
  assert.equal(r.leases[0].severity, 'mine');
  assert.equal(r.leases[0].mine, true);
  assert.equal(r.hasConflict, false);
});

test('radarFor: a directory/glob lease matches a file inside it', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    leases: [{ target: 'scripts/*.mjs', lockedBy: 'codex-b' }]
  });
  assert.equal(r.leases.length, 1);
  assert.equal(r.hasConflict, true);
});

test('radarFor: an unrelated lease does not match', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    leases: [{ target: 'lib/auth.ts', lockedBy: 'codex-b' }]
  });
  assert.equal(r.leases.length, 0);
  assert.equal(r.hasConflict, false);
});

// ---------------------------------------------------------------------------
// radarFor — governing ADRs (decision records matching the file's module)
// ---------------------------------------------------------------------------

test('radarFor: a decision record whose module matches the file is surfaced', () => {
  const records = [
    codeRec('scripts/retrieval.mjs', { module: 'scripts/retrieval' }),
    decisionRec('.project-brain/decisions/0014-rerank.md', 'scripts/retrieval', 'Cross-encoder rerank')
  ];
  const r = radarFor('scripts/retrieval.mjs', records);
  assert.equal(r.module, 'scripts/retrieval');
  assert.equal(r.adrs.length, 1);
  assert.equal(r.adrs[0].decision, '0014-rerank');
  assert.match(r.adrs[0].title, /Cross-encoder rerank/);
});

test('radarFor: a curated short ADR module matches the file stem (alias match)', () => {
  // Real-world shape: ADRs use a short module like `retrieval`; the file infers
  // `scripts` (path heuristic). Alias match on the file stem bridges them.
  const records = [
    codeRec('scripts/retrieval.mjs'), // no module field → inferred "scripts"
    decisionRec('.project-brain/decisions/0014-rerank.md', 'retrieval', 'Rerank')
  ];
  const r = radarFor('scripts/retrieval.mjs', records);
  assert.equal(r.adrs.length, 1);
  assert.equal(r.adrs[0].decision, '0014-rerank');
});

test('radarFor: a decision for a different module is NOT surfaced', () => {
  const records = [
    codeRec('scripts/retrieval.mjs', { module: 'scripts/retrieval' }),
    decisionRec('.project-brain/decisions/0009-fleet.md', 'scripts/fleet')
  ];
  const r = radarFor('scripts/retrieval.mjs', records);
  assert.equal(r.adrs.length, 0);
});

test('radarFor: duplicate decision chunks for one ADR collapse to a single entry', () => {
  const records = [
    codeRec('scripts/retrieval.mjs', { module: 'scripts/retrieval' }),
    decisionRec('.project-brain/decisions/0014-rerank.md', 'scripts/retrieval', 'A'),
    decisionRec('.project-brain/decisions/0014-rerank.md', 'scripts/retrieval', 'B') // same decision id
  ];
  const r = radarFor('scripts/retrieval.mjs', records);
  assert.equal(r.adrs.length, 1);
});

// ---------------------------------------------------------------------------
// radarFor — downstream cross-project consumers (edgeTo owns the file's project)
// ---------------------------------------------------------------------------

test('radarFor: an edge whose edgeTo owns this file flags the consumer as downstream', () => {
  const records = [
    codeRec('backend/api/charge.ts', { project: 'backend', module: 'backend/api' }),
    edgeRec('frontend', 'backend', 'http-client', 'high') // frontend depends on backend
  ];
  const r = radarFor('backend/api/charge.ts', records);
  assert.equal(r.project, 'backend');
  assert.equal(r.downstream.length, 1);
  assert.equal(r.downstream[0].consumer, 'frontend');
  assert.equal(r.downstream[0].kind, 'http-client');
});

test('radarFor: an outbound edge (this file is the consumer) is NOT downstream', () => {
  const records = [
    codeRec('backend/api/charge.ts', { project: 'backend', module: 'backend/api' }),
    edgeRec('backend', 'workers', 'pubsub', 'high') // backend depends on workers
  ];
  const r = radarFor('backend/api/charge.ts', records);
  assert.equal(r.downstream.length, 0);
});

test('radarFor: no project (single-repo) → no downstream consumers', () => {
  const records = [
    codeRec('scripts/retrieval.mjs', { module: 'scripts/retrieval' }), // project ''
    edgeRec('frontend', 'backend')
  ];
  const r = radarFor('scripts/retrieval.mjs', records);
  assert.equal(r.project, '');
  assert.equal(r.downstream.length, 0);
});

test('radarFor: projectForFile override resolves the file project (fleet path)', () => {
  const records = [edgeRec('frontend', 'backend', 'grpc-client')];
  const r = radarFor('backend/api/charge.ts', records, {
    projectForFile: () => 'backend'
  });
  assert.equal(r.project, 'backend');
  assert.equal(r.downstream.length, 1);
  assert.equal(r.downstream[0].consumer, 'frontend');
});

// ---------------------------------------------------------------------------
// radarFor — open findings citing the file
// ---------------------------------------------------------------------------

test('radarFor: an open finding citing the file is surfaced', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    findings: [{
      slug: 'slow-rerank', title: 'Rerank is slow', status: 'open', category: 'performance', impact: 4,
      sources: [{ path: 'scripts/retrieval.mjs' }]
    }]
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].slug, 'slow-rerank');
  assert.equal(r.findings[0].impact, 4);
});

test('radarFor: a resolved/wontfix finding is ignored', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    findings: [
      { slug: 'done', status: 'resolved', sources: [{ path: 'scripts/retrieval.mjs' }] },
      { slug: 'nope', status: 'wontfix', sources: [{ path: 'scripts/retrieval.mjs' }] }
    ]
  });
  assert.equal(r.findings.length, 0);
});

test('radarFor: a planned finding still counts (open|planned)', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    findings: [{ slug: 'p', status: 'planned', sources: [{ path: 'scripts/retrieval.mjs' }] }]
  });
  assert.equal(r.findings.length, 1);
});

test('radarFor: a finding citing a different file is ignored', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    findings: [{ slug: 'x', status: 'open', sources: [{ path: 'scripts/other.mjs' }] }]
  });
  assert.equal(r.findings.length, 0);
});

test('radarFor: findings are sorted by impact descending', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    findings: [
      { slug: 'low', status: 'open', impact: 1, sources: [{ path: 'scripts/retrieval.mjs' }] },
      { slug: 'high', status: 'open', impact: 5, sources: [{ path: 'scripts/retrieval.mjs' }] }
    ]
  });
  assert.deepEqual(r.findings.map(f => f.slug), ['high', 'low']);
});

// ---------------------------------------------------------------------------
// radarFor — blast radius (precomputed by caller) + clean state
// ---------------------------------------------------------------------------

test('radarFor: blastFor is threaded through onto the report', () => {
  const r = radarFor('scripts/retrieval.mjs', [], {
    blastFor: () => ({ symbols: ['hybridScore'], callers: 3, tests: 2 })
  });
  assert.ok(r.blast);
  assert.equal(r.blast.callers, 3);
  assert.equal(r.blast.tests, 2);
});

test('radarFor: a file with nothing on radar reports empty counts and no conflict', () => {
  const r = radarFor('scripts/lonely.mjs', []);
  assert.equal(r.counts.leases, 0);
  assert.equal(r.counts.adrs, 0);
  assert.equal(r.counts.downstream, 0);
  assert.equal(r.counts.findings, 0);
  assert.equal(r.hasConflict, false);
  assert.equal(r.blast, null);
});

test('radarFor: path normalization (./ and backslashes) still matches a lease', () => {
  const r = radarFor('./scripts/retrieval.mjs', [], {
    leases: [{ target: 'scripts/retrieval.mjs', lockedBy: 'codex-b' }]
  });
  assert.equal(r.file, 'scripts/retrieval.mjs');
  assert.equal(r.leases.length, 1);
});

// ---------------------------------------------------------------------------
// symbolsDefinedIn + radarScan
// ---------------------------------------------------------------------------

test('symbolsDefinedIn: unions exported + local symbols for the exact file', () => {
  const records = [
    codeRec('scripts/retrieval.mjs', { symbols: ['tfidfScore'], exportedSymbols: ['hybridScore'] }),
    codeRec('scripts/other.mjs', { exportedSymbols: ['nope'] })
  ];
  const syms = symbolsDefinedIn('scripts/retrieval.mjs', records);
  assert.ok(syms.includes('hybridScore'));
  assert.ok(syms.includes('tfidfScore'));
  assert.ok(!syms.includes('nope'));
});

test('radarScan: maps multiple files and summarizes conflicts', () => {
  const records = [
    codeRec('scripts/retrieval.mjs', { module: 'scripts/retrieval' }),
    decisionRec('.project-brain/decisions/0001-a.md', 'scripts/retrieval')
  ];
  const scan = radarScan(['scripts/retrieval.mjs', 'lib/clean.ts', './scripts/retrieval.mjs'], records, {
    leases: [{ target: 'lib/clean.ts', lockedBy: 'codex-b' }]
  });
  assert.equal(scan.reports.length, 2); // dedup ./ duplicate
  assert.equal(scan.summary.files, 2);
  assert.equal(scan.summary.conflicts, 1);
  assert.equal(scan.summary.withAdvisories, 2); // retrieval has an ADR, clean has a lease
});

// ---------------------------------------------------------------------------
// Integration: real subprocess against a tmpdir repo (arg-handling / --json).
// JSON store, no embedder/model needed (no index → records empty, soft path).
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-radar-'));
  fs.mkdirSync(path.join(cwd, '.project-brain', 'findings'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });

  fs.writeFileSync(path.join(cwd, 'scripts', 'retrieval.mjs'), 'export const hybridScore = () => 1;\n');

  fs.writeFileSync(path.join(cwd, '.project-brain', 'active_state.md'), `# Active State

## Workstreams

| task_id | owner | tool | project | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- | --- |
| issue-9 | codex-other | codex | | feature/x | leases | active |

## File Leases

| path glob or file | project | locked_by | until | notes |
| --- | --- | --- | --- | --- |
| scripts/retrieval.mjs | | codex-other | PR-42 | task=issue-9 |

## Blockers

- None recorded

## Overlaps

- None recorded
`);

  // An open finding citing the file (round-trips through findings.mjs loader).
  fs.writeFileSync(path.join(cwd, '.project-brain', 'findings', 'slow-rerank.md'), `---
type: finding
title: Rerank is slow
category: performance
status: open
impact: 4
created: 2026-06-22T00:00:00.000Z
updated: 2026-06-22T00:00:00.000Z
actor: tester
module: scripts/retrieval
symbols: hybridScore
sources:
  - path: "scripts/retrieval.mjs"
    sha256: "deadbeef"
---
Evidence and fix notes.
`);
  return cwd;
}

function runRadar(cwd, args) {
  return spawnSync(process.execPath, [RADAR_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_QUIET: '1', BRAIN_STORE: 'json' }
  });
}

test('brain:radar --help prints usage and exits 0', () => {
  const cwd = makeRepo();
  const r = runRadar(cwd, ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: npm run brain:radar/);
});

test('brain:radar --for surfaces a lease and an open finding for the file', () => {
  const cwd = makeRepo();
  const r = runRadar(cwd, ['--for', 'scripts/retrieval.mjs', '--no-impact']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scripts\/retrieval\.mjs/);
  assert.match(r.stdout, /lease held by codex-other/);
  assert.match(r.stdout, /open finding slow-rerank/);
});

test('brain:radar --json emits a parseable scan with the per-file report', () => {
  const cwd = makeRepo();
  const r = runRadar(cwd, ['--for', 'scripts/retrieval.mjs', '--no-impact', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const scan = JSON.parse(r.stdout);
  assert.equal(scan.reports.length, 1);
  const report = scan.reports[0];
  assert.equal(report.file, 'scripts/retrieval.mjs');
  assert.equal(report.leases.length, 1);
  assert.equal(report.leases[0].lockedBy, 'codex-other');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].slug, 'slow-rerank');
  assert.equal(scan.summary.conflicts, 1);
});

test('brain:radar positional file argument works like --for', () => {
  const cwd = makeRepo();
  const r = runRadar(cwd, ['scripts/retrieval.mjs', '--no-impact', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const scan = JSON.parse(r.stdout);
  assert.equal(scan.reports[0].file, 'scripts/retrieval.mjs');
});

test('brain:radar with no target and clean tree reports no files (exit 0)', () => {
  const cwd = makeRepo();
  // commit so the working tree is clean → no changed files, no positional/--for
  execSync('git add -A', { cwd });
  execSync('git commit -q -m init', { cwd });
  const r = runRadar(cwd, ['--no-impact']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No target files/);
});

test('brain:radar --staged targets git-staged files', () => {
  const cwd = makeRepo();
  execSync('git add -A', { cwd });
  execSync('git commit -q -m init', { cwd });
  fs.writeFileSync(path.join(cwd, 'scripts', 'retrieval.mjs'), 'export const hybridScore = () => 2;\n');
  execSync('git add scripts/retrieval.mjs', { cwd });
  const r = runRadar(cwd, ['--staged', '--no-impact', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const scan = JSON.parse(r.stdout);
  assert.equal(scan.reports[0].file, 'scripts/retrieval.mjs');
  assert.equal(scan.reports[0].leases.length, 1);
});
