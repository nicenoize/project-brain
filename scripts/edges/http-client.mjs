/**
 * http-client: cross-project edges where one project calls another's
 * HTTP endpoint. Per-language regex over common HTTP-client patterns,
 * resolved against:
 *   1. BRAIN_FLEET_SERVICE_URLS=backend=https://backend.local,...  → high
 *   2. facts.openapiServices (published by openapi-schema)         → high
 *   3. URL host containing a sibling project's name                → medium
 *   4. localhost / 127.* without resolution                        → low
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'http-client';

const PATTERNS = [
  // JS/TS
  /\bfetch\(\s*['"`]([^'"`]+)['"`]/g,
  /\baxios\.(?:get|post|put|delete|patch|head|options)\(\s*['"`]([^'"`]+)['"`]/g,
  /\baxios\(\s*\{\s*[^}]*url:\s*['"`]([^'"`]+)['"`]/g,
  // Go
  /\bhttp\.(?:Get|Post|Head)\(\s*['"]([^'"]+)['"]/g,
  /\bhttp\.NewRequest\(\s*['"][A-Z]+['"]\s*,\s*['"]([^'"]+)['"]/g,
  // Python
  /\brequests\.(?:get|post|put|delete|patch|head)\(\s*['"]([^'"]+)['"]/g,
  /\bhttpx\.(?:Client|AsyncClient)\(\s*[^)]*base_url=['"]([^'"]+)['"]/g,
  /\bhttpx\.(?:get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g
];

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.go', '.py']);
const STDLIB_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'example.com']);

async function* detect(ctx) {
  const openapiServices = ctx.facts.get('openapiServices') || new Map();
  const serviceUrlsEnv = parseServiceUrlsEnv(process.env.BRAIN_FLEET_SERVICE_URLS);
  // Pre-index by hostname for cheap lookups.
  const hostIndex = new Map();
  for (const [url, project] of openapiServices) {
    const host = safeHost(url);
    if (host) hostIndex.set(host, { project, confidence: 'high', source: 'openapi' });
  }
  for (const [name, url] of serviceUrlsEnv) {
    const host = safeHost(url);
    if (host && !hostIndex.has(host)) hostIndex.set(host, { project: name, confidence: 'high', source: 'env' });
  }

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
      const candidates = new Map(); // 'to|confidence' -> Set(line numbers)
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of PATTERNS) {
          pattern.lastIndex = 0;
          let m;
          while ((m = pattern.exec(lines[i]))) {
            const target = resolveUrl(m[1], hostIndex, ctx.projects, project);
            if (!target) continue;
            const key = `${target.to}|${target.confidence}`;
            if (!candidates.has(key)) candidates.set(key, new Set());
            candidates.get(key).add(i + 1);
          }
        }
      }
      for (const [key, lineSet] of candidates) {
        const [to, confidence] = key.split('|');
        yield {
          from: project.name,
          to,
          kind: 'http-call',
          evidence: [...lineSet].sort((a, b) => a - b).slice(0, 5).map(ln => `${rel}:${ln}`),
          confidence
        };
      }
    }
  }
}

function resolveUrl(rawUrl, hostIndex, projects, selfProject) {
  let url = String(rawUrl).trim();
  if (!url) return null;
  // Skip relative URLs and obviously non-network strings.
  if (!/^(https?:)?\/\//.test(url) && !url.startsWith('http')) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host) return null;
  const lc = host.toLowerCase();
  // 1. Direct host hit.
  const direct = hostIndex.get(lc);
  if (direct && direct.project !== selfProject.name) {
    return { to: direct.project, confidence: direct.confidence };
  }
  // 2. Hostname contains a sibling project's name as a label.
  for (const p of projects) {
    if (p.name === selfProject.name) continue;
    if (lc === p.name || lc.startsWith(p.name + '.') || lc.includes('.' + p.name + '.') || lc.endsWith('.' + p.name)) {
      return { to: p.name, confidence: 'medium' };
    }
  }
  // 3. Localhost without resolution → skip (would false-positive every dev server).
  if (STDLIB_HOSTS.has(lc)) return null;
  return null;
}

function safeHost(url) {
  try {
    return new URL(/^https?:/.test(url) ? url : 'http://' + url).hostname.toLowerCase();
  } catch { return ''; }
}

function parseServiceUrlsEnv(value) {
  const out = new Map();
  if (!value) return out;
  for (const part of String(value).split(',')) {
    const [name, url] = part.split('=');
    if (name && url) out.set(name.trim(), url.trim());
  }
  return out;
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
