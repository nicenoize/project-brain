/**
 * Tests for scripts/lease-overlap.mjs — the canonical lease-target semantics
 * (strategy M3): exhaustive match/miss table, segment-wise glob intersection,
 * unsupported-pattern rejection, property-style fuzz (match ⟹ overlap,
 * overlap is symmetric), and the brain:lease CLI reject/warn paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  targetMatchesFile,
  targetsOverlap,
  validateTarget,
  UnsupportedPatternError,
  LEASE_TARGET_GRAMMAR
} from '../scripts/lease-overlap.mjs';

const LEASE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'brain-lease.mjs');

// ---------------------------------------------------------------------------
// targetMatchesFile — exhaustive semantics table.
// ---------------------------------------------------------------------------

test('targetMatchesFile: exact / dir-prefix / glob semantics table', () => {
  const cases = [
    // --- exact paths ---
    ['scripts/a.mjs', 'scripts/a.mjs', true],
    ['./scripts/a.mjs', 'scripts/a.mjs', true], // leading ./ normalized
    ['scripts/a.mjs', './scripts/a.mjs', true],
    ['scripts/a.mjs', 'scripts/b.mjs', false],
    ['scripts/a.mjs', 'scripts/a.mjs.bak', false], // no partial-segment match
    ['Scripts/a.mjs', 'scripts/a.mjs', false], // case-sensitive
    // --- directory prefixes (exact-or-subtree, whole segments only) ---
    ['scripts', 'scripts/a.mjs', true],
    ['scripts/', 'scripts/deep/a.mjs', true],
    ['scripts', 'scripts', true], // covers the path itself
    ['scripts', 'scripts2/a.mjs', false], // "scripts" ≠ segment "scripts2"
    ['scripts/deep', 'scripts/a.mjs', false],
    ['src/auth', 'src/auth2.ts', false],
    // --- * stays within one segment ---
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/deep/a.ts', false], // * never crosses /
    ['src/*.ts', 'src/a.js', false],
    ['src/a*', 'src/abc.ts', true],
    ['src/*/x.ts', 'src/a/x.ts', true],
    ['src/*/x.ts', 'src/a/b/x.ts', false],
    // --- ** crosses segments ---
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/deep/nested/a.ts', true],
    ['src/**', 'src', false], // trailing ** = contents, not the anchor
    ['src/**', 'srcx/a.ts', false],
    ['src/**/x.ts', 'src/x.ts', true], // interior ** matches zero segments
    ['src/**/x.ts', 'src/a/b/x.ts', true],
    ['src/**/x.ts', 'src/a/y.ts', false],
    ['**', 'anything/at/all.ts', true], // bare ** leases everything
    ['**/x.ts', 'x.ts', true],
    ['**/x.ts', 'a/b/x.ts', true],
    // --- slash-free globs float on basenames ---
    ['*.mjs', 'scripts/a.mjs', true],
    ['*.mjs', 'a.mjs', true],
    ['*.mjs', 'scripts/a.ts', false],
    ['a*', 'x/y/abc.ts', true],
    ['a*', 'abc/file.ts', false], // basename only — not directory segments
    // --- degenerate inputs ---
    ['scripts/a.mjs', '', false],
    // --- literal special characters (no classes: [ ] are literal) ---
    ['app/[id]/page.tsx', 'app/[id]/page.tsx', true],
    ['app/*/page.tsx', 'app/[id]/page.tsx', true]
  ];
  for (const [target, file, expected] of cases) {
    assert.equal(targetMatchesFile(target, file), expected,
      `targetMatchesFile(${JSON.stringify(target)}, ${JSON.stringify(file)}) should be ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// targetsOverlap — segment-wise glob intersection.
// ---------------------------------------------------------------------------

test('targetsOverlap: plan example and pattern×pattern intersection', () => {
  const cases = [
    // The plan's headline example.
    ['src/**', 'src/auth/*.ts', true],
    // deep-glob vs deep-glob
    ['src/**', 'src/a/**', true],
    ['src/a/**', 'src/b/**', false],
    ['**', 'literally/anything.ts', true],
    // disjoint prefixes
    ['src/a', 'src/b', false],
    ['docs/**', 'scripts/**', false],
    ['docs', 'scripts/a.mjs', false],
    // prefix vs contained things
    ['src', 'src/auth/login.ts', true],
    ['src', 'src', true],
    ['src', 'srcx', false],
    // same-depth star vs concrete name → match check
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a.js', false],
    ['src/*.ts', 'src/deep/a.ts', false], // * does not reach into src/deep
    // star vs star at same depth
    ['src/a*', 'src/*b', true], // e.g. src/ab
    ['src/a*/x', 'src/b*/x', false],
    // floating vs anchored
    ['*.ts', 'src/auth/login.ts', true],
    ['*.ts', 'src/**', true],
    ['*.mjs', 'src/*.ts', false],
    // interior ** zero-segment interplay
    ['src/**/x.ts', 'src/x.ts', true],
    ['src/**/x.ts', 'src/*/y.ts', false]
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(targetsOverlap(a, b), expected,
      `targetsOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)}) should be ${expected}`);
    assert.equal(targetsOverlap(b, a), expected, 'must be symmetric');
  }
});

test('targetsOverlap: single * covers only depth-1 files, so no overlap with a deeper exact target', () => {
  // src/* matches files directly under src/ (one segment). src/deep/a.ts is
  // two segments below → no single file satisfies both.
  assert.equal(targetsOverlap('src/*', 'src/deep/a.ts'), false);
  // But the no-wildcard target src/deep is exact-OR-SUBTREE, and the file
  // "src/deep" itself (depth 1 under src) satisfies src/* too.
  assert.equal(targetsOverlap('src/*', 'src/deep'), true);
});

// ---------------------------------------------------------------------------
// Unsupported constructs — reject, never mis-check.
// ---------------------------------------------------------------------------

test('validateTarget: reports unsupported constructs with reasons', () => {
  assert.deepEqual(validateTarget('src/auth.ts'), { ok: true });
  assert.deepEqual(validateTarget('src/**'), { ok: true });
  assert.deepEqual(validateTarget('app/[id]/page.tsx'), { ok: true }); // brackets are literal
  for (const [target, hint] of [
    ['src/{a,b}.ts', /brace/],
    ['!src/a.ts', /negation/],
    ['src\\a.ts', /backslash/],
    ['src/a?.ts', /\? wildcard/],
    ['/abs/path.ts', /absolute/],
    ['', /empty/],
    ['   ', /empty/]
  ]) {
    const v = validateTarget(target);
    assert.equal(v.ok, false, `expected ${JSON.stringify(target)} to be rejected`);
    assert.match(v.reason, hint);
  }
});

test('targetMatchesFile / targetsOverlap throw UnsupportedPatternError for braces and negation', () => {
  for (const bad of ['src/{a,b}.ts', '!src/a.ts']) {
    assert.throws(() => targetMatchesFile(bad, 'src/a.ts'), UnsupportedPatternError);
    assert.throws(() => targetsOverlap(bad, 'src/**'), UnsupportedPatternError);
    assert.throws(() => targetsOverlap('src/**', bad), UnsupportedPatternError);
  }
  try {
    targetsOverlap('src/{a,b}.ts', 'src/**');
    assert.fail('expected throw');
  } catch (error) {
    assert.equal(error.name, 'UnsupportedPatternError');
    assert.equal(error.code, 'EUNSUPPORTED_PATTERN');
    assert.equal(error.target, 'src/{a,b}.ts');
    assert.match(error.message, /unsupported lease target/);
  }
});

test('grammar constant is frozen and lists the supported wildcards', () => {
  assert.ok(Object.isFrozen(LEASE_TARGET_GRAMMAR));
  assert.deepEqual([...LEASE_TARGET_GRAMMAR.wildcards], ['*', '**']);
  assert.equal(LEASE_TARGET_GRAMMAR.caseSensitive, true);
});

// ---------------------------------------------------------------------------
// Property-style fuzz: ~200 seeded random pairs from a small alphabet.
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — fuzz failures must be reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_SEGS = ['a', 'b', 'c', 'ab', 'cb', 'abc'];
const PATTERN_SEGS = [...PATH_SEGS, '*', '**', 'a*', '*b', 'a*c'];

function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
function randomPath(rand) {
  const n = 1 + Math.floor(rand() * 3);
  return Array.from({ length: n }, () => pick(rand, PATH_SEGS)).join('/');
}
function randomPattern(rand) {
  const n = 1 + Math.floor(rand() * 3);
  return Array.from({ length: n }, () => pick(rand, PATTERN_SEGS)).join('/');
}

test('fuzz: targetMatchesFile(t, f) implies targetsOverlap(t, f-as-exact-target)', () => {
  const rand = mulberry32(0xbeef);
  for (let i = 0; i < 200; i++) {
    const t = randomPattern(rand);
    const f = randomPath(rand);
    if (targetMatchesFile(t, f)) {
      assert.equal(targetsOverlap(t, f), true,
        `match(${JSON.stringify(t)}, ${JSON.stringify(f)}) but no overlap (iteration ${i})`);
    }
  }
});

test('fuzz: targetsOverlap is symmetric', () => {
  const rand = mulberry32(0xcafe);
  for (let i = 0; i < 200; i++) {
    const a = randomPattern(rand);
    const b = randomPattern(rand);
    assert.equal(targetsOverlap(a, b), targetsOverlap(b, a),
      `asymmetric overlap for ${JSON.stringify(a)} ⊗ ${JSON.stringify(b)} (iteration ${i})`);
  }
});

// ---------------------------------------------------------------------------
// brain:lease CLI — subprocess reject / warn paths.
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-overlap-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  return cwd;
}

function runLease(cwd, args, env = {}) {
  return spawnSync(process.execPath, [LEASE_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_QUIET: '1', BRAIN_ACTOR: '', BRAIN_TASK: '', ...env }
  });
}

test('brain:lease add rejects a {a,b} brace target with exit 1', () => {
  const cwd = makeRepo();
  const r = runLease(cwd, ['add', 'src/{a,b}.ts', '--task', 'issue-1', '--actor', 'codex-a']);
  assert.equal(r.status, 1, r.stderr);
  // NOTE: the CLI's comma-list splitting turns `src/{a,b}.ts` into two
  // fragments; the leading fragment still carries the brace and is rejected.
  assert.match(r.stderr, /rejected 'src\/\{a'/);
  assert.match(r.stderr, /brace expansion/);
  assert.match(r.stderr, /Supported targets/);
  // Nothing was added: the table stays empty.
  const list = runLease(cwd, ['list', '--json']);
  assert.deepEqual(JSON.parse(list.stdout), []);
});

test('brain:lease add validates all targets before adding any', () => {
  const cwd = makeRepo();
  const r = runLease(cwd, ['add', 'src/ok.ts,!bad.ts', '--actor', 'codex-a']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /negation/);
  const list = runLease(cwd, ['list', '--json']);
  assert.deepEqual(JSON.parse(list.stdout), [], 'valid sibling target must not be added either');
});

test('brain:lease add warns (does not block) on overlap with a different actor\'s lease', () => {
  const cwd = makeRepo();
  const first = runLease(cwd, ['add', 'src/**', '--task', 'issue-1', '--actor', 'codex-a', '--until', 'PR-7']);
  assert.equal(first.status, 0, first.stderr);

  const second = runLease(cwd, ['add', 'src/auth/login.ts', '--task', 'issue-2', '--actor', 'codex-b']);
  assert.equal(second.status, 0, second.stderr); // warn, never block
  assert.match(second.stderr, /warning: 'src\/auth\/login\.ts' overlaps active lease 'src\/\*\*' held by codex-a until PR-7/);
  assert.match(second.stdout, /Added 1 lease\(s\)\./);

  const list = runLease(cwd, ['list', '--json']);
  assert.equal(JSON.parse(list.stdout).length, 2, 'both leases exist');
});

test('brain:lease add stays silent for overlap with the SAME actor', () => {
  const cwd = makeRepo();
  runLease(cwd, ['add', 'src/**', '--actor', 'codex-a']);
  const r = runLease(cwd, ['add', 'src/auth/login.ts', '--actor', 'codex-a']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /overlaps/);
});
