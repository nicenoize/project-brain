import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  frictionEnabled,
  frictionOversizeBytes,
  FRICTION_OVERSIZE_BYTES_DEFAULT,
  frictionSlug,
  frictionEventKey,
  classifyExitEvents,
  dedupeFrictionEvents,
  buildFrictionFinding,
  noteFriction,
  drainFrictionQueue,
  flushFriction,
  instrumentFriction
} from '../scripts/friction.mjs';
import { parseFinding, upsertFinding } from '../scripts/findings.mjs';

function tmpFindingsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-friction-'));
}
function findingFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

// ---------------------------------------------------------------------------
// gates — env + threshold (PURE)
// ---------------------------------------------------------------------------

test('frictionEnabled: only "1" turns it on', () => {
  assert.equal(frictionEnabled({ BRAIN_FRICTION_LOG: '1' }), true);
  assert.equal(frictionEnabled({ BRAIN_FRICTION_LOG: '0' }), false);
  assert.equal(frictionEnabled({}), false);
});

test('frictionOversizeBytes: env override, else default, ignores junk', () => {
  assert.equal(frictionOversizeBytes({}), FRICTION_OVERSIZE_BYTES_DEFAULT);
  assert.equal(frictionOversizeBytes({ BRAIN_FRICTION_OVERSIZE_BYTES: '500' }), 500);
  assert.equal(frictionOversizeBytes({ BRAIN_FRICTION_OVERSIZE_BYTES: 'nope' }), FRICTION_OVERSIZE_BYTES_DEFAULT);
  assert.equal(frictionOversizeBytes({ BRAIN_FRICTION_OVERSIZE_BYTES: '-5' }), FRICTION_OVERSIZE_BYTES_DEFAULT);
});

// ---------------------------------------------------------------------------
// slug / key — deterministic dedupe identity (PURE)
// ---------------------------------------------------------------------------

test('frictionSlug: deterministic, one per (kind, cmd)', () => {
  assert.equal(frictionSlug({ kind: 'error-exit', cmd: 'graph' }), 'friction-error-exit-graph');
  assert.equal(frictionSlug({ kind: 'oversize-output', cmd: 'search' }), 'friction-oversize-output-search');
  // same class → same slug (this is what makes upsert dedupe to one file)
  assert.equal(frictionSlug({ kind: 'error-exit', cmd: 'graph' }), frictionSlug({ kind: 'error-exit', cmd: 'graph' }));
  // different class → different slug
  assert.notEqual(frictionSlug({ kind: 'error-exit', cmd: 'graph' }), frictionSlug({ kind: 'error-exit', cmd: 'search' }));
});

test('frictionEventKey: kind + cmd', () => {
  assert.equal(frictionEventKey({ kind: 'error-exit', cmd: 'graph' }), 'error-exit:graph');
  assert.equal(frictionEventKey({}), 'unknown:unknown');
});

// ---------------------------------------------------------------------------
// classifyExitEvents (PURE)
// ---------------------------------------------------------------------------

test('classifyExitEvents: non-zero exit → error-exit event', () => {
  const ev = classifyExitEvents({ cmd: 'graph', exitCode: 1, stdoutBytes: 10 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'error-exit');
  assert.equal(ev[0].cmd, 'graph');
  assert.equal(ev[0].exitCode, 1);
});

test('classifyExitEvents: oversize stdout → oversize-output event', () => {
  const ev = classifyExitEvents({ cmd: 'search', exitCode: 0, stdoutBytes: 5000, oversizeBytes: 1000 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'oversize-output');
  assert.equal(ev[0].bytes, 5000);
  assert.equal(ev[0].threshold, 1000);
});

test('classifyExitEvents: both a failure and oversize → two events', () => {
  const ev = classifyExitEvents({ cmd: 'x', exitCode: 2, stdoutBytes: 5000, oversizeBytes: 1000 });
  assert.deepEqual(ev.map((e) => e.kind).sort(), ['error-exit', 'oversize-output']);
});

test('classifyExitEvents: clean exit under threshold → no events (no friction)', () => {
  assert.deepEqual(classifyExitEvents({ cmd: 'search', exitCode: 0, stdoutBytes: 100, oversizeBytes: 1000 }), []);
});

test('classifyExitEvents: empty cmd (worker / test runner) → no events', () => {
  assert.deepEqual(classifyExitEvents({ cmd: '', exitCode: 1, stdoutBytes: 999999 }), []);
});

// ---------------------------------------------------------------------------
// dedupe + finding construction (PURE)
// ---------------------------------------------------------------------------

test('dedupeFrictionEvents: collapses same class to one', () => {
  const out = dedupeFrictionEvents([
    { kind: 'error-exit', cmd: 'graph' },
    { kind: 'error-exit', cmd: 'graph' },
    { kind: 'oversize-output', cmd: 'graph' }
  ]);
  assert.equal(out.length, 2);
});

test('buildFrictionFinding: dx finding, open, deterministic slug, category-appropriate impact', () => {
  const rec = buildFrictionFinding({ kind: 'error-exit', cmd: 'graph', exitCode: 1 }, { now: 'NOW' });
  assert.equal(rec.category, 'dx');
  assert.equal(rec.status, 'open');
  assert.equal(rec.slug, 'friction-error-exit-graph');
  assert.equal(rec.impact, 3);
  assert.equal(rec.module, 'brain:graph');
  assert.match(rec.body, /exit code: 1/);
});

// ---------------------------------------------------------------------------
// upsertFinding (findings.mjs) — the programmatic write choke point
// ---------------------------------------------------------------------------

test('upsertFinding: creates then dedupes by slug, preserving created + bumping occurrences', () => {
  const dir = tmpFindingsDir();
  try {
    const a = upsertFinding({ slug: 'x-1', title: 'X', category: 'dx', impact: 3, body: 'b' }, { dir, now: 'C1' });
    assert.equal(a.existed, false);
    assert.equal(a.occurrences, 1);
    const b = upsertFinding({ slug: 'x-1', title: 'X', category: 'dx', impact: 3, body: 'b' }, { dir, now: 'C2' });
    assert.equal(b.existed, true);
    assert.equal(b.occurrences, 2);
    assert.equal(b.created, 'C1'); // first-seen preserved
    assert.deepEqual(findingFiles(dir), ['x-1.md']); // still one file
    const rec = parseFinding(fs.readFileSync(path.join(dir, 'x-1.md'), 'utf8'));
    assert.equal(rec.updated, 'C2');
    assert.equal(rec.impact, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ACCEPTANCE — one finding per class, deduped; two classes → two findings
// ---------------------------------------------------------------------------

test('flushFriction: a forced failure produces exactly one finding', () => {
  drainFrictionQueue();
  const dir = tmpFindingsDir();
  try {
    const w = flushFriction({ cmd: 'graph', exitCode: 1, stdoutBytes: 0, dir, now: 'T1' });
    assert.equal(w.length, 1);
    assert.deepEqual(findingFiles(dir), ['friction-error-exit-graph.md']);
    const rec = parseFinding(fs.readFileSync(path.join(dir, 'friction-error-exit-graph.md'), 'utf8'));
    assert.equal(rec.type, 'finding');
    assert.equal(rec.status, 'open');
    assert.equal(rec.category, 'dx');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushFriction: an oversized output produces exactly one finding', () => {
  drainFrictionQueue();
  const dir = tmpFindingsDir();
  try {
    process.env.BRAIN_FRICTION_OVERSIZE_BYTES = '1000';
    const w = flushFriction({ cmd: 'search', exitCode: 0, stdoutBytes: 5000, dir, now: 'T1' });
    assert.equal(w.length, 1);
    assert.deepEqual(findingFiles(dir), ['friction-oversize-output-search.md']);
  } finally {
    delete process.env.BRAIN_FRICTION_OVERSIZE_BYTES;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushFriction: the SAME event does not spam — deduped to one file, occurrences bump', () => {
  drainFrictionQueue();
  const dir = tmpFindingsDir();
  try {
    flushFriction({ cmd: 'graph', exitCode: 1, stdoutBytes: 0, dir, now: 'T1' });
    flushFriction({ cmd: 'graph', exitCode: 1, stdoutBytes: 0, dir, now: 'T2' });
    flushFriction({ cmd: 'graph', exitCode: 1, stdoutBytes: 0, dir, now: 'T3' });
    // still ONE file
    assert.deepEqual(findingFiles(dir), ['friction-error-exit-graph.md']);
    const raw = fs.readFileSync(path.join(dir, 'friction-error-exit-graph.md'), 'utf8');
    const rec = parseFinding(raw);
    assert.equal(rec.created, 'T1');   // first-seen preserved
    assert.equal(rec.updated, 'T3');   // refreshed each occurrence
    assert.match(raw, /occurrences:\s*3/); // counted, not spammed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushFriction: distinct classes each get their own finding', () => {
  drainFrictionQueue();
  const dir = tmpFindingsDir();
  try {
    flushFriction({ cmd: 'x', exitCode: 2, stdoutBytes: 5000, dir, now: 'T1', });
    // both an error-exit AND an oversize (default threshold 20000 → tune down)
    process.env.BRAIN_FRICTION_OVERSIZE_BYTES = '1000';
    flushFriction({ cmd: 'x', exitCode: 2, stdoutBytes: 5000, dir, now: 'T2' });
    const files = findingFiles(dir).sort();
    assert.deepEqual(files, ['friction-error-exit-x.md', 'friction-oversize-output-x.md']);
  } finally {
    delete process.env.BRAIN_FRICTION_OVERSIZE_BYTES;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// queue + truncation signal (in-memory producer path)
// ---------------------------------------------------------------------------

test('noteFriction: queued when on, flushed as a truncation finding', () => {
  drainFrictionQueue();
  const dir = tmpFindingsDir();
  try {
    assert.equal(noteFriction({ kind: 'truncation', cmd: 'route', detail: 'hook cap' }, { BRAIN_FRICTION_LOG: '1' }), true);
    const w = flushFriction({ cmd: 'route', exitCode: 0, stdoutBytes: 0, dir, now: 'T1' });
    assert.equal(w.length, 1);
    assert.deepEqual(findingFiles(dir), ['friction-truncation-route.md']);
    assert.match(fs.readFileSync(path.join(dir, 'friction-truncation-route.md'), 'utf8'), /hook cap/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FLAG OFF — zero writes, zero overhead
// ---------------------------------------------------------------------------

test('noteFriction: no-op (returns false, queue stays empty) when the flag is off', () => {
  drainFrictionQueue();
  assert.equal(noteFriction({ kind: 'truncation', cmd: 'route' }, { BRAIN_FRICTION_LOG: '0' }), false);
  assert.equal(noteFriction({ kind: 'truncation', cmd: 'route' }, {}), false);
  assert.deepEqual(drainFrictionQueue(), []);
});

test('instrumentFriction: does not arm (no handler, no writes) when the flag is off', () => {
  const saved = process.env.BRAIN_FRICTION_LOG;
  delete process.env.BRAIN_FRICTION_LOG;
  try {
    // Even with a valid brain entry point, an off flag means it never arms.
    assert.equal(instrumentFriction(['node', '/x/scripts/brain-graph.mjs']), false);
  } finally {
    if (saved === undefined) delete process.env.BRAIN_FRICTION_LOG;
    else process.env.BRAIN_FRICTION_LOG = saved;
  }
});

test('flushFriction: nothing to record → zero files written', () => {
  drainFrictionQueue();
  const dir = tmpFindingsDir();
  try {
    const w = flushFriction({ cmd: 'search', exitCode: 0, stdoutBytes: 10, dir, now: 'T1' });
    assert.equal(w.length, 0);
    assert.deepEqual(findingFiles(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
