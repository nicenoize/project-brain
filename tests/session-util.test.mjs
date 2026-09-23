import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentAutoCompact, AUTO_COMPACT_STOP_DEBOUNCE_MS } from '../scripts/session-util.mjs';

test('recentAutoCompact: debounces per branch, inside the window only', () => {
  const now = 10 * AUTO_COMPACT_STOP_DEBOUNCE_MS;
  const snap = (name, ageMs) => ({ name, mtimeMs: now - ageMs });
  const fresh = snap('main__auto-compact__2026-09-23T101010.md', 60_000);

  assert.equal(recentAutoCompact([fresh], 'main', now), true, 'a fresh snapshot on this branch → skip');
  assert.equal(recentAutoCompact([fresh], 'feature-x', now), false, 'another branch\'s snapshot does not count');
  assert.equal(recentAutoCompact([snap('main__auto-compact__old.md', AUTO_COMPACT_STOP_DEBOUNCE_MS)], 'main', now), false,
    'window lapsed → write a new one');
  assert.equal(recentAutoCompact([snap('main__task-1__2026-09-23T101010.md', 1_000)], 'main', now), false,
    'a hand-written session is not an auto-compact snapshot');
  assert.equal(recentAutoCompact([snap('main__auto-compact__x.md.tmp', 1_000)], 'main', now), false);
  assert.equal(recentAutoCompact([snap('main__auto-compact__future.md', -60_000)], 'main', now), false,
    'a future mtime (clock skew) never suppresses');
  assert.equal(recentAutoCompact([], 'main', now), false);
  assert.equal(recentAutoCompact(undefined, 'main', now), false);
});
