import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { buildUsageRecord, usageCmdFromScript } from './usage.mjs';
// Static import forms a benign ESM cycle (common↔friction): friction never
// touches common's bindings at load time, and it defers findings.mjs to a lazy
// require, so importing it here does NOT evaluate findings.mjs during common's
// own init. See friction.mjs's header + the createRequire note there.
import { instrumentFriction } from './friction.mjs';

/**
 * PURE-ish (reads fs + one env var, never writes). Resolve the project root the
 * brain operates on. The CLI (bin/cli.mjs, ADR 0028) can be invoked from any
 * subdirectory of a consuming repo, so ROOT can no longer be a bare
 * process.cwd(). Resolution order:
 *
 *   1. BRAIN_ROOT env override (tests, unusual layouts) — used verbatim.
 *   2. Nearest ancestor (incl. startDir) containing a `.project-brain/` dir —
 *      a brain-enabled root wins even inside nested git repos.
 *   3. Nearest ancestor containing `.git` (dir or worktree/submodule file) —
 *      repo root before `brain:init` has run.
 *   4. startDir itself — preserves the old cwd semantics for bare temp dirs
 *      and non-repo contexts (the test suite's mkdtemp fixtures rely on this).
 */
export function findRoot(startDir = process.cwd()) {
  if (process.env.BRAIN_ROOT) return path.resolve(process.env.BRAIN_ROOT);
  const start = path.resolve(startDir);
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const markers = [
    { name: '.project-brain', hit: isDir },              // must be a directory
    { name: '.git', hit: (p) => fs.existsSync(p) }       // dir, or file in worktrees/submodules
  ];
  for (const marker of markers) {
    let dir = start;
    for (;;) {
      if (marker.hit(path.join(dir, marker.name))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return start;
}

export const ROOT = findRoot();
/** Root of the project-brain package itself (parent of scripts/), independent of cwd. */
export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BRAIN_DIR = path.join(ROOT, '.project-brain');
export const SKILL_DIR = path.join(ROOT, 'skills', 'project-brain');
export const VECTOR_DIR = path.join(BRAIN_DIR, 'vector-db');
export const LANCE_DIR = VECTOR_DIR;
export const JSON_INDEX = path.join(BRAIN_DIR, 'search_index.json');
export const MANIFEST = path.join(BRAIN_DIR, 'index_manifest.json');
export const SYNC_STATE = path.join(BRAIN_DIR, '.sync-state.json');
export const SYNC_BG_LOG = path.join(BRAIN_DIR, '.sync-bg.log');
export const USAGE_LOG = path.join(BRAIN_DIR, '.usage.jsonl');
export const DIRTY_FILES = path.join(BRAIN_DIR, '.dirty-files');

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

// Shrink-guard defaults (#20 item 1). Below MIN_FLOOR records we never guard
// (cold/initial builds legitimately grow from ~0). Above it, a write that
// keeps < RATIO of the prior record count is treated as a truncation/partial
// run and blocked unless forced. Tunable via env for huge or unusual repos.
export const SHRINK_GUARD_MIN_FLOOR = Number(process.env.BRAIN_SHRINK_GUARD_MIN_FLOOR || 50);
export const SHRINK_GUARD_RATIO = Number(process.env.BRAIN_SHRINK_GUARD_RATIO || 0.5);

/**
 * Decide whether a destructive overwrite that shrinks a maintained artifact
 * (the index/store JSON mirror) should be blocked. Pure + unit-tested; wired
 * into the store's persist path so a truncation bug or partial run can't
 * silently destroy a good index.
 *
 * Only SIGNIFICANT shrink is blocked — incremental deletes and modest trims
 * (e.g. a handful of flag-gated records toggled off) still write freely. When
 * a large shrink IS intentional (a flag-gated record type like BRAIN_RATIONALE
 * turned off, or a deliberate rebuild), the caller passes `--force`, which the
 * stderr message names explicitly.
 *
 * @returns {{blocked: boolean, reason?: string}}
 */
export function shrinkGuard({
  oldCount = 0,
  newCount = 0,
  force = false,
  minFloor = SHRINK_GUARD_MIN_FLOOR,
  ratio = SHRINK_GUARD_RATIO,
} = {}) {
  if (force) return { blocked: false };
  if (!(oldCount >= minFloor)) return { blocked: false }; // cold/tiny index: never guard
  if (newCount >= oldCount) return { blocked: false };    // growth or steady-state
  const keptRatio = newCount / oldCount;
  if (keptRatio >= ratio) return { blocked: false };      // modest shrink: allow
  return {
    blocked: true,
    reason:
      `refusing to overwrite index: ${oldCount} → ${newCount} records ` +
      `(would drop ${oldCount - newCount}, keeping ${Math.round(keptRatio * 100)}% — ` +
      `below the ${Math.round(ratio * 100)}% floor). ` +
      `This looks like a truncation or partial run; the existing index was left untouched. ` +
      `If the shrink is intentional (deliberate rebuild, or a flag-gated record type such as ` +
      `BRAIN_RATIONALE toggled off), re-run with --force.`,
  };
}

/** One row per source file in the index; detects ghost paths and content drift vs on-disk files. */
export function staleIndexFromRecords(records = []) {
  const deleted = new Set();
  const changed = new Set();
  const seen = new Set();
  for (const record of records) {
    if (!record.file) continue;
    // Synthetic aggregate records (project-summary, module/feature/package-summary,
    // decision-cluster) carry a placeholder `file` path that intentionally doesn't
    // exist on disk; they are derived from indexed children, not from a source file.
    if (record.file.startsWith('.project-brain/project-summary')) continue;
    if (record.file.includes('.project-brain/decisions/__cluster__/')) continue;
    if (record.file.includes('.project-brain/fleet/edges/')) continue;
    if (record.type?.endsWith('-summary')) continue;
    if (record.type === 'decision-cluster' || record.type === 'repo-summary' || record.type === 'fleet-summary' || record.type === 'cross-project-edge') continue;
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
  if (file === '.project-brain/.dirty-files') return 'ignored';
  if (file === '.project-brain/.usage.jsonl') return 'ignored';
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

// ---------------------------------------------------------------------------
// "Which files changed" primitive (issue #35) — the post-edit dirty-file
// staging list, shared between the PostToolUse hook (producer) and
// `brain:sync --if-stale` (consumer). It closes the staleness window at the
// source: the moment a file is edited, its path is staged here; the next sync
// re-indexes exactly those files (bounded, no full-corpus cost). It is a cheap
// signal + accelerator only — the index manifest stays the source of truth, so
// losing/clearing this list never corrupts anything (sync's hash-diff recovers).
// Coordinates with the #23 query-time staleness banner (retrieval.staleResults),
// which is the read-time consumption side of the same "drifted files" idea.
// ---------------------------------------------------------------------------

// Trees the brain never indexes / would never re-sync — never stage them (and
// crucially exclude `.project-brain` itself so the hook can't stage its own
// bookkeeping and loop). Mirrors the exclusions in brain-route-tool's matcher.
const DIRTY_EXCLUDE_RE = /(^|\/)(node_modules|\.git|dist|build|\.next|out|coverage|vendor|\.project-brain|\.cache|\.venv|__pycache__|\.worktrees)(\/|$)/;
const DIRTY_GENERATED_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/;

/**
 * PURE. Normalise a raw edited path into a repo-relative, forward-slashed path
 * worth staging — or '' when it is not something the brain would re-index
 * (outside root, generated lockfile, or in a vendored/build/brain-internal
 * tree). Never touches disk. `opts.root` defaults to ROOT.
 */
export function dirtyPathFor(rawPath, opts = {}) {
  const root = opts.root || ROOT;
  let s = String(rawPath || '').trim();
  if (!s) return '';
  if (path.isAbsolute(s)) {
    const rel = path.relative(root, s);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''; // outside root
    s = rel;
  }
  s = s.split(path.sep).join('/').replace(/^\.\//, '');
  if (!s || s.startsWith('../')) return '';
  if (DIRTY_EXCLUDE_RE.test(s)) return '';
  if (DIRTY_GENERATED_RE.test(s)) return '';
  return s;
}

/** Read the staged dirty-file list (deduped, order-preserving). Missing/corrupt → []. */
export function readDirtyFiles(dirtyPath = DIRTY_FILES) {
  try {
    const raw = read(dirtyPath, '');
    if (!raw) return [];
    const seen = new Set();
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  } catch { return []; }
}

/**
 * Append one already-normalised relative path to the dirty list, atomically and
 * deduped. Returns true when newly added, false when empty/duplicate. Bounded:
 * dedup keeps the file from growing without limit. Atomic via atomicWrite
 * (read → dedup → rename) so a concurrent reader never sees a torn line.
 */
export function appendDirtyFile(relPath, dirtyPath = DIRTY_FILES) {
  const rel = String(relPath || '').trim();
  if (!rel) return false;
  const cur = readDirtyFiles(dirtyPath);
  if (cur.includes(rel)) return false;
  cur.push(rel);
  atomicWrite(dirtyPath, cur.join('\n') + '\n');
  return true;
}

/** Clear the staged dirty-file list (best-effort; absent → no-op). */
export function clearDirtyFiles(dirtyPath = DIRTY_FILES) {
  try { if (exists(dirtyPath)) fs.unlinkSync(dirtyPath); } catch { /* soft — never throw */ }
}

export function gitBranchSafe() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/** Resolve the git toplevel for an arbitrary directory (used by fleet per-project git ops). */
export function gitRootOf(dir) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
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
    'brain:verify': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-verify.mjs',
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
    'brain:state-digest': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-state-digest.mjs',
    'brain:adr': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-adr.mjs',
    'brain:lint-conventions': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-lint-conventions.mjs',
    'brain:link-check': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-link-check.mjs',
    'brain:install-cursor-hooks': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/install-cursor-hooks.mjs',
    'brain:install-hooks': 'bash skills/project-brain/bin/install-hooks.sh',
    'brain:update-skill': 'bash skills/project-brain/bin/update.sh',
    'brain:edges': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-edges.mjs',
    'brain:projects': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-projects.mjs',
    'brain:speckit': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-speckit.mjs',
    'brain:repair': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-repair.mjs',
    'brain:handoff': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-handoff.mjs',
    'brain:feature': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-feature.mjs',
    'brain:explain': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-explain.mjs',
    'brain:brief': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-brief.mjs',
    'brain:audit': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-audit.mjs',
    'brain:improve': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-improve.mjs',
    'brain:diagram': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-diagram.mjs',
    'brain:skill-audit': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-skill-audit.mjs',
    'brain:radar': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-radar.mjs',
    'brain:why': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-why.mjs',
    'brain:gaps': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-gaps.mjs',
    'brain:insight': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-insight.mjs',
    'brain:learn': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-learn.mjs',
    'brain:grill': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-grill.mjs',
    'brain:route': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-route.mjs',
    'brain:close': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-close.mjs',
    'brain:reflect': 'node --preserve-symlinks --preserve-symlinks-main skills/project-brain/scripts/brain-reflect.mjs'
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

export async function listIndexableFiles(opts = {}) {
  const root = opts.root || ROOT;
  const { default: fg } = await import('fast-glob');
  const patterns = [
    '.project-brain/**/*.md',
    // Root-level markdown (README, CONTRIBUTING, SKILL, CHANGELOG, ...).
    // Eval failure analysis showed CONTRIBUTING.md-style targets were
    // unwinnable because only README.md was listed (docs/eval-failure-analysis.md).
    '*.md',
    'docs/**/*.md',
    // Repo plumbing newcomers ask about: setup/update scripts, scaffold
    // templates (incl. extensionless git hooks), CI workflow definitions.
    'bin/**/*.{sh,mjs,js}',
    'templates/**/*.{md,mdc,yml,yaml,json,sh}',
    'templates/hooks/*',
    '.github/workflows/*.{yml,yaml}',
    'scripts/**/*.{mjs,js,ts,tsx}',
    'app/**/*.{ts,tsx,js,jsx,md,mdx}',
    'pages/**/*.{ts,tsx,js,jsx,md,mdx}',
    'components/**/*.{ts,tsx,js,jsx,md,mdx}',
    'lib/**/*.{ts,tsx,js,jsx,md,mdx}',
    'src/**/*.{ts,tsx,js,jsx,md,mdx}',
    'server/**/*.{ts,tsx,js,jsx,md,mdx}',
    'actions/**/*.{ts,tsx,js,jsx,md,mdx}',
    'packages/**/*.{ts,tsx,js,jsx,md,mdx}',
    'pkg/**/*.{ts,tsx,js,jsx,md,mdx}',
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
    'config/**/*.{mjs,js,ts,tsx,md,mdx}',
    // Spec-kit artifacts (github/spec-kit). Indexed gracefully when present;
    // single-project repos without these dirs see no records.
    '.specify/**/*.md',
    'specs/**/*.md',
    'specs/**/*.{yml,yaml,json}'
  ];
  // Polyglot symbol extraction (Python/Go) is gated OFF by default. When
  // BRAIN_POLYGLOT_SYMBOLS=1, widen the file listing so .py/.go sources are
  // discovered and fed through the lite extractor. Unset → byte-for-byte
  // unchanged file set. Tree-sitter precision is the documented follow-up.
  const polyglotPatterns = process.env.BRAIN_POLYGLOT_SYMBOLS === '1'
    ? [
        '**/*.py',
        '**/*.go'
      ]
    : [];
  const extra = (process.env.BRAIN_INDEX_EXTRA_GLOBS || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return fg([...patterns, ...polyglotPatterns, ...extra], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    ignore: [
      '**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', '**/coverage/**',
      // Vendored deps + language build caches — never index these (esp. with
      // BRAIN_POLYGLOT_SYMBOLS=1, which globs **/*.go|**/*.py under dot:true and
      // would otherwise pull in a whole Go module cache).
      '**/vendor/**', '**/.gocache/**', '**/.go/pkg/**', '**/__pycache__/**', '**/.venv/**', '**/.tox/**',
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
export function filterGitignoredRelativePaths(paths, opts = {}) {
  if (process.env.BRAIN_INDEX_GITIGNORE !== '1' || !paths.length) return paths;
  const cwd = opts.root || ROOT;
  const input = Buffer.from(paths.join('\0') + '\0', 'utf8');
  const r = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd,
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

/** Remove a boolean flag from argv (in-place). Returns true if present. */
export function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** Remove `--name value` from argv (in-place). Returns the value or ''. */
export function takeOption(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  const value = args[i + 1] || '';
  args.splice(i, value ? 2 : 1);
  return value;
}

/** Read `--name value` from argv without mutating. Returns the value or ''. */
export function peekOption(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  return args[i + 1] || '';
}

/** Split a comma/newline-delimited env var into trimmed non-empty entries. */
export function splitEnv(name) {
  return (process.env[name] || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// --- Usage ledger (issue #32) -----------------------------------------------
// A QUANTITY/footprint instrument, distinct from #28's quality events. Gated
// behind BRAIN_USAGE_LOG=1: zero writes and zero overhead when off. Append-only,
// fail-silent, sidecar — it must never break or slow a command.

/** Append one usage record as a JSONL line. Fail-silent, append-only, sidecar. */
export function appendUsageRecord(record, logPath = USAGE_LOG) {
  try {
    ensureDir(path.dirname(logPath));
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    return true;
  } catch {
    // The ledger is measurement, never load-bearing — swallow all I/O errors.
    return false;
  }
}

let usageInstrumented = false;

/**
 * THE single choke point. When BRAIN_USAGE_LOG=1, instrument the current
 * brain:* process so exactly one JSONL line is appended on exit. Called once at
 * module load (below), so every command that imports common.mjs — directly or
 * transitively — is logged with no per-script wiring. Returns whether it armed.
 *
 * Guarantees: returns immediately (no listeners, no stdout wrapping, no writes)
 * when the flag is off, and only arms for a recognised `brain-*.mjs` entry point
 * (so embed/aggregate workers and test runners are never logged as commands).
 */
export function instrumentUsage(argv = process.argv) {
  if (process.env.BRAIN_USAGE_LOG !== '1') return false;
  if (usageInstrumented) return false;
  const cmd = usageCmdFromScript(argv && argv[1]);
  if (!cmd) return false;
  usageInstrumented = true;

  const startMs = Date.now();
  let stdoutBytes = 0;
  try {
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
      try {
        stdoutBytes += Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8');
      } catch { /* non-buffer/odd chunk — ignore in the counter only */ }
      return orig(chunk, enc, cb);
    };
  } catch { /* stdout not writable/patchable — still log with stdoutBytes=0 */ }

  process.on('exit', (code) => {
    appendUsageRecord(
      buildUsageRecord({
        cmd,
        ts: new Date().toISOString(),
        exitCode: code,
        stdoutBytes,
        durationMs: Date.now() - startMs
      })
    );
  });
  return true;
}

// Arm the ledger at import time (the choke point). No-op unless BRAIN_USAGE_LOG=1.
instrumentUsage();

// Arm the friction sensors at import time (issue #28) — the QUALITY-event
// sibling of the usage ledger above. instrumentFriction() is a no-op (single env
// check, no listeners, no writes) unless BRAIN_FRICTION_LOG=1, and registers its
// exit handler SYNCHRONOUSLY so a process.exit(1) failure is still captured. The
// try/catch keeps self-observation from ever breaking a command.
try { instrumentFriction(); } catch { /* friction is best-effort */ }
