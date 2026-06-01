/**
 * Fleet-mode project discovery.
 *
 * Walks one level deep under a fleet root, classifies each subdirectory by
 * the presence of language/stack markers (package.json, go.mod, pyproject.toml,
 * Chart.yaml, kustomization.yaml, Dockerfile, *.proto, *.tf), and returns
 * one ProjectDescriptor per detected project. When the list has ≥ 2 entries
 * (and BRAIN_FLEET_MODE doesn't explicitly disable it), the brain switches
 * into fleet mode and records get tagged with `project: <name>`.
 *
 * Single-project repos return 0 or 1 projects and stay on the existing
 * single-root code path. Activation rule: see isFleetMode().
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKERS = {
  node: ['package.json'],
  go: ['go.mod'],
  python: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'],
  helm: ['Chart.yaml'],
  kustomize: ['kustomization.yaml', 'kustomization.yml'],
  docker: ['Dockerfile'],
  terraform: ['main.tf', 'terraform.tf']
};

const SKIP_DIRS = new Set(['node_modules', 'skills', '.git', 'tests', '__tests__', 'dist', 'build', 'coverage', '.next', '.turbo']);

/** Classify a directory by language/stack markers. Returns string[] of detected kinds. */
export function projectKindsForDir(absDir) {
  const kinds = [];
  for (const [kind, markers] of Object.entries(MARKERS)) {
    if (markers.some(m => fs.existsSync(path.join(absDir, m)))) kinds.push(kind);
  }
  // Proto: any top-level .proto file.
  try {
    for (const entry of fs.readdirSync(absDir)) {
      if (entry.endsWith('.proto')) { kinds.push('proto'); break; }
    }
  } catch {}
  return kinds;
}

/**
 * Discover sibling projects under `root`. Returns ProjectDescriptor[] sorted by name.
 * Throws on duplicate project basenames.
 *
 * Nested containers: a depth-1 directory with no markers of its own (e.g. a
 * `modules/` monorepo holding many sibling Go modules) is invisible to the
 * depth-1 scan. Opt in via `BRAIN_FLEET_NESTED_DIRS=modules` (comma list) or
 * `opts.nested` to descend one extra level into each named container and add
 * each marker-bearing child as a project (name = child basename,
 * dir = `<container>/<child>`). Default OFF — unset, behavior is unchanged.
 *
 * @param {string} root - absolute fleet root
 * @param {{exclude?: string|string[], projects?: string|string[], nested?: string|string[]}} [opts]
 */
export function discoverProjects(root, opts = {}) {
  const exclude = new Set(splitList(opts.exclude ?? process.env.BRAIN_FLEET_EXCLUDE));
  const explicit = splitList(opts.projects ?? process.env.BRAIN_FLEET_PROJECTS);
  const explicitSet = new Set(explicit);
  const nested = new Set(splitList(opts.nested ?? process.env.BRAIN_FLEET_NESTED_DIRS));

  const projects = [];
  const seen = new Set();
  let rootReal;
  const resolveRootReal = () => (rootReal ??= fs.realpathSync(root));

  // Add one candidate dir as a project. `parentAbs` is its containing dir;
  // `relPrefix` (POSIX) is prepended to the basename to form `dir`.
  const addCandidate = (entry, parentAbs, relPrefix = '') => {
    const isDir = entry.isDirectory() || entry.isSymbolicLink();
    if (!isDir) return;
    if (entry.name.startsWith('.')) return;
    if (SKIP_DIRS.has(entry.name)) return;
    if (exclude.has(entry.name)) return;
    if (explicitSet.size && !explicitSet.has(entry.name)) return;

    const absDir = path.join(parentAbs, entry.name);
    // Reject symlinks that resolve to the fleet root itself or to an ancestor —
    // these are self-loops (e.g. a `project-brain -> .` symlink) and would
    // cause discoverProjects to report the host repo as its own subproject.
    if (entry.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync(absDir); } catch { return; }
      const rr = resolveRootReal();
      if (real === rr || rr.startsWith(real + path.sep)) return;
    }
    const kinds = projectKindsForDir(absDir);
    if (!kinds.length) return;

    if (seen.has(entry.name)) {
      throw new Error(`Duplicate project name "${entry.name}" under ${root}; project names must be unique across the fleet.`);
    }
    seen.add(entry.name);

    projects.push({
      name: entry.name,
      dir: relPrefix ? path.posix.join(relPrefix, entry.name) : entry.name,
      kinds,
      git: fs.existsSync(path.join(absDir, '.git')),
      hasReadme: ['README.md', 'README.MD', 'readme.md', 'Readme.md'].some(r => fs.existsSync(path.join(absDir, r)))
    });
  };

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) addCandidate(entry, root);

  // Descend one level into opt-in nested container dirs (e.g. `modules/`).
  for (const container of nested) {
    if (exclude.has(container)) continue;
    const containerAbs = path.join(root, container);
    let childEntries;
    try { childEntries = fs.readdirSync(containerAbs, { withFileTypes: true }); } catch { continue; }
    for (const child of childEntries) addCandidate(child, containerAbs, container);
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Longest-prefix match: which project does this file belong to? */
export function findProjectForFile(filePath, projects) {
  if (!filePath || !projects?.length) return null;
  const norm = String(filePath).replace(/^\.\//, '');
  const sorted = [...projects].sort((a, b) => b.dir.length - a.dir.length);
  for (const p of sorted) {
    if (norm === p.dir) return p;
    if (norm.startsWith(`${p.dir}/`)) return p;
  }
  return null;
}

/**
 * Fleet-mode activation.
 *   BRAIN_FLEET_MODE=0 → always off
 *   BRAIN_FLEET_MODE=1 → always on
 *   unset              → on iff projects.length >= 2
 */
export function isFleetMode(projects) {
  const explicit = process.env.BRAIN_FLEET_MODE;
  if (explicit === '0') return false;
  if (explicit === '1') return true;
  return (projects || []).length >= 2;
}

function splitList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}
