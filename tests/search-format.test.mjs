import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hitFlags, scoringLine, terseHitLine, verboseHitHeader } from '../scripts/search-format.mjs';

const HIT = {
  file: 'scripts/brain-sync.mjs', chunk: 3, type: 'code',
  heading: 'flushPending  handler', title: 'brain-sync',
  score: 0.87654, denseScore: 0.512, keywordScore: 0.34, symbolScore: 0.9, metadataScore: 0.1
};

test('hitFlags: joins type + summary markers, drops falsy', () => {
  assert.equal(hitFlags(HIT), 'code');
  assert.equal(hitFlags({ type: 'doc', isModuleSummary: true, isSummary: true }), 'doc,module-summary,summary');
});

test('terseHitLine: one line, score file#chunk [type] heading, no body/diagnostics', () => {
  const line = terseHitLine(HIT);
  assert.equal(line, '0.8765 scripts/brain-sync.mjs#chunk-3 [code] flushPending handler');
  assert.doesNotMatch(line, /dense=|keyword=|symbol=|metadata=/);
  assert.ok(!line.includes('\n'));
});

test('terseHitLine: falls back to title when heading missing; tolerates none', () => {
  assert.match(terseHitLine({ ...HIT, heading: '' }), /\[code\] brain-sync$/);
  assert.equal(terseHitLine({ file: 'a.ts', chunk: 0, type: 'code', score: 1 }), '1.0000 a.ts#chunk-0 [code]');
});

test('scoringLine: renders the dense/keyword/symbol/metadata diagnostics', () => {
  assert.equal(scoringLine(HIT), 'dense=0.512 keyword=0.340 symbol=0.900 metadata=0.100');
});

test('verboseHitHeader: default omits diagnostics; --explain includes them', () => {
  const plain = verboseHitHeader(HIT);
  assert.equal(plain, '--- 0.8765 scripts/brain-sync.mjs#chunk-3 [code]');
  assert.doesNotMatch(plain, /dense=/);
  const explained = verboseHitHeader(HIT, { explain: true });
  assert.match(explained, /dense=0\.512 keyword=0\.340 symbol=0\.900 metadata=0\.100$/);
});
