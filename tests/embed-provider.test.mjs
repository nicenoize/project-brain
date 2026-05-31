import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider, openEmbedder, DEFAULT_LOCAL_EMBED_MODEL, DEFAULT_LOCAL_EMBED_DIMS } from '../scripts/embed.mjs';

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
