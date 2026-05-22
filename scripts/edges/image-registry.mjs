/**
 * Phase-1 registrar (no edges emitted).
 *
 * Walks every project, finds Dockerfile* / Containerfile, derives the
 * image ref each project would push (heuristics: sibling package.json#name,
 * go.mod module basename, Chart.yaml name, or project dir basename).
 *
 * Publishes context.facts.imageRegistry: Map<imageRef, {project, file}>
 * for k8s-image.mjs to resolve `image:` references against.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'image-registry';

async function* detect(ctx) {
  const registry = new Map();

  for (const project of ctx.projects) {
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const dockerfiles = findDockerfiles(projAbs);
    if (!dockerfiles.length) continue;

    const baseRefs = imageRefsForProject(projAbs, project);

    for (const df of dockerfiles) {
      const rel = path.relative(ctx.ROOT, df);
      for (const ref of baseRefs) {
        const entry = registry.get(ref) || { project: project.name, file: rel };
        registry.set(ref, entry);
        // Also index ref without registry prefix (e.g. ghcr.io/x/y → y)
        const short = ref.split('/').pop();
        if (short && short !== ref && !registry.has(short)) {
          registry.set(short, { project: project.name, file: rel });
        }
      }
    }
  }

  ctx.facts.set('imageRegistry', registry);
  return; // no edges
}

function findDockerfiles(absDir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir); } catch { return out; }
  for (const entry of entries) {
    if (entry === 'Dockerfile' || entry === 'Containerfile') out.push(path.join(absDir, entry));
    else if (/^Dockerfile\..+$/.test(entry)) out.push(path.join(absDir, entry));
  }
  return out;
}

function imageRefsForProject(absDir, project) {
  const refs = new Set();
  // package.json#name
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8'));
    if (pkg.name) refs.add(stripScope(pkg.name));
  } catch {}
  // go.mod module name (last segment)
  try {
    const mod = fs.readFileSync(path.join(absDir, 'go.mod'), 'utf8');
    const m = mod.match(/^module\s+(\S+)/m);
    if (m) refs.add(path.basename(m[1]));
  } catch {}
  // Chart.yaml name
  try {
    const chart = fs.readFileSync(path.join(absDir, 'Chart.yaml'), 'utf8');
    const m = chart.match(/^\s*name:\s*([^\n#]+)/m);
    if (m) refs.add(m[1].trim());
  } catch {}
  // pyproject.toml name
  try {
    const py = fs.readFileSync(path.join(absDir, 'pyproject.toml'), 'utf8');
    const m = py.match(/^\s*name\s*=\s*['"]([^'"]+)['"]/m);
    if (m) refs.add(m[1]);
  } catch {}
  // Always include project dir basename as fallback ref
  refs.add(project.name);
  return [...refs];
}

function stripScope(name) {
  // @scope/foo → foo
  const m = name.match(/^@[^/]+\/(.+)$/);
  return m ? m[1] : name;
}

export default { name: NAME, detect };
