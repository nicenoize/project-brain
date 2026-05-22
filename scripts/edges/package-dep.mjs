/**
 * package-dep: cross-project edges where one Node project depends on
 * another's published package name (matched via package.json#name).
 *
 * Confidence: high (parsed JSON, exact name match).
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'package-dep';

async function* detect(ctx) {
  // Phase 1: index each Node project's package name.
  const nameToProject = new Map(); // package.json#name -> project name
  const pkgByProject = new Map();
  for (const project of ctx.projects) {
    if (!project.kinds.includes('node')) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projAbs, 'package.json'), 'utf8'));
      if (pkg.name) nameToProject.set(pkg.name, project.name);
      pkgByProject.set(project.name, pkg);
    } catch {}
  }

  // Phase 2: scan each project's deps for sibling references.
  for (const project of ctx.projects) {
    if (!pkgByProject.has(project.name)) continue;
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) continue;
    const pkg = pkgByProject.get(project.name);
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {})
    };
    const rel = path.relative(ctx.ROOT, path.join(ctx.projectDirs.get(project.name), 'package.json'));
    for (const dep of Object.keys(allDeps)) {
      const owner = nameToProject.get(dep);
      if (!owner || owner === project.name) continue;
      yield {
        from: project.name,
        to: owner,
        kind: 'package-dep',
        evidence: [`${rel}: "${dep}"`],
        confidence: 'high',
        meta: { dep }
      };
    }
  }
}

export default { name: NAME, detect };
