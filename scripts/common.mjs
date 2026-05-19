import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

export const ROOT = process.cwd();
export const BRAIN_DIR = path.join(ROOT, '.project-brain');
export const SKILL_DIR = path.join(ROOT, 'skills', 'project-brain');
export const VECTOR_DIR = path.join(BRAIN_DIR, 'vector-db');
export const LANCE_DIR = VECTOR_DIR;
export const JSON_INDEX = path.join(BRAIN_DIR, 'search_index.json');
export const MANIFEST = path.join(BRAIN_DIR, 'index_manifest.json');
export const SYNC_STATE = path.join(BRAIN_DIR, '.sync-state.json');
export const SYNC_BG_LOG = path.join(BRAIN_DIR, '.sync-bg.log');

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

/** One row per source file in the index; detects ghost paths and content drift vs on-disk files. */
export function staleIndexFromRecords(records = []) {
  const deleted = new Set();
  const changed = new Set();
  const seen = new Set();
  for (const record of records) {
    if (!record.file || record.file.startsWith('.project-brain/project-summary') || record.type?.endsWith('-summary')) continue;
    if (seen.has(record.file)) continue;
    seen.add(record.file);
    const full = path.isAbsolute(record.file) ? record.file : path.join(ROOT, record.file);
    if (!exists(full)) {
      deleted.add(record.file);
      continue;
    }
    if (record.hash) {
      const current = sha256(read(full));
      if (current !== record.hash) changed.add(record.file);
    }
  }
  return { deleted: [...deleted], changed: [...changed] };
}
export function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'untitled'; }

export function isFastMode() {
  return process.env.BRAIN_FAST === '1';
}

export function classifyChange(file) {
  if (!file) return 'ignored';
  if (file.startsWith('.project-brain/sessions/')) return 'ignored';
  if (file.startsWith('.project-brain/.sync-')) return 'ignored';
  if (file.startsWith('.project-brain/') && /\.md$/i.test(file)) return 'brain-relevant';
  return 'code-relevant';
}

export function classifyChanges(files) {
  const counts = { brain: 0, code: 0, ignored: 0, total: files.length };
  for (const file of files) {
    const kind = classifyChange(file);
    if (kind === 'brain-relevant') counts.brain++;
    else if (kind === 'code-relevant') counts.code++;
    else counts.ignored++;
  }
  return counts;
}

export function readSyncState() {
  if (!exists(SYNC_STATE)) return null;
  try { return JSON.parse(read(SYNC_STATE)); } catch { return null; }
}

export function writeSyncState(state) {
  ensureDir(BRAIN_DIR);
  atomicWrite(SYNC_STATE, JSON.stringify({ ts: new Date().toISOString(), ...state }, null, 2));
}

export function gitBranchSafe() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

export function mergePackageScripts(pkg) {
  pkg.scripts ||= {};
  const scripts = {
    'brain:init': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-init.mjs',
    'brain:index': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-index.mjs',
    'brain:search': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-search.mjs',
    'brain:ask': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-ask.mjs',
    'brain:sync': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-sync.mjs',
    'brain:guard': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-guard.mjs',
    'brain:health': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-health.mjs',
    'brain:session': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-session.mjs',
    'brain:lease': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-lease.mjs',
    'brain:work': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-work.mjs',
    'brain:pr': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-pr.mjs',
    'brain:ticket': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-ticket.mjs',
    'brain:orchestrate': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-orchestrate.mjs',
    'brain:worktree': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-worktree.mjs',
    'brain:pack': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-pack.mjs',
    'brain:symbol': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-search.mjs --type code --symbol',
    'brain:impact': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-impact.mjs',
    'brain:graph': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-graph.mjs',
    'brain:eval': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-eval.mjs',
    'brain:maintain': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-maintain.mjs',
    'brain:compact': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-compact.mjs',
    'brain:prune': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-prune.mjs',
    'brain:digest': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-session-digest.mjs',
    'brain:adr': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-adr.mjs',
    'brain:lint-conventions': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-lint-conventions.mjs',
    'brain:link-check': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-link-check.mjs',
    'brain:install-cursor-hooks': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/install-cursor-hooks.mjs',
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
  if (!pkg.optionalDependencies.typescript) pkg.optionalDependencies.typescript = '^5.6.0';
  return pkg;
}

export async function listIndexableFiles() {
  const { default: fg } = await import('fast-glob');
  const patterns = [
    '.project-brain/**/*.md',
    'README.md',
    'docs/**/*.md',
    'scripts/**/*.{mjs,js,ts,tsx}',
    'app/**/*.{ts,tsx,js,jsx,md,mdx}',
    'pages/**/*.{ts,tsx,js,jsx,md,mdx}',
    'components/**/*.{ts,tsx,js,jsx,md,mdx}',
    'lib/**/*.{ts,tsx,js,jsx,md,mdx}',
    'src/**/*.{ts,tsx,js,jsx,md,mdx}',
    'server/**/*.{ts,tsx,js,jsx,md,mdx}',
    'actions/**/*.{ts,tsx,js,jsx,md,mdx}',
    'packages/**/*.{ts,tsx,js,jsx,md,mdx}',
    'apps/**/*.{ts,tsx,js,jsx,md,mdx}',
    'hooks/**/*.{ts,tsx,js,jsx}',
    'workers/**/*.{ts,tsx,js,jsx}',
    'api/**/*.{ts,tsx,js,jsx}',
    'tests/**/*.{ts,tsx,js,jsx,md,mdx}',
    'test/**/*.{ts,tsx,js,jsx,md,mdx}',
    'e2e/**/*.{ts,tsx,js,jsx,md,mdx}',
    '__tests__/**/*.{ts,tsx,js,jsx}',
    'shared/**/*.{ts,tsx,js,jsx,md,mdx}',
    'internal/**/*.{ts,tsx,js,jsx,md,mdx}',
    'modules/**/*.{ts,tsx,js,jsx,md,mdx}',
    'features/**/*.{ts,tsx,js,jsx,md,mdx}',
    'types/**/*.{ts,tsx,md,mdx}',
    'tooling/**/*.{mjs,js,ts,tsx}',
    'config/**/*.{mjs,js,ts,tsx,md,mdx}'
  ];
  const extra = (process.env.BRAIN_INDEX_EXTRA_GLOBS || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return fg([...patterns, ...extra], {
    cwd: ROOT,
    dot: true,
    onlyFiles: true,
    ignore: [
      '**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', '**/coverage/**',
      '.project-brain/vector-db/**', '.project-brain/search_index.json', '.project-brain/index_manifest.json',
      '.project-brain/.sync-state.json', '.project-brain/.sync-bg.log',
      '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
      ...(process.env.BRAIN_INDEX_AUTO_COMPACT === '0'
        ? []
        : ['.project-brain/sessions/**/*__auto-compact__*.md'])
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

/** Coerce common YAML/frontmatter boolean strings to boolean; unknown stays falsy for flags. */
export function truthyFrontmatter(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Drop paths ignored by Git (uses repo .gitignore / exclude). Opt-in: BRAIN_INDEX_GITIGNORE=1.
 * Cheap batch: `git check-ignore -z --stdin`.
 */
export function filterGitignoredRelativePaths(paths) {
  if (process.env.BRAIN_INDEX_GITIGNORE !== '1' || !paths.length) return paths;
  const input = Buffer.from(paths.join('\0') + '\0', 'utf8');
  const r = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    maxBuffer: Math.max(8 * 1024 * 1024, paths.length * 256)
  });
  if (r.error || (r.status != null && r.status !== 0 && r.status !== 1)) return paths;
  const ignored = new Set();
  const outStr = r.stdout || '';
  if (outStr) for (const p of outStr.split('\0')) if (p) ignored.add(p);
  return paths.filter((p) => !ignored.has(p));
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
