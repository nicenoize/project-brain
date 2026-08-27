/**
 * The Control Room bundle must actually reach a consuming repo.
 *
 * WHY THIS EXISTS. `ui/dist` was gitignored and nothing built it on the
 * consumer side, so every panel we shipped was invisible outside this
 * checkout: club-ops, updated to the exact same commit, served
 * "the Control Room UI is not built yet" while its API happily reported four
 * collaborators and eight shared areas. Third time today that the code
 * shipped and the product did not — after the missing mergePackageScripts
 * entries and the six commands SKILL.md had never heard of.
 *
 * So the bundle is committed, and this is the discipline that makes committing
 * build output safe: it must exist, it must be internally consistent, and it
 * must not be older than the source it was built from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'ui', 'dist');

test('the built Control Room is committed and self-consistent', () => {
  const index = path.join(DIST, 'index.html');
  assert.ok(fs.existsSync(index), 'ui/dist/index.html is missing — run `npm --prefix ui run build`');
  const html = fs.readFileSync(index, 'utf8');

  // Every asset the page asks for must be in the commit. A half-committed
  // bundle serves a blank page, which is worse than the honest fallback.
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, `expected the bundle to reference its assets, found ${refs.length}`);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(DIST, ref)), `index.html references a missing asset: ${ref}`);
  }
  // Vite emits content-hashed names; a zero-byte asset means a broken write.
  for (const ref of refs) {
    assert.ok(fs.statSync(path.join(DIST, ref)).size > 0, `empty asset: ${ref}`);
  }
});

test('the committed bundle is not older than the source it was built from', () => {
  const lastCommit = (p) => {
    const r = spawnSync('git', ['log', '-1', '--format=%ct', '--', p], {
      cwd: ROOT, encoding: 'utf8'
    });
    if (r.status !== 0) return null;
    const t = Number((r.stdout || '').trim());
    return Number.isFinite(t) && t > 0 ? t : null;
  };
  const src = lastCommit('ui/src');
  const dist = lastCommit('ui/dist');

  if (src === null || dist === null) {
    // A shallow clone has no history to compare. Say so rather than passing
    // silently: a guard that quietly does nothing is not a guard.
    console.log('[ui-bundle] staleness check skipped — no git history for ui/src or ui/dist (shallow clone?)');
    return;
  }
  assert.ok(
    dist >= src,
    `ui/dist was last committed ${Math.round((src - dist) / 60)} min BEFORE the last ui/src change — ` +
    'the Control Room a consumer gets is stale. Run `npm --prefix ui run build` and commit ui/dist.'
  );
});
