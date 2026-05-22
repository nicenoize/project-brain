/**
 * openapi-schema: registrar + edge emitter.
 *
 * Registrar: scans each project for `openapi.{yml,yaml,json}` /
 * `*-openapi.yml`, extracts the server URL(s) declared in the spec, and
 * publishes facts.openapiServices: Map<baseUrl, project> so http-client
 * can resolve outbound calls to known services.
 *
 * Edge emitter: when one project hosts the spec and another references
 * it via $ref or import, emit an openapi-schema edge (high confidence).
 * In practice this is rare; the registrar half is the main payoff.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'openapi-schema';
const SPEC_NAMES = /^(openapi|api|swagger)\.(ya?ml|json)$|-openapi\.(ya?ml|json)$/i;

async function* detect(ctx) {
  const openapiServices = new Map(); // baseUrl -> project
  const specsByProject = new Map();  // project -> [{file, urls}]

  for (const project of ctx.projects) {
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const specs = collectSpecs(projAbs);
    if (!specs.length) continue;
    const entries = [];
    for (const abs of specs) {
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const urls = extractServerUrls(text);
      entries.push({ file: abs, urls });
      for (const url of urls) openapiServices.set(url, project.name);
    }
    specsByProject.set(project.name, entries);
  }
  ctx.facts.set('openapiServices', openapiServices);

  if (!openapiServices.size) return;

  // Detect cross-project spec references (rare).
  for (const project of ctx.projects) {
    if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(project.name)) continue;
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const specs = (specsByProject.get(project.name) || []).map(e => e.file);
    for (const abs of specs) {
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = path.relative(ctx.ROOT, abs);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/\$ref:\s*['"]?([^'"\s]+)['"]?/);
        if (!m) continue;
        const target = m[1];
        if (!/^(\.\.|\/)/.test(target)) continue;
        // Find which project owns target.
        const resolvedAbs = path.resolve(path.dirname(abs), target);
        for (const [otherName, entries] of specsByProject) {
          if (otherName === project.name) continue;
          if (entries.some(e => path.resolve(e.file) === resolvedAbs)) {
            yield {
              from: project.name,
              to: otherName,
              kind: 'openapi-schema',
              evidence: [`${rel}:${i + 1}`],
              confidence: 'high',
              meta: { ref: target }
            };
          }
        }
      }
    }
  }
}

function collectSpecs(absDir, out = [], depth = 4) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) collectSpecs(full, out, depth - 1);
    else if (SPEC_NAMES.test(entry.name)) out.push(full);
  }
  return out;
}

function extractServerUrls(text) {
  // OpenAPI servers: [{url: 'https://api.example.com'}, ...]
  const urls = new Set();
  for (const m of text.matchAll(/^\s*-\s*url:\s*['"]?([^\s'"]+)/gm)) urls.add(m[1]);
  for (const m of text.matchAll(/"url"\s*:\s*"([^"]+)"/g)) urls.add(m[1]);
  for (const m of text.matchAll(/^\s*host:\s*['"]?([^\s'"]+)/gm)) urls.add(m[1]);
  return [...urls].filter(Boolean);
}

export default { name: NAME, detect };
