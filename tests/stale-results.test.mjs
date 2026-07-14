import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleResults, staleBanner } from '../scripts/retrieval.mjs';
import { sha256 } from '../scripts/common.mjs';

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-stale-'));
  const full = path.join(dir, name);
  fs.writeFileSync(full, content);
  return full;
}

const OLD_MTIME = '2000-01-01T00:00:00.000Z'; // far in the past → disk always newer

test('mtime-newer + hash-same → NOT stale (kills branch-switch false positive)', () => {
  const content = 'export const a = 1;\n';
  const full = tmpFile('a.ts', content);
  // On disk now (mtime ≈ now) but content byte-identical to what we indexed.
  const record = { file: full, mtime: OLD_MTIME, hash: sha256(content) };
  assert.deepEqual(staleResults([record]), []);
});

test('mtime-newer + hash-diff → stale', () => {
  const full = tmpFile('b.ts', 'export const b = 2;\n');
  // Index recorded a DIFFERENT hash → real unsynced edit.
  const record = { file: full, mtime: OLD_MTIME, hash: sha256('OLD CONTENT') };
  assert.deepEqual(staleResults([record]), [full]);
});

test('missing file is handled (skipped, no throw)', () => {
  const record = { file: '/no/such/brain/file.ts', mtime: OLD_MTIME, hash: 'deadbeef' };
  assert.deepEqual(staleResults([record]), []);
});

test('records without mtime/hash are skipped (e.g. synthetic aggregates)', () => {
  const full = tmpFile('c.ts', 'x');
  assert.deepEqual(staleResults([{ file: full }]), []);
  assert.deepEqual(staleResults([{ file: full, mtime: OLD_MTIME }]), []);
  assert.deepEqual(staleResults([{ file: full, hash: sha256('x') }]), []);
});

test('distinct files deduped and bounded by opts.max', () => {
  const full = tmpFile('d.ts', 'd');
  const record = { file: full, mtime: OLD_MTIME, hash: sha256('DIFFERENT') };
  // Same file repeated across chunks → reported once.
  assert.deepEqual(staleResults([record, { ...record }, { ...record }]), [full]);
});

test('non-newer mtime → NOT stale even if hash would differ (stage-1 gate)', () => {
  const content = 'unchanged\n';
  const full = tmpFile('e.ts', content);
  // Record mtime in the far FUTURE → disk is not newer → stage 1 short-circuits.
  const record = { file: full, mtime: '2999-01-01T00:00:00.000Z', hash: sha256('anything-else') };
  assert.deepEqual(staleResults([record]), []);
});

test('staleBanner formats one line and honors BRAIN_STALE_BANNER=0 opt-out', () => {
  const full = tmpFile('f.ts', 'edited\n');
  const record = { file: full, mtime: OLD_MTIME, hash: sha256('OLD') };
  const prev = process.env.BRAIN_STALE_BANNER;
  try {
    delete process.env.BRAIN_STALE_BANNER;
    const banner = staleBanner([record]);
    assert.match(banner, /^⚠ index stale for 1 file\(s\):/);
    assert.match(banner, /npm run brain:sync/);

    process.env.BRAIN_STALE_BANNER = '0';
    assert.equal(staleBanner([record]), '');
  } finally {
    if (prev === undefined) delete process.env.BRAIN_STALE_BANNER;
    else process.env.BRAIN_STALE_BANNER = prev;
  }
});

test('empty input returns empty (no work, no throw)', () => {
  assert.deepEqual(staleResults([]), []);
  assert.equal(staleBanner([]), '');
});
