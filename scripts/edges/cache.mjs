/**
 * Per-detector cache for incremental edge detection.
 *
 * Each detector gets a JSON file under `.project-brain/.fleet-cache/`.
 * When dirtyProjects is non-empty, the runner restores cached candidates
 * for clean (from, to) pairs and only re-runs the detector for dirty
 * pairs. Full re-scans (dirtyProjects empty or rebuildAll) bypass.
 *
 * Cache format: { version: 1, computedAt, candidates: EdgeCandidate[] }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR, ensureDir, exists, read, atomicWrite } from '../common.mjs';

const CACHE_DIR = path.join(BRAIN_DIR, '.fleet-cache');

export function openDetectorCache(detectorName) {
  const file = path.join(CACHE_DIR, `${detectorName}.json`);
  return {
    name: detectorName,
    has() { return exists(file); },
    read() {
      if (!exists(file)) return { version: 1, computedAt: 0, candidates: [] };
      try {
        return JSON.parse(read(file));
      } catch {
        return { version: 1, computedAt: 0, candidates: [] };
      }
    },
    write(candidates) {
      ensureDir(CACHE_DIR);
      atomicWrite(file, JSON.stringify({
        version: 1,
        computedAt: new Date().toISOString(),
        candidates
      }, null, 2));
    },
    /** Return cached candidates whose from/to don't intersect dirty. */
    cleanCandidates(dirtyProjects) {
      const dirty = new Set(dirtyProjects || []);
      if (!dirty.size) return [];
      const cache = this.read();
      return cache.candidates.filter(c => !dirty.has(c.from) && !dirty.has(c.to));
    }
  };
}

export function clearAllCaches() {
  if (!exists(CACHE_DIR)) return;
  for (const entry of fs.readdirSync(CACHE_DIR)) {
    try { fs.unlinkSync(path.join(CACHE_DIR, entry)); } catch {}
  }
}
