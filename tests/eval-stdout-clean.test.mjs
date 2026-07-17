/**
 * Guards issue #37: `brain:eval` must keep stdout pure JSON so
 * `node scripts/brain-eval.mjs --hard-only > r.json` is directly valid and
 * pipeable into `brain:eval:compare`. The store/model preamble
 * ("Project Brain store: …", "Loading local embedding model: …") belongs on
 * STDERR, never stdout.
 *
 * These are cheap, deterministic checks — they never load the embedding model
 * or a real index (that is the heavy eval path). One live check exercises the
 * cheap JSON store banner; the rest are source-level regression guards that
 * pin the exact console channel each preamble line uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore } from '../scripts/store.mjs';

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

async function captureConsole(fn) {
  const logs = [];
  const errs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => errs.push(a.map(String).join(' '));
  console.warn = (...a) => errs.push(a.map(String).join(' '));
  try {
    const result = await fn();
    return { result, logs, errs };
  } finally {
    Object.assign(console, orig);
  }
}

test('openStore emits its backend banner to stderr, never stdout', async () => {
  // Missing path → readRecords() returns [] with no disk work; the JSON backend
  // needs no model, so this stays cheap and deterministic.
  const missing = path.join(os.tmpdir(), `brain-eval-stdout-${process.pid}-${Date.now()}.json`);
  const { result: store, logs, errs } = await captureConsole(() =>
    openStore({ backend: 'json', path: missing }));
  await store.close();
  // Nothing may reach stdout: the eval report is the only thing on stdout, so
  // the first byte a redirect sees is '{'.
  assert.deepEqual(logs, [], `store preamble leaked to stdout: ${logs.join(' | ')}`);
  assert.ok(
    errs.some(line => line.includes('Project Brain store: json')),
    `expected the store banner on stderr, got: ${errs.join(' | ')}`
  );
});

test('store/embed preamble lines route to stderr in source (regression guard)', () => {
  const store = fs.readFileSync(path.join(scriptsDir, 'store.mjs'), 'utf8');
  const embed = fs.readFileSync(path.join(scriptsDir, 'embed.mjs'), 'utf8');
  // No console.log may carry a banner — console.log is stdout.
  assert.ok(
    !/console\.log\([^\n]*Project Brain store:/.test(store),
    'store banner must not use console.log (that would corrupt stdout JSON)'
  );
  assert.ok(
    !/console\.log\([^\n]*Loading local embedding model:/.test(embed),
    'model-load banner must not use console.log (that would corrupt stdout JSON)'
  );
  // …and they must still be emitted, just on stderr.
  assert.ok(/console\.error\([^\n]*Project Brain store:/.test(store));
  assert.ok(/console\.error\(`Loading local embedding model:/.test(embed));
});

test('brain-eval writes only JSON.stringify to stdout (first byte is "{")', () => {
  const src = fs.readFileSync(path.join(scriptsDir, 'brain-eval.mjs'), 'utf8');
  const logCalls = src.match(/console\.log\([^\n]*/g) || [];
  assert.ok(logCalls.length > 0, 'expected the eval report to be printed via console.log');
  for (const call of logCalls) {
    assert.ok(
      call.includes('JSON.stringify'),
      `brain-eval stdout must be pure JSON; offending console.log: ${call}`
    );
  }
});
