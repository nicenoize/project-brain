import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextualPrefix,
  situateEmbeddingText,
  contextualChunksEnabled,
  contextualProvider,
  repoLabel,
  MAX_PREFIX_CHARS
} from '../scripts/contextual.mjs';

test('buildContextualPrefix produces a compact bracketed, space-terminated prefix', () => {
  const prefix = buildContextualPrefix({
    file: 'scripts/retrieval.mjs',
    module: 'retrieval',
    type: 'code',
    heading: 'recordText',
    exportedSymbols: ['hybridScore']
  });
  assert.equal(prefix, '[project-brain · module: retrieval · code · scripts/retrieval.mjs · hybridScore] ');
  assert.ok(prefix.startsWith('['));
  assert.ok(prefix.endsWith('] '));
});

test('buildContextualPrefix prefers exported symbol over heading as anchor', () => {
  const prefix = buildContextualPrefix({
    file: 'a.mjs',
    module: 'm',
    heading: 'someHeading',
    exportedSymbols: ['theExport'],
    symbols: ['theSymbol']
  });
  assert.ok(prefix.includes('theExport'));
  assert.ok(!prefix.includes('someHeading'));
  assert.ok(!prefix.includes('theSymbol'));
});

test('buildContextualPrefix falls back to symbols, then heading', () => {
  const sym = buildContextualPrefix({ file: 'a.mjs', module: 'm', symbols: ['fromSymbols'] });
  assert.ok(sym.includes('fromSymbols'));
  const head = buildContextualPrefix({ file: 'a.mjs', module: 'm', heading: 'fromHeading' });
  assert.ok(head.includes('fromHeading'));
});

test('buildContextualPrefix uses feature when module is absent', () => {
  const prefix = buildContextualPrefix({ file: 'a.mjs', feature: 'auth' });
  assert.ok(prefix.includes('feature: auth'));
  assert.ok(!prefix.includes('module:'));
});

test('buildContextualPrefix returns empty string when nothing to situate', () => {
  assert.equal(buildContextualPrefix({}), '');
  assert.equal(buildContextualPrefix({ symbols: [], exportedSymbols: [] }), '');
  // A bare repo label with no other usable field is not worth situating.
  assert.equal(buildContextualPrefix({ heading: '   ' }), '');
});

test('buildContextualPrefix handles missing/empty fields gracefully', () => {
  const prefix = buildContextualPrefix({
    file: 'x.mjs',
    module: '',
    feature: undefined,
    type: null,
    heading: '',
    symbols: ['', '  ', 'realOne'],
    exportedSymbols: []
  });
  assert.ok(prefix.includes('x.mjs'));
  assert.ok(prefix.includes('realOne'));
});

test('buildContextualPrefix respects the length cap', () => {
  const longModule = 'm'.repeat(500);
  const prefix = buildContextualPrefix({ file: 'f.mjs', module: longModule });
  assert.ok(prefix.length <= MAX_PREFIX_CHARS, `prefix length ${prefix.length} > ${MAX_PREFIX_CHARS}`);
  assert.ok(prefix.startsWith('['));
  // A custom cap is honored too.
  const small = buildContextualPrefix({ file: 'f.mjs', module: longModule }, { maxChars: 40 });
  assert.ok(small.length <= 40, `prefix length ${small.length} > 40`);
});

test('buildContextualPrefix honors a custom repo label', () => {
  const prefix = buildContextualPrefix({ file: 'f.mjs', module: 'm' }, { repo: 'my-app' });
  assert.ok(prefix.startsWith('[my-app · '));
});

test('compact heading is truncated with an ellipsis', () => {
  const longHeading = 'H'.repeat(120);
  const prefix = buildContextualPrefix({ file: 'f.mjs', module: 'm', heading: longHeading });
  assert.ok(prefix.includes('…'));
});

test('contextualChunksEnabled is OFF unless BRAIN_CONTEXTUAL_CHUNKS=1', () => {
  assert.equal(contextualChunksEnabled({}), false);
  assert.equal(contextualChunksEnabled({ BRAIN_CONTEXTUAL_CHUNKS: '0' }), false);
  assert.equal(contextualChunksEnabled({ BRAIN_CONTEXTUAL_CHUNKS: 'true' }), false);
  assert.equal(contextualChunksEnabled({ BRAIN_CONTEXTUAL_CHUNKS: '1' }), true);
});

test('contextualProvider defaults to deterministic and reflects the reserved seam', () => {
  assert.equal(contextualProvider({}), 'deterministic');
  assert.equal(contextualProvider({ BRAIN_CONTEXTUAL_PROVIDER: '' }), 'deterministic');
  assert.equal(contextualProvider({ BRAIN_CONTEXTUAL_PROVIDER: 'anthropic' }), 'anthropic');
});

test('repoLabel uses project, else root basename, else default', () => {
  assert.equal(repoLabel({ project: 'svc-a' }, '/x/y/anything'), 'svc-a');
  assert.equal(repoLabel({}, '/x/y/my-repo'), 'my-repo');
  assert.equal(repoLabel({}, ''), 'project-brain');
});

test('situateEmbeddingText leaves embed input UNCHANGED when disabled', () => {
  const base = 'scripts/retrieval.mjs\nexport function hybridScore() {}';
  const out = situateEmbeddingText(base, { file: 'scripts/retrieval.mjs', module: 'retrieval' }, { enabled: false });
  assert.equal(out, base);
});

test('situateEmbeddingText defaults to env gate (OFF by default)', () => {
  const base = 'body';
  // No enabled override, empty env → unchanged.
  assert.equal(situateEmbeddingText(base, { file: 'a.mjs', module: 'm' }, { env: {} }), base);
  assert.equal(
    situateEmbeddingText(base, { file: 'a.mjs', module: 'm' }, { env: { BRAIN_CONTEXTUAL_CHUNKS: '1' } }).startsWith('['),
    true
  );
});

test('situateEmbeddingText augments embed input while the original stays recoverable', () => {
  // Simulate the index seam: the stored `text` is the original chunk; the embed
  // input is the situated text. They MUST differ, and the original is the suffix.
  const storedText = 'export function hybridScore() { /* ... */ }';
  const base = `scripts/retrieval.mjs\n${storedText}`;
  const embedInput = situateEmbeddingText(base, {
    file: 'scripts/retrieval.mjs',
    module: 'retrieval',
    type: 'code',
    exportedSymbols: ['hybridScore']
  }, { enabled: true });

  // Embed input differs from the base (and therefore from stored text).
  assert.notEqual(embedInput, base);
  assert.notEqual(embedInput, storedText);
  // Stored text is untouched and still embedded verbatim inside the embed input.
  assert.ok(embedInput.includes(storedText), 'situated embed input must contain the original chunk body');
  assert.ok(embedInput.startsWith('[project-brain · '), 'situated embed input is prefixed');
});

test('situateEmbeddingText returns base unchanged when prefix is empty even if enabled', () => {
  const base = 'body with no situating metadata';
  // No file/module/feature/type/symbol/heading → empty prefix → no-op.
  assert.equal(situateEmbeddingText(base, {}, { enabled: true }), base);
});
