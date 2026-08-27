/**
 * brain:orchestrate — work-package SCOPE and the file leases built from it.
 *
 * WHY THIS FILE EXISTS AT ALL. The orchestrator had no tests, because importing
 * it ran a real orchestration: there was no isMain guard, so `import { … } from
 * './brain-orchestrate.mjs'` planned and printed a plan as a side effect. The
 * guard came first; these are the tests it made possible.
 *
 * What they pin down is the product's headline claim. Planning three real work
 * packages against this repo showed two of them resolving to `Needs discovery`
 * and the plan carrying `leases: []` — the only lease this orchestrator ever
 * took was `orchestration-slot/<n>`, a lock on its own spawner slot, released
 * again the moment the worktree existed. N agents were launched coordinated by
 * branch alone, which is what git already does for humans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractScopes, scopeToLeaseTargets, splitScope, leaseConflicts,
  leaseUntil, ORCHESTRATION_LEASE_HOURS
} from '../scripts/brain-orchestrate.mjs';

test('extractScopes: a package described by AREA has a scope', () => {
  // Both of these came back empty in the field. Describing a package by
  // directory is the normal case, not the exception.
  assert.deepEqual(
    extractScopes('Touches .project-brain/decisions/ and docs/.'),
    { files: [], dirs: ['.project-brain/decisions/', 'docs/'] }
  );
  assert.deepEqual(
    extractScopes('Touches scripts/serve/ and ui/src/components/.'),
    { files: [], dirs: ['scripts/serve/', 'ui/src/components/'] }
  );
  // The old extractor whitelisted top-level names (app|src|lib|…|e2e), so
  // `ui/` and `.project-brain/` could never match however they were written.
  assert.deepEqual(extractScopes('see `ui/src/app.css`').files, ['ui/src/app.css']);
  assert.deepEqual(extractScopes('see `bin/cli.mjs`').files, ['bin/cli.mjs']);
});

test('extractScopes: a trailing sentence period does not eat the extension', () => {
  // `foo.test.mjs.` matches no extension and used to vanish without a word.
  const r = extractScopes('Touches scripts/brain-grill.mjs and tests/brain-grill.test.mjs.');
  assert.deepEqual(r.files, ['scripts/brain-grill.mjs', 'tests/brain-grill.test.mjs']);
  assert.deepEqual(extractScopes('Edit lib/a.mjs, then lib/b.mjs; done.').files, ['lib/a.mjs', 'lib/b.mjs']);
});

test('extractScopes: prose, dates and URLs are not paths', () => {
  // A bare directory must end in `/` — a deliberate author signal that keeps
  // "and/or" and "2026/08" out without needing a whitelist.
  const r = extractScopes('See https://github.com/a/b.md — and/or he/she, on 2026/08.');
  assert.deepEqual(r, { files: [], dirs: [] });
  assert.deepEqual(extractScopes('nothing here at all'), { files: [], dirs: [] });
  assert.deepEqual(extractScopes(''), { files: [], dirs: [] });
  assert.deepEqual(extractScopes(null), { files: [], dirs: [] });
});

test('extractScopes: a directory already named by a file adds nothing', () => {
  const r = extractScopes('Touches scripts/a.mjs and scripts/.');
  assert.deepEqual(r.files, ['scripts/a.mjs']);
  assert.deepEqual(r.dirs, [], 'the parent of a named file is redundant scope');
});

test('scopeToLeaseTargets: directories widen to a ** glob, files stay exact', () => {
  assert.deepEqual(
    scopeToLeaseTargets({ files: ['bin/cli.mjs'], dirs: ['scripts/serve/'] }),
    ['bin/cli.mjs', 'scripts/serve/**']
  );
  // Widening matters: `scripts/serve/**` is what lets the overlap engine see a
  // sibling claiming one file underneath it.
  assert.deepEqual(scopeToLeaseTargets({}), []);
  assert.deepEqual(scopeToLeaseTargets({ files: ['Needs discovery'] }), []);
});

test('splitScope: the mixed scope list round-trips back into files and dirs', () => {
  assert.deepEqual(
    splitScope(['a/b.mjs', 'docs/', 'Needs discovery', '', null]),
    { files: ['a/b.mjs'], dirs: ['docs/'] }
  );
});

test('leaseConflicts: overlap, not string equality, is the test', () => {
  const held = [{ target: 'scripts/serve/records.mjs', lockedBy: 'codex-worker-9' }];
  // The case a string comparison misses entirely: the same work at two
  // granularities. This is why targetsOverlap exists — and it had no caller.
  const hits = leaseConflicts(['scripts/serve/**'], held, { actor: 'codex-worker-1' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].heldBy, 'codex-worker-9');
  assert.equal(hits[0].existing, 'scripts/serve/records.mjs');

  // Disjoint scopes are exactly what parallel agents are supposed to have.
  assert.deepEqual(leaseConflicts(['ui/**'], held, { actor: 'codex-worker-1' }), []);
  // A lease this actor already holds is not a conflict with itself.
  assert.deepEqual(
    leaseConflicts(['scripts/serve/**'], held, { actor: 'codex-worker-9' }),
    []
  );
  assert.deepEqual(leaseConflicts([], held, {}), []);
  assert.deepEqual(leaseConflicts(['a/**'], [], {}), []);
});

test('leaseConflicts: "cannot decide" is reported as a conflict, never as clear', () => {
  // An unsupported pattern must fail toward caution: treating an undecidable
  // overlap as "no overlap" would hand out a lease the engine never checked.
  const held = [{ target: '!never/**', lockedBy: 'someone' }];
  const hits = leaseConflicts(['scripts/**'], held, { actor: 'me' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /cannot decide overlap/);
});

test('leaseUntil: an orchestration lease expires', () => {
  // A crashed runner must not hold scripts/** forever. Nothing sweeps expired
  // rows yet, but `until` is read by brief/lease/the Control Room, so a stale
  // claim is at least visibly stale rather than silently authoritative.
  assert.equal(leaseUntil(Date.parse('2026-08-28T10:00:00Z')), '2026-08-28T14:00:00Z');
  assert.equal(ORCHESTRATION_LEASE_HOURS, 4);
  assert.equal(leaseUntil(Date.parse('2026-08-28T10:00:00Z'), 1), '2026-08-28T11:00:00Z');
});
