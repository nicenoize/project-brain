/**
 * Pure rendering helpers for `brain:search` hits — kept out of the CLI script
 * (which opens the vector store at import time) so they are unit-testable in
 * isolation, per the applyRules/buildGraph house pattern.
 *
 * Token-lean output (decisions/0024): `--terse` prints one line per hit with no
 * body, and the dense/keyword/symbol/metadata diagnostics live behind
 * `--explain` / `--json` instead of on every default line.
 */

/** The `[type,...]` classification flags for a hit. PURE. */
export function hitFlags(r) {
  return [
    r.type,
    r.isModuleSummary ? 'module-summary' : '',
    r.isProjectSummary ? 'project-summary' : '',
    r.isSummary ? 'summary' : ''
  ].filter(Boolean).join(',');
}

/** The dense/keyword/symbol/metadata diagnostics string (behind --explain/--json). PURE. */
export function scoringLine(r) {
  const n = (v) => Number(v || 0).toFixed(3);
  return `dense=${n(r.denseScore)} keyword=${n(r.keywordScore)} symbol=${n(r.symbolScore)} metadata=${n(r.metadataScore)}`;
}

/** One-line terse rendering: `score file#chunk-N [flags] heading` (body omitted). PURE. */
export function terseHitLine(r) {
  const heading = String(r.heading || r.title || '').replace(/\s+/g, ' ').trim();
  return `${Number(r.score || 0).toFixed(4)} ${r.file}#chunk-${r.chunk} [${hitFlags(r)}]${heading ? ' ' + heading : ''}`;
}

/**
 * The default (verbose) header line for a hit. Includes the diagnostics string
 * only when `explain` is set — the default no longer leaks it. PURE.
 */
export function verboseHitHeader(r, { explain = false } = {}) {
  const head = `--- ${Number(r.score || 0).toFixed(4)} ${r.file}#chunk-${r.chunk} [${hitFlags(r)}]`;
  return explain ? `${head} ${scoringLine(r)}` : head;
}
