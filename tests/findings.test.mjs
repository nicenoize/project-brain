import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeFinding, parseFinding, serializePlan, parsePlan } from '../scripts/findings.mjs';
import { inferType } from '../scripts/infer.mjs';

// ---------------------------------------------------------------------------
// finding (de)serialization
// ---------------------------------------------------------------------------

test('finding roundtrip preserves every field', () => {
  const rec = {
    title: 'Hybrid score clamps too aggressively',
    category: 'performance', status: 'open', impact: 4,
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z',
    actor: 'tester', module: 'scripts/retrieval',
    symbols: ['hybridScore', 'tfidfScore'],
    sources: [{ path: 'scripts/retrieval.mjs', sha256: 'a'.repeat(64) }, { path: 'gone.mjs', sha256: null }],
    body: '## Evidence\nLine 200 clamps.\n'
  };
  const md = serializeFinding(rec);
  assert.match(md, /^type: finding$/m);

  const back = parseFinding(md);
  assert.equal(back.title, rec.title);
  assert.equal(back.category, 'performance');
  assert.equal(back.status, 'open');
  assert.equal(back.impact, 4);
  assert.equal(back.module, 'scripts/retrieval');
  assert.deepEqual(back.symbols, ['hybridScore', 'tfidfScore']);
  assert.equal(back.sources.length, 2);
  assert.equal(back.sources[0].path, 'scripts/retrieval.mjs');
  assert.equal(back.sources[0].sha256, 'a'.repeat(64));
  assert.equal(back.sources[1].sha256, null);
  assert.match(back.body, /Line 200 clamps/);
});

test('finding handles empty symbols and sources', () => {
  const md = serializeFinding({
    title: 'x', category: 'tech-debt', status: 'open', impact: 0,
    created: 'c', updated: 'u', actor: '', module: '', symbols: [], sources: [], body: ''
  });
  const back = parseFinding(md);
  assert.deepEqual(back.symbols, []);
  assert.deepEqual(back.sources, []);
  assert.equal(back.impact, 0);
});

test('finding title with separators and quotes survives quoting', () => {
  const title = 'Why: a, b — "c"?';
  const md = serializeFinding({
    title, category: 'dx', status: 'wontfix', impact: 1,
    created: 'c', updated: 'u', actor: '', module: '', symbols: [], sources: [], body: 'b'
  });
  const back = parseFinding(md);
  assert.equal(back.title, title);
  assert.equal(back.status, 'wontfix');
});

// ---------------------------------------------------------------------------
// improve-plan (de)serialization
// ---------------------------------------------------------------------------

test('improve-plan roundtrip', () => {
  const md = serializePlan({
    title: 'Fix X', finding: 'fix-x', category: 'correctness', status: 'draft',
    created: 'c', updated: 'u', actor: 'a', module: 'lib/x', body: '# plan\n'
  });
  assert.match(md, /^type: improve-plan$/m);
  const back = parsePlan(md);
  assert.equal(back.title, 'Fix X');
  assert.equal(back.finding, 'fix-x');
  assert.equal(back.category, 'correctness');
  assert.equal(back.module, 'lib/x');
});

// ---------------------------------------------------------------------------
// type registration (collision-safety with spec-kit 'plan')
// ---------------------------------------------------------------------------

test('inferType registers finding/improve-plan without breaking spec-kit plan', () => {
  assert.equal(inferType('.project-brain/findings/some-bug.md'), 'finding');
  assert.equal(inferType('.project-brain/plans/improve-some-bug.md'), 'improve-plan');
  // spec-kit plan.md must still resolve to 'plan' (its rule is anchored and runs first).
  assert.equal(inferType('specs/123-feature/plan.md'), 'plan');
});
