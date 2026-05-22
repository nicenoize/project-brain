/**
 * Convert EdgeCandidate objects into cross-project-edge records (chunk:-9).
 *
 * IDs are deterministic — `sha256(from|to|kind|sorted-evidence)` — so
 * incremental delete-then-upsert is idempotent. Records carry edge*
 * scalar fields so retrieval can filter by edgeKind / edgeFrom / edgeTo
 * via store.matchesFilter (added in F1.1).
 */
import crypto from 'node:crypto';

export function candidateToRecord(candidate, embedderResult) {
  const { from, to, kind, evidence = [], confidence, detector } = candidate;
  const sortedEvidence = [...evidence].sort();
  const id = sha256(`cross-project-edge:${from}|${to}|${kind}|${sortedEvidence.join(',')}`);
  const sampleEvidence = sortedEvidence.slice(0, 5).join('; ');

  const embeddingText = `Cross-project edge from ${from} to ${to} via ${kind}. Detected by ${detector}. Confidence ${confidence}. Evidence: ${sampleEvidence}.`;
  const text = [
    `# ${from} → ${to} (${kind})`,
    `**Detector:** ${detector}`,
    `**Confidence:** ${confidence}`,
    sortedEvidence.length ? `**Evidence:**\n${sortedEvidence.map(e => `- ${e}`).join('\n')}` : '',
    candidate.meta ? `**Meta:** ${JSON.stringify(candidate.meta)}` : ''
  ].filter(Boolean).join('\n\n');

  return {
    id,
    file: `.project-brain/fleet/edges/${from}__${to}__${kind}.md`,
    chunk: -9,
    title: `${from} → ${to} via ${kind}`,
    type: 'cross-project-edge',
    heading: `${from} → ${to}`,
    text,
    embeddingText,
    isSummary: true,
    project: from,
    edgeFrom: from,
    edgeTo: to,
    edgeKind: kind,
    edgeConfidence: confidence,
    module: `${from}->${to}`,
    vector: embedderResult || []
  };
}

/**
 * Dedupe candidates by (from, to, kind, first-evidence). On collision,
 * keep the highest confidence; merge evidence arrays.
 */
export function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const sortedEvidence = [...(c.evidence || [])].sort();
    const key = `${c.from}|${c.to}|${c.kind}|${sortedEvidence[0] || ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c, evidence: sortedEvidence });
      continue;
    }
    // Keep highest confidence.
    if (confidenceRank(c.confidence) > confidenceRank(existing.confidence)) {
      byKey.set(key, { ...c, evidence: mergeEvidence(existing.evidence, sortedEvidence) });
    } else {
      existing.evidence = mergeEvidence(existing.evidence, sortedEvidence);
    }
  }
  return [...byKey.values()];
}

function confidenceRank(level) {
  return { high: 3, medium: 2, low: 1 }[level] || 0;
}

function mergeEvidence(a = [], b = []) {
  return [...new Set([...a, ...b])].sort();
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
