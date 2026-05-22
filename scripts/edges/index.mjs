/**
 * Cross-project edge detector runner.
 *
 * Imports each detector in dependency order (registrars first), passes a
 * shared context, dedupes candidates, and returns the final EdgeCandidate
 * list. Per-detector timeouts via AbortSignal.timeout — a single hanging
 * detector cannot block the rest.
 *
 * To add a new detector:
 *   1. Export an async generator from scripts/edges/<name>.mjs
 *   2. Add it to DETECTORS below in the right phase
 *   3. Add tests/edges/<name>.test.mjs
 */
import path from 'node:path';
import { dedupeCandidates } from './materialize.mjs';
import { openDetectorCache } from './cache.mjs';

// Detectors land in commits F3.1–F3.5. Each must export `name` and `detect`.
import imageRegistry from './image-registry.mjs';
import k8sImage from './k8s-image.mjs';
import protoSchema from './proto-schema.mjs';
import grpcClient from './grpc-client.mjs';
import openapiSchema from './openapi-schema.mjs';
import httpClient from './http-client.mjs';
import envVar from './env-var.mjs';
import pubsub from './pubsub.mjs';
import dbShared from './db-shared.mjs';
import packageDep from './package-dep.mjs';
import goReplace from './go-replace.mjs';

export const DETECTORS = [
  imageRegistry,    // phase 1: shared registrar (no edges emitted)
  protoSchema,      // emits proto-schema edges + publishes grpcServices
  openapiSchema,    // emits openapi-schema edges + publishes openapiServices
  k8sImage,         // consumes imageRegistry
  grpcClient,       // consumes grpcServices
  httpClient,       // consumes openapiServices
  envVar,           // collects env keys
  pubsub,           // SDK-specific producer/consumer patterns
  dbShared,         // migration dirs + DATABASE_URL overlap
  packageDep,       // internal npm package deps
  goReplace         // go.mod replace directives
];

export async function runDetectors(options = {}) {
  const {
    ROOT,
    projects,
    dirtyProjects = new Set(),
    useCache = true,
    onlyDetector = null,
    perDetectorTimeoutMs = Number(process.env.BRAIN_EDGE_TIMEOUT_MS || 30_000),
    logger = console
  } = options;

  const projectDirs = new Map(projects.map(p => [p.name, path.join(ROOT, p.dir)]));
  const facts = new Map();
  const all = [];

  for (const detector of DETECTORS) {
    if (!detector?.name || typeof detector.detect !== 'function') continue;
    if (onlyDetector && detector.name !== onlyDetector) continue;

    const cache = useCache ? openDetectorCache(detector.name) : null;
    const ctx = {
      ROOT,
      projects,
      projectDirs,
      dirtyProjects,
      facts,
      cache,
      logger,
      signal: AbortSignal.timeout(perDetectorTimeoutMs)
    };

    const detectorCandidates = [];
    // 1. Replay cached candidates for clean (from, to) pairs.
    if (cache && dirtyProjects.size) {
      for (const cached of cache.cleanCandidates(dirtyProjects)) {
        detectorCandidates.push(cached);
      }
    }

    // 2. Run the detector for dirty pairs (or everything if no dirty set).
    try {
      for await (const cand of detector.detect(ctx)) {
        detectorCandidates.push({ ...cand, detector: detector.name });
      }
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        logger.warn(`[edges] ${detector.name}: timeout after ${perDetectorTimeoutMs}ms`);
      } else {
        logger.warn(`[edges] ${detector.name}: ${err?.message || err}`);
      }
    }

    if (cache && detectorCandidates.length) {
      try { cache.write(detectorCandidates); } catch (err) {
        logger.warn(`[edges] ${detector.name} cache write failed: ${err.message || err}`);
      }
    }
    all.push(...detectorCandidates);
  }

  return dedupeCandidates(all);
}
