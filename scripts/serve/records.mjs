/**
 * serve/records.mjs — freshness metadata + the .project-brain record helpers.
 *
 * Two responsibilities that belong together because both answer "what does the
 * brain already say, and how old is it":
 *   · freshness()/liveMeta(): the state_age/stale_warning pair every API
 *     response carries (Praktiken-Katalog: freshness on every answer);
 *   · the record/doc vocabulary: frontmatter parsing, module globs, the
 *     module↔file mapping, and the traversal-safe ?file= resolver.
 *
 * PURE apart from the three functions that read files (freshness, listRecords,
 * resolveBrainDoc's symlink check). Every name here is re-exported from
 * brain-serve.mjs — brain-mcp.mjs and brain-answer.mjs import several of them
 * so the MCP answer, the ambient answer and the Control Room can never
 * disagree about which ADR governs a file.
 */
import fs from 'node:fs';
import path from 'node:path';
// Canonical glob engine (same one brain:radar/brief/lease use) — the
// Doc-Navigator's module→file mapping must never disagree with lease overlap.
import { targetMatchesFile } from '../lease-overlap.mjs';
import { sendJson } from './security.mjs';

const STALE_AFTER_S = Number(process.env.BRAIN_SERVE_STALE_S || 24 * 3600);

const RECORD_DIRS = Object.freeze({
  decision: 'decisions',
  grill: 'grills',
  finding: 'findings'
});

/** mtime-based freshness metadata for a state file (Praktiken-Katalog). */
export function freshness(file, nowMs = Date.now(), staleAfterS = STALE_AFTER_S) {
  try {
    const st = fs.statSync(file);
    const age = Math.max(0, Math.round((nowMs - st.mtimeMs) / 1000));
    const hours = Math.round(age / 360) / 10;
    return {
      state_age: age,
      stale_warning: age > staleAfterS
        ? `${path.basename(file)} last changed ${hours}h ago — data may be stale`
        : null
    };
  } catch {
    return { state_age: null, stale_warning: `${path.basename(file)} not found — empty state` };
  }
}

/** PURE. Frontmatter `title:`, else first `# ` heading, else ''. */
export function frontmatterTitle(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (fm) {
    const m = /^title:\s*(.+)\s*$/m.exec(fm[1]);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  const h = /^#\s+(.+)\s*$/m.exec(text || '');
  return h ? h[1].trim() : '';
}

/**
 * List record markdown files for a type (decision|grill|finding) with their
 * frontmatter titles. Read-only; unknown type → null (caller sends 400).
 */
export function listRecords(root, type) {
  const dirName = RECORD_DIRS[type];
  if (!dirName) return null;
  const dir = path.join(root, '.project-brain', dirName);
  const records = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) {
        let title = '';
        try { title = frontmatterTitle(fs.readFileSync(p, 'utf8').slice(0, 4096)); } catch {}
        records.push({ file: path.relative(root, p), title });
      }
    }
  };
  walk(dir);
  records.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return records;
}

// ---------------------------------------------------------------------------
// Doc-Navigator helpers (/api/map, /api/doc, /api/why) — pure, exported for
// tests. Deliberately NOT a doc generator: nothing here reads code to invent
// prose. It reads the human/agent-authored .project-brain records, derives the
// file globs they already name, and measures the drift between the two.
// ---------------------------------------------------------------------------

/** Record folders the map counts. Separate from RECORD_DIRS on purpose:
 *  /api/records' public type vocabulary must not shift underneath it. */
export const DOC_DIRS = Object.freeze({
  decisions: 'decisions',
  modules: 'modules',
  features: 'features',
  findings: 'findings',
  insights: 'insights'
});

export const MAX_DOC_BYTES = 64 * 1024;
const MAX_MODULE_GLOBS = 40;
export const MAX_WHY_HISTORY = 5;
export const MAX_ORPHAN_DIRS = 40;
export const ORPHAN_SCAN_DEPTH = 3;
export const CODE_EXT_RE = /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|swift|php|cs|scala|sh|vue|svelte|c|h|cc|cpp|hpp)$/i;
// Extensions that make a slash-less backtick span a FILE rather than a dotted
// identifier — keeps `app.mjs` in and `record.symbols` out.
const KNOWN_FILE_EXT_RE = /\.(m?[jt]sx?|cjs|json|md|mdx|ya?ml|toml|sh|py|go|rs|rb|java|kt|swift|php|cs|css|scss|html|txt|lock|sql|proto|vue|svelte)$/i;
export const SKIP_TOP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp', 'temp',
  'venv', '__pycache__', 'target', '.project-brain'
]);

/** Read at call time so tests (and users) can flip the threshold per process. */
export function staleDocDays() {
  const n = Number(process.env.BRAIN_STALE_DOC_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** PURE. Repo-relative normalization: strip `./`, unify separators. */
export function normPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * PURE. Frontmatter key/values + body — same shape as common.mjs parseDoc but
 * CRLF-tolerant and never throwing. Nested YAML (findings' `sources:` list)
 * is skipped by the key regex, which is exactly what callers want here.
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { data: {}, body: String(text || '') };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: m[2] || '' };
}

/**
 * PURE. Repo paths a record NAMES in backticks (`scripts/retrieval.mjs`,
 * `scripts/**`). This is the honest source for a module's fileGlobs: the
 * author already wrote which files the module owns — we just read them back
 * instead of inferring ownership from the code.
 */
export function extractPaths(text, { limit = MAX_MODULE_GLOBS } = {}) {
  const out = [];
  const seen = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = normPath(m[1]);
    if (!raw || raw.length > 200) continue;
    if (!/^[\w.@\-/*]+$/.test(raw)) continue;      // prose, commands, code → out
    if (raw.includes('/')) {
      // A path or glob: needs a star or a file extension, else it is a bare dir
      // reference like `scripts/` that would over-claim the whole tree.
      if (!raw.includes('*') && !/\.[A-Za-z0-9]{1,8}$/.test(raw)) continue;
    } else if (!KNOWN_FILE_EXT_RE.test(raw)) {
      // No slash: only a real filename counts (`app.mjs`), never an identifier
      // the prose happens to dot-qualify (`record.symbols`, `store.search`).
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * PURE. A module record's file globs: an explicit frontmatter list wins
 * (`globs:`/`fileGlobs:`/`files:`, comma-separated), else the paths its body
 * names. Explicit-first means a record can always override the derivation.
 */
export function moduleGlobs(data = {}, body = '') {
  const explicit = String(data.globs ?? data.fileGlobs ?? data.files ?? '').trim();
  if (explicit) {
    return [...new Set(explicit.split(',').map(normPath).filter(Boolean))].slice(0, MAX_MODULE_GLOBS);
  }
  return extractPaths(body);
}

/** PURE. Canonical glob/dir/exact match, delegated to the lease engine. */
export function globMatchesFile(glob, file) {
  const g = normPath(glob);
  const f = normPath(file);
  if (!g || !f) return false;
  if (g === f) return true;
  try { return targetMatchesFile(g, f); } catch { return false; }
}

/** PURE. Path heuristic mirroring brain-radar/infer's inferModule. */
export function inferModuleFromPath(file) {
  const f = normPath(file);
  if (!f) return '';
  if (f.includes('/modules/')) return path.basename(f, path.extname(f));
  const parts = f.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) {
    return parts.slice(0, 2).join('/');
  }
  return path.dirname(f) === '.' ? '' : path.dirname(f);
}

/**
 * PURE. The module owning a file: the first module record whose globs match,
 * else the path heuristic. `modules` is the loadDocRecords() shape.
 */
export function moduleForFile(file, modules = []) {
  const f = normPath(file);
  for (const rec of modules) {
    if ((rec.globs || []).some((g) => globMatchesFile(g, f))) return rec.module || rec.name;
  }
  return inferModuleFromPath(f);
}

/**
 * PURE. Module aliases used to match records by their `module:` frontmatter —
 * same widening brain:radar applies (ADRs curate short module names like
 * `retrieval` while a path infers `scripts/retrieval`).
 */
export function moduleAliases(module, file = '') {
  const last = String(module || '').split('/').filter(Boolean).pop() || '';
  const stem = file ? path.basename(normPath(file), path.extname(normPath(file))) : '';
  return new Set([module, last, stem].map((s) => String(s || '').trim()).filter(Boolean));
}

/** PURE. First real paragraph of a record body (headings/links skipped). */
export function summarize(body, max = 220) {
  for (const block of String(body || '').split(/\r?\n\s*\r?\n/)) {
    const t = block.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('|')) continue;
    const flat = t.replace(/\s+/g, ' ').replace(/^[-*]\s+/, '');
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }
  return '';
}

/**
 * PURE. The "why" excerpt of an ADR: the Decision section if the record has
 * one (that IS the answer), else Context, else the opening paragraph.
 */
export function decisionExcerpt(body, max = 280) {
  for (const heading of ['Decision', 'Context']) {
    // No `m` flag on purpose: `$` must mean end-of-record, not end-of-line,
    // or the lazy body capture stops after the section's first line.
    const re = new RegExp(`(?:^|\\n)#{1,6}[ \\t]+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}[ \\t]|$)`, 'i');
    const m = re.exec(String(body || ''));
    if (m && m[1].trim()) return summarize(m[1], max);
  }
  return summarize(body, max);
}

/**
 * Resolve a `?file=` doc parameter to an absolute path INSIDE
 * <root>/.project-brain, or null when it must be rejected (400). Rejects:
 * absolute paths (posix + windows drive), NUL bytes, non-.md, and anything
 * that escapes the brain dir after resolution — including via a symlink,
 * which is re-checked against the real path. A leading `.project-brain/` is
 * accepted (that is how every record is addressed elsewhere in the API).
 */
export function resolveBrainDoc(root, rel) {
  if (typeof rel !== 'string') return null;
  const raw = rel.trim();
  if (!raw || raw.length > 1024) return null;
  if (raw.includes('\0')) return null;
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const norm = normPath(raw);
  if (!/\.md$/i.test(norm)) return null;
  const brainDir = path.resolve(root, '.project-brain');
  const inner = norm.replace(/^\.project-brain\/+/, '');
  const resolved = path.resolve(brainDir, inner);
  const inside = (p) => p === brainDir || p.startsWith(brainDir + path.sep);
  if (!inside(resolved)) return null;
  try {
    // Symlink escape: a link inside the brain dir pointing out of it. Both
    // sides are realpath'd — on macOS the root itself is often reached through
    // a symlink (/var → /private/var), which would otherwise reject every doc.
    if (fs.existsSync(resolved)) {
      const realBrain = fs.realpathSync(brainDir);
      const realDoc = fs.realpathSync(resolved);
      if (realDoc !== realBrain && !realDoc.startsWith(realBrain + path.sep)) return null;
    }
  } catch { /* unreadable → let the caller 404 on read */ }
  return resolved;
}

/** PURE. `[[wiki-link]]` targets a record body names (deduped, bounded). */
export function wikiLinks(body, limit = 60) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    const id = m[1].trim().replace(/\.md$/i, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// endpoint: /api/records
// ---------------------------------------------------------------------------

/** Live-computed responses report age 0 by construction (like apiIntel). */
export function liveMeta() {
  return { state_age: 0, stale_warning: null, generated_at: new Date().toISOString() };
}

export function apiRecords(api, res, url) {
  const { root, brainDir } = api;
  const type = url.searchParams.get('type') || '';
  const records = listRecords(root, type);
  if (records === null) {
    return sendJson(res, 400, { error: `unknown record type "${type}" — expected one of: ${Object.keys(RECORD_DIRS).join(', ')}` });
  }
  const dir = path.join(brainDir, RECORD_DIRS[type]);
  let newest = null;
  for (const r of records) {
    try {
      const m = fs.statSync(path.join(root, r.file)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {}
  }
  if (newest === null) return sendJson(res, 200, { type, records, ...freshness(dir) });
  // Records are durable documents — age is informational, never a warning.
  const age = Math.max(0, Math.round((Date.now() - newest) / 1000));
  sendJson(res, 200, { type, records, state_age: age, stale_warning: null });
}
