/**
 * Embedding providers for the semantic index.
 *
 * LocalProvider wraps @xenova/transformers (an OPTIONAL dependency since M2 —
 * a plain `npx` install ships without the ~300 MB model stack). The module is
 * imported lazily inside load(); when it is absent or broken the provider
 * surfaces a typed EmbedderUnavailableError instead of crashing, and
 * `available()` lets callers (index-provider.mjs) probe cheaply — via module
 * resolution, without loading the heavy runtime — before deciding to degrade
 * to lexical-only search. OpenAIProvider needs only fetch + OPENAI_API_KEY.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Threads the local model may use. ONNX Runtime's default is one per core,
 * which made every index run take ~4.6 of 12 cores for its whole length and
 * left the machine sluggish (measured 2026-10-13, all-MiniLM-L6-v2: 24 ms per
 * chunk at 4.6 cores; 2 threads: 47 ms at 1.9 cores). An index is background
 * work, so it gets 2 threads. BRAIN_EMBED_THREADS=N sets another cap, 0 lifts it.
 */
export const DEFAULT_EMBED_THREADS = 2;
export function embedThreads(env = process.env) {
  const raw = env.BRAIN_EMBED_THREADS;
  if (raw == null || raw === '') return DEFAULT_EMBED_THREADS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_EMBED_THREADS;
}

/**
 * Cap ONNX Runtime's threads for every session transformers.js creates.
 * transformers.js 2.x passes no session options and loads the model as a
 * buffer, and onnxruntime-node 1.14 ignores the options for a buffer anyway —
 * only a model loaded from a path honours intraOpNumThreads. So the buffer is
 * written once to a content-addressed file and the session is made from that.
 * Returns false when nothing was patched (no cap, or no runtime to patch).
 */
export function limitOnnxThreads(ort, threads, { dir = os.tmpdir() } = {}) {
  const IS = ort && ort.InferenceSession;
  if (!threads || !IS || typeof IS.create !== 'function' || IS.create.brainThreads) return false;
  const create = IS.create.bind(IS);
  const limited = (model, options = {}) => {
    let source = model;
    if (model instanceof Uint8Array) {
      const sha = crypto.createHash('sha256').update(model).digest('hex').slice(0, 16);
      source = path.join(dir, `project-brain-model-${sha}.onnx`);
      if (!fs.existsSync(source)) {
        const tmp = `${source}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, model);
        fs.renameSync(tmp, source);
      }
    }
    // The node runtime only knows 'cpu'; transformers.js also lists 'wasm'.
    const providers = (options.executionProviders || []).filter((p) => p !== 'wasm');
    return create(source, {
      ...options,
      ...(providers.length ? { executionProviders: providers } : {}),
      intraOpNumThreads: threads,
      interOpNumThreads: 1
    });
  };
  limited.brainThreads = threads;
  IS.create = limited;
  return true;
}

/** Thrown when the local embedding stack cannot be loaded (optional dependency absent/broken). */
export class EmbedderUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'EmbedderUnavailableError';
    this.code = 'EMBEDDER_UNAVAILABLE';
  }
}

export class EmbedProvider {
  get modelName() { throw new Error('EmbedProvider.modelName is not implemented'); }
  get dims() { throw new Error('EmbedProvider.dims is not implemented'); }
  /** Whether this provider can actually produce embeddings in this install. */
  async available() { return true; }
  async embed() { throw new Error('EmbedProvider.embed is not implemented'); }
  async embedBatch(texts) {
    const vectors = [];
    for (const text of texts) vectors.push(await this.embed(text));
    return vectors;
  }
}

export const DEFAULT_LOCAL_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_LOCAL_EMBED_DIMS = 384;

export class LocalProvider extends EmbedProvider {
  constructor(options = {}) {
    super();
    this.extractor = null;
    // Env-gated seam: any transformers.js feature-extraction model id can be
    // plugged via BRAIN_LOCAL_EMBED_MODEL (+ its output width via
    // BRAIN_LOCAL_EMBED_DIMS) so a code-aware model can be A/B-tested. With
    // both envs unset, this is byte-for-byte identical to the prior hardcoded
    // all-MiniLM-L6-v2 / 384-dim behavior.
    this.model = options.model || process.env.BRAIN_LOCAL_EMBED_MODEL || DEFAULT_LOCAL_EMBED_MODEL;
    const dimsRaw = options.dims ?? process.env.BRAIN_LOCAL_EMBED_DIMS;
    const dimsNum = Number(dimsRaw);
    this._dims = Number.isFinite(dimsNum) && dimsNum > 0 ? dimsNum : DEFAULT_LOCAL_EMBED_DIMS;
  }

  get modelName() { return this.model; }
  get dims() { return this._dims; }

  /**
   * Cheap availability probe: resolves the optional module without importing
   * (importing @xenova/transformers pulls in the whole ONNX runtime). Mirrors
   * the graceful-degradation pattern used for @lancedb/lancedb in store.mjs.
   */
  async available() {
    try { require.resolve('@xenova/transformers'); return true; }
    catch { return false; }
  }

  async load() {
    if (!this.extractor) {
      if (!process.env.BRAIN_QUIET) console.error(`Loading local embedding model: ${this.modelName}`);
      let pipeline;
      try {
        ({ pipeline } = await import('@xenova/transformers'));
      } catch (error) {
        throw new EmbedderUnavailableError(
          'Local embedder unavailable: optional dependency @xenova/transformers could not be loaded. ' +
          'Install it (npm i @xenova/transformers) or set OPENAI_API_KEY with BRAIN_EMBED_PROVIDER=openai.',
          { cause: error }
        );
      }
      try {
        // The runtime transformers.js resolves, not a possibly different copy.
        const ort = createRequire(require.resolve('@xenova/transformers'))('onnxruntime-node');
        limitOnnxThreads(ort, embedThreads());
      } catch (error) {
        if (!process.env.BRAIN_QUIET) console.error(`Project Brain: embedding thread cap unavailable (${error.message || error}); using all cores.`);
      }
      this.extractor = await pipeline('feature-extraction', this.modelName);
    }
    return this.extractor;
  }

  async embed(text) {
    const extractor = await this.load();
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }
}

export class OpenAIProvider extends EmbedProvider {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = options.model || process.env.BRAIN_OPENAI_EMBED_MODEL || 'text-embedding-3-small';
    this.batchSize = Number(process.env.BRAIN_OPENAI_BATCH_SIZE || 96);
  }

  get modelName() { return this.model; }
  get dims() { return this.model === 'text-embedding-3-large' ? 3072 : 1536; }

  async embed(text) {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const data = await this.requestBatchWithBackoff(batch);
      vectors.push(...data.data.sort((a, b) => a.index - b.index).map(item => item.embedding));
    }
    return vectors;
  }

  async requestBatchWithBackoff(batch) {
    const maxRetries = Number(process.env.BRAIN_OPENAI_MAX_RETRIES || 3);
    let attempt = 0;
    let lastError;
    while (attempt <= maxRetries) {
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ model: this.model, input: batch })
        });
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) throw error;
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }
      if (response.ok) return response.json();
      const transient = response.status === 429 || (response.status >= 500 && response.status < 600);
      const body = await response.text();
      if (!transient || attempt === maxRetries) {
        throw new Error(`OpenAI embeddings failed (${response.status}): ${body}`);
      }
      lastError = new Error(`transient OpenAI ${response.status}: ${body.slice(0, 200)}`);
      await sleep(backoffMs(attempt));
      attempt++;
    }
    throw lastError || new Error('OpenAI embeddings exhausted retries');
  }
}

function backoffMs(attempt) {
  // 1s, 2s, 4s, 8s … with ±20% jitter.
  const base = 1000 * Math.pow(2, attempt);
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(250, Math.round(base + jitter));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function openEmbedder(options = {}) {
  const provider = options.provider || process.env.BRAIN_EMBED_PROVIDER || 'local';
  if (provider === 'openai') {
    const openai = new OpenAIProvider(options);
    if (openai.apiKey) return openai;
    console.warn('BRAIN_EMBED_PROVIDER=openai requested but OPENAI_API_KEY is missing. Falling back to local embeddings.');
  }
  return new LocalProvider();
}
