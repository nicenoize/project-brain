import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchChunker } from '../scripts/chunk.mjs';

const PY = `import os
from billing import charge

DEFAULT_RATE = 0.05

def compute_total(items):
    return charge(sum(i.price for i in items), DEFAULT_RATE)

class InvoiceBuilder:
    def build(self):
        return compute_total(self.items)
`;

const GO = `package billing

import "fmt"

func Charge(amount float64) float64 {
	fmt.Println(amount)
	return amount
}
`;

test('dispatchChunker: .py with BRAIN_POLYGLOT_SYMBOLS=1 produces code chunks carrying symbols/references', async () => {
  const prev = process.env.BRAIN_POLYGLOT_SYMBOLS;
  process.env.BRAIN_POLYGLOT_SYMBOLS = '1';
  try {
    const out = await dispatchChunker('app/models.py', PY, {});
    // [0] is the chunk:-1 summary, the rest are content chunks.
    const content = out.filter(c => c.chunk >= 0);
    assert.ok(content.length >= 1, 'expected at least one content chunk');
    const flatSymbols = content.flatMap(c => c.symbols || []);
    assert.ok(flatSymbols.includes('compute_total'), 'compute_total should be a symbol');
    assert.ok(flatSymbols.includes('InvoiceBuilder'), 'InvoiceBuilder should be a symbol');
    const flatExported = content.flatMap(c => c.exportedSymbols || []);
    assert.ok(flatExported.includes('compute_total'));
    const flatRefs = content.flatMap(c => c.references || []);
    assert.ok(flatRefs.includes('charge'), 'external call charge should be a reference');
    // Summary record advertises symbols too (feeds dense recall).
    assert.ok((out[0].symbols || []).includes('compute_total'));
  } finally {
    if (prev === undefined) delete process.env.BRAIN_POLYGLOT_SYMBOLS;
    else process.env.BRAIN_POLYGLOT_SYMBOLS = prev;
  }
});

test('dispatchChunker: .go with flag on produces code chunks with symbols', async () => {
  const prev = process.env.BRAIN_POLYGLOT_SYMBOLS;
  process.env.BRAIN_POLYGLOT_SYMBOLS = '1';
  try {
    const out = await dispatchChunker('pkg/billing.go', GO, {});
    const content = out.filter(c => c.chunk >= 0);
    const flatSymbols = content.flatMap(c => c.symbols || []);
    assert.ok(flatSymbols.includes('Charge'), 'Charge should be a symbol');
    assert.ok(content.flatMap(c => c.exportedSymbols || []).includes('Charge'));
  } finally {
    if (prev === undefined) delete process.env.BRAIN_POLYGLOT_SYMBOLS;
    else process.env.BRAIN_POLYGLOT_SYMBOLS = prev;
  }
});

test('dispatchChunker: .py with flag UNSET adds no symbols (markdown fallback, unchanged behavior)', async () => {
  const prev = process.env.BRAIN_POLYGLOT_SYMBOLS;
  delete process.env.BRAIN_POLYGLOT_SYMBOLS;
  try {
    const out = await dispatchChunker('app/models.py', PY, {});
    const content = out.filter(c => c.chunk >= 0);
    const flatSymbols = content.flatMap(c => c.symbols || []);
    assert.equal(flatSymbols.length, 0, 'no symbols when flag is unset');
    // Summary is the plain markdown summary (no Exports/symbols line, no code symbols).
    assert.deepEqual(out[0].symbols, undefined);
  } finally {
    if (prev !== undefined) process.env.BRAIN_POLYGLOT_SYMBOLS = prev;
  }
});
