import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = process.cwd();
export const BRAIN_DIR = path.join(ROOT, '.project-brain');
export const SKILL_DIR = path.join(ROOT, 'skills', 'project-brain');
export const VECTOR_DIR = path.join(BRAIN_DIR, 'vector-db');
export const LANCE_DIR = VECTOR_DIR;
export const JSON_INDEX = path.join(BRAIN_DIR, 'search_index.json');
export const MANIFEST = path.join(BRAIN_DIR, 'index_manifest.json');

export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
export function exists(p) { return fs.existsSync(p); }
export function read(p, fallback = '') { return exists(p) ? fs.readFileSync(p, 'utf8') : fallback; }
export function write(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, data); }
export function atomicWrite(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
export function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
export function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'untitled'; }

export function mergePackageScripts(pkg) {
  pkg.scripts ||= {};
  const scripts = {
    'brain:init': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-init.mjs',
    'brain:index': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-index.mjs',
    'brain:search': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-search.mjs',
    'brain:sync': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-sync.mjs',
    'brain:guard': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-guard.mjs',
    'brain:health': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-health.mjs',
    'brain:session': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-session.mjs',
    'brain:pack': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-pack.mjs',
    'brain:install-hooks': 'bash skills/project-brain/bin/install-hooks.sh',
    'brain:update-skill': 'bash skills/project-brain/bin/update.sh'
  };
  for (const [k, v] of Object.entries(scripts)) {
    if (!pkg.scripts[k] || pkg.scripts[k].includes('skills/project-brain/')) pkg.scripts[k] = v;
  }
  return pkg;
}

export function mergePackageDeps(pkg) {
  pkg.dependencies ||= {};
  const deps = {
    '@xenova/transformers': '^2.17.2',
    'fast-glob': '^3.3.2'
  };
  for (const [k, v] of Object.entries(deps)) {
    if (!pkg.dependencies[k] && !(pkg.devDependencies && pkg.devDependencies[k])) pkg.dependencies[k] = v;
  }
  pkg.optionalDependencies ||= {};
  if (!pkg.optionalDependencies['@lancedb/lancedb']) pkg.optionalDependencies['@lancedb/lancedb'] = '^0.9.0';
  return pkg;
}

export async function listIndexableFiles() {
  const { default: fg } = await import('fast-glob');
  const patterns = [
    '.project-brain/**/*.md',
    'README.md',
    'docs/**/*.md',
    'app/**/*.{ts,tsx,js,jsx,md,mdx}',
    'pages/**/*.{ts,tsx,js,jsx,md,mdx}',
    'components/**/*.{ts,tsx,js,jsx,md,mdx}',
    'lib/**/*.{ts,tsx,js,jsx,md,mdx}',
    'src/**/*.{ts,tsx,js,jsx,md,mdx}',
    'server/**/*.{ts,tsx,js,jsx,md,mdx}',
    'actions/**/*.{ts,tsx,js,jsx,md,mdx}'
  ];
  return fg(patterns, {
    cwd: ROOT,
    dot: true,
    onlyFiles: true,
    ignore: [
      '**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', '**/coverage/**',
      '.project-brain/vector-db/**', '.project-brain/search_index.json', '.project-brain/index_manifest.json',
      '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock'
    ]
  });
}

export function chunkText(text, maxChars = 1800, overlap = 250) {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(i + maxChars, clean.length);
    let slice = clean.slice(i, end);
    const lastBreak = slice.lastIndexOf('\n## ');
    if (lastBreak > 400 && end < clean.length) slice = slice.slice(0, lastBreak);
    chunks.push(slice.trim());
    i += Math.max(1, slice.length - overlap);
  }
  return chunks.filter(Boolean);
}

export function parseDoc(file, content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatter) return { file, data: {}, body: content };
  const data = {};
  for (const line of frontmatter[1].split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return { file, data, body: frontmatter[2] || '' };
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
