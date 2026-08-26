/**
 * M2: optional embedding index — index-provider seam tests.
 *
 * (a) unit: provider selection honors BRAIN_INDEX_PROVIDER=none, and the
 *     lexical (pure BM25 over the JSON mirror) fallback ranks real matches /
 *     returns a clearly-marked empty result when no mirror exists.
 * (b) subprocess, fixture repo, BRAIN_INDEX_PROVIDER=none: brain-search exits
 *     0 with the degradation warning (never a stack trace); brain-sync exits
 *     0 with a skip warning.
 * (c) builtin is still selected in this repo (node_modules contains
 *     @xenova/transformers), so the semantic path has no regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getIndexProvider,
  lexicalSearch,
  LEXICAL_FALLBACK_WARNING,
  NO_RESULTS_WARNING
} from '../scripts/index-provider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const SEARCH_SCRIPT = path.join(scriptsDir, 'brain-search.mjs');
const SYNC_SCRIPT = path.join(scriptsDir, 'brain-sync.mjs');

function withEnv(overrides, fn) {
  const keys = ['BRAIN_INDEX_PROVIDER', 'BRAIN_EMBED_PROVIDER', 'OPENAI_API_KEY'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function mirrorRecord(id, file, text, extra = {}) {
  return { id, file, chunk: 0, title: path.basename(file), type: 'doc', text, vector: [], ...extra };
}

function writeMirror(dir, records) {
  const mirror = path.join(dir, '.project-brain', 'search_index.json');
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(mirror, JSON.stringify({ version: 2, backend: 'json', model: 'Xenova/all-MiniLM-L6-v2', records }, null, 2));
  return mirror;
}

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-index-provider-'));
  writeMirror(dir, [
    mirrorRecord('r1', 'docs/auth.md', 'authentication flow uses refresh tokens and session cookies'),
    mirrorRecord('r2', 'docs/billing.md', 'billing invoices are generated monthly by the cron worker')
  ]);
  // index_manifest.json so brain-search's "no index" guard passes.
  fs.writeFileSync(
    path.join(dir, '.project-brain', 'index_manifest.json'),
    JSON.stringify({ version: 2, model: 'Xenova/all-MiniLM-L6-v2', dims: 384, files: {} }, null, 2)
  );
  return dir;
}

function runScript(script, args, cwd, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_ROOT: cwd, BRAIN_INDEX_PROVIDER: 'none', ...env }
  });
}

// ---------------------------------------------------------------------------
// (a) unit: selection + lexical fallback
// ---------------------------------------------------------------------------

test('BRAIN_INDEX_PROVIDER=none selects the none provider', async () => {
  await withEnv({ BRAIN_INDEX_PROVIDER: 'none' }, async () => {
    const provider = await getIndexProvider();
    assert.equal(provider.name, 'none');
    assert.equal(provider.available(), false);
    assert.equal(provider.reason, 'BRAIN_INDEX_PROVIDER=none');
    assert.equal(provider.warning, LEXICAL_FALLBACK_WARNING);
  });
});

test('none provider ensureIndex skips with warning instead of indexing', async () => {
  await withEnv({ BRAIN_INDEX_PROVIDER: 'none' }, async () => {
    const provider = await getIndexProvider();
    const out = await provider.ensureIndex({ force: true });
    assert.equal(out.ok, false);
    assert.equal(out.skipped, true);
    assert.equal(out.warning, LEXICAL_FALLBACK_WARNING);
  });
});

test('lexicalSearch is a real BM25 search over the JSON mirror (not empty-with-reason)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lexical-'));
  const jsonPath = writeMirror(dir, [
    mirrorRecord('a', 'docs/auth.md', 'authentication flow uses refresh tokens and session cookies'),
    mirrorRecord('b', 'docs/billing.md', 'billing invoices are generated monthly by the cron worker')
  ]);
  const { results, warning } = await lexicalSearch('refresh tokens authentication', { jsonPath, topK: 5 });
  assert.equal(warning, LEXICAL_FALLBACK_WARNING);
  assert.ok(results.length >= 1, 'expected at least one lexical hit');
  assert.equal(results[0].file, 'docs/auth.md');
  // Result shape mirrors retrieve(): dense/symbol/metadata zeroed, BM25 carried.
  assert.equal(results[0].denseScore, 0);
  assert.ok(results[0].keywordScore > 0);
  assert.equal(results[0].score, results[0].keywordScore);
  // The non-matching record must not outrank; zero-score records are dropped.
  assert.ok(!results.some(r => r.file === 'docs/billing.md' && r.score >= results[0].score));
});

test('lexicalSearch honors filters via matchesFilter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lexical-filter-'));
  const jsonPath = writeMirror(dir, [
    mirrorRecord('a', 'docs/auth.md', 'authentication tokens', { type: 'doc' }),
    mirrorRecord('b', 'src/auth.mjs', 'authentication tokens in code', { type: 'code' })
  ]);
  const { results } = await lexicalSearch('authentication tokens', { jsonPath, filter: { type: 'code' } });
  assert.ok(results.length >= 1);
  assert.ok(results.every(r => r.type === 'code'));
});

test('lexicalSearch with no mirror returns clearly-marked empty result', async () => {
  const jsonPath = path.join(os.tmpdir(), `brain-missing-${process.pid}-${Date.now()}.json`);
  const { results, warning } = await lexicalSearch('anything', { jsonPath });
  assert.deepEqual(results, []);
  assert.equal(warning, NO_RESULTS_WARNING);
});

// ---------------------------------------------------------------------------
// (b) subprocess: absence never crashes the CLI surface
// ---------------------------------------------------------------------------

test('brain-search with BRAIN_INDEX_PROVIDER=none exits 0 with warning, no stack trace', () => {
  const cwd = makeFixtureRepo();
  const out = runScript(SEARCH_SCRIPT, ['refresh', 'tokens', 'authentication'], cwd);
  assert.equal(out.status, 0, `stderr: ${out.stderr}\nstdout: ${out.stdout}`);
  assert.ok(out.stderr.includes(LEXICAL_FALLBACK_WARNING), `expected warning on stderr, got: ${out.stderr}`);
  assert.ok(out.stdout.includes('docs/auth.md'), `expected lexical hit on stdout, got: ${out.stdout}`);
  assert.ok(!/\n\s+at /.test(out.stderr), `stack trace leaked to stderr: ${out.stderr}`);
});

test('brain-search --json with provider none carries warning + results in JSON', () => {
  const cwd = makeFixtureRepo();
  const out = runScript(SEARCH_SCRIPT, ['--json', 'refresh', 'tokens', 'authentication'], cwd);
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.warning, LEXICAL_FALLBACK_WARNING);
  assert.equal(parsed.provider, 'none');
  assert.ok(parsed.results.some(r => r.file === 'docs/auth.md'));
});

test('brain-sync with BRAIN_INDEX_PROVIDER=none exits 0 with skip warning', () => {
  const cwd = makeFixtureRepo();
  const out = runScript(SYNC_SCRIPT, [], cwd);
  assert.equal(out.status, 0, `stderr: ${out.stderr}\nstdout: ${out.stdout}`);
  const combined = `${out.stdout}\n${out.stderr}`;
  assert.ok(/Project Brain sync: skipped/.test(combined), `expected skip warning, got: ${combined}`);
  assert.ok(!/\n\s+at /.test(out.stderr), `stack trace leaked to stderr: ${out.stderr}`);
});

test('brain-index with BRAIN_INDEX_PROVIDER=none exits 0 with skip warning', () => {
  const cwd = makeFixtureRepo();
  const out = runScript(path.join(scriptsDir, 'brain-index.mjs'), [], cwd);
  assert.equal(out.status, 0, `stderr: ${out.stderr}\nstdout: ${out.stdout}`);
  const combined = `${out.stdout}\n${out.stderr}`;
  assert.ok(/Project Brain index: skipped/.test(combined), `expected skip warning, got: ${combined}`);
});

// ---------------------------------------------------------------------------
// (c) builtin still selected when the embedder is importable (this repo)
// ---------------------------------------------------------------------------

test('builtin provider selected when @xenova/transformers is resolvable', async () => {
  await withEnv({}, async () => {
    const provider = await getIndexProvider();
    assert.equal(provider.name, 'builtin');
    assert.equal(provider.available(), true);
    assert.equal(provider.modelName, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(provider.dims, 384);
  });
});
