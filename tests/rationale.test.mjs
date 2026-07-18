import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rationaleEnabled,
  commentBodies,
  extractAdrRefs,
  extractRationale,
  buildRationaleRecord,
  RATIONALE_CHUNK
} from '../scripts/rationale.mjs';
import { inferType } from '../scripts/infer.mjs';
import { matchesFilter } from '../scripts/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function withFlag(value, fn) {
  const prev = process.env.BRAIN_RATIONALE;
  if (value === undefined) delete process.env.BRAIN_RATIONALE;
  else process.env.BRAIN_RATIONALE = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.BRAIN_RATIONALE;
    else process.env.BRAIN_RATIONALE = prev;
  }
}

// ---------------------------------------------------------------------------
// Flag gate
// ---------------------------------------------------------------------------

test('rationaleEnabled: default-off, on only when BRAIN_RATIONALE=1', () => {
  withFlag(undefined, () => assert.equal(rationaleEnabled(), false));
  withFlag('0', () => assert.equal(rationaleEnabled(), false));
  withFlag('true', () => assert.equal(rationaleEnabled(), false));
  withFlag('1', () => assert.equal(rationaleEnabled(), true));
});

// ---------------------------------------------------------------------------
// Comment styles: // , # , /* */ , and JSDoc ` * ` continuation + inline
// ---------------------------------------------------------------------------

test('commentBodies strips each comment style', () => {
  assert.deepEqual(commentBodies('// WHY: keep it simple'), ['WHY: keep it simple']);
  assert.deepEqual(commentBodies('   # WHY: python style'), ['WHY: python style']);
  assert.deepEqual(commentBodies('/* WHY: block style */'), ['WHY: block style']);
  assert.deepEqual(commentBodies(' * NOTE: jsdoc continuation'), ['NOTE: jsdoc continuation']);
  // Inline comment trailing real code.
  assert.deepEqual(commentBodies('doStuff(); // HACK: temporary'), ['HACK: temporary']);
  assert.deepEqual(commentBodies('const x = 1; /* NOTE: inline */'), ['NOTE: inline']);
  // Non-comment / block terminator lines yield nothing.
  assert.deepEqual(commentBodies('const y = 2;'), []);
  assert.deepEqual(commentBodies(' */'), []);
});

test('extractRationale: // line comments (WHY/NOTE/HACK) with provenance', () => {
  const src = [
    'const a = 1;',
    '// WHY: dense recall lives in this one line',
    'function f() {}',
    '// NOTE: careful with ordering',
    '// HACK: works around a bug',
    '// just a normal comment'
  ].join('\n');
  const found = extractRationale(src);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map(f => f.marker), ['WHY', 'NOTE', 'HACK']);
  assert.deepEqual(found.map(f => f.lineStart), [2, 4, 5]);
  assert.equal(found[0].text, 'dense recall lives in this one line');
});

test('extractRationale: # comment style (python/shell/yaml)', () => {
  const found = extractRationale('x = 1  # inline\n# WHY: hashed rationale\n# TODO: not a marker');
  assert.equal(found.length, 1);
  assert.equal(found[0].marker, 'WHY');
  assert.equal(found[0].text, 'hashed rationale');
  assert.equal(found[0].lineStart, 2);
});

test('extractRationale: /* */ block and JSDoc continuation styles', () => {
  const single = extractRationale('/* HACK: single-line block */');
  assert.equal(single.length, 1);
  assert.equal(single[0].marker, 'HACK');
  assert.equal(single[0].text, 'single-line block');

  const block = [
    '/**',
    ' * WHY: this multi-line reason',
    ' * NOTE: and a second one',
    ' */'
  ].join('\n');
  const found = extractRationale(block);
  assert.deepEqual(found.map(f => f.marker), ['WHY', 'NOTE']);
  assert.deepEqual(found.map(f => f.lineStart), [2, 3]);
});

test('extractRationale: case-insensitive marker, colon required', () => {
  const found = extractRationale('// why: lowercase ok\n// WHY it works (no colon → not a marker)');
  assert.equal(found.length, 1);
  assert.equal(found[0].marker, 'WHY');
});

// ---------------------------------------------------------------------------
// ADR / RFC reference forms
// ---------------------------------------------------------------------------

test('extractAdrRefs: all ADR / decisions/ / RFC forms, normalized + deduped', () => {
  assert.deepEqual(extractAdrRefs('see ADR 13'), ['ADR 0013']);
  assert.deepEqual(extractAdrRefs('ADR-0014 applies'), ['ADR 0014']);
  assert.deepEqual(extractAdrRefs('per ADR0014'), ['ADR 0014']);
  assert.deepEqual(extractAdrRefs('adr #5'), ['ADR 0005']);
  assert.deepEqual(extractAdrRefs('decisions/0013-cross-encoder-rerank.md'), ['ADR 0013']);
  assert.deepEqual(extractAdrRefs('decisions/0013-*'), ['ADR 0013']);
  assert.deepEqual(extractAdrRefs('RFC 7231 and RFC-2119'), ['RFC 7231', 'RFC 2119']);
  // Dedupe: ADR 0013 mentioned two ways collapses to one.
  assert.deepEqual(extractAdrRefs('ADR 13 and decisions/0013-foo'), ['ADR 0013']);
  assert.deepEqual(extractAdrRefs('no citations here'), []);
});

test('extractRationale: ADR citation in a comment WITHOUT a marker still records', () => {
  const found = extractRationale('doThing(); // implements decisions/0021-grill-axis approach');
  assert.equal(found.length, 1);
  assert.equal(found[0].marker, '');
  assert.deepEqual(found[0].references, ['ADR 0021']);
});

test('extractRationale: marker + ADR citation on the same line captures both', () => {
  const found = extractRationale('// WHY: reranker chosen — see ADR 0013');
  assert.equal(found.length, 1);
  assert.equal(found[0].marker, 'WHY');
  assert.deepEqual(found[0].references, ['ADR 0013']);
});

test('extractRationale: ADR-looking text OUTSIDE a comment is ignored', () => {
  // A code/string mention that is not in a comment must not become a record.
  assert.deepEqual(extractRationale('const p = "decisions/0013-foo.md";'), []);
});

// ---------------------------------------------------------------------------
// Record building
// ---------------------------------------------------------------------------

test('buildRationaleRecord: shape, type, provenance, deterministic id', () => {
  const finding = { marker: 'WHY', text: 'keep it simple', lineStart: 42, references: ['ADR 0013'] };
  const rec = buildRationaleRecord('scripts/foo.mjs', finding, 'deadbeef', { module: 'scripts', project: '' });
  assert.equal(rec.type, 'rationale');
  assert.equal(rec.chunk, RATIONALE_CHUNK);
  assert.equal(rec.file, 'scripts/foo.mjs');
  assert.equal(rec.lineStart, 42);
  assert.equal(rec.lineEnd, 42);
  assert.equal(rec.marker, 'WHY');
  assert.deepEqual(rec.references, ['ADR 0013']);
  assert.equal(rec.module, 'scripts');
  assert.equal(rec.text, 'WHY: keep it simple (ADR 0013)');
  assert.ok(rec.embeddingText.includes('scripts/foo.mjs:42'));
  assert.equal(rec.isSummary, false);
  // Deterministic id: same inputs → same id; line change → different id.
  const rec2 = buildRationaleRecord('scripts/foo.mjs', finding, 'deadbeef', { module: 'scripts', project: '' });
  assert.equal(rec.id, rec2.id);
  const moved = buildRationaleRecord('scripts/foo.mjs', { ...finding, lineStart: 43 }, 'deadbeef', {});
  assert.notEqual(rec.id, moved.id);
});

test('buildRationaleRecord: citation-only finding uses RATIONALE: label', () => {
  const rec = buildRationaleRecord('a.py', { marker: '', text: 'see decisions/0021-x', lineStart: 3, references: ['ADR 0021'] }, 'h');
  assert.equal(rec.heading, 'RATIONALE:');
  assert.ok(rec.text.startsWith('RATIONALE:'));
});

// ---------------------------------------------------------------------------
// DORMANCY — flag-off index behavior byte-identical to before
// ---------------------------------------------------------------------------

test('inferType: rationale taxonomy is dormant — unchanged with flag off', () => {
  withFlag(undefined, () => {
    // The rationale branch never fires; existing taxonomy is byte-identical.
    assert.equal(inferType('.project-brain/rationale/foo.md'), 'doc');
    assert.equal(inferType('scripts/retrieval.mjs'), 'code');
    assert.equal(inferType('.project-brain/decisions/0013-x.md'), 'decision');
  });
  withFlag('1', () => {
    // Only when the flag is set does the reserved path map to the new kind.
    assert.equal(inferType('.project-brain/rationale/foo.md'), 'rationale');
    // Everything else is unchanged regardless of the flag.
    assert.equal(inferType('scripts/retrieval.mjs'), 'code');
    assert.equal(inferType('.project-brain/decisions/0013-x.md'), 'decision');
  });
});

test('matchesFilter: string type filter is byte-identical; array widens', () => {
  const history = { type: 'history' };
  const rationale = { type: 'rationale' };
  const code = { type: 'code' };
  // Existing string behavior unchanged.
  assert.equal(matchesFilter(history, { type: 'history' }), true);
  assert.equal(matchesFilter(rationale, { type: 'history' }), false);
  // New array behavior (used by brain:why only when the flag is on).
  assert.equal(matchesFilter(rationale, { type: ['history', 'rationale'] }), true);
  assert.equal(matchesFilter(history, { type: ['history', 'rationale'] }), true);
  assert.equal(matchesFilter(code, { type: ['history', 'rationale'] }), false);
});

test('dormancy contract: brain-index only builds rationale records behind the flag', () => {
  // Static seam check: every rationale entry point in the indexer is guarded by
  // rationaleEnabled(), so with the flag unset no rationale record is ever
  // constructed and the index output is byte-identical to before.
  const src = fs.readFileSync(path.join(HERE, '..', 'scripts', 'brain-index.mjs'), 'utf8');
  assert.match(src, /if \(rationaleEnabled\(\) && inferSourceKind\(file\) === 'code'\)/);
  const guardIdx = src.indexOf('if (rationaleEnabled()');
  const callIdx = src.indexOf('buildRationaleRecord(file'); // the call site, not the import
  assert.ok(guardIdx > -1 && callIdx > guardIdx, 'buildRationaleRecord call must sit inside the flag guard');
});
