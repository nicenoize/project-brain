// Contextual Retrieval (index-time chunk situating).
//
// Anthropic's "Contextual Retrieval" technique: before embedding a chunk,
// prepend a short situating blurb describing where the chunk sits in the repo.
// This materially improves dense recall because the embedded vector now carries
// the chunk's location/identity context, not just its raw body.
//
// This module is the *deterministic, dependency-free* generator: it builds a
// one-line prefix purely from metadata that is ALREADY available on the chunk/
// record (file path, module, feature, nearest heading, type, declared symbols).
// No LLM, no network, no new dependencies.
//
// Default OFF. The whole behavior is gated behind BRAIN_CONTEXTUAL_CHUNKS=1 in
// the caller (brain-index.mjs). When unset, indexing is byte-for-byte unchanged.
//
// Extension seam (NOT implemented here): BRAIN_CONTEXTUAL_PROVIDER is a reserved
// env var that future work may use to shell out to an LLM for richer blurbs.
// `contextualProvider()` reports the active provider so callers can branch; the
// only implemented generator today is the deterministic one. No client code is
// added for any other provider — selecting one simply falls back to deterministic.

import path from 'node:path';

/** Hard cap on the situating prefix length (chars), trailing space included. */
export const MAX_PREFIX_CHARS = 200;

/** Repo/workspace label used to anchor the prefix. */
const DEFAULT_REPO = 'project-brain';

/**
 * Returns the configured contextual provider name. Default 'deterministic'.
 * Reserved seam: BRAIN_CONTEXTUAL_PROVIDER may name a future LLM provider, but
 * no provider other than the deterministic one is implemented — anything else
 * is treated as a request that callers may honor later and currently falls back
 * to deterministic generation.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function contextualProvider(env = process.env) {
  const raw = String(env.BRAIN_CONTEXTUAL_PROVIDER || '').trim();
  return raw || 'deterministic';
}

/**
 * Whether index-time contextual chunk situating is enabled. Default OFF.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function contextualChunksEnabled(env = process.env) {
  return env.BRAIN_CONTEXTUAL_CHUNKS === '1';
}

function firstSymbol(meta) {
  const pools = [meta.exportedSymbols, meta.symbols];
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      for (const s of pool) {
        const v = String(s || '').trim();
        if (v) return v;
      }
    }
  }
  return '';
}

function compactHeading(heading) {
  const h = String(heading || '').trim().replace(/\s+/g, ' ');
  if (!h) return '';
  // Keep headings short so a single long heading can't eat the whole budget.
  return h.length > 60 ? `${h.slice(0, 57).trimEnd()}…` : h;
}

/**
 * Build a compact one-line situating prefix from chunk/record metadata.
 *
 * Pure: no I/O, no env reads (pass `repo`/`provider` explicitly if needed).
 * Shape example:
 *   "[project-brain · module: retrieval · scripts/retrieval.mjs · hybridScore] "
 *
 * Segments are included only when their source field is present; the whole
 * string is capped at MAX_PREFIX_CHARS. Returns '' when there's nothing useful
 * to situate (so callers can safely concatenate without producing noise).
 *
 * @param {object} meta
 * @param {string} [meta.file]            relative file path
 * @param {string} [meta.module]          inferred/declared module
 * @param {string} [meta.feature]         inferred/declared feature
 * @param {string} [meta.heading]         nearest heading / symbol context
 * @param {string} [meta.type]            record type (doc/code/decision/…)
 * @param {string[]} [meta.symbols]       declared symbols
 * @param {string[]} [meta.exportedSymbols] exported symbols (preferred)
 * @param {object} [opts]
 * @param {string} [opts.repo]            repo label (default 'project-brain')
 * @param {number} [opts.maxChars]        length cap (default MAX_PREFIX_CHARS)
 * @returns {string} situating prefix ending in a single space, or ''
 */
export function buildContextualPrefix(meta = {}, opts = {}) {
  const repo = String(opts.repo || DEFAULT_REPO).trim() || DEFAULT_REPO;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : MAX_PREFIX_CHARS;

  const file = String(meta.file || '').trim();
  const module = String(meta.module || '').trim();
  const feature = String(meta.feature || '').trim();
  const type = String(meta.type || '').trim();
  const heading = compactHeading(meta.heading);
  const symbol = firstSymbol(meta);

  const segments = [repo];
  if (module) segments.push(`module: ${module}`);
  else if (feature) segments.push(`feature: ${feature}`);
  if (type) segments.push(type);
  if (file) segments.push(file);
  // Prefer an exported symbol as the most specific anchor; else nearest heading.
  const anchor = symbol || heading;
  if (anchor) segments.push(anchor);

  // Nothing beyond the bare repo label → not worth situating.
  if (segments.length <= 1) return '';

  let inner = segments.join(' · ');
  // Enforce the cap on the bracketed body, leaving room for "[", "] ".
  const budget = Math.max(0, maxChars - 3); // 3 = "[" + "] " (the bracket + space)
  if (inner.length > budget) inner = inner.slice(0, budget).trimEnd();

  return `[${inner}] `;
}

/**
 * Given the base embedding text for a chunk and its metadata, return the text
 * that should actually be embedded. When contextual chunks are enabled and a
 * non-empty prefix is generated, the prefix is prepended; otherwise the base
 * text is returned unchanged.
 *
 * IMPORTANT: this augments ONLY the embedding/keyword input. The caller must
 * keep the stored/displayed `text` field as the original chunk body.
 *
 * @param {string} baseEmbeddingText  the text that would otherwise be embedded
 * @param {object} meta               chunk/record metadata (see buildContextualPrefix)
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]    override the env gate (default: env-derived)
 * @param {string} [opts.repo]
 * @param {number} [opts.maxChars]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {string}
 */
export function situateEmbeddingText(baseEmbeddingText, meta = {}, opts = {}) {
  const base = String(baseEmbeddingText ?? '');
  const enabled = opts.enabled != null
    ? Boolean(opts.enabled)
    : contextualChunksEnabled(opts.env || process.env);
  if (!enabled) return base;
  const prefix = buildContextualPrefix(meta, { repo: opts.repo, maxChars: opts.maxChars });
  if (!prefix) return base;
  return `${prefix}${base}`;
}

/**
 * Convenience: derive the repo label from a fleet project name or fall back to
 * the basename of the workspace root. Kept tiny + pure so it stays testable.
 * @param {object} [meta]
 * @param {string} [rootDir]
 * @returns {string}
 */
export function repoLabel(meta = {}, rootDir = '') {
  const project = String(meta.project || '').trim();
  if (project) return project;
  const base = rootDir ? path.basename(rootDir) : '';
  return base || DEFAULT_REPO;
}
