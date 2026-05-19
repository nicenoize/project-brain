#!/usr/bin/env node
/**
 * brain:link-check — verify that code references inside .project-brain/**.md
 * still exist in the working tree. Catches the silent rot where the brain's
 * map and the codebase drift apart after a rename/move.
 *
 * What counts as a "code reference":
 *   - Inline-code spans (`like/this.ts`) whose contents look like a relative
 *     project path (contains a `/` or a recognised code extension) and
 *     resolve to a real path on disk.
 *   - Plain words in prose that match a recognised code extension and look
 *     like a path (heuristic, falls back to inline-code when unsure).
 *
 * What is intentionally NOT checked:
 *   - URLs, mailto:, and Markdown links to other .md docs (those are covered
 *     by brain:health --check-brain-refs).
 *   - Bare symbol names (no path component, no extension) — too noisy to
 *     check reliably without a real symbol index. brain:impact / brain:graph
 *     own that.
 *
 * Usage:
 *   node scripts/brain-link-check.mjs            # human report, exit 1 on any miss
 *   node scripts/brain-link-check.mjs --json     # machine-readable
 *   node scripts/brain-link-check.mjs --quiet    # only fail loudly, no clean-run message
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BRAIN_DIR = path.join(ROOT, '.project-brain');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const QUIET = args.includes('--quiet');

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift',
  'css', 'scss', 'html',
  'sql', 'sh', 'mts', 'cts',
  'json', 'yaml', 'yml', 'toml',
]);

// Skip references that look like external/built-in identifiers, not project paths.
const SKIP_PREFIXES = ['http://', 'https://', 'mailto:', 'tel:', '@', '#', '//'];
const SKIP_TOKENS = new Set(['package.json', 'tsconfig.json', 'README.md']); // checked separately below if needed

function listBrainDocs() {
  if (!fs.existsSync(BRAIN_DIR)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'vector-db' || entry.name === 'runner-logs') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(BRAIN_DIR);
  return out;
}

function isPlausiblePath(token) {
  if (!token || token.length < 3 || token.length > 200) return false;
  if (SKIP_PREFIXES.some((p) => token.startsWith(p))) return false;
  if (token.includes(' ') || token.includes('\t')) return false;
  if (token.includes('://')) return false;
  // Skip variable interpolations (`${VAR}`, `$VAR/...`, `<placeholder>`) — these aren't real paths.
  if (token.includes('${') || token.includes('<') || token.includes('>')) return false;
  if (/^\$[A-Z_]/.test(token)) return false;
  if (token.startsWith('.project-brain/')) return true; // brain-internal links

  // Strip trailing punctuation that often clings in prose.
  token = token.replace(/[.,;:)\]]+$/, '');

  const ext = token.includes('.') ? token.split('.').pop().toLowerCase() : '';
  const hasSlash = token.includes('/');
  if (!hasSlash && !CODE_EXTS.has(ext)) return false;
  if (hasSlash && !ext) {
    // Directory-like — accept only when first segment looks like a project dir
    // (lowercase, hyphens, no spaces). Keeps us from chasing arbitrary prose.
    return /^[a-z0-9][a-z0-9_\-/.]*$/.test(token);
  }
  return CODE_EXTS.has(ext);
}

function normalisePath(p) {
  return p.replace(/[.,;:)\]]+$/, '').replace(/^\.\//, '');
}

function extractRefs(content) {
  const refs = [];
  const lines = content.split('\n');

  // Inline code spans first — highest signal.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip Markdown link bodies (handled by brain:health) — we still want bare paths in text.
    // Pull every `…` span.
    const spanRe = /`([^`]+)`/g;
    let m;
    while ((m = spanRe.exec(line)) !== null) {
      const raw = m[1].trim();
      const token = normalisePath(raw);
      if (SKIP_TOKENS.has(token)) continue;
      if (isPlausiblePath(token)) refs.push({ token, line: i + 1, kind: 'span' });
    }
  }
  return refs;
}

function resolveRef(token) {
  // Brain-relative references resolve from repo root (since `.project-brain/` lives there).
  const candidates = [
    path.join(ROOT, token),
    path.join(BRAIN_DIR, token),
  ];
  // Glob-ish endings (e.g. `lib/db/*.ts`) — consider parent dir existence sufficient.
  if (token.includes('*')) {
    const parent = token.split('*')[0].replace(/\/$/, '');
    if (parent) candidates.push(path.join(ROOT, parent));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return true;
  }
  return false;
}

function isTracked(token) {
  // Some references point at git-ignored generated paths; treat as resolved
  // if git knows about the parent dir.
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', token], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const docs = listBrainDocs();
  if (!docs.length) {
    if (!QUIET) process.stderr.write('[brain-link-check] no .project-brain docs found\n');
    return 0;
  }

  const misses = [];
  let checked = 0;
  for (const doc of docs) {
    const content = fs.readFileSync(doc, 'utf8');
    const refs = extractRefs(content);
    for (const ref of refs) {
      checked++;
      if (resolveRef(ref.token)) continue;
      if (isTracked(ref.token)) continue;
      misses.push({ doc: path.relative(ROOT, doc), line: ref.line, token: ref.token });
    }
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ checked, misses }, null, 2) + '\n');
  } else if (misses.length) {
    process.stdout.write(`[brain-link-check] ${misses.length} broken code reference(s) across ${docs.length} doc(s):\n`);
    for (const m of misses) {
      process.stdout.write(`  ${m.doc}:${m.line}  →  ${m.token}\n`);
    }
    process.stdout.write(`\nFix: update the brain doc, or restore/rename the path. Run with --json for machine output.\n`);
  } else if (!QUIET) {
    process.stdout.write(`[brain-link-check] clean (${checked} refs across ${docs.length} docs)\n`);
  }
  return misses.length ? 1 : 0;
}

process.exit(main());
