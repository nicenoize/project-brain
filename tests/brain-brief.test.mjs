import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildBrief } from '../scripts/brain-brief.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const BRIEF_SCRIPT = path.join(scriptsDir, 'brain-brief.mjs');

// ---------------------------------------------------------------------------
// Unit tests for the pure core.
// ---------------------------------------------------------------------------

test('buildBrief: a leased file produces a hard-conflict lease advisory', () => {
  const brief = buildBrief({
    files: ['scripts/auth.mjs'],
    leases: [{ target: 'scripts/auth.mjs', lockedBy: 'codex-b', until: 'PR-42', notes: 'task=issue-9' }],
    workstreams: [{ taskId: 'issue-9', owner: 'codex-b' }]
  });
  const lease = brief.advisories.find(a => a.kind === 'lease');
  assert.ok(lease, 'expected a lease advisory');
  assert.equal(lease.severity, 'conflict');
  assert.match(lease.message, /leased by codex-b/);
  assert.match(lease.message, /workstream issue-9/);
  assert.equal(brief.conflicts.length, 1);
});

test('buildBrief: self-held lease is a warning, not a conflict', () => {
  const brief = buildBrief({
    files: ['scripts/auth.mjs'],
    leases: [{ target: 'scripts/auth.mjs', lockedBy: 'me' }],
    actor: 'me'
  });
  const lease = brief.advisories.find(a => a.kind === 'lease');
  assert.ok(lease);
  assert.equal(lease.severity, 'warn');
  assert.equal(brief.conflicts.length, 0);
});

test('buildBrief: a governing ADR for the module produces an ADR advisory', () => {
  const brief = buildBrief({
    files: ['scripts/active-state.mjs'],
    decisions: [{
      id: '0005-active-state-exclusive-lock',
      module: 'scripts',
      title: 'active_state exclusive lock',
      body: 'scripts/active-state.mjs originally implemented every mutation...',
      file: '.project-brain/decisions/0005-active-state-exclusive-lock.md'
    }]
  });
  const adr = brief.advisories.find(a => a.kind === 'adr');
  assert.ok(adr, 'expected an ADR advisory');
  assert.match(adr.message, /0005-active-state-exclusive-lock/);
});

test('buildBrief: a specific (path-like) module matches an ADR by body mention', () => {
  const brief = buildBrief({
    files: ['lib/db/events.ts'], // inferModule => "lib/db"
    decisions: [{
      id: '0099-events',
      module: 'other',
      title: 'Event bus',
      body: 'The lib/db layer publishes events.',
      file: '.project-brain/decisions/0099-events.md'
    }]
  });
  assert.ok(brief.advisories.find(a => a.kind === 'adr'), 'expected ADR via specific module body match');
});

test('buildBrief: a bare top-level module does NOT match ADRs by body (noise suppression)', () => {
  const brief = buildBrief({
    files: ['toplevel-file.mjs'], // inferModule => "" (dirname '.'), so no module noise
    decisions: [{
      id: '0098-x', module: 'something-else', title: 'X',
      body: 'mentions scripts and lib and many dirs',
      file: '.project-brain/decisions/0098-x.md'
    }]
  });
  assert.equal(brief.advisories.filter(a => a.kind === 'adr').length, 0);
});

test('buildBrief: a cross-project edge from this project flags a downstream consumer', () => {
  const brief = buildBrief({
    files: ['scripts/events.mjs'],
    project: 'backend',
    edges: [{ from: 'backend', to: 'workers', kind: 'pubsub', confidence: 'high' }]
  });
  const edge = brief.advisories.find(a => a.kind === 'edge');
  assert.ok(edge, 'expected an edge advisory');
  assert.match(edge.message, /affect workers via pubsub/);
});

test('buildBrief: an inbound edge (this project is downstream) is NOT flagged', () => {
  const brief = buildBrief({
    files: ['scripts/events.mjs'],
    project: 'backend',
    edges: [{ from: 'frontend', to: 'backend', kind: 'http-call', confidence: 'medium' }]
  });
  assert.equal(brief.advisories.filter(a => a.kind === 'edge').length, 0);
});

test('buildBrief: no inputs → clean, nothing to flag', () => {
  const brief = buildBrief({ files: ['scripts/auth.mjs'] });
  assert.equal(brief.advisories.length, 0);
  assert.equal(brief.conflicts.length, 0);
  assert.equal(brief.summary.total, 0);
});

test('buildBrief: empty file set yields an empty, clean brief', () => {
  const brief = buildBrief({ files: [] });
  assert.equal(brief.files.length, 0);
  assert.equal(brief.advisories.length, 0);
});

// ---------------------------------------------------------------------------
// Integration test: real subprocess against a tmpdir repo.
// ---------------------------------------------------------------------------

/** Minimal brain repo with an active_state.md holding one file lease. */
function makeRepo(leaseTarget, lockedBy = 'codex-other') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-brief-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });
  execSync('git checkout -q -b feature/test', { cwd });

  const activeState = `# Active State

## Workstreams

| task_id | owner | tool | project | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- | --- |
| issue-9 | ${lockedBy} | codex | | feature/x | leases | active |

## File Leases

| path glob or file | project | locked_by | until | notes |
| --- | --- | --- | --- | --- |
| ${leaseTarget} | | ${lockedBy} | PR-42 | task=issue-9 |

## Blockers

- None recorded

## Overlaps

- None recorded
`;
  fs.writeFileSync(path.join(cwd, '.project-brain', 'active_state.md'), activeState);
  return cwd;
}

function runBrief(cwd, args) {
  return spawnSync(process.execPath, [BRIEF_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_QUIET: '1', BRAIN_STORE: 'json' }
  });
}

test('brain:brief --files surfaces an active file lease from active_state.md', () => {
  const cwd = makeRepo('scripts/auth.mjs');
  const r = runBrief(cwd, ['--files', 'scripts/auth.mjs']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /leased by codex-other/);
  assert.match(r.stdout, /workstream issue-9/);
});

test('brain:brief --json emits a parseable brief with the conflict', () => {
  const cwd = makeRepo('scripts/auth.mjs');
  const r = runBrief(cwd, ['--files', 'scripts/auth.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.conflicts.length, 1);
  assert.equal(parsed.conflicts[0].lockedBy, 'codex-other');
});

test('brain:brief --strict exits non-zero on a conflicting lease', () => {
  const cwd = makeRepo('scripts/auth.mjs');
  const r = runBrief(cwd, ['--files', 'scripts/auth.mjs', '--strict']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /hard lease conflict/);
});

test('brain:brief is clean (exit 0) for a file with no advisories', () => {
  const cwd = makeRepo('scripts/auth.mjs');
  const r = runBrief(cwd, ['--files', 'lib/unrelated.ts', '--strict']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing to flag/);
});
