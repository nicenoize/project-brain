/**
 * proto-schema: cross-project edges where one project's .proto file is
 * imported by another's. Also publishes facts.grpcServices so the
 * grpc-client detector can resolve generated-client references.
 *
 * Confidence: high (parser-level certainty via path resolution).
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'proto-schema';

async function* detect(ctx) {
  // Phase 1: index every .proto file across the fleet.
  const protos = new Map();   // protoBasename -> {project, file (fleet-rel)}
  const services = new Map(); // serviceName -> project

  for (const project of ctx.projects) {
    if (!project.kinds.includes('proto')) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const files = collectProtos(projAbs);
    for (const abs of files) {
      const rel = path.relative(ctx.ROOT, abs);
      const base = path.basename(abs);
      protos.set(base, { project: project.name, file: rel });
      // Cheap service-name extraction.
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        services.set(m[1], project.name);
      }
    }
  }
  ctx.facts.set('grpcServices', services);

  if (!protos.size) return;

  // Phase 2: scan every project's protos for imports → emit edges.
  for (const project of ctx.projects) {
    if (!project.kinds.includes('proto')) continue;
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    const files = collectProtos(projAbs);
    for (const abs of files) {
      const rel = path.relative(ctx.ROOT, abs);
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"/);
        if (!m) continue;
        const imported = path.basename(m[1]);
        const owner = protos.get(imported);
        if (!owner) continue;
        if (owner.project === project.name) continue;
        yield {
          from: project.name,
          to: owner.project,
          kind: 'proto-schema',
          evidence: [`${rel}:${i + 1}`],
          confidence: 'high',
          meta: { protoFile: imported }
        };
      }
    }
  }
}

function collectProtos(absDir, out = [], depth = 5) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) collectProtos(full, out, depth - 1);
    else if (entry.name.endsWith('.proto')) out.push(full);
  }
  return out;
}

export default { name: NAME, detect };
