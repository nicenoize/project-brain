import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, dispatchChunker } from '../scripts/chunk.mjs';

test('chunkMarkdown returns empty array on empty input', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('   \n  \n  '), []);
});

test('chunkMarkdown keeps short single-section text as one chunk', () => {
  const chunks = chunkMarkdown('## H\nshort body');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'H');
  assert.ok(chunks[0].text.includes('short body'));
});

test('chunkMarkdown splits long text within a section', () => {
  const big = '## H\n' + 'word '.repeat(2000);
  const chunks = chunkMarkdown(big, { maxChars: 500 });
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
});

test('dispatchChunker emits a summary plus content for markdown', async () => {
  const out = await dispatchChunker('docs/foo.md', '# Title\n## H\nbody text', {});
  assert.equal(out[0].chunk, -1);
  assert.equal(out[0].isSummary, true);
  assert.ok(out.length >= 2);
});

test('dispatchChunker handles code file with no symbols (no AST hit)', async () => {
  const out = await dispatchChunker('scripts/empty.mjs', '// just a comment\n', {});
  // Should still return summary plus at least one chunk wrapper.
  assert.equal(out[0].isSummary, true);
});
