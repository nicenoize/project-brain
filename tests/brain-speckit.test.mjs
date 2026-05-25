import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'scripts', 'brain-speckit.mjs');

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-speckit-test-'));
}

function write(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

function runSpeckit(cwd, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
}

const SPEC_FIXTURE = `# Feature Specification: User auth

**Feature Branch**: \`001-user-auth\`
**Created**: 2026-05-25
**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign up flow (Priority: P1)

Users can create accounts.

### User Story 2 - Sign in (Priority: P2)

Users can log in with their credentials.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow users to create accounts via email/password
- **FR-002**: System MUST validate email format
- **FR-003**: Users MUST be able to reset their password via [NEEDS CLARIFICATION: reset method not specified]

## Success Criteria

### Measurable Outcomes

- **SC-001**: Account creation completes in under 2 minutes
- **SC-002**: 99.9% sign-in success rate
`;

const TASKS_FIXTURE = `# Tasks: User auth

## Phase 1: Setup

- [ ] T001 [P] [US1] Create User model in src/models/user.ts
- [ ] T002 [P] [US1] Create signup form component in app/signup/page.tsx
- [ ] T003 [US1] Wire signup API route in app/api/signup/route.ts

## Phase 2: Sign in

- [ ] T004 [P] [US2] Create signin form component in app/signin/page.tsx
- [ ] T005 [US2] Wire signin API route in app/api/signin/route.ts
`;

// ---------- import ----------

test('brain:speckit import: writes .project-brain/features/<id>.md with cross-links + frontmatter', () => {
  const cwd = tmpCwd();
  write(path.join(cwd, 'specs', 'auth', 'spec.md'), SPEC_FIXTURE);
  write(path.join(cwd, 'specs', 'auth', 'plan.md'), '# Plan stub');
  write(path.join(cwd, 'specs', 'auth', 'tasks.md'), TASKS_FIXTURE);

  const r = runSpeckit(cwd, ['import', 'auth']);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const out = path.join(cwd, '.project-brain', 'features', 'auth.md');
  assert.ok(fs.existsSync(out));
  const body = fs.readFileSync(out, 'utf8');
  assert.ok(body.includes('feature: auth'));
  assert.ok(body.includes('spec_source: specs/auth/spec.md'));
  assert.ok(body.includes('# User auth'));
  assert.ok(body.includes('Source:'));
  assert.ok(body.includes('Technical plan:'));
  assert.ok(body.includes('Tasks:'));
  // FR-NNN + SC-NNN extracted under Acceptance summary.
  assert.ok(body.includes('allow users to create accounts via email/password'));
  assert.ok(body.includes('Account creation completes in under 2 minutes'));
  // NEEDS CLARIFICATION pulled into open questions.
  assert.ok(body.includes('reset method not specified'));
  // User stories rendered with priorities.
  assert.ok(body.includes('Sign up flow') && body.includes('P1'));
});

test('brain:speckit import: is idempotent (rerun = same content)', () => {
  const cwd = tmpCwd();
  write(path.join(cwd, 'specs', 'auth', 'spec.md'), SPEC_FIXTURE);

  runSpeckit(cwd, ['import', 'auth']);
  const first = fs.readFileSync(path.join(cwd, '.project-brain', 'features', 'auth.md'), 'utf8');
  runSpeckit(cwd, ['import', 'auth']);
  const second = fs.readFileSync(path.join(cwd, '.project-brain', 'features', 'auth.md'), 'utf8');
  // Both runs produce identical body (timestamp is date-only; same date → byte-identical).
  assert.equal(first.replace(/last_updated: \d{4}-\d{2}-\d{2}/g, 'last_updated: DATE'),
               second.replace(/last_updated: \d{4}-\d{2}-\d{2}/g, 'last_updated: DATE'));
});

// ---------- tasks ----------

test('brain:speckit tasks --write: emits one work-package per user-story group', () => {
  const cwd = tmpCwd();
  write(path.join(cwd, 'specs', 'auth', 'tasks.md'), TASKS_FIXTURE);

  const r = runSpeckit(cwd, ['tasks', 'auth', '--write']);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const wpDir = path.join(cwd, '.project-brain', 'work-packages');
  const files = fs.readdirSync(wpDir).filter(f => f.startsWith('spec-auth-wp')).sort();
  assert.equal(files.length, 2, `expected 2 work-packages for US1+US2, got ${files.join(', ')}`);

  const wp1 = fs.readFileSync(path.join(wpDir, files[0]), 'utf8');
  assert.ok(wp1.includes('US1'));
  assert.ok(wp1.includes('T001'));
  assert.ok(wp1.includes('T002'));
  assert.ok(wp1.includes('T003'));
  // [P] markers preserved.
  assert.ok(wp1.includes('[P] **T001**') || wp1.includes('[P] **T002**'));

  const wp2 = fs.readFileSync(path.join(wpDir, files[1]), 'utf8');
  assert.ok(wp2.includes('US2'));
  assert.ok(wp2.includes('T004'));
});

test('brain:speckit tasks: errors cleanly when tasks.md has no parseable tasks', () => {
  const cwd = tmpCwd();
  write(path.join(cwd, 'specs', 'auth', 'tasks.md'), '# tasks but no checkbox lines\n');
  const r = runSpeckit(cwd, ['tasks', 'auth', '--write']);
  assert.notEqual(r.status, 0);
  assert.ok((r.stderr || r.stdout).includes('No parseable tasks'));
});

test('brain:speckit: missing specs/<id>/ exits with helpful message', () => {
  const cwd = tmpCwd();
  const r = runSpeckit(cwd, ['import', 'missing-feature']);
  assert.notEqual(r.status, 0);
  assert.ok((r.stderr || r.stdout).includes('Spec-kit feature directory not found'));
});
