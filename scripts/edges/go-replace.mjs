/**
 * go-replace: cross-project edges for Go modules that override a dependency
 * with a relative path pointing at a sibling project in the fleet.
 *
 * Matches:
 *   replace github.com/acme/foo => ../foo
 *   replace github.com/acme/foo => ./vendor/foo
 *   ( one-line and block form )
 *
 * Also handles a Go `require` of another project's module path (no
 * replace), emitted as medium-confidence.
 *
 * Confidence: high for explicit `replace =>` to a sibling path,
 *             medium for `require` matching a sibling's module declaration.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'go-replace';

async function* detect(ctx) {
  // Phase 1: index each Go project's module declaration.
  const moduleToProject = new Map();
  const goModByProject = new Map();
  for (const project of ctx.projects) {
    if (!project.kinds.includes('go')) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const goModPath = path.join(projAbs, 'go.mod');
    let text = '';
    try { text = fs.readFileSync(goModPath, 'utf8'); } catch { continue; }
    const mod = text.match(/^module\s+(\S+)/m);
    if (mod) moduleToProject.set(mod[1], project.name);
    goModByProject.set(project.name, { text, file: path.relative(ctx.ROOT, goModPath) });
  }

  for (const project of ctx.projects) {
    if (!goModByProject.has(project.name)) continue;
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) continue;
    const { text, file } = goModByProject.get(project.name);
    const lines = text.split('\n');
    // Replace directives.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s*(?:replace\s+)?(\S+)\s+(?:\S+\s+)?=>\s+([^\s]+)/);
      if (!m) continue;
      const target = m[2];
      // Only relative-path replaces are fleet edges.
      if (!/^\.\.?\//.test(target)) continue;
      const absTarget = path.resolve(ctx.projectDirs.get(project.name), target);
      // Resolve to a sibling project.
      const sibling = ctx.projects.find(p => {
        const pAbs = ctx.projectDirs.get(p.name);
        return pAbs && absTarget === pAbs;
      });
      if (!sibling || sibling.name === project.name) continue;
      yield {
        from: project.name,
        to: sibling.name,
        kind: 'go-replace',
        evidence: [`${file}:${i + 1}`],
        confidence: 'high',
        meta: { target, module: m[1] }
      };
    }
    // Require directives (medium). Handles `require module v…` (one-line)
    // and the indented form inside `require ( … )` blocks.
    let inRequireBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*require\s*\(/.test(line)) { inRequireBlock = true; continue; }
      if (inRequireBlock && /^\s*\)/.test(line)) { inRequireBlock = false; continue; }
      let module = null;
      const oneLine = line.match(/^\s*require\s+(\S+)\s+v\d/);
      if (oneLine) module = oneLine[1];
      else if (inRequireBlock) {
        const blockLine = line.match(/^\s*(\S+)\s+v\d/);
        if (blockLine) module = blockLine[1];
      }
      if (!module) continue;
      const owner = moduleToProject.get(module);
      if (!owner || owner === project.name) continue;
      yield {
        from: project.name,
        to: owner,
        kind: 'go-replace',
        evidence: [`${file}:${i + 1}`],
        confidence: 'medium',
        meta: { module, source: 'require' }
      };
    }
  }
}

export default { name: NAME, detect };
