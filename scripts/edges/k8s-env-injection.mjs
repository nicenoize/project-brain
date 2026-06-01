/**
 * k8s-env-injection: directed edges from an orchestrator that *injects*
 * environment variables into a workload spec → the project that *reads*
 * those same variables at runtime.
 *
 * This captures the operator→pod backbone that `env-var` (which only emits
 * undirected "both projects mention the same key" pairs) and the static
 * import detectors cannot see: a Kubernetes operator builds a container env
 * in Go (`corev1.EnvVar{Name: "X", ...}`) or Helm (`env: - name: X`), and a
 * separate service image consumes `os.Getenv("X")`. There is no import or
 * schema edge between them — only the shared key, in a known direction.
 *
 * Injector side (who sets the env on a pod):
 *   - Go: `Name: "KEY"` literals inside files that reference `EnvVar`
 *     (k8s core/v1). `_test.go` excluded.
 *   - Helm/k8s YAML: `- name: KEY` lines beneath an `env:` block.
 * Reader side (who consumes it):
 *   - os.Getenv("KEY") / os.getenv / os.environ[...] / process.env.KEY
 *   - struct tags: `env:"KEY"` / `envconfig:"KEY"`, and viper-style
 *     `mapstructure:"snake_key"` (mapped to upper-snake `SNAKE_KEY`).
 *     The mapstructure→env mapping is a heuristic, but precision stays high
 *     because an edge only forms when the injector *also* sets that exact
 *     upper-cased key as a literal `Name:` — the intersection self-validates.
 *
 * Edge: injector → reader for every key in (injected ∩ read), reader ≠
 * injector. Confidence scales with how many keys overlap (high ≥4, medium
 * ≥2, low 1). Evidence interleaves injection sites and read sites so the
 * edge is verifiable from both ends.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'k8s-env-injection';

const KEY = '[A-Z_][A-Z0-9_]*';
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'testdata']);

async function* detect(ctx) {
  const injectByProject = new Map();  // project -> Map(key -> 'rel:line')
  const readByProject = new Map();    // project -> Map(key -> 'rel:line')

  for (const project of ctx.projects) {
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const injected = new Map();
    const read = new Map();
    walk(projAbs, ctx.ROOT, 6, (abs, rel) => {
      const base = path.basename(abs);
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }

      // --- Injector: Go EnvVar{Name: "X"} ---
      if (base.endsWith('.go') && !base.endsWith('_test.go') && text.includes('EnvVar')) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          for (const m of lines[i].matchAll(new RegExp(`\\bName:\\s*"(${KEY})"`, 'g'))) {
            if (!injected.has(m[1])) injected.set(m[1], `${rel}:${i + 1}`);
          }
        }
      }
      // --- Injector: Helm / k8s YAML `env: - name: X` ---
      if (/\.ya?ml$/.test(base)) {
        const lines = text.split('\n');
        let envIndent = -1;
        for (let i = 0; i < lines.length; i++) {
          const env = lines[i].match(/^(\s*)env:\s*$/);
          if (env) { envIndent = env[1].length; continue; }
          if (envIndent >= 0) {
            const indent = (lines[i].match(/^(\s*)\S/) || [, ''])[1].length;
            if (lines[i].trim() && indent <= envIndent) envIndent = -1; // env block ended
            const nm = lines[i].match(new RegExp(`^\\s*-?\\s*name:\\s*["']?(${KEY})["']?`));
            if (nm && envIndent >= 0 && !injected.has(nm[1])) injected.set(nm[1], `${rel}:${i + 1}`);
          }
        }
      }
      // --- Reader: os.Getenv / process.env / os.environ + config struct tags ---
      if (/\.(go|ts|tsx|js|jsx|mjs|py)$/.test(base)) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const add = k => { if (k && !read.has(k)) read.set(k, `${rel}:${i + 1}`); };
          for (const m of line.matchAll(new RegExp(`os\\.Getenv\\(\\s*"(${KEY})"`, 'g'))) add(m[1]);
          for (const m of line.matchAll(new RegExp(`os\\.getenv\\(\\s*['"](${KEY})['"]`, 'g'))) add(m[1]);
          for (const m of line.matchAll(new RegExp(`process\\.env\\.(${KEY})`, 'g'))) add(m[1]);
          for (const m of line.matchAll(new RegExp(`process\\.env\\[\\s*['"](${KEY})['"]`, 'g'))) add(m[1]);
          for (const m of line.matchAll(new RegExp(`os\\.environ(?:\\[\\s*['"](${KEY})['"]|\\.get\\(\\s*['"](${KEY})['"])`, 'g'))) add(m[1] || m[2]);
          // explicit env struct tags (already upper-snake)
          for (const m of line.matchAll(new RegExp(`(?:env|envconfig):"(${KEY})"`, 'g'))) add(m[1]);
          // viper mapstructure tags: snake_case → SNAKE_CASE
          for (const m of line.matchAll(/mapstructure:"([a-z0-9_]+)"/g)) add(m[1].toUpperCase());
        }
      }
    });
    if (injected.size) injectByProject.set(project.name, injected);
    if (read.size) readByProject.set(project.name, read);
  }

  for (const [injector, injected] of injectByProject) {
    for (const [reader, read] of readByProject) {
      if (reader === injector) continue;
      if (ctx.dirtyProjects.size && !ctx.dirtyProjects.has(injector) && !ctx.dirtyProjects.has(reader)) continue;
      const shared = [...injected.keys()].filter(k => read.has(k)).sort();
      if (!shared.length) continue;
      const confidence = shared.length >= 4 ? 'high' : shared.length >= 2 ? 'medium' : 'low';
      const evidence = [];
      for (const k of shared.slice(0, 3)) evidence.push(injected.get(k));
      for (const k of shared.slice(0, 2)) evidence.push(read.get(k));
      yield {
        from: injector,
        to: reader,
        kind: 'k8s-env-injection',
        evidence: [...new Set(evidence)],
        confidence,
        meta: { keys: shared.slice(0, 20), count: shared.length }
      };
    }
  }
}

function walk(absDir, root, depth, onFile) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;       // .git, .gocache, .next …
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) walk(full, root, depth - 1, onFile);
    else if (entry.isFile()) onFile(full, path.relative(root, full));
  }
}

export default { name: NAME, detect };
