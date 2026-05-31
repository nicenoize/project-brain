import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLiteSymbols, extractPython, extractGo, isLiteCodeExt } from '../scripts/lang-symbols.mjs';

// ---------- Python ----------

const PY = `
import os
from billing import charge

DEFAULT_RATE = 0.05
_private_cache = {}

def compute_total(items):
    subtotal = sum(i.price for i in items)
    return charge(subtotal, DEFAULT_RATE)

async def fetch_user(uid):
    return await db.get(uid)

class InvoiceBuilder:
    def build(self):
        return compute_total(self.items)

def _helper():
    pass
`;

test('extractPython: def/class/module-assign become symbols', () => {
  const { symbols } = extractPython(PY);
  for (const name of ['compute_total', 'fetch_user', 'InvoiceBuilder', 'DEFAULT_RATE', '_private_cache', '_helper']) {
    assert.ok(symbols.includes(name), `expected symbol ${name} in ${symbols.join(', ')}`);
  }
});

test('extractPython: exported excludes leading-underscore names', () => {
  const { exportedSymbols } = extractPython(PY);
  assert.ok(exportedSymbols.includes('compute_total'));
  assert.ok(exportedSymbols.includes('InvoiceBuilder'));
  assert.ok(exportedSymbols.includes('DEFAULT_RATE'));
  assert.ok(!exportedSymbols.includes('_private_cache'), 'private name should not be exported');
  assert.ok(!exportedSymbols.includes('_helper'), 'private fn should not be exported');
});

test('extractPython: references capture called/attribute identifiers, skip builtins', () => {
  const { references } = extractPython(PY);
  assert.ok(references.includes('charge'), 'imported call charge() should be a reference');
  assert.ok(references.includes('db'), 'attribute root db should be a reference');
  // builtins filtered
  assert.ok(!references.includes('sum'), 'builtin sum should be filtered');
});

test('extractLiteSymbols: references are disjoint from local definitions', () => {
  // The disjoint-from-locals guarantee is applied by extractLiteSymbols (finalize),
  // not by the raw per-language extractor. compute_total is defined locally AND
  // called locally, so it must not appear as a self-reference on the record.
  const { references, symbols } = extractLiteSymbols('app/models.py', PY);
  assert.ok(symbols.includes('compute_total'));
  assert.ok(!references.includes('compute_total'), 'local def should not be a self-reference');
  assert.ok(references.includes('charge'), 'external call still referenced');
});

// ---------- Go ----------

const GO = `
package billing

import "fmt"

const DefaultRate = 0.05

var (
	GlobalCache map[string]int
	internalSeq int
)

type Invoice struct {
	Total float64
}

func (i *Invoice) Compute(items []Item) float64 {
	return Charge(i.Total, DefaultRate)
}

func Charge(amount float64, rate float64) float64 {
	fmt.Println(amount)
	return amount * rate
}

func helper() int {
	return 1
}
`;

test('extractGo: func/method/type/var/const become symbols', () => {
  const { symbols } = extractGo(GO);
  for (const name of ['DefaultRate', 'GlobalCache', 'internalSeq', 'Invoice', 'Compute', 'Charge', 'helper']) {
    assert.ok(symbols.includes(name), `expected symbol ${name} in ${symbols.join(', ')}`);
  }
});

test('extractGo: exported == capitalized', () => {
  const { exportedSymbols } = extractGo(GO);
  assert.ok(exportedSymbols.includes('Charge'));
  assert.ok(exportedSymbols.includes('Invoice'));
  assert.ok(exportedSymbols.includes('Compute'));
  assert.ok(exportedSymbols.includes('DefaultRate'));
  assert.ok(exportedSymbols.includes('GlobalCache'));
  assert.ok(!exportedSymbols.includes('helper'), 'lowercase func is unexported');
  assert.ok(!exportedSymbols.includes('internalSeq'), 'lowercase var is unexported');
});

test('extractGo: references capture call sites, skip keywords/builtins', () => {
  const { references } = extractGo(GO);
  assert.ok(references.includes('fmt'), 'package root fmt should be referenced');
  assert.ok(!references.includes('return'), 'keyword return should be filtered');
  assert.ok(!references.includes('Println') || references.includes('fmt'), 'selector handled');
});

// ---------- dispatch / fallback ----------

test('extractLiteSymbols dispatches by extension', () => {
  const py = extractLiteSymbols('app/models.py', PY);
  assert.ok(py.symbols.includes('compute_total'));
  const go = extractLiteSymbols('pkg/billing.go', GO);
  assert.ok(go.symbols.includes('Charge'));
});

test('extractLiteSymbols returns empty arrays for unknown extensions', () => {
  for (const f of ['README.md', 'foo.rb', 'bar.rs', 'baz', 'x.txt']) {
    const out = extractLiteSymbols(f, 'def whatever(): pass\nfunc Whatever() {}');
    assert.deepEqual(out, { symbols: [], exportedSymbols: [], references: [] }, `expected empty for ${f}`);
  }
});

test('isLiteCodeExt recognizes .py/.go only', () => {
  assert.equal(isLiteCodeExt('.py'), true);
  assert.equal(isLiteCodeExt('.go'), true);
  assert.equal(isLiteCodeExt('.ts'), false);
  assert.equal(isLiteCodeExt('.rb'), false);
});
