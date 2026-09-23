import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTsSemanticContext } from '../scripts/ts-graph.mjs';

test('loadTsSemanticContext: analyses a file on first ask, once, and only files in the program', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ts-lazy-'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha(n: number): number { return n + 1; }\n');
  fs.writeFileSync(path.join(root, 'b.ts'), "import { alpha } from './a';\nexport const beta = () => alpha(1);\n");
  const ctx = await loadTsSemanticContext(root, new Set(['a.ts', 'b.ts', 'notes.md']));
  if (!ctx) { t.skip('typescript not installed (optional dependency)'); return; }

  const b1 = ctx.get('b.ts');
  assert.ok(b1, 'a file in the program gets an analysis');
  assert.equal(ctx.get('b.ts'), b1, 'the second ask returns the cached analysis');
  assert.equal(ctx.get('notes.md'), null, 'not in the program → null');
  assert.equal(ctx.get('missing.ts'), null);
  assert.ok(JSON.stringify(b1).includes('alpha'), 'the analysis sees the cross-file reference');
});
