import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferType, inferSourceKind } from '../scripts/infer.mjs';

function withFlag(value, fn) {
  const prev = process.env.BRAIN_POLYGLOT_SYMBOLS;
  if (value === undefined) delete process.env.BRAIN_POLYGLOT_SYMBOLS;
  else process.env.BRAIN_POLYGLOT_SYMBOLS = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.BRAIN_POLYGLOT_SYMBOLS;
    else process.env.BRAIN_POLYGLOT_SYMBOLS = prev;
  }
}

test('inferType: .py/.go → code only when BRAIN_POLYGLOT_SYMBOLS=1', () => {
  withFlag('1', () => {
    assert.equal(inferType('app/models.py'), 'code');
    assert.equal(inferType('pkg/billing.go'), 'code');
  });
  withFlag(undefined, () => {
    // Default-off: unchanged taxonomy (these never reach indexing anyway).
    assert.equal(inferType('app/models.py'), 'doc');
    assert.equal(inferType('pkg/billing.go'), 'doc');
  });
});

test('inferSourceKind: .py/.go → code only when flag set', () => {
  withFlag('1', () => {
    assert.equal(inferSourceKind('app/models.py'), 'code');
    assert.equal(inferSourceKind('pkg/billing.go'), 'code');
  });
  withFlag(undefined, () => {
    assert.equal(inferSourceKind('app/models.py'), 'other');
    assert.equal(inferSourceKind('pkg/billing.go'), 'other');
  });
});

test('inferType: existing TS/JS taxonomy unchanged regardless of flag', () => {
  for (const flag of ['1', undefined]) {
    withFlag(flag, () => {
      assert.equal(inferType('scripts/retrieval.mjs'), 'code');
      assert.equal(inferType('README.md'), 'doc');
    });
  }
});
