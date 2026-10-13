import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalProvider, openEmbedder, DEFAULT_LOCAL_EMBED_MODEL, DEFAULT_LOCAL_EMBED_DIMS, DEFAULT_EMBED_THREADS, embedThreads, limitOnnxThreads } from '../scripts/embed.mjs';

// These tests exercise only the model/dims config getters — they never call
// .embed()/.load(), so no transformers.js model is downloaded or loaded.

function withEnv(overrides, fn) {
  const keys = ['BRAIN_LOCAL_EMBED_MODEL', 'BRAIN_LOCAL_EMBED_DIMS', 'BRAIN_EMBED_PROVIDER'];
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

test('LocalProvider defaults to all-MiniLM-L6-v2 / 384 dims when envs unset', () => {
  withEnv({}, () => {
    const p = new LocalProvider();
    assert.equal(p.modelName, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(p.dims, 384);
    // Guard the exported constants too.
    assert.equal(DEFAULT_LOCAL_EMBED_MODEL, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(DEFAULT_LOCAL_EMBED_DIMS, 384);
  });
});

test('openEmbedder() (default provider=local) reports default model + dims', () => {
  withEnv({}, () => {
    const e = openEmbedder();
    assert.equal(e.modelName, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(e.dims, 384);
  });
});

test('LocalProvider honors BRAIN_LOCAL_EMBED_MODEL / BRAIN_LOCAL_EMBED_DIMS overrides', () => {
  withEnv({ BRAIN_LOCAL_EMBED_MODEL: 'Xenova/some-other-model', BRAIN_LOCAL_EMBED_DIMS: '768' }, () => {
    const p = new LocalProvider();
    assert.equal(p.modelName, 'Xenova/some-other-model');
    assert.equal(p.dims, 768);
  });
});

test('openEmbedder() picks up local model/dims overrides', () => {
  withEnv({ BRAIN_LOCAL_EMBED_MODEL: 'Xenova/code-model', BRAIN_LOCAL_EMBED_DIMS: '512' }, () => {
    const e = openEmbedder();
    assert.equal(e.modelName, 'Xenova/code-model');
    assert.equal(e.dims, 512);
  });
});

test('LocalProvider falls back to default dims when BRAIN_LOCAL_EMBED_DIMS is non-numeric', () => {
  withEnv({ BRAIN_LOCAL_EMBED_DIMS: 'not-a-number' }, () => {
    const p = new LocalProvider();
    assert.equal(p.dims, 384);
  });
});

test('embedThreads: capped at 2 by default, BRAIN_EMBED_THREADS overrides, 0 lifts the cap', () => {
  assert.equal(DEFAULT_EMBED_THREADS, 2);
  assert.equal(embedThreads({}), 2);
  assert.equal(embedThreads({ BRAIN_EMBED_THREADS: '' }), 2);
  assert.equal(embedThreads({ BRAIN_EMBED_THREADS: '4' }), 4);
  assert.equal(embedThreads({ BRAIN_EMBED_THREADS: '0' }), 0);
  assert.equal(embedThreads({ BRAIN_EMBED_THREADS: 'many' }), 2);
  assert.equal(embedThreads({ BRAIN_EMBED_THREADS: '-1' }), 2);
});

test('limitOnnxThreads: a buffer model becomes a file (the runtime ignores options for buffers) and gets the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ort-'));
  const calls = [];
  const ort = { InferenceSession: { create: async (model, options) => { calls.push({ model, options }); return 'session'; } } };
  assert.equal(limitOnnxThreads(ort, 2, { dir }), true);
  assert.equal(limitOnnxThreads(ort, 2, { dir }), false, 'patching twice is a no-op');
  const buf = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await ort.InferenceSession.create(buf, { executionProviders: ['cpu', 'wasm'] }), 'session');
  await ort.InferenceSession.create(buf, {});
  const [first, second] = calls;
  assert.equal(typeof first.model, 'string');
  assert.deepEqual([...fs.readFileSync(first.model)], [1, 2, 3, 4]);
  assert.equal(second.model, first.model, 'same bytes, same file');
  assert.deepEqual(first.options, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
  assert.equal(second.options.intraOpNumThreads, 2);
  await ort.InferenceSession.create('/some/model.onnx', {});
  assert.equal(calls[2].model, '/some/model.onnx');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('limitOnnxThreads: no cap or no runtime means nothing is patched', () => {
  const create = async () => 'session';
  const ort = { InferenceSession: { create } };
  assert.equal(limitOnnxThreads(ort, 0), false);
  assert.equal(ort.InferenceSession.create, create);
  assert.equal(limitOnnxThreads(null, 2), false);
  assert.equal(limitOnnxThreads({}, 2), false);
});
