import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSON_INDEX, LANCE_DIR, ensureDir, read, shrinkGuard } from './common.mjs';

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

// Default 200 MB — well below Node's ~512 MB string limit and big enough
// to hold ~50 k brain records with vectors. Above this, we skip the mirror
// rather than OOM at JSON.parse time.
const JSON_MIRROR_MAX_BYTES = Number(process.env.BRAIN_JSON_MIRROR_MAX_BYTES || 200 * 1024 * 1024);
// Skip the per-call write when the in-memory record count exceeds this. A
// freshly bloated mirror from a botched recovery used to balloon to 60 k+
// records and hit the string-limit on the next read. Tunable for huge repos.
//
// The record cap is a PROXY for the byte cap, and the proxy is only as good as
// its assumption about record size. 50 k was calibrated when every record
// carried its 384-dimension vector as decimal text — about 9.3 KB each. A
// metadata-only mirror stores ~1.6 KB, so the same 200 MB now holds roughly six
// times as many records, and the old number locks out repos the byte guard
// would happily accept: a 33-project fleet indexed to 52,255 records had its
// mirror disabled while the file it would have written was ~84 MB.
//
// Derived rather than re-guessed, so the two caps cannot drift apart again.
const JSON_MIRROR_MAX_RECORDS = Number(process.env.BRAIN_JSON_MIRROR_MAX_RECORDS || 50_000);
const MIRROR_BYTES_PER_RECORD_WITH_VECTORS = 9_300;
const MIRROR_BYTES_PER_RECORD_METADATA_ONLY = 1_600;

/**
 * PURE. How many records may the mirror hold, given what it actually stores?
 *
 * An explicit BRAIN_JSON_MIRROR_MAX_RECORDS always wins — someone who set it
 * meant it. Otherwise the cap follows the payload: the byte guard is the real
 * protection (Node's ~512 MB string limit), and this keeps the proxy honest.
 */
export function mirrorRecordCap({
  vectorsOwnedElsewhere = false,
  byteCap = JSON_MIRROR_MAX_BYTES,
  explicit = process.env.BRAIN_JSON_MIRROR_MAX_RECORDS
} = {}) {
  if (explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const perRecord = vectorsOwnedElsewhere
    ? MIRROR_BYTES_PER_RECORD_METADATA_ONLY
    : MIRROR_BYTES_PER_RECORD_WITH_VECTORS;
  // Half the byte cap: the estimate is an average, and a mirror that trips the
  // byte guard on read is frozen until someone reindexes.
  return Math.max(1000, Math.floor((byteCap * 0.5) / perRecord));
}

export class JsonStore extends BrainStore {
  constructor(options = {}) {
    super();
    this.path = options.path || JSON_INDEX;
    this.model = options.model || null;
    this.disabled = false;
    // Shrink-guard (#20 item 1): a run started with --force (or
    // BRAIN_FORCE_SHRINK=1) may deliberately shrink the index; otherwise a
    // significant record-count drop is blocked as a suspected truncation.
    this.force = Boolean(options.force) || process.env.BRAIN_FORCE_SHRINK === '1';
    this.records = this.readRecords();
    // Baseline for the guard: what's currently on disk. Updated after each
    // successful persist so incremental deletes compare against the last
    // written snapshot, not the original cold-start count.
    this._persistedCount = this.records.length;
  }

  readRecords() {
    if (!fs.existsSync(this.path)) return [];
    try {
      const stat = fs.statSync(this.path);
      if (stat.size > JSON_MIRROR_MAX_BYTES) {
        console.warn(`Project Brain: JSON mirror at ${this.path} is ${Math.round(stat.size / 1024 / 1024)} MB ` +
          `(over ${Math.round(JSON_MIRROR_MAX_BYTES / 1024 / 1024)} MB cap). Skipping read to avoid OOM. ` +
          `Run \`npm run brain:repair\` to rebuild from source.`);
        this.disabled = true;
        return [];
      }
    } catch {}
    try {
      const data = JSON.parse(read(this.path));
      this.model ||= data.model || null;
      return (data.records || []).map(normalizeRecord);
    } catch (error) {
      if (error?.code === 'ERR_STRING_TOO_LONG') {
        console.warn(`Project Brain: JSON mirror at ${this.path} exceeds Node's string limit. ` +
          `Skipping read. Run \`npm run brain:repair\` to rebuild.`);
        this.disabled = true;
        return [];
      }
      console.warn(`Project Brain: JSON mirror read failed (${error.message || error}); treating as empty.`);
      return [];
    }
  }

  /**
   * Drop the vectors from the mirror when a vector backend holds them.
   *
   * The mirror exists as a portable, human-readable record of WHAT is indexed.
   * When LanceDB is the backend it also owns the embeddings, and mirroring them
   * as well costs ~2 KB per record for data that is never read from here —
   * enough to push a real repo's mirror past its own size cap, at which point
   * the mirror is skipped on read AND frozen on write, silently diverging from
   * the live index. That is how one repo ended up with 22,045 records in the
   * mirror and 106,467 in LanceDB.
   */
  set vectorsOwnedElsewhere(v) { this._noVectors = Boolean(v); }
  get vectorsOwnedElsewhere() { return Boolean(this._noVectors); }

  persist(opts = {}) {
    // If the mirror was already disabled at read time (too big / unreadable),
    // skip writes too — keeping the on-disk file frozen is preferable to
    // either crashing or doubling down on a corrupted snapshot.
    if (this.disabled) return;
    // Shrink-guard: refuse to overwrite a healthy index with a significantly
    // smaller one unless this run is forced (or the caller opts out, e.g.
    // auto-recovery reseeding the mirror from the current batch).
    const guard = shrinkGuard({
      oldCount: this._persistedCount,
      newCount: this.records.length,
      force: opts.force || this.force,
    });
    if (guard.blocked) {
      console.warn(`Project Brain shrink-guard: ${guard.reason}`);
      return;
    }
    const recordCap = mirrorRecordCap({ vectorsOwnedElsewhere: this.vectorsOwnedElsewhere });
    if (this.records.length > recordCap) {
      console.warn(`Project Brain: JSON mirror would hold ${this.records.length} records ` +
        `(cap ${recordCap}). Disabling mirror writes for this run. ` +
        `Set BRAIN_JSON_MIRROR_MAX_RECORDS to raise, or run \`npm run brain:repair\`.`);
      this.disabled = true;
      return;
    }
    // Stream JSON to disk to avoid creating one giant in-memory string.
    ensureDir(path.dirname(this.path));
    const tmpPath = `${this.path}.tmp.${process.pid}`;
    let fd;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, '{\n');
      fs.writeSync(fd, '  "version": 3,\n');
      fs.writeSync(fd, '  "backend": "json",\n');
      fs.writeSync(fd, `  "model": ${JSON.stringify(this.model ?? null)},\n`);
      fs.writeSync(fd, '  "records": [\n');
      for (let i = 0; i < this.records.length; i++) {
        // Vectors go out as base64 Float32 (v3). normalizeRecord reads both
        // forms back, so a v2 mirror on disk stays readable without a reindex.
        const record = normalizeRecord(this.records[i]);
        const wire = this._noVectors
          ? { ...record, vector: '' }
          : { ...record, vector: encodeVector(record.vector) };
        fs.writeSync(fd, `    ${JSON.stringify(wire)}${i < this.records.length - 1 ? ',' : ''}\n`);
      }
      fs.writeSync(fd, '  ]\n');
      fs.writeSync(fd, '}\n');
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.renameSync(tmpPath, this.path);
      } catch (renameErr) {
        // Concurrent bg-sync racing can unlink our pid-scoped tmp file or
        // already swap the target. Treat ENOENT as a soft failure — the
        // surviving process wrote a valid snapshot.
        if (renameErr?.code === 'ENOENT') {
          console.warn(`Project Brain mirror rename ENOENT (concurrent sync?). Continuing.`);
          return;
        }
        throw renameErr;
      }
      // Snapshot on disk now matches this.records — advance the guard baseline.
      this._persistedCount = this.records.length;
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
    // LanceDB owns the embeddings; the mirror records WHAT is indexed, not the
    // numbers. Set BRAIN_JSON_MIRROR_VECTORS=1 to keep them (a fully portable
    // snapshot that can serve similarity search on its own).
    this.mirror.vectorsOwnedElsewhere = process.env.BRAIN_JSON_MIRROR_VECTORS !== '1';
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
      // A metadata-only mirror CANNOT seed Lance, and pretending otherwise
      // destroys the index: seeding with empty vectors creates the table with a
      // zero-width vector column, the next real upsert is a schema mismatch,
      // and auto-recovery drops the table — then reseeds from the same
      // vector-less mirror. That loop wiped a 98,690-record index on a real
      // repo within minutes of the change that introduced it.
      //
      // The mirror's job is to record WHAT is indexed. It is not a backup, and
      // it never really was: the one on that repo had been frozen at 22,045
      // records while Lance held 106,467. Refusing here forces an honest
      // reindex instead of a silent rebuild from nothing.
      if (seed.some((r) => !(r.vector || []).length)) {
        console.warn(
          'Project Brain: the JSON mirror carries no vectors, so it cannot rebuild the ' +
          'vector store. Run `npm run brain:index -- --force` to reindex from source. ' +
          '(Set BRAIN_JSON_MIRROR_VECTORS=1 to keep a mirror that can.)'
        );
        return null;
      }
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
        const isSchemaErr = /schema|fields did not match|unexpected=/i.test(msg);
        if (isSchemaErr) {
          // Auto-recovery is on by default: schema mismatches almost always
          // mean the brain skill was upgraded (new record fields) and the
          // existing Lance table is stale. Dropping + recreating from the
          // current batch is the safe path. Opt out with BRAIN_AUTO_RECOVER=0.
          if (process.env.BRAIN_AUTO_RECOVER === '0') {
            console.error('Project Brain: Lance table schema is older than this package (new coordination fields on records).');
            console.error('Fix: rm -rf .project-brain/vector-db && npm run brain:index -- --force');
            console.error('Or: rerun without BRAIN_AUTO_RECOVER=0 to drop+rebuild the Lance table automatically.');
            throw error;
          }
          // NEVER destroy more than we can rebuild.
          //
          // This path used to drop the table and recreate it from the CURRENT
          // UPSERT BATCH. On a real repo a background sync carrying 179 records
          // hit a schema mismatch and this "recovery" destroyed 98,690 —
          // silently, from a hook, with a warning that said "auto-recovering"
          // and never said how much was being deleted. A recovery that loses
          // 99.8% of the index is a wipe wearing a recovery's name.
          //
          // The mirror can only rebuild the table if the mirror carries
          // vectors. When it cannot, refusing is correct: a reindex from source
          // is slow, and a silently emptied index is worse than slow.
          let existingRows = null;
          try { existingRows = await table.countRows(); } catch { existingRows = null; }
          const mirrorCanRestore = !this.mirror.vectorsOwnedElsewhere
            && this.mirror.readRecords().some((r) => (r.vector || []).length);
          const verdict = canAutoRecover({
            existingRows, batchSize: forLance.length, mirrorCanRestore
          });
          if (!verdict.allowed) {
            console.error(
              'Project Brain: Lance schema mismatch, and the JSON mirror cannot rebuild the ' +
              `table (it carries no vectors). REFUSING — ${verdict.reason}. Nothing was deleted. ` +
              'Fix: `npm run brain:index -- --force` to reindex from source, or set ' +
              'BRAIN_AUTO_RECOVER=0 to see the underlying error.'
            );
            throw error;
          }
          console.warn(
            'Project Brain: Lance schema mismatch detected. Auto-recovering — dropping ' +
            `${existingRows === null ? 'an unknown number of' : existingRows} record(s), ` +
            `rebuilding from ${mirrorCanRestore ? 'the JSON mirror' : `this batch of ${forLance.length}`}.`
          );
          try {
            await this.db.dropTable(TABLE_NAME);
          } catch {}
          // Reset the mirror so the next openTable can't seed Lance back from
          // a stale snapshot. Without this reset the bg-sync hook can
          // explode the record count by re-hydrating + re-upserting on every
          // failed → succeeded recovery cycle.
          this.resetMirror(forLance);
          this.table = await this.db.createTable(TABLE_NAME, forLance, { mode: 'overwrite' });
          return;
        }
        throw error;
      }
    } else {
      await table.add(forLance);
    }
  }

  /**
   * Replace the JSON mirror's in-memory records and on-disk snapshot with
   * the given seed (typically the current upsert batch). Used during
   * auto-recovery to prevent a bloated mirror from leaking stale rows back
   * into a freshly rebuilt Lance table.
   */
  resetMirror(seedRecords) {
    if (!this.mirrorEnabled) return;
    try {
      this.mirror.records = (seedRecords || []).map(normalizeRecord);
      if (this.model) this.mirror.model = this.model;
      // Auto-recovery deliberately reseeds the mirror from the current batch,
      // which is expected to be far smaller than the corrupt snapshot — force
      // past the shrink-guard rather than block a recovery.
      this.mirror.persist({ force: true });
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror reset failed: ${error.message || error}`);
    }
  }

  /**
   * Compact fragments and drop superseded versions.
   *
   * LanceDB appends: every incremental sync writes a new fragment and a new
   * version, and nothing reclaims the old ones on its own. A repo synced 737
   * times held 863 MB of data files and 555 fragments for an index whose live
   * vectors are 34 MB — and `optimize()` was called from nowhere in this
   * codebase. One call took it to 293 MB in 0.8 seconds.
   *
   * Total by construction: compaction is an optimisation, never a correctness
   * step, so a failure is reported and swallowed rather than failing the sync
   * that just succeeded.
   *
   * @returns {{ran: boolean, ms: number, reason?: string}}
   */
  async compact({ keepVersionsNewerThan = null } = {}) {
    const started = Date.now();
    try {
      const table = await this.openTable();
      if (!table || typeof table.optimize !== 'function') {
        return { ran: false, ms: 0, reason: 'this lancedb build has no optimize()' };
      }
      // Old versions are only safe to drop once nothing is mid-read; the
      // default keeps the last hour, which covers a concurrent sync.
      const cleanupOlderThan = keepVersionsNewerThan
        || new Date(Date.now() - 60 * 60 * 1000);
      await table.optimize({ cleanupOlderThan });
      return { ran: true, ms: Date.now() - started };
    } catch (error) {
      return { ran: false, ms: Date.now() - started, reason: String(error.message || error) };
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
    const pageSize = Number(process.env.BRAIN_LANCE_PAGE_SIZE || 4000);
    let total;
    try {
      total = await table.countRows();
    } catch {
      total = null;
    }
    // Lance has no cursor-based pagination yet; we rely on a sufficiently
    // large limit and a configurable page size. If row count is known, raise
    // the limit to fit; otherwise default to 100k to preserve old behavior.
    const limit = Number.isFinite(total) ? Math.max(pageSize, total + pageSize) : 100000;
    const rows = await table.query().limit(limit).toArray();
    return rows.map(normalizeRecord);
  }

  /** Rewrite JSON mirror from the Lance table so health/search_index stay consistent after deletes. */
  async flushMirrorFromLance() {
    if (!this.mirrorEnabled) return;
    try {
      const rows = await this.getAll();
      this.mirror.records = rows;
      if (this.model) this.mirror.model = this.model;
      this.mirror.persist();
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror flush failed: ${error.message || error}`);
    }
  }

  async close() {
    await this.flushMirrorFromLance();
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

  async flushMirrorFromQdrant() {
    if (!this.mirrorEnabled) return;
    try {
      const rows = await this.getAll();
      this.mirror.records = rows;
      if (this.model) this.mirror.model = this.model;
      this.mirror.persist();
    } catch (error) {
      if (this.mirrorStrict) throw error;
      console.warn(`Project Brain mirror flush failed: ${error.message || error}`);
    }
  }

  async close() {
    await this.flushMirrorFromQdrant();
  }
}

export async function openStore(options = {}) {
  const requested = options.backend || process.env.BRAIN_STORE || 'auto';
  if (requested === 'qdrant') {
    if (!process.env.BRAIN_QUIET) console.error('Project Brain store: qdrant');
    return new QdrantStore(options);
  }
  if (requested !== 'json') {
    try {
      const lancedb = await import('@lancedb/lancedb');
      if (!process.env.BRAIN_QUIET) console.error('Project Brain store: lance');
      return new LanceStore(lancedb, options).open();
    } catch (error) {
      if (requested === 'lance') throw error;
      console.warn('Project Brain store: json fallback (@lancedb/lancedb unavailable)');
    }
  } else {
    if (!process.env.BRAIN_QUIET) console.error('Project Brain store: json');
  }
  return new JsonStore(options);
}

function pointId(id) {
  const hex = /^[a-f0-9]{64}$/i.test(id) ? id : crypto.createHash('sha256').update(String(id)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * PURE. Encode an embedding as base64 Float32.
 *
 * WHY. The JSON mirror wrote each vector as decimal TEXT: a 384-dimension
 * embedding became ~7,700 characters, because a value like
 * `-0.07386847585439682` costs 20 bytes to say what fits in 4. On a real repo
 * that made the mirror 205 MB, of which 169 MB (83%) was vector text — over its
 * own 200 MB cap, so the mirror was skipped on every read and that repo had
 * been running with degraded retrieval for weeks without anyone noticing.
 *
 * Float32 is not a new loss: LanceDB, which holds the same vectors beside it,
 * already stores Float32. The mirror was carrying MORE precision than the
 * database it mirrors, in the most expensive possible encoding.
 *
 * 384 floats: ~7,700 chars → 2,048. On that repo, 169 MB → 44 MB.
 */
/**
 * PURE. May auto-recovery drop the vector table?
 *
 * The path this guards used to drop the table and recreate it from the CURRENT
 * UPSERT BATCH. On a real repo a background sync carrying 179 records hit a
 * schema mismatch and that "recovery" destroyed 98,690 — silently, from a hook,
 * behind a warning that said "auto-recovering" and never said how much was
 * being deleted. A recovery that loses 99.8% of the index is a wipe wearing a
 * recovery's name.
 *
 * Rule: never destroy more than can be rebuilt. The mirror can rebuild the
 * table only if it carries vectors; when it cannot and the drop would lose
 * rows, refuse. A reindex from source is slow, and a silently emptied index is
 * worse than slow.
 *
 * @param {{existingRows: number|null, batchSize: number, mirrorCanRestore: boolean}} i
 * @returns {{allowed: boolean, wouldLose: number|null, reason: string}}
 */
export function canAutoRecover({ existingRows = null, batchSize = 0, mirrorCanRestore = false } = {}) {
  if (mirrorCanRestore) {
    return { allowed: true, wouldLose: null, reason: 'the mirror carries vectors and can rebuild the table' };
  }
  if (!Number.isFinite(existingRows)) {
    // Unknown row count: the table is unreadable, so there is nothing provably
    // worth protecting and refusing would deadlock a genuinely broken store.
    return { allowed: true, wouldLose: null, reason: 'existing row count unknown — nothing provably at risk' };
  }
  const wouldLose = existingRows - batchSize;
  if (wouldLose > 0) {
    return {
      allowed: false,
      wouldLose,
      reason: `dropping ${existingRows} record(s) to recreate ${batchSize} would lose ${wouldLose}`
    };
  }
  return { allowed: true, wouldLose, reason: 'the incoming batch is at least as large as the table' };
}

export function encodeVector(vec) {
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec || []);
  if (!arr.length) return '';
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

/**
 * PURE. Decode either form: a base64 Float32 string (mirror v3) or a plain
 * number array (v2 and every mirror written before this change). Reading both
 * is what lets an existing index keep working without a reindex.
 */
export function decodeVector(v) {
  if (typeof v === 'string') {
    if (!v) return [];
    const buf = Buffer.from(v, 'base64');
    // A truncated or corrupted field must not throw mid-read; an empty vector
    // simply scores 0 and the record ranks last, which is visible and safe.
    if (buf.byteLength % 4 !== 0) return [];
    return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return Array.from(v || []);
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
    project: record.project || '',
    edgeFrom: record.edgeFrom || '',
    edgeTo: record.edgeTo || '',
    edgeKind: record.edgeKind || '',
    edgeConfidence: record.edgeConfidence || '',
    projectKinds: stripLanceSentinel(normalizeList(record.projectKinds)),
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
    vector: decodeVector(record.vector)
  };
}

export function matchesFilter(record, filter = {}) {
  if (filter.summaryOnly && !record.isSummary) return false;
  if (filter.modulesOnly && !record.isModuleSummary) return false;
  if (filter.type) {
    // String filter behaves exactly as before; array widens to a set (used by
    // brain:why when BRAIN_RATIONALE=1 to also surface `rationale` records).
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(record.type)) return false;
  }
  if (filter.file && record.file !== filter.file) return false;
  if (filter.project) {
    const allowed = Array.isArray(filter.project) ? filter.project : String(filter.project).split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(record.project)) return false;
  }
  if (filter.edgeKind && record.edgeKind !== filter.edgeKind) return false;
  if (filter.edgeFrom && record.edgeFrom !== filter.edgeFrom) return false;
  if (filter.edgeTo && record.edgeTo !== filter.edgeTo) return false;
  return true;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  // Arrow Vector (Lance returns list<string> columns as `apache-arrow` Vectors,
  // not plain arrays). Detect by .toArray() availability so we don't go through
  // String() coercion, which renders Vectors as JSON-like `"[a, b, c]"` and
  // pollutes the first/last elements with stray brackets after a split.
  if (typeof value.toArray === 'function') {
    return value.toArray().map(String).filter(Boolean);
  }
  // Generic iterable fallback (covers anything else that's array-like).
  if (typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') {
    return [...value].map(String).filter(Boolean);
  }
  return String(value).split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function stripLanceSentinel(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item !== LANCE_LIST_PLACEHOLDER);
}

function padLanceListColumns(record) {
  const out = { ...record };
  for (const key of ['symbols', 'symbolKinds', 'exportedSymbols', 'imports', 'references', 'changedFiles', 'projectKinds']) {
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
