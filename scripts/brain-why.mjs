/**
 * brain:why — git archaeology (the temporal axis).
 *
 * Makes git history queryable knowledge so an agent can answer
 * "why is this code like this?".
 *
 *   npm run brain:why -- ingest [--limit N] [--since <ref>]
 *       Run `git log` (subject + body + changed files) and write one Markdown
 *       record per commit under .project-brain/history/<shortsha>.md with
 *       frontmatter `type: history`, `sha`, `date`, `author`, `subject`, and a
 *       body of: commit message + changed-files list + extracted ADR / Closes #
 *       / Fixes # references. Optionally enriched with PR bodies via `gh` when
 *       available (degrades gracefully when absent).
 *
 *   npm run brain:why -- "<question>" [--json] [--top N]
 *       Retrieve `type: history` records to answer the question; prints the top
 *       commits/PRs with sha/date/subject + any linked ADR refs.
 *
 * Ingest is explicit (a one-time / occasional pass) — it is NOT wired into
 * brain:sync. Records are regenerable from git, so .project-brain/history/ is
 * gitignored. History records become indexed automatically: infer.mjs maps the
 * path to `type: history` (see the integration manifest).
 *
 * Record (de)serialization follows the findings.mjs / brain-explain.mjs pattern
 * (frontmatter md owned here, since the shared parseDoc is scalar-only and can't
 * carry the nested `references:` list). Pure parsing helpers are exported so the
 * git-log parser is unit-testable without a real repo/index/model.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  BRAIN_DIR,
  JSON_INDEX,
  MANIFEST,
  ensureDir,
  exists,
  read,
  write,
  takeFlag,
  takeOption
} from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';
import { retrieve } from './retrieval.mjs';

export const HISTORY_DIR = path.join(BRAIN_DIR, 'history');

// Unit/record-separator control chars: safe field/record delimiters for a
// `git log --pretty` format because commit metadata never contains them.
const FIELD_SEP = ''; // US — between fields of one commit
const RECORD_SEP = ''; // RS — between commits

function usage() {
  return [
    'Usage:',
    '  npm run brain:why -- ingest [--limit N] [--since <ref>]',
    '      Build .project-brain/history/<shortsha>.md records from `git log`.',
    '  npm run brain:why -- "why is this code like this?" [--top N] [--json]',
    '      Retrieve history records to answer the question.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PURE parsing helpers (exported for unit tests — no git/store/embedder)
// ---------------------------------------------------------------------------

/**
 * Extract ADR / issue references from a commit message body.
 * Returns a de-duplicated, order-preserving list of short tokens like
 * `ADR 0017`, `ADR-0014`, `Closes #12`, `Fixes #3`.
 */
export function extractReferences(message) {
  const text = String(message || '');
  const out = [];
  const seen = new Set();
  const push = (token) => {
    const t = token.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  // ADR references: "ADR 0017", "ADR-0014", "ADR0014", "adr #5".
  for (const m of text.matchAll(/\bADR[\s#-]*(\d{1,4})\b/gi)) {
    push(`ADR ${m[1].padStart(4, '0')}`);
  }
  // Issue/PR closers: "Closes #123", "Fixes #45", "Resolves #7", "Close/Fix/Resolve".
  for (const m of text.matchAll(/\b(clos|fix|resolv)e?[sd]?\s+#(\d+)\b/gi)) {
    const verb = m[1].toLowerCase();
    const label = verb === 'clos' ? 'Closes' : verb === 'fix' ? 'Fixes' : 'Resolves';
    push(`${label} #${m[2]}`);
  }
  return out;
}

/**
 * PURE: parse the delimited `git log` output produced by `gitLogArgs()` into
 * structured commit records.
 *
 * Each record block is FIELD_SEP-joined:
 *   shortsha, sha, isoDate, authorName, subject, body
 * followed by a "--FILES--" marker line and then the NUL-free changed-file
 * paths (one per line, from `--name-only`). Blocks are RECORD_SEP-separated.
 *
 * @returns {Array<{shortSha, sha, date, author, subject, body, changedFiles, references}>}
 */
export function parseGitLog(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const records = [];
  for (const block of raw.split(RECORD_SEP)) {
    const trimmed = block.replace(/^\s+/, '');
    if (!trimmed) continue;
    const [meta, filesPart = ''] = trimmed.split('--FILES--');
    const fields = meta.split(FIELD_SEP);
    const [shortSha = '', sha = '', date = '', author = '', subject = '', ...bodyParts] = fields;
    if (!sha.trim() && !shortSha.trim()) continue;
    const body = bodyParts.join(FIELD_SEP).trim();
    const changedFiles = filesPart
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const refSource = `${subject}\n${body}`;
    records.push({
      shortSha: shortSha.trim(),
      sha: sha.trim(),
      date: date.trim(),
      author: author.trim(),
      subject: subject.trim(),
      body,
      changedFiles,
      references: extractReferences(refSource)
    });
  }
  return records;
}

/** Render a frontmatter scalar: plain tokens bare, anything else JSON-quoted. */
function fmScalar(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  if (/^[A-Za-z0-9 _\-:/.,()@+]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/** Inverse of fmScalar. */
function unq(value) {
  const t = String(value ?? '').trim();
  if (t === 'null') return null;
  try { return JSON.parse(t); } catch { return t.replace(/^["']|["']$/g, ''); }
}

/**
 * Serialize a parsed commit record to frontmatter markdown.
 * The body is the commit message followed by a changed-files list and any
 * extracted ADR / Closes/Fixes references, so retrieval matches on all three.
 */
export function serializeHistory(rec) {
  const lines = ['---'];
  lines.push('type: history');
  lines.push(`sha: ${fmScalar(rec.shortSha || rec.sha)}`);
  lines.push(`fullSha: ${fmScalar(rec.sha)}`);
  lines.push(`date: ${fmScalar(rec.date)}`);
  lines.push(`author: ${fmScalar(rec.author)}`);
  lines.push(`subject: ${fmScalar(rec.subject)}`);
  lines.push('---');

  const out = [lines.join('\n'), ''];
  out.push(`# ${rec.subject || rec.shortSha || rec.sha}`);
  out.push('');
  if (rec.body) {
    out.push(rec.body.trim());
    out.push('');
  }
  if (rec.references && rec.references.length) {
    out.push('## References');
    out.push('');
    for (const ref of rec.references) out.push(`- ${ref}`);
    out.push('');
  }
  if (rec.prBody) {
    out.push('## Pull request');
    out.push('');
    out.push(rec.prBody.trim());
    out.push('');
  }
  out.push('## Changed files');
  out.push('');
  if (rec.changedFiles && rec.changedFiles.length) {
    for (const file of rec.changedFiles) out.push(`- ${file}`);
  } else {
    out.push('- (none)');
  }
  out.push('');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n';
}

/**
 * PURE: parse a history record markdown file we wrote. Mirrors the
 * findings.mjs/brain-explain.mjs parsers (scalar frontmatter + a list section,
 * here `## References`). Returns { sha, fullSha, date, author, subject, references, body }.
 */
export function parseHistory(content) {
  const m = String(content || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { sha: '', fullSha: '', date: '', author: '', subject: '', references: [], body: content || '' };
  const out = { sha: '', fullSha: '', date: '', author: '', subject: '', references: [], body: m[2] || '' };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'sha') out.sha = unq(kv[2]) || '';
    else if (kv[1] === 'fullSha') out.fullSha = unq(kv[2]) || '';
    else if (kv[1] === 'date') out.date = unq(kv[2]) || '';
    else if (kv[1] === 'author') out.author = unq(kv[2]) || '';
    else if (kv[1] === 'subject') out.subject = unq(kv[2]) || '';
  }
  // References live under a "## References" section as "- <ref>" bullets.
  // Walk lines: collect bullets after the heading until the next "## " heading.
  let inRefs = false;
  for (const line of out.body.split('\n')) {
    if (/^##\s+References\s*$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (/^##\s+/.test(line)) break; // next section ends the list
    const b = line.match(/^\s*-\s+(.*\S)\s*$/);
    if (b) out.references.push(b[1].trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// git / gh plumbing (impure, exercised via the spawn integration test)
// ---------------------------------------------------------------------------

/** Build the `git log` argv that produces the delimited format parseGitLog reads. */
export function gitLogArgs({ limit, since } = {}) {
  // %H full sha, %h short sha, %aI author ISO date, %an author, %s subject, %b body.
  const pretty = `%h${FIELD_SEP}%H${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%s${FIELD_SEP}%b--FILES--`;
  const args = ['log', `--pretty=format:${RECORD_SEP}${pretty}`, '--name-only', '--no-color'];
  if (limit && Number(limit) > 0) args.push(`-n${Number(limit)}`);
  if (since) args.push(`${since}..HEAD`);
  return args;
}

function runGitLog(opts) {
  const r = spawnSync('git', gitLogArgs(opts), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git log failed (status ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout || '';
}

/** True if the `gh` CLI is installed and authenticated (best-effort, never throws). */
function ghAvailable() {
  try {
    const r = spawnSync('gh', ['auth', 'status'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Build a map of issue/PR number → PR body via `gh`, for the issue numbers
 * referenced by the parsed commits. Degrades to an empty map on any failure or
 * when gh is absent — enrichment is optional, never fatal.
 */
function fetchPrBodies(records) {
  const map = new Map();
  if (!ghAvailable()) return map;
  const numbers = new Set();
  for (const rec of records) {
    for (const ref of rec.references || []) {
      const m = ref.match(/#(\d+)/);
      if (m) numbers.add(m[1]);
    }
  }
  if (!numbers.size) return map;
  for (const num of numbers) {
    try {
      const r = spawnSync('gh', ['pr', 'view', num, '--json', 'number,title,body'], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      if (r.error || r.status !== 0 || !r.stdout) continue;
      const data = JSON.parse(r.stdout);
      const body = [data.title, data.body].filter(Boolean).join('\n\n').trim();
      if (body) map.set(String(data.number), body);
    } catch {
      // skip this number, keep going
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function cmdIngest(args) {
  const limitRaw = takeOption(args, '--limit');
  const since = takeOption(args, '--since');
  const json = takeFlag(args, '--json');
  const limit = limitRaw ? Number(limitRaw) : 0;
  if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
    process.stderr.write(`[brain:why] --limit must be a positive integer, got: ${limitRaw}\n`);
    process.exit(1);
  }

  const out = runGitLog({ limit, since });
  const records = parseGitLog(out);
  if (!records.length) {
    if (json) process.stdout.write(JSON.stringify({ ingested: 0, dir: relFromRoot(HISTORY_DIR) }, null, 2) + '\n');
    else process.stdout.write('[brain:why] no commits found to ingest.\n');
    return;
  }

  const prBodies = fetchPrBodies(records);
  ensureDir(HISTORY_DIR);
  const written = [];
  for (const rec of records) {
    const slug = (rec.shortSha || rec.sha).trim();
    if (!slug) continue;
    let prBody = '';
    for (const ref of rec.references || []) {
      const m = ref.match(/#(\d+)/);
      if (m && prBodies.has(m[1])) prBody = prBodies.get(m[1]);
    }
    const dest = path.join(HISTORY_DIR, `${slug}.md`);
    write(dest, serializeHistory({ ...rec, prBody }));
    written.push(relFromRoot(dest));
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      ingested: written.length,
      dir: relFromRoot(HISTORY_DIR),
      prEnriched: prBodies.size,
      files: written
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`[brain:why] ingested ${written.length} commit(s) → ${relFromRoot(HISTORY_DIR)}/\n`);
    if (prBodies.size) process.stdout.write(`[brain:why] enriched ${prBodies.size} record(s) with PR bodies via gh.\n`);
    process.stdout.write('[brain:why] run `npm run brain:index` (or brain:sync) to make them searchable.\n');
  }
}

async function cmdQuery(args, query) {
  const json = takeFlag(args, '--json');
  const topRaw = takeOption(args, '--top');
  const topK = topRaw && Number(topRaw) > 0 ? Number(topRaw) : Number(process.env.BRAIN_TOP_K || 8);

  if (!exists(JSON_INDEX) && !exists(MANIFEST)) {
    // No index yet → tell the user how to build one (don't crash on a fresh repo).
    const msg = 'No semantic index found. Run: npm run brain:why -- ingest && npm run brain:index';
    if (json) { process.stdout.write(JSON.stringify({ query, results: [], note: msg }, null, 2) + '\n'); return; }
    process.stderr.write(`[brain:why] ${msg}\n`);
    process.exit(1);
  }

  const manifest = exists(MANIFEST) ? JSON.parse(read(MANIFEST)) : {};
  const embedder = openEmbedder();
  const store = await openStore({ model: manifest.model || embedder.modelName, dims: manifest.dims || embedder.dims });
  let results;
  try {
    results = await retrieve(query, store, embedder, {
      topK,
      filter: { type: 'history' }
    });
  } finally {
    await store.close();
  }

  // Decorate each hit with parsed sha/date/subject/references from the source
  // file when available (retrieval returns a chunk, not the full record).
  const decorated = results.map((r) => decorateHit(r));

  if (json) {
    process.stdout.write(JSON.stringify({ query, results: decorated.map(toJson) }, null, 2) + '\n');
    return;
  }

  if (!decorated.length) {
    process.stdout.write('No history records matched. Did you run `npm run brain:why -- ingest` and `npm run brain:index`?\n');
    return;
  }
  process.stdout.write(`Why: ${query}\n`);
  for (const r of decorated) {
    const head = [r.sha && `[${r.sha}]`, r.date && r.date.slice(0, 10), r.subject || r.title]
      .filter(Boolean)
      .join(' ');
    process.stdout.write(`\n• ${head}  (score ${r.score.toFixed(3)})\n`);
    if (r.author) process.stdout.write(`    author: ${r.author}\n`);
    if (r.references && r.references.length) {
      process.stdout.write(`    refs: ${r.references.join(', ')}\n`);
    }
    process.stdout.write(`    ${r.file}\n`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function relFromRoot(p) {
  return path.relative(ROOT, p) || p;
}

/** Merge a retrieval hit with the parsed source record (sha/date/subject/refs). */
function decorateHit(r) {
  const base = {
    file: r.file,
    title: r.title,
    score: r.score,
    sha: '',
    fullSha: '',
    date: '',
    author: '',
    subject: '',
    references: [],
    text: r.text
  };
  try {
    const abs = path.isAbsolute(r.file) ? r.file : path.join(ROOT, r.file);
    if (exists(abs)) {
      const parsed = parseHistory(read(abs));
      base.sha = parsed.sha;
      base.fullSha = parsed.fullSha;
      base.date = parsed.date;
      base.author = parsed.author;
      base.subject = parsed.subject;
      base.references = parsed.references;
    }
  } catch {
    // fall back to the chunk-only view
  }
  return base;
}

function toJson(r) {
  return {
    sha: r.sha,
    fullSha: r.fullSha,
    date: r.date,
    author: r.author,
    subject: r.subject || r.title,
    references: r.references,
    file: r.file,
    score: r.score
  };
}

async function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  if (help) { process.stdout.write(usage() + '\n'); process.exit(0); }

  const first = args[0];
  if (!first) { process.stderr.write(usage() + '\n'); process.exit(1); }

  try {
    if (first === 'ingest') {
      args.shift();
      return cmdIngest(args);
    }
    // Anything else is treated as a free-text question. Strip flags handled by
    // the query path, then join the remaining tokens into the query string.
    const json = takeFlag(args, '--json');
    const top = takeOption(args, '--top');
    const query = args.join(' ').trim();
    if (!query) { process.stderr.write(usage() + '\n'); process.exit(1); }
    // Re-thread the consumed flags so cmdQuery's own takeFlag/takeOption see them.
    const passthrough = [];
    if (json) passthrough.push('--json');
    if (top) passthrough.push('--top', top);
    return await cmdQuery(passthrough, query);
  } catch (error) {
    process.stderr.write(`[brain:why] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
