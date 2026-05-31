import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDocSymbols,
  liveSymbolSet,
  findSymbolDrift,
  findStaleSummaries,
  runVerify
} from '../scripts/brain-verify.mjs';

test('extractDocSymbols picks code-ish backticked tokens, skips prose/paths/env', () => {
  const text = 'We call `acquireLease()` and `withStateLock`, see `lib/db/events.ts`. ' +
    'Plain `lease` and `the cat` and `BRAIN_TASK` are not symbols.';
  const out = extractDocSymbols(text);
  assert.ok(out.includes('acquireLease'), 'call form captured');
  assert.ok(out.includes('withStateLock'), 'camelCase captured');
  assert.ok(!out.includes('lib/db/events.ts'), 'paths excluded (link-check owns these)');
  assert.ok(!out.includes('lease'), 'bare lowercase word excluded');
  assert.ok(!out.includes('BRAIN_TASK'), 'ALL_CAPS env var excluded');
  assert.ok(!out.some((t) => t.includes(' ')), 'multi-word spans excluded');
});

test('liveSymbolSet collects declared and exported code symbols only', () => {
  const records = [
    { type: 'code', symbols: ['acquireLease'], exportedSymbols: ['withStateLock'] },
    { type: 'decision', symbols: ['ShouldBeIgnored'] }
  ];
  const live = liveSymbolSet(records);
  assert.ok(live.has('acquirelease'));
  assert.ok(live.has('withstatelock'));
  assert.ok(!live.has('shouldbeignored'), 'non-code records do not contribute live symbols');
});

test('findSymbolDrift flags a renamed symbol still named in an ADR', () => {
  const records = [
    { type: 'code', file: 'scripts/lease.mjs', symbols: ['acquireLease'], exportedSymbols: [] },
    {
      type: 'decision',
      file: '.project-brain/decisions/0006-orchestrator-slot-lease.md',
      isSummary: false,
      text: 'The orchestrator uses `acquireSlot()` to claim work.' // renamed away
    }
  ];
  const findings = findSymbolDrift(records);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'symbol-drift');
  assert.equal(findings[0].symbol, 'acquireSlot');
});

test('findSymbolDrift does not flag a symbol that still exists', () => {
  const records = [
    { type: 'code', file: 'scripts/lease.mjs', symbols: ['acquireLease'] },
    { type: 'decision', file: '.project-brain/decisions/0006.md', text: 'We call `acquireLease()`.' }
  ];
  assert.equal(findSymbolDrift(records).length, 0);
});

test('findSymbolDrift auto-skips when no code symbols are indexed (non-JS repo)', () => {
  const records = [
    { type: 'decision', file: '.project-brain/decisions/0001.md', text: 'Uses `SomeGoStruct`.' }
  ];
  assert.equal(findSymbolDrift(records).length, 0, 'no baseline → no false positives');
});

test('findStaleSummaries flags a module summary behind its newest code', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const day = 86400000;
  const records = [
    { type: 'module-summary', file: '.project-brain/modules/lease.md', module: 'lease', mtime: new Date(now - 40 * day).toISOString() },
    { type: 'code', file: 'scripts/lease.mjs', module: 'lease', mtime: new Date(now - 2 * day).toISOString() }
  ];
  const findings = findStaleSummaries(records, { staleDays: 14, now });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'stale-summary');
  assert.equal(findings[0].key, 'lease');
  assert.ok(findings[0].lagDays > 14);
});

test('findStaleSummaries respects the staleDays threshold', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const day = 86400000;
  const records = [
    { type: 'module-summary', file: '.project-brain/modules/lease.md', module: 'lease', mtime: new Date(now - 10 * day).toISOString() },
    { type: 'code', file: 'scripts/lease.mjs', module: 'lease', mtime: new Date(now - 2 * day).toISOString() }
  ];
  assert.equal(findStaleSummaries(records, { staleDays: 14, now }).length, 0, '8d lag is under 14d threshold');
});

test('runVerify aggregates both signals and reports clean state', () => {
  const clean = runVerify([
    { type: 'code', file: 'a.mjs', symbols: ['Foo'], mtime: '2026-06-01T00:00:00Z' }
  ], { staleDays: 14, now: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(clean.ok, true);
  assert.equal(clean.counts.total, 0);

  const dirty = runVerify([
    { type: 'code', file: 'a.mjs', symbols: ['Foo'], module: 'm', mtime: '2026-06-01T00:00:00Z' },
    { type: 'module-summary', file: '.project-brain/modules/m.md', module: 'm', mtime: '2026-01-01T00:00:00Z' },
    { type: 'decision', file: '.project-brain/decisions/0001.md', text: 'Calls `GoneSymbol()`.' }
  ], { staleDays: 14, now: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.counts.staleSummary, 1);
  assert.equal(dirty.counts.symbolDrift, 1);
  assert.equal(dirty.symbolDriftChecked, true);
});

test('runVerify honors symbolDrift:false', () => {
  const report = runVerify([
    { type: 'code', file: 'a.mjs', symbols: ['Foo'] },
    { type: 'decision', file: '.project-brain/decisions/0001.md', text: 'Calls `GoneSymbol()`.' }
  ], { symbolDrift: false });
  assert.equal(report.counts.symbolDrift, 0);
});
