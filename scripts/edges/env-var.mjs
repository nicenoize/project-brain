/**
 * env-var: cross-project edges when ≥ 2 projects reference the same env
 * variable key. Indicates a shared dependency (DB, broker, downstream URL).
 *
 * Sources scanned per project:
 *   - .env*, .env.example
 *   - Dockerfile ENV
 *   - docker-compose*.yml services.*.environment
 *   - Helm values.yaml env / envFrom
 *   - k8s Deployment containers[*].env[*].name
 *   - source-code references: process.env.X, os.Getenv("X"), os.environ.get("X")
 *
 * Confidence:
 *   - high   for *_URL / *_HOST / KAFKA_* / *_TOPIC / DATABASE_URL / *_DSN
 *   - low    for NODE_ENV / PORT / LOG_LEVEL / DEBUG / HOME / PATH (generic)
 *   - medium otherwise
 *
 * Also publishes facts.envKeysByProject = Map<project, Set<key>> for the
 * pubsub + db-shared detectors to consume.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'env-var';

const HIGH_RX = /(_URL$|_HOST$|^KAFKA_|_TOPIC$|^DATABASE_URL$|_DSN$|_BROKER|_QUEUE$|_BUCKET$|_REGION$)/;
const LOW_KEYS = new Set(['NODE_ENV', 'PORT', 'LOG_LEVEL', 'DEBUG', 'HOME', 'PATH', 'USER', 'TZ', 'LANG', 'PYTHONPATH']);

async function* detect(ctx) {
  const envKeysByProject = new Map();
  const lineCitations = new Map(); // `${key}|${project}` -> Set('file:line')

  for (const project of ctx.projects) {
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const keys = new Set();
    scanEnvSources(projAbs, ctx.ROOT, keys, (key, citation) => {
      const k = `${key}|${project.name}`;
      if (!lineCitations.has(k)) lineCitations.set(k, new Set());
      lineCitations.get(k).add(citation);
    });
    envKeysByProject.set(project.name, keys);
  }
  ctx.facts.set('envKeysByProject', envKeysByProject);

  // Invert: key -> Set(project)
  const byKey = new Map();
  for (const [project, keys] of envKeysByProject) {
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(project);
    }
  }

  for (const [key, projectSet] of byKey) {
    if (projectSet.size < 2) continue;
    const projects = [...projectSet].sort();
    const confidence = HIGH_RX.test(key) ? 'high' : LOW_KEYS.has(key) ? 'low' : 'medium';
    // Pairwise edges, both directions per pair.
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const a = projects[i], b = projects[j];
        const evidence = [
          ...(lineCitations.get(`${key}|${a}`) || []),
          ...(lineCitations.get(`${key}|${b}`) || [])
        ].sort().slice(0, 5);
        yield {
          from: a, to: b, kind: 'env-shared',
          evidence, confidence,
          meta: { key }
        };
      }
    }
  }
}

function scanEnvSources(absDir, root, keysOut, cite) {
  const addKey = (key, citation) => {
    const k = String(key).trim();
    if (!k || !/^[A-Z_][A-Z0-9_]*$/.test(k)) return;
    keysOut.add(k);
    if (citation) cite(k, citation);
  };

  walkShallow(absDir, root, 4, (abs, rel) => {
    const name = path.basename(abs);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const lines = text.split('\n');

    if (/^\.env(\..+)?$|^\.env\.example$/.test(name)) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
        if (m) addKey(m[1], `${rel}:${i + 1}`);
      }
    }
    if (name === 'Dockerfile' || /^Dockerfile\..+$/.test(name) || name === 'Containerfile') {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*ENV\s+([A-Z_][A-Z0-9_]*)\s*[=\s]/);
        if (m) addKey(m[1], `${rel}:${i + 1}`);
      }
    }
    if (/docker-compose.*\.ya?ml$/.test(name) || /values\.ya?ml$/.test(name) || /\.ya?ml$/.test(name)) {
      // Look for `name: KEY_NAME` under env blocks; or `KEY: value` in environment.
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s+(?:-\s+)?name:\s*['"]?([A-Z_][A-Z0-9_]*)['"]?/);
        if (m) addKey(m[1], `${rel}:${i + 1}`);
        const eq = lines[i].match(/^\s+([A-Z_][A-Z0-9_]+):\s*['"]?[^#{]/);
        if (eq && eq[1] === eq[1].toUpperCase()) addKey(eq[1], `${rel}:${i + 1}`);
      }
    }
    if (/\.(ts|tsx|js|jsx|mjs|go|py)$/.test(name)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // process.env.X / process.env['X']
        for (const m of line.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) addKey(m[1], `${rel}:${i + 1}`);
        for (const m of line.matchAll(/process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g)) addKey(m[1], `${rel}:${i + 1}`);
        // Go: os.Getenv("X")
        for (const m of line.matchAll(/os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g)) addKey(m[1], `${rel}:${i + 1}`);
        // Python: os.environ["X"] / os.environ.get("X") / os.getenv("X")
        for (const m of line.matchAll(/os\.environ(?:\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"])/g)) {
          addKey(m[1] || m[2], `${rel}:${i + 1}`);
        }
        for (const m of line.matchAll(/os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) addKey(m[1], `${rel}:${i + 1}`);
      }
    }
  });
}

function walkShallow(absDir, root, depth, onFile) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor' || entry.name === 'dist' || entry.name === 'build') continue;
    if (entry.name.startsWith('.') && !/^\.env/.test(entry.name)) continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) walkShallow(full, root, depth - 1, onFile);
    else if (entry.isFile()) onFile(full, path.relative(root, full));
  }
}

export default { name: NAME, detect };
