/**
 * k8s-image: resolves `image: <ref>` in YAML manifests (Helm/kustomize/raw)
 * against the imageRegistry published by image-registry.mjs.
 *
 * Emits one edge per (k8s-project) → (Dockerfile-owning-project) per image ref.
 * Confidence:
 *   - high   when the ref matches a registry entry directly
 *   - medium when the ref is a Helm template ({{ .Values.image.repository }})
 *            that we resolve to a sibling values.yaml entry
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'k8s-image';

async function* detect(ctx) {
  const registry = ctx.facts.get('imageRegistry') || new Map();
  if (!registry.size) return;

  for (const project of ctx.projects) {
    if (!project.kinds.includes('helm') && !project.kinds.includes('kustomize')) continue;
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) {
      // Cached candidates already restored by the runner; skip clean projects.
      continue;
    }
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const yamls = collectYaml(projAbs);
    const values = readValuesYaml(projAbs);

    for (const yamlPath of yamls) {
      let text;
      try { text = fs.readFileSync(yamlPath, 'utf8'); } catch { continue; }
      const rel = path.relative(ctx.ROOT, yamlPath);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Match `image: "..."` (preserve inner spaces) or `image: foo`.
        const quoted = lines[i].match(/^\s*image:\s*["']([^"']+)["']/);
        const bare = lines[i].match(/^\s*image:\s*([^\s'"#]+)/);
        const m = quoted || bare;
        if (!m) continue;
        const raw = m[1].trim();
        const resolved = resolveImage(raw, registry, values);
        if (!resolved) continue;
        if (resolved.project === project.name) continue; // self-deploy
        yield {
          from: project.name,
          to: resolved.project,
          kind: 'k8s-image',
          evidence: [`${rel}:${i + 1}`],
          confidence: resolved.confidence,
          meta: { image: resolved.ref }
        };
      }
    }
  }
}

function collectYaml(absDir, out = [], depth = 5) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) collectYaml(full, out, depth - 1);
    else if (/\.(ya?ml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readValuesYaml(absDir) {
  // Lazy: just look for image.repository keys.
  const candidates = ['values.yaml', 'values.yml', path.join('helm', 'values.yaml')];
  for (const rel of candidates) {
    const full = path.join(absDir, rel);
    try {
      const text = fs.readFileSync(full, 'utf8');
      const repo = text.match(/^\s*repository:\s*['"]?([^\s'"]+)/m);
      const tag = text.match(/^\s*tag:\s*['"]?([^\s'"]+)/m);
      if (repo) return { repository: repo[1], tag: tag ? tag[1] : '', file: rel };
    } catch {}
  }
  return null;
}

function resolveImage(raw, registry, values) {
  // Strip tag.
  const ref = raw.split(':')[0];
  // Helm template e.g. "{{ .Values.image.repository }}:{{ .Values.image.tag }}".
  if (/^\{\{.*\}\}/.test(ref)) {
    if (values?.repository) {
      const r = registry.get(values.repository) || registry.get(values.repository.split('/').pop());
      if (r) return { project: r.project, confidence: 'medium', ref: values.repository };
    }
    return null;
  }
  // Direct match: registry has full ref or last segment.
  const direct = registry.get(ref);
  if (direct) return { project: direct.project, confidence: 'high', ref };
  const last = ref.split('/').pop();
  if (last && last !== ref) {
    const hit = registry.get(last);
    if (hit) return { project: hit.project, confidence: 'high', ref };
  }
  return null;
}

export default { name: NAME, detect };
