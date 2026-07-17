/**
 * Pure path/frontmatter → record-field inference helpers.
 *
 * Extracted from brain-index.mjs so they're unit-testable without
 * triggering the indexer's top-level await (which loads the embedder
 * and opens the store).
 *
 * Used by brain-index.mjs to assign record.type / module / feature /
 * decision / sourceKind during the per-file indexing loop.
 */
import path from 'node:path';

export function inferType(file) {
  // Spec-kit artifacts (see decisions/0012-spec-kit-integration.md). Matched
  // strictly so an app's existing `specs/` test directory doesn't get mistaken
  // for a spec-kit feature folder — only specs/<id>/{spec,plan,tasks}.md hit.
  if (file === '.specify/memory/constitution.md') return 'constitution';
  if (/^specs\/[^/]+\/spec\.md$/.test(file)) return 'spec';
  if (/^specs\/[^/]+\/plan\.md$/.test(file)) return 'plan';
  if (/^specs\/[^/]+\/tasks\.md$/.test(file)) return 'tasks-list';
  if (/^specs\/[^/]+\//.test(file)) return 'spec-support';
  // Reasoning-cache records: durable cited answers under .project-brain/explainers/.
  if (file.includes('.project-brain/explainers/')) return 'explainer';
  // Synthesis-axis record (decisions/0019): cross-source claims, gated on >=2 cited sources.
  if (file.includes('.project-brain/insights/')) return 'insight';
  // Act-axis records (decisions/0017): audit findings and their remediation plans.
  // 'improve-plan' (not 'plan') avoids colliding with the spec-kit plan.md type above.
  if (file.includes('.project-brain/findings/')) return 'finding';
  if (file.includes('.project-brain/plans/')) return 'improve-plan';
  // Grill-axis record (decisions/0021): adversarial pre-implementation interview.
  if (file.includes('.project-brain/grills/')) return 'grill';
  // Temporal-axis record (decisions/0019): git history; regenerable, gitignored.
  if (file.includes('.project-brain/history/')) return 'history';
  // Learning-loop digest (decisions/0027): regenerable lessons summary derived
  // from the outcome sidecar. outcomes.jsonl is not .md so it never indexes.
  if (file.includes('.project-brain/reflect/')) return 'lesson';
  if (file.includes('/features/')) return 'feature';
  if (file.includes('/modules/')) return 'module';
  if (file.includes('/decisions/')) return 'decision';
  if (file.includes('/sessions/')) return 'session';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'code';
  // Polyglot code (Python/Go), env-gated so the default file set / taxonomy is
  // unchanged. These only ever reach indexing when BRAIN_POLYGLOT_SYMBOLS=1
  // (the file listing in common.mjs is widened under the same flag).
  if (isPolyglotCodeFile(file)) return 'code';
  return 'doc';
}

/** Python/Go source files, recognized only when polyglot extraction is enabled. */
export function isPolyglotCodeFile(file) {
  if (process.env.BRAIN_POLYGLOT_SYMBOLS !== '1') return false;
  return /\.(py|go)$/.test(file);
}

export function inferModule(file, data = {}) {
  if (data.module) return data.module;
  if (file.includes('/modules/')) return path.basename(file, path.extname(file));
  const parts = file.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) return parts.slice(0, 2).join('/');
  return path.dirname(file) === '.' ? '' : path.dirname(file);
}

export function inferFeature(file, data = {}) {
  if (data.feature) return data.feature;
  // Spec-kit: every file under specs/<id>/ shares the same feature id, so the
  // existing chunk:-3 feature-summary aggregation groups them automatically.
  const speckitMatch = file.match(/^specs\/([^/]+)\//);
  if (speckitMatch) return speckitMatch[1];
  return file.includes('/features/') ? path.basename(file, path.extname(file)) : '';
}

export function inferDecision(file, data = {}) {
  if (data.decision) return data.decision;
  return file.includes('/decisions/') ? path.basename(file, path.extname(file)) : '';
}

export function inferSourceKind(file) {
  if (file.startsWith('.project-brain/')) return 'brain';
  if (file.startsWith('.specify/')) return 'brain';
  if (file.startsWith('specs/')) return 'brain';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'code';
  if (isPolyglotCodeFile(file)) return 'code';
  if (/\.mdx?$/.test(file)) return 'doc';
  return 'other';
}
