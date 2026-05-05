export class EmbedProvider {
  get modelName() { throw new Error('EmbedProvider.modelName is not implemented'); }
  get dims() { throw new Error('EmbedProvider.dims is not implemented'); }
  async embed() { throw new Error('EmbedProvider.embed is not implemented'); }
  async embedBatch(texts) {
    const vectors = [];
    for (const text of texts) vectors.push(await this.embed(text));
    return vectors;
  }
}

export class LocalProvider extends EmbedProvider {
  constructor() {
    super();
    this.extractor = null;
  }

  get modelName() { return 'Xenova/all-MiniLM-L6-v2'; }
  get dims() { return 384; }

  async load() {
    if (!this.extractor) {
      console.log(`Loading local embedding model: ${this.modelName}`);
      const { pipeline } = await import('@xenova/transformers');
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
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: this.model, input: batch })
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI embeddings failed (${response.status}): ${body}`);
      }
      const data = await response.json();
      vectors.push(...data.data.sort((a, b) => a.index - b.index).map(item => item.embedding));
    }
    return vectors;
  }
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
