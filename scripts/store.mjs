import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSON_INDEX, LANCE_DIR, ensureDir, read } from './common.mjs';

export const TABLE_NAME = 'brain_records';

/** Lance/Arrow cannot merge or infer list<string> columns from empty arrays; pad on write, strip on read. */
const LANCE_LIST_PLACEHOLDER = '\uE000';

export class BrainStore {
  async upsert() { throw new Error('BrainStore.upsert is not implemented'); }
  async delete() { throw new Error('BrainStore.delete is not implemented'); }
  async search() { throw new Error('BrainStore.search is not implemented'); }
  async getAll() { throw new Error('BrainStore.getAll is not implemented'); }
  async close() {}
}

export class JsonStore extends BrainStore {
  constructor(options = {}) {
    super();
    this.path = options.path || JSON_INDEX;
    this.model = options.model || null;
    this.records = this.readRecords();
  }

  readRecords() {
    if (!fs.existsSync(this.path)) return [];
    const data = JSON.parse(read(this.path));
    this.model ||= data.model || null;
    return (data.records || []).map(normalizeRecord);
  }

  persist() {
    // Stream JSON to disk to avoid creating one giant in-memory string.
    ensureDir(path.dirname(this.path));
    const tmpPath = `${this.path}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, '{\n');
      fs.writeSync(fd, '  "version": 2,\n');
      fs.writeSync(fd, '  "backend": "json",\n');
      fs.writeSync(fd, `  "model": ${JSON.stringify(this.model ?? null)},\n`);
      fs.writeSync(fd, '  "records": [\n');
      for (let i = 0; i < this.records.length; i++) {
        const record = normalizeRecord(this.records[i]);
        fs.writeSync(fd, `    ${JSON.stringify(record)}${i < this.records.length - 1 ? ',' : ''}\n`);
      }
      fs.writeSync(fd, '  ]\n');
      fs.writeSync(fd, '}\n');
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmpPath, this.path);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(tmpPath); } catch {}
      throw error;
    }
  }

  async upsert(records) {
    const incoming = records.map(normalizeRecord);
    const byId = new Map(this.records.map(record => [record.id, record]));
    for (const record of incoming) byId.set(record.id, record);
    this.records = [...byId.values()];
    this.persist();
  }

  async delete(ids) {
    const remove = new Set(ids);
    if (!remove.size) return;
    this.records = this.records.filter(record => !remove.has(record.id));
    this.persist();
  }

  async search(queryVec, topK, filter = {}) {
    return this.records
      .filter(record => matchesFilter(record, filter))
      .map(record => ({ ...record, score: cosine(queryVec, record.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async getAll() {
    return this.records.map(normalizeRecord);
  }
}

export class LanceStore extends BrainStore {
  constructor(lancedb, options = {}) {
    super();
    this.lancedb = lancedb;
    this.dir = options.dir || LANCE_DIR;
    this.model = options.model || null;
    this.mirror = new JsonStore(options);
    this.mirrorEnabled = options.mirror !== false && process.env.BRAIN_JSON_MIRROR !== '0';
    this.mirrorStrict = process.env.BRAIN_JSON_MIRROR_STRICT === '1';
    this.db = null;
    this.table = null;
  }

  async open() {
    ensureDir(this.dir);
    this.db ||= await this.lancedb.connect(this.dir);
    return this;
  }

  async openTable() {
    await this.open();
    if (this.table) return this.table;
    try {
      this.table = await this.db.openTable(TABLE_NAME);
    } catch {
      const seed = this.mirror.readRecords();
      if (!seed.length) return null;
      const padded = seed.map((record) => padLanceListColumns(normalizeRecord(record)));
      this.table = await this.db.createTable(TABLE_NAME, padded, { mode: 'overwrite' });
    }
    return this.table;
  }

  async upsert(records) {
    const normalized = records.map(normalizeRecord);
    if (!normalized.length) return;
    await this.maybeMirrorUpsert(normalized);
    await this.open();
    const forLance = normalized.map(padLanceListColumns);
    let table;
    try {
      table = await this.db.openTable(TABLE_NAME);
    } catch {
      this.table = await this.db.createTable(TABLE_NAME, forLance, { mode: 'overwrite' });
      return;
    }
    this.table = table;
    if (typeof table.mergeInsert === 'function') {
      try {
        await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(forLance);
      } catch (error) {
        const msg = String(error?.message || error);
        if (/schema|fields did not match|unexpected=/i.test(msg)) {
          console.error('Project Brain: Lance table schema is older than this package (new coordination fields on records).');
          console.error('Fix: rm -rf .project-brain/vector-db && npm run brain:index -- --force');
        }
        throw error;
      }
    } else {
      await table.add(forLance);
    }
  }

  async delete(ids) {
    if (!ids.length) return;
    await this.maybeMirrorDelete(ids);
    const table = await this.openTable();
    if (!table) return;
    const quoted = ids.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
    await table.delete(`id IN (${quoted})`);
  }

  async search(queryVec, topK, filter = {}) {
    const table = await this.openTable();
    if (!table) return [];
    const query = table.search(queryVec).limit(topK * 10);
    const rows = await query.toArray();
    return rows
      .map(row => ({ ...normalizeRecord(row), score: toScore(row) }))
      .filter(record => matchesFilter(record, filter))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async getAll() {
    const table = await this.openTable();
    if (!table) return [];
    const rows = await table.query().limit(100000).toArray();
    return rows.map(normalizeRecord);
  }

  async maybeMirrorUpsert(records) {
    if (!this.mirrorEnabled) return;
    try {
      await this.mirror.upsert(records);
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror warning (lance upsert): ${error.message || error}`);
      console.warn('Continuing with Lance as source of truth. Set BRAIN_JSON_MIRROR=0 to disable mirror writes.');
    }
  }

  async maybeMirrorDelete(ids) {
    if (!this.mirrorEnabled) return;
    try {
      await this.mirror.delete(ids);
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror warning (lance delete): ${error.message || error}`);
      console.warn('Continuing with Lance as source of truth. Set BRAIN_JSON_MIRROR=0 to disable mirror writes.');
    }
  }
}

export class QdrantStore extends BrainStore {
  constructor(options = {}) {
    super();
    this.url = (options.url || process.env.BRAIN_QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
    this.collection = options.collection || process.env.BRAIN_QDRANT_COLLECTION || 'project_brain';
    this.apiKey = options.apiKey || process.env.BRAIN_QDRANT_API_KEY || '';
    this.model = options.model || null;
    this.dims = Number(options.dims || process.env.BRAIN_VECTOR_DIMS || 384);
    this.mirror = new JsonStore(options);
    this.mirrorEnabled = options.mirror !== false && process.env.BRAIN_JSON_MIRROR !== '0';
    this.mirrorStrict = process.env.BRAIN_JSON_MIRROR_STRICT === '1';
  }

  async upsert(records) {
    const normalized = records.map(normalizeRecord);
    if (!normalized.length) return;
    await this.ensureCollection(normalized[0].vector.length || this.dims);
    await this.maybeMirrorUpsert(normalized);
    await this.request(`/collections/${this.collection}/points?wait=true`, {
      method: 'PUT',
      body: {
        points: normalized.map(record => ({
          id: pointId(record.id),
          vector: record.vector,
          payload: { ...record, vector: undefined }
        }))
      }
    });
  }

  async delete(ids) {
    if (!ids.length) return;
    await this.maybeMirrorDelete(ids);
    await this.ensureCollection(this.dims);
    await this.request(`/collections/${this.collection}/points/delete?wait=true`, {
      method: 'POST',
      body: { points: ids.map(pointId) }
    });
  }

  async search(queryVec, topK, filter = {}) {
    await this.ensureCollection(queryVec.length || this.dims);
    const response = await this.request(`/collections/${this.collection}/points/search`, {
      method: 'POST',
      body: { vector: queryVec, limit: topK * 10, with_payload: true, with_vector: true }
    });
    return (response.result || [])
      .map(point => ({ ...normalizeRecord({ ...(point.payload || {}), vector: point.vector || [] }), score: point.score || 0 }))
      .filter(record => matchesFilter(record, filter))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async getAll() {
    await this.ensureCollection(this.dims);
    const records = [];
    let offset = null;
    do {
      const response = await this.request(`/collections/${this.collection}/points/scroll`, {
        method: 'POST',
        body: { limit: 256, offset, with_payload: true, with_vector: true }
      });
      for (const point of response.result?.points || []) {
        records.push(normalizeRecord({ ...(point.payload || {}), vector: point.vector || [] }));
      }
      offset = response.result?.next_page_offset || null;
    } while (offset);
    return records;
  }

  async ensureCollection(dims) {
    const response = await fetch(`${this.url}/collections/${this.collection}`);
    if (response.ok) return;
    await this.request(`/collections/${this.collection}`, {
      method: 'PUT',
      body: { vectors: { size: dims, distance: 'Cosine' } }
    });
  }

  async request(pathname, options = {}) {
    const response = await fetch(`${this.url}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) throw new Error(`Qdrant request failed (${response.status}): ${await response.text()}`);
    return response.json();
  }

  async maybeMirrorUpsert(records) {
    if (!this.mirrorEnabled) return;
    try {
      await this.mirror.upsert(records);
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror warning (qdrant upsert): ${error.message || error}`);
      console.warn('Continuing with Qdrant as source of truth. Set BRAIN_JSON_MIRROR=0 to disable mirror writes.');
    }
  }

  async maybeMirrorDelete(ids) {
    if (!this.mirrorEnabled) return;
    try {
      await this.mirror.delete(ids);
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror warning (qdrant delete): ${error.message || error}`);
      console.warn('Continuing with Qdrant as source of truth. Set BRAIN_JSON_MIRROR=0 to disable mirror writes.');
    }
  }
}

export async function openStore(options = {}) {
  const requested = options.backend || process.env.BRAIN_STORE || 'auto';
  if (requested === 'qdrant') {
    console.log('Project Brain store: qdrant');
    return new QdrantStore(options);
  }
  if (requested !== 'json') {
    try {
      const lancedb = await import('@lancedb/lancedb');
      console.log('Project Brain store: lance');
      return new LanceStore(lancedb, options).open();
    } catch (error) {
      if (requested === 'lance') throw error;
      console.warn('Project Brain store: json fallback (@lancedb/lancedb unavailable)');
    }
  } else {
    console.log('Project Brain store: json');
  }
  return new JsonStore(options);
}

function pointId(id) {
  const hex = /^[a-f0-9]{64}$/i.test(id) ? id : crypto.createHash('sha256').update(String(id)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function normalizeRecord(record) {
  return {
    id: String(record.id),
    file: record.file || '',
    chunk: Number(record.chunk || 0),
    title: record.title || path.basename(record.file || 'unknown'),
    type: record.type || 'doc',
    heading: record.heading || '',
    text: record.text || '',
    embeddingText: record.embeddingText || record.text || '',
    isSummary: Boolean(record.isSummary),
    isModuleSummary: Boolean(record.isModuleSummary),
    isProjectSummary: Boolean(record.isProjectSummary),
    branch: record.branch || '',
    expiresAt: record.expiresAt || '',
    taskId: record.taskId || '',
    actor: record.actor || '',
    tool: record.tool || '',
    parentRun: record.parentRun || '',
    module: record.module || inferModule(record.file || ''),
    feature: record.feature || inferFeature(record.file || ''),
    decision: record.decision || inferDecision(record.file || ''),
    sourceKind: record.sourceKind || '',
    mtime: record.mtime || '',
    hash: record.hash || '',
    symbols: stripLanceSentinel(normalizeList(record.symbols)),
    symbolKinds: stripLanceSentinel(normalizeList(record.symbolKinds)),
    exportedSymbols: stripLanceSentinel(normalizeList(record.exportedSymbols)),
    lineStart: Number(record.lineStart || 0),
    lineEnd: Number(record.lineEnd || 0),
    imports: stripLanceSentinel(normalizeList(record.imports)),
    references: stripLanceSentinel(normalizeList(record.references)),
    changedFiles: stripLanceSentinel(normalizeList(record.changedFiles)),
    vector: Array.from(record.vector || [])
  };
}

export function matchesFilter(record, filter = {}) {
  if (filter.summaryOnly && !record.isSummary) return false;
  if (filter.modulesOnly && !record.isModuleSummary) return false;
  if (filter.type && record.type !== filter.type) return false;
  if (filter.file && record.file !== filter.file) return false;
  return true;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function stripLanceSentinel(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item !== LANCE_LIST_PLACEHOLDER);
}

function padLanceListColumns(record) {
  const out = { ...record };
  for (const key of ['symbols', 'symbolKinds', 'exportedSymbols', 'imports', 'references', 'changedFiles']) {
    const arr = out[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      out[key] = [LANCE_LIST_PLACEHOLDER];
    }
  }
  return out;
}

function inferModule(file) {
  if (file.includes('/modules/')) return path.basename(file, path.extname(file));
  const parts = file.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) return parts.slice(0, 2).join('/');
  return path.dirname(file) === '.' ? '' : path.dirname(file);
}

function inferFeature(file) {
  return file.includes('/features/') ? path.basename(file, path.extname(file)) : '';
}

function inferDecision(file) {
  return file.includes('/decisions/') ? path.basename(file, path.extname(file)) : '';
}

function toScore(row) {
  if (typeof row.score === 'number') return row.score;
  if (typeof row._score === 'number') return row._score;
  if (typeof row._distance === 'number') return 1 / (1 + row._distance);
  if (typeof row.distance === 'number') return 1 / (1 + row.distance);
  return 0;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
