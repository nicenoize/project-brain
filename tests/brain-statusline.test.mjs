import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { segment } from '../scripts/brain-statusline.mjs';

const usage = (n) => ({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: n - 1002 });

test('segment shows context used of the window, the compaction mark and the count', () => {
  const input = { context_window: { context_window_size: 1_000_000, current_usage: usage(412_000) } };
  assert.equal(segment(input, { window: 300000, compactions: 2 }), 'ctx 412k/1M (41%) · compacts at 300k · 2× compacted');
  assert.equal(segment(input), 'ctx 412k/1M (41%)');
});

test('segment degrades: no usage yet (fresh or just compacted), or nothing at all', () => {
  assert.equal(segment({ context_window: { context_window_size: 200000, current_usage: null, used_percentage: 12.4 } }), 'ctx 12%');
  assert.equal(segment({}), 'ctx —');
});

test('the script never fails: garbage in, empty line out, exit 0', () => {
  const script = fileURLToPath(new URL('../scripts/brain-statusline.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
