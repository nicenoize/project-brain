import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  dedupeCandidates,
  toEvalCase,
  mergeIntoEval,
  normalizeQuery,
  splitList,
  candidateHash,
  recommendAB
} from '../scripts/brain-learn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const LEARN_SCRIPT = path.join(scriptsDir, 'brain-learn.mjs');

// ---------------------------------------------------------------------------
// PURE: normalizeQuery / splitList / candidateHash
// ---------------------------------------------------------------------------

test('normalizeQuery is case- and whitespace-insensitive', () => {
  assert.equal(normalizeQuery('  How  Does X Work? '), 'how does x work?');
  assert.equal(normalizeQuery('how does x work?'), normalizeQuery('HOW   DOES   X   WORK?'));
});

test('candidateHash is stable across equivalent query spellings', () => {
  assert.equal(candidateHash('foo bar'), candidateHash('  FOO   bar '));
  assert.notEqual(candidateHash('foo bar'), candidateHash('foo baz'));
  assert.match(candidateHash('foo bar'), /^[0-9a-f]{16}$/);
});

test('splitList trims, drops empties, and de-dupes preserving order', () => {
  assert.deepEqual(splitList('a.mjs, b.mjs ,a.mjs\nc.mjs,'), ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.deepEqual(splitList(''), []);
});

// ---------------------------------------------------------------------------
// PURE: dedupeCandidates
// ---------------------------------------------------------------------------

test('dedupeCandidates merges duplicate queries: unions files, sums uses', () => {
  const out = dedupeCandidates([
    { query: 'how does sync work', used: ['a.mjs'], uses: 1, created: '2026-01-01' },
    { query: 'How Does Sync Work', used: ['b.mjs', 'a.mjs'], uses: 2, created: '2026-01-02' },
    { query: 'unrelated', used: ['c.mjs'], uses: 1 }
  ]);
  assert.equal(out.length, 2);
  const sync = out.find((c) => normalizeQuery(c.query) === 'how does sync work');
  assert.deepEqual(sync.used, ['a.mjs', 'b.mjs']); // union, order-preserving
  assert.equal(sync.uses, 3);                       // summed
  assert.equal(sync.created, '2026-01-02');          // latest metadata wins
});

test('dedupeCandidates drops entries with a blank query', () => {
  const out = dedupeCandidates([
    { query: '   ', used: ['a.mjs'] },
    { query: '', used: ['b.mjs'] },
    { query: 'real', used: ['c.mjs'] }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].query, 'real');
});

// ---------------------------------------------------------------------------
// PURE: toEvalCase — eval.json shape ({ query, expectedFiles }), NO symbols
// ---------------------------------------------------------------------------

test('toEvalCase produces the exact eval.json file-level shape', () => {
  const c = toEvalCase({ query: 'where is the lease lock', used: ['a.mjs', 'a.mjs', 'b.md'], uses: 2 });
  assert.deepEqual(Object.keys(c).sort(), ['expectedFiles', 'note', 'query']);
  assert.equal(c.query, 'where is the lease lock');
  assert.deepEqual(c.expectedFiles, ['a.mjs', 'b.md']);     // de-duped
  assert.equal('expectedSymbols' in c, false);              // file-level discipline: never symbols
  assert.doesNotMatch(c.note, /^hard:/i);                   // not silently in the curated hard subset
});

test('toEvalCase returns null when query or files are missing', () => {
  assert.equal(toEvalCase({ query: 'q', used: [] }), null);
  assert.equal(toEvalCase({ query: '', used: ['a.mjs'] }), null);
  assert.equal(toEvalCase(null), null);
});

// ---------------------------------------------------------------------------
// PURE: mergeIntoEval — additive, idempotent, preserves invariants
// ---------------------------------------------------------------------------

test('mergeIntoEval appends new cases without touching existing ones', () => {
  const existing = [
    { query: 'Qdrant adapter', expectedFiles: ['scripts/store.mjs'], expectedSymbols: ['QdrantStore'], expectedTypes: ['code'] }
  ];
  const { merged, added, skipped } = mergeIntoEval(existing, [
    { query: 'new usage query', used: ['lib/new.mjs'], uses: 1 }
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0]);                 // existing untouched + same position
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].expectedFiles, ['lib/new.mjs']);
  assert.equal(skipped.length, 0);
});

test('mergeIntoEval is idempotent: re-merging the same candidate is a no-op (dedupe by query)', () => {
  const existing = [{ query: 'dup me', expectedFiles: ['a.mjs'] }];
  const { merged, added, skipped } = mergeIntoEval(existing, [
    { query: 'DUP ME', used: ['b.mjs'], uses: 9 }            // same query, diff spelling/files
  ]);
  assert.equal(merged.length, 1);
  assert.equal(added.length, 0);
  assert.equal(skipped[0].reason, 'duplicate');
});

test('mergeIntoEval preserves the unique-query invariant within one batch', () => {
  const { merged, added } = mergeIntoEval([], [
    { query: 'same', used: ['a.mjs'], uses: 1 },
    { query: 'Same', used: ['b.mjs'], uses: 1 }             // dedupes to one before insert
  ]);
  assert.equal(added.length, 1);
  const queries = merged.map((c) => normalizeQuery(c.query));
  assert.equal(new Set(queries).size, queries.length);     // still all unique
});

test('mergeIntoEval honors --min-uses gating', () => {
  const { added, skipped } = mergeIntoEval([], [
    { query: 'weak', used: ['a.mjs'], uses: 1 },
    { query: 'strong', used: ['b.mjs'], uses: 3 }
  ], { minUses: 2 });
  assert.deepEqual(added.map((c) => c.query), ['strong']);
  assert.equal(skipped.find((s) => s.query === 'weak').reason, 'min-uses');
});

test('mergeIntoEval skips malformed candidates (no files)', () => {
  const { added, skipped } = mergeIntoEval([], [{ query: 'no files', used: [], uses: 5 }]);
  assert.equal(added.length, 0);
  assert.equal(skipped[0].reason, 'malformed');
});

test('mergeIntoEval has no ranking side effects — output is a pure data transform', () => {
  // The merged array is a plain JSON-serializable case list: no functions,
  // no retrieval handles, round-trips through JSON unchanged.
  const { merged } = mergeIntoEval(
    [{ query: 'a', expectedFiles: ['x.mjs'] }],
    [{ query: 'b', used: ['y.mjs'], uses: 1 }]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), merged);
  for (const c of merged) assert.equal(typeof c.query, 'string');
});

// ---------------------------------------------------------------------------
// PURE: recommendAB — suggests a knob, never mutates anything
// ---------------------------------------------------------------------------

test('recommendAB returns the documented primary pair + a runnable procedure', () => {
  const r = recommendAB(7);
  assert.equal(r.misses, 7);
  assert.match(r.recommend, /BRAIN_LEXICAL_UNION=1 BRAIN_RERANK=1/);
  assert.ok(Array.isArray(r.alternatives) && r.alternatives.length >= 1);
  assert.ok(r.procedure.some((line) => line.includes('brain:eval:compare')));
});

// ---------------------------------------------------------------------------
// SPAWN: capture → promote --dry-run round-trip in a tmpdir
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-learn-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  // A minimal but real-shaped eval.json (same shape as the live one).
  fs.writeFileSync(
    path.join(cwd, '.project-brain', 'eval.json'),
    JSON.stringify([{ query: 'seed case', expectedFiles: ['seed.mjs'] }], null, 2) + '\n'
  );
  fs.writeFileSync(path.join(cwd, 'seed.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(cwd, 'lib.mjs'), 'export const y = 2;\n');
  return cwd;
}

function runLearn(cwd, args) {
  return spawnSync(process.execPath, [LEARN_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('capture stages a candidate JSON under .eval-candidates (gitignored staging)', () => {
  const cwd = makeRepo();
  const r = runLearn(cwd, ['capture', '--query', 'how do leases work', '--used', 'lib.mjs,seed.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.uses, 1);
  assert.deepEqual(out.used, ['lib.mjs', 'seed.mjs']);

  const stagingDir = path.join(cwd, '.project-brain', '.eval-candidates');
  const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(stagingDir, files[0]), 'utf8'));
  assert.equal(rec.query, 'how do leases work');
});

test('capture de-dupes by query: second capture bumps uses and unions files', () => {
  const cwd = makeRepo();
  runLearn(cwd, ['capture', '--query', 'dup q', '--used', 'a.mjs']);
  const r = runLearn(cwd, ['capture', '--query', 'DUP Q', '--used', 'b.mjs', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.uses, 2);
  assert.deepEqual(out.used, ['a.mjs', 'b.mjs']);
  // still exactly one staged file (deduped by query hash)
  const files = fs.readdirSync(path.join(cwd, '.project-brain', '.eval-candidates')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
});

test('promote --dry-run previews but does NOT mutate eval.json or clear staging', () => {
  const cwd = makeRepo();
  runLearn(cwd, ['capture', '--query', 'preview me', '--used', 'lib.mjs']);
  const evalPath = path.join(cwd, '.project-brain', 'eval.json');
  const before = fs.readFileSync(evalPath, 'utf8');

  const r = runLearn(cwd, ['promote', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.promoted, 1);
  assert.deepEqual(out.added, ['preview me']);

  // eval.json untouched and still valid + shape-preserved.
  assert.equal(fs.readFileSync(evalPath, 'utf8'), before);
  const cases = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  assert.equal(cases.length, 1);
  assert.equal(cases[0].query, 'seed case');
  // staging intact for the real run.
  assert.equal(fs.readdirSync(path.join(cwd, '.project-brain', '.eval-candidates')).filter((f) => f.endsWith('.json')).length, 1);
});

test('promote (real) appends to eval.json in shape and clears the promoted staging file', () => {
  const cwd = makeRepo();
  runLearn(cwd, ['capture', '--query', 'real promote', '--used', 'lib.mjs']);
  const r = runLearn(cwd, ['promote', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).promoted, 1);

  const cases = JSON.parse(fs.readFileSync(path.join(cwd, '.project-brain', 'eval.json'), 'utf8'));
  assert.equal(cases.length, 2);
  const added = cases.find((c) => c.query === 'real promote');
  assert.deepEqual(added.expectedFiles, ['lib.mjs']);
  assert.equal('expectedSymbols' in added, false);
  // seed case preserved verbatim
  assert.deepEqual(cases[0], { query: 'seed case', expectedFiles: ['seed.mjs'] });
  // promoted staging file removed
  assert.equal(fs.readdirSync(path.join(cwd, '.project-brain', '.eval-candidates')).filter((f) => f.endsWith('.json')).length, 0);

  // Idempotent: a second promote with nothing staged is a clean no-op.
  const r2 = runLearn(cwd, ['promote', '--json']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).promoted, 0);
});

test('promote --min-uses leaves weak candidates staged for later', () => {
  const cwd = makeRepo();
  runLearn(cwd, ['capture', '--query', 'weak case', '--used', 'lib.mjs']); // uses=1
  const r = runLearn(cwd, ['promote', '--min-uses', '2', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.promoted, 0);
  assert.equal(out.skipped[0].reason, 'min-uses');
  // eval.json unchanged, candidate still staged.
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.project-brain', 'eval.json'), 'utf8')).length, 1);
  assert.equal(fs.readdirSync(path.join(cwd, '.project-brain', '.eval-candidates')).filter((f) => f.endsWith('.json')).length, 1);
});

test('suggest outputs an A/B recommendation and never mutates eval.json', () => {
  const cwd = makeRepo();
  runLearn(cwd, ['capture', '--query', 'a miss', '--used', 'lib.mjs']);
  const before = fs.readFileSync(path.join(cwd, '.project-brain', 'eval.json'), 'utf8');
  const r = runLearn(cwd, ['suggest', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.recommend, /BRAIN_/);
  assert.equal(out.misses, 1);
  // suggest must not touch ranking/eval — file unchanged.
  assert.equal(fs.readFileSync(path.join(cwd, '.project-brain', 'eval.json'), 'utf8'), before);
});

test('capture errors clearly without --query or --used', () => {
  const cwd = makeRepo();
  const noQuery = runLearn(cwd, ['capture', '--used', 'lib.mjs']);
  assert.notEqual(noQuery.status, 0);
  assert.match(noQuery.stderr, /--query/);
  const noUsed = runLearn(cwd, ['capture', '--query', 'q']);
  assert.notEqual(noUsed.status, 0);
  assert.match(noUsed.stderr, /--used/);
});

test('unknown subcommand exits non-zero with usage', () => {
  const cwd = makeRepo();
  const r = runLearn(cwd, ['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown subcommand/);
});
