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

test('queries are unique (pairing key for brain:eval:compare)', () => {
  const cases = loadCases();
  const seen = new Set();
  const dupes = [];
  for (const item of cases) {
    if (seen.has(item.query)) dupes.push(item.query);
    seen.add(item.query);
  }
  assert.deepEqual(dupes, [], `duplicate queries break run pairing: ${dupes.join(' | ')}`);
});

test('hard subset (note starting with "Hard:") has at least 80 cases', () => {
  const cases = loadCases();
  const hard = cases.filter(item => /^hard:/i.test(String(item.note || '').trim()));
  assert.ok(hard.length >= 80, `expected >= 80 hard cases, found ${hard.length}`);
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
