/**
 * Rationale extraction (issue #29) — DORMANT, default-off behind BRAIN_RATIONALE=1.
 *
 * Graphify treats rationale comments (`WHY:`/`NOTE:`/`HACK:`) and ADR/RFC
 * citations as first-class graph nodes. The brain indexes ADR *documents* but
 * not the rationale embedded in code comments — a gap on the temporal/why axis
 * (brain:why). This scanner closes it: it walks code comments, extracts the
 * marker comments and any ADR/RFC references, and turns each into a dedicated
 * `type: rationale` index record with file/line provenance.
 *
 * DORMANCY CONTRACT: brain-index.mjs only invokes any of this when
 * `rationaleEnabled()` is true. With BRAIN_RATIONALE unset, no rationale record
 * is ever built, so the index is byte-identical to before (proven in
 * tests/rationale.test.mjs — the flag-off path emits zero records).
 *
 * Pure + exported so the extractor is unit-testable without a store/embedder.
 */
import crypto from 'node:crypto';

/** Sentinel chunk index for rationale records (distinct from -1..-9 summaries). */
export const RATIONALE_CHUNK = -10;

/** Default-OFF flag gate. */
export function rationaleEnabled() {
  return process.env.BRAIN_RATIONALE === '1';
}

// A rationale marker at the START of a comment body: `WHY:`, `NOTE:`, `HACK:`
// (case-insensitive, colon required to match the documented convention and
// avoid matching the bare words in prose).
const MARKER_RE = /^(WHY|NOTE|HACK)\s*:\s*(.*)$/i;

/**
 * PURE: extract the comment "bodies" from a single source line — the text with
 * its comment introducer stripped. Handles the three comment styles the ticket
 * calls out plus inline comments:
 *   - `// ...`      line + inline (JS/TS/Go/…)
 *   - `# ...`       line (Python/shell/YAML)
 *   - `/* ... *​/`  block, single-line and inline
 *   - ` * ...`      block continuation (JSDoc-style)
 * De-duplicated so a full-line comment doesn't also register as an inline one.
 */
export function commentBodies(line) {
  const raw = String(line);
  const trimmed = raw.trim();
  const bodies = [];
  if (trimmed.startsWith('//')) {
    bodies.push(trimmed.replace(/^\/\/+/, '').trim());
  } else if (trimmed.startsWith('#')) {
    bodies.push(trimmed.replace(/^#+/, '').trim());
  } else if (trimmed.startsWith('/*')) {
    bodies.push(trimmed.replace(/^\/\*+/, '').replace(/\*+\/\s*$/, '').trim());
  } else if (trimmed.startsWith('*') && !trimmed.startsWith('*/')) {
    bodies.push(trimmed.replace(/^\*+/, '').trim());
  } else {
    // Inline comments trailing real code.
    const blk = raw.match(/\/\*+([\s\S]*?)\*+\//);
    if (blk) bodies.push(blk[1].trim());
    const dbl = raw.indexOf('//');
    if (dbl >= 0) bodies.push(raw.slice(dbl + 2).trim());
  }
  return [...new Set(bodies.filter(Boolean))];
}

/**
 * PURE: extract ADR / RFC citations from a string. Recognizes:
 *   - `ADR 0013`, `ADR-0014`, `ADR0014`, `adr #5`     → `ADR 0013`
 *   - `decisions/0013-foo`, `decisions/0013-*`         → `ADR 0013`
 *   - `RFC 7231`, `RFC-2119`                            → `RFC 7231`
 * De-duplicated, order-preserving, ADR numbers zero-padded to 4 for stability.
 */
export function extractAdrRefs(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (token) => {
    const k = token.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(token);
  };
  for (const m of src.matchAll(/\bADR[\s#-]*(\d{1,4})\b/gi)) push(`ADR ${m[1].padStart(4, '0')}`);
  for (const m of src.matchAll(/\bdecisions\/(\d{1,4})\b/gi)) push(`ADR ${m[1].padStart(4, '0')}`);
  for (const m of src.matchAll(/\bRFC[\s#-]*(\d{1,5})\b/gi)) push(`RFC ${m[1]}`);
  return out;
}

/**
 * PURE: scan source text for rationale. Returns one finding per qualifying
 * comment line — a line that either carries a WHY:/NOTE:/HACK: marker OR cites
 * an ADR/RFC. Each finding is `{ marker, text, lineStart, references }` where
 * `marker` is '' for citation-only lines. 1-indexed line numbers = provenance.
 */
export function extractRationale(text) {
  const lines = String(text || '').split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    for (const body of commentBodies(lines[i])) {
      const marked = body.match(MARKER_RE);
      if (marked) {
        const content = marked[2].trim();
        findings.push({
          marker: marked[1].toUpperCase(),
          text: content,
          lineStart: i + 1,
          references: extractAdrRefs(body)
        });
        break; // one finding per line
      }
      const refs = extractAdrRefs(body);
      if (refs.length) {
        findings.push({ marker: '', text: body, lineStart: i + 1, references: refs });
        break;
      }
    }
  }
  return findings;
}

/**
 * PURE: turn a finding into an index record (vector filled in by the caller).
 * Deterministic id keyed on file/line/marker/content/hash so incremental
 * delete-then-upsert is idempotent.
 */
export function buildRationaleRecord(file, finding, fileHash, extra = {}) {
  const marker = (finding.marker || '').toUpperCase();
  const references = finding.references || [];
  const label = marker ? `${marker}:` : 'RATIONALE:';
  const refSuffix = references.length ? ` (${references.join(', ')})` : '';
  const displayText = `${label} ${finding.text}`.trim() + refSuffix;
  const embeddingText = `${file}:${finding.lineStart}\n${displayText}`;
  return {
    id: sha256(`rationale:${file}:${finding.lineStart}:${marker}:${finding.text}:${fileHash}`),
    file,
    chunk: RATIONALE_CHUNK,
    title: `${label} ${file}:${finding.lineStart}`,
    type: 'rationale',
    heading: label,
    text: displayText,
    embeddingText,
    isSummary: false,
    isModuleSummary: false,
    isProjectSummary: false,
    marker,
    references,
    lineStart: finding.lineStart,
    lineEnd: finding.lineStart,
    vector: [],
    ...extra
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
