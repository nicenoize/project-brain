import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferType, inferFeature, inferModule, inferDecision, inferSourceKind } from '../scripts/infer.mjs';

// ---------- inferType (spec-kit) ----------

test('inferType: .specify/memory/constitution.md → constitution', () => {
  assert.equal(inferType('.specify/memory/constitution.md'), 'constitution');
});

test('inferType: specs/<id>/spec.md → spec', () => {
  assert.equal(inferType('specs/auth/spec.md'), 'spec');
  assert.equal(inferType('specs/001-billing/spec.md'), 'spec');
});

test('inferType: specs/<id>/plan.md → plan', () => {
  assert.equal(inferType('specs/auth/plan.md'), 'plan');
});

test('inferType: specs/<id>/tasks.md → tasks-list', () => {
  assert.equal(inferType('specs/auth/tasks.md'), 'tasks-list');
});

test('inferType: specs/<id>/research.md (and other support docs) → spec-support', () => {
  assert.equal(inferType('specs/auth/research.md'), 'spec-support');
  assert.equal(inferType('specs/auth/data-model.md'), 'spec-support');
  assert.equal(inferType('specs/auth/quickstart.md'), 'spec-support');
  assert.equal(inferType('specs/auth/contracts/users.yaml'), 'spec-support');
});

test('inferType: app-owned specs/ (non-spec-kit shape) does NOT collide', () => {
  // An app keeping a `specs/` test dir with arbitrary .md files at top
  // level (no spec.md/plan.md/tasks.md basenames) should NOT be flagged
  // as spec-kit. But anything under specs/<id>/ does fall into spec-support.
  // Confirm only the strict shapes are special-cased.
  assert.equal(inferType('specs/something-else.md'), 'doc');
});

test('inferType: existing taxonomy unchanged for non-speckit paths', () => {
  assert.equal(inferType('.project-brain/features/auth.md'), 'feature');
  assert.equal(inferType('.project-brain/modules/retrieval.md'), 'module');
  assert.equal(inferType('.project-brain/decisions/0001-x.md'), 'decision');
  assert.equal(inferType('.project-brain/sessions/foo.md'), 'session');
  assert.equal(inferType('scripts/retrieval.mjs'), 'code');
  assert.equal(inferType('README.md'), 'doc');
});

// ---------- inferFeature (spec-kit) ----------

test('inferFeature: extracts <id> from specs/<id>/spec.md and siblings', () => {
  assert.equal(inferFeature('specs/auth/spec.md'), 'auth');
  assert.equal(inferFeature('specs/auth/plan.md'), 'auth');
  assert.equal(inferFeature('specs/auth/tasks.md'), 'auth');
  assert.equal(inferFeature('specs/auth/contracts/users.yaml'), 'auth');
  assert.equal(inferFeature('specs/001-billing/research.md'), '001-billing');
});

test('inferFeature: frontmatter wins over path', () => {
  assert.equal(inferFeature('specs/auth/spec.md', { feature: 'override' }), 'override');
});

test('inferFeature: legacy .project-brain/features/ still works', () => {
  assert.equal(inferFeature('.project-brain/features/billing.md'), 'billing');
  assert.equal(inferFeature('scripts/foo.mjs'), '');
});

// ---------- inferSourceKind (spec-kit) ----------

test('inferSourceKind: .specify/ and specs/ → brain (canonical content)', () => {
  assert.equal(inferSourceKind('.specify/memory/constitution.md'), 'brain');
  assert.equal(inferSourceKind('specs/auth/spec.md'), 'brain');
});
