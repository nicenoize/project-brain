import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_PATH = path.join(ROOT, '.project-brain', 'eval.json');

function loadCases() {
  return JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
}

test('eval.json parses as a JSON array', () => {
  const cases = loadCases();
  assert.ok(Array.isArray(cases), 'eval.json must be a JSON array');
});

test('eval.json has at least 50 cases', () => {
  const cases = loadCases();
  assert.ok(cases.length >= 50, `expected >= 50 cases, found ${cases.length}`);
});

test('every expectedFiles path exists in the repo', () => {
  const cases = loadCases();
  const missing = [];
  for (const item of cases) {
    for (const rel of item.expectedFiles || []) {
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], `missing expectedFiles paths: ${missing.join(', ')}`);
});
