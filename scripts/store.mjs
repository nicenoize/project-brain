import fs from 'node:fs';
import path from 'node:path';
import { JSON_INDEX, LANCE_DIR, atomicWrite, ensureDir, read } from './common.mjs';

export const TABLE_NAME = 'brain_records';

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
    atomicWrite(this.path, JSON.stringify({
      version: 2,
      backend: 'json',
      model: this.model,
      records: this.records.map(normalizeRecord)
    }, null, 2));
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
      this.table = await this.db.createTable(TABLE_NAME, seed, { mode: 'overwrite' });
    }
    return this.table;
  }

  async upsert(records) {
    const normalized = records.map(normalizeRecord);
    if (!normalized.length) return;
    await this.mirror.upsert(normalized);
    await this.open();
    let table;
    try {
      table = await this.db.openTable(TABLE_NAME);
    } catch {
      this.table = await this.db.createTable(TABLE_NAME, normalized, { mode: 'overwrite' });
      return;
    }
    this.table = table;
    if (typeof table.mergeInsert === 'function') {
      await table.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(normalized);
    } else {
      await table.add(normalized);
    }
  }

  async delete(ids) {
    if (!ids.length) return;
    await this.mirror.delete(ids);
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
}

export async function openStore(options = {}) {
  const requested = options.backend || process.env.BRAIN_STORE || 'auto';
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
    branch: record.branch || '',
    expiresAt: record.expiresAt || '',
    vector: Array.from(record.vector || [])
  };
}

export function matchesFilter(record, filter = {}) {
  if (filter.summaryOnly && !record.isSummary) return false;
  if (filter.modulesOnly && !record.isModuleSummary) return false;
  if (filter.type && record.type !== filter.type) return false;
  return true;
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
