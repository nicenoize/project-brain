/**
 * Shared parser for feature spec frontmatter at .project-brain/features/<slug>.md.
 *
 * Feature specs are scaffolded by brain:feature and consumed by brain:pr
 * (stage subcommand) and any future cross-feature tooling. Centralizing the
 * parser keeps the spec format honest: change the schema here, both writers
 * and readers stay in sync.
 *
 * Frontmatter shape:
 *   ---
 *   title: ...
 *   status: draft|active|done|cancelled
 *   feature: <slug>
 *   issue: <number or empty>
 *   date: YYYY-MM-DD
 *   owner: <actor>
 *   projects:
 *     - frontend
 *     - backend
 *   ---
 */

export function parseFeatureSpec(body) {
  const meta = {};
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return meta;
  const fm = fmMatch[1];
  for (const line of fm.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const projMatch = fm.match(/^projects:\n((?:  - .+\n?)+)/m);
  if (projMatch) {
    meta.projects = projMatch[1]
      .split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)
      .filter(p => p !== '(single-project)');
  } else {
    meta.projects = [];
  }
  return meta;
}

/** Heuristic: does this workstream belong to feature <slug>? */
export function workstreamMatchesFeature(workstream, slug) {
  if (!workstream || !slug) return false;
  if (workstream.scope?.includes(`feature ${slug}`)) return true;
  if (workstream.taskId === `feature-${slug}`) return true;
  if (workstream.taskId?.includes(`-${slug}-`)) return true;
  if (workstream.taskId?.endsWith(`-${slug}`)) return true;
  return false;
}
