/**
 * grpc-client: cross-project edges where a project instantiates a gRPC
 * client for a service whose `service` declaration lives in another
 * project's .proto file (resolved via facts.grpcServices).
 *
 * Pattern coverage:
 *   - TS/JS:  new <Name>Client(  /  new <Name>ServiceClient(
 *   - Go:     pb.New<Name>Client(  /  <pkg>.New<Name>ServiceClient(
 *   - Python: <Name>Stub(channel)  /  <Name>ServiceStub(channel)
 *
 * Confidence: high when the matched name maps to a known service in
 * grpcServices; the detector skips otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'grpc-client';

const PATTERNS = [
  /\bnew\s+([A-Za-z_][A-Za-z0-9_]*)Client\s*\(/g,
  /\bNew([A-Za-z_][A-Za-z0-9_]*)Client\s*\(/g,
  /\b([A-Z][A-Za-z0-9_]*)Stub\s*\(/g
];

/** Try matching the captured name against services as-is, with/without 'Service' suffix. */
function resolveService(name, services) {
  if (services.has(name)) return name;
  if (services.has(name + 'Service')) return name + 'Service';
  if (name.endsWith('Service')) {
    const trimmed = name.replace(/Service$/, '');
    if (services.has(trimmed)) return trimmed;
  }
  return null;
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.go', '.py']);

async function* detect(ctx) {
  const services = ctx.facts.get('grpcServices') || new Map();
  if (!services.size) return;

  for (const project of ctx.projects) {
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const files = collectFiles(projAbs);
    for (const abs of files) {
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = path.relative(ctx.ROOT, abs);
      const lines = text.split('\n');
      const found = new Map(); // serviceName -> Set(line numbers)
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of PATTERNS) {
          pattern.lastIndex = 0;
          let m;
          while ((m = pattern.exec(lines[i]))) {
            const resolved = resolveService(m[1], services);
            if (!resolved) continue;
            if (services.get(resolved) === project.name) continue;
            if (!found.has(resolved)) found.set(resolved, new Set());
            found.get(resolved).add(i + 1);
          }
        }
      }
      for (const [name, lineSet] of found) {
        yield {
          from: project.name,
          to: services.get(name),
          kind: 'grpc-call',
          evidence: [...lineSet].sort((a, b) => a - b).slice(0, 5).map(ln => `${rel}:${ln}`),
          confidence: 'high',
          meta: { service: name }
        };
      }
    }
  }
}

function collectFiles(absDir, out = [], depth = 5) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out, depth - 1);
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

export default { name: NAME, detect };
