/**
 * Reasoning cache: durable, cited, staleness-tracked agent answers.
 *
 * Today every `brain:ask` is throwaway — an agent synthesizes an answer from
 * chunks and it evaporates, so the brain re-derives the same explanations every
 * session. `brain:explain` captures them as `explainer` records under
 * `.project-brain/explainers/<slug>.md`, each citing the source files it was
 * derived from (path + sha256 of the cited file's content at save time).
 *
 * When a cited source's current content no longer hashes to the recorded value
 * (or the source is gone), the explainer is STALE — its cached answer may be
 * outdated. This is the staleness invalidation that pairs with the drift
 * philosophy (see staleIndexFromRecords in common.mjs).
 *
 * Subcommands:
 *   save  --query "..." [--answer-file <path> | stdin] [--sources a.mjs,b/c.md]
 *         [--actor X]
 *   check [--json] [--strict]
 *   list  [--json]
 *
 * v1 does NOT touch retrieval ranking; a search boost for explainers is a
 * documented follow-up (see SKILL.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  BRAIN_DIR,
  ensureDir,
  exists,
  read,
  write,
  sha256,
  slugify,
  takeFlag,
  takeOption
} from './common.mjs';

const EXPLAINERS_DIR = path.join(BRAIN_DIR, 'explainers');

function usage() {
  return [
    'Usage:',
    '  npm run brain:explain -- save --query "..." [--answer-file <path>] [--sources a.mjs,b/c.md] [--actor X]',
    '    (answer is read from --answer-file or, if omitted, from stdin)',
    '  npm run brain:explain -- check [--json] [--strict]',
    '  npm run brain:explain -- list [--json]'
  ].join('\n');
}

/** Hash a cited source file by its CURRENT on-disk content. Returns null if missing. */
function hashSource(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  if (!exists(abs)) return null;
  return sha256(read(abs));
}

/**
 * Serialize an explainer record to frontmatter markdown.
 * `sources` is a list of { path, sha256 } (sha256 may be null for a missing path).
 */
function serialize({ query, created, updated, actor, sources, body }) {
  const lines = ['---'];
  lines.push('type: explainer');
  lines.push(`query: ${JSON.stringify(query)}`);
  lines.push(`created: ${created}`);
  lines.push(`updated: ${updated}`);
  lines.push(`actor: ${JSON.stringify(actor || '')}`);
  lines.push('sources:');
  for (const s of sources) {
    lines.push(`  - path: ${JSON.stringify(s.path)}`);
    lines.push(`    sha256: ${s.sha256 === null ? 'null' : JSON.stringify(s.sha256)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${body.replace(/\s*$/, '')}\n`;
}

/**
 * Parse an explainer markdown file we wrote. The shared `parseDoc` is
 * line/scalar only and can't read the `sources:` list, so explainers own
 * their (de)serialization. Returns { query, created, updated, actor, sources, body }.
 */
function parseExplainer(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { query: '', created: '', updated: '', actor: '', sources: [], body: content };
  const fmLines = m[1].split('\n');
  const out = { query: '', created: '', updated: '', actor: '', sources: [], body: m[2] || '' };
  let inSources = false;
  let cur = null;
  const unq = (v) => {
    const t = v.trim();
    if (t === 'null') return null;
    try { return JSON.parse(t); } catch { return t.replace(/^["']|["']$/g, ''); }
  };
  for (const line of fmLines) {
    if (/^sources:\s*$/.test(line)) { inSources = true; continue; }
    if (inSources) {
      const pathMatch = line.match(/^\s*-\s*path:\s*(.*)$/);
      if (pathMatch) {
        cur = { path: unq(pathMatch[1]), sha256: null };
        out.sources.push(cur);
        continue;
      }
      const shaMatch = line.match(/^\s*sha256:\s*(.*)$/);
      if (shaMatch && cur) { cur.sha256 = unq(shaMatch[1]); continue; }
      if (/^\S/.test(line)) inSources = false; // a new top-level key ends the list
    }
    if (!inSources) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1];
      if (key === 'query') out.query = unq(kv[2]);
      else if (key === 'created') out.created = kv[2].trim();
      else if (key === 'updated') out.updated = kv[2].trim();
      else if (key === 'actor') out.actor = unq(kv[2]) || '';
    }
  }
  return out;
}

/** Load every explainer record from disk as { slug, file, ...record }. */
function loadExplainers() {
  if (!exists(EXPLAINERS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(EXPLAINERS_DIR).sort()) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(EXPLAINERS_DIR, name);
    const rec = parseExplainer(read(abs));
    out.push({ slug: name.replace(/\.md$/, ''), file: path.join('.project-brain', 'explainers', name), ...rec });
  }
  return out;
}

/**
 * PURE: evaluate staleness for a set of explainers.
 *
 * @param {Array<{slug?:string, query?:string, sources:Array<{path:string, sha256:string|null}>}>} explainers
 * @param {(path:string)=>string|null} hashOf  current hash of a source path, or null if missing.
 * @returns {Array<{slug, query, stale, reasons:Array<{path, status:'ok'|'changed'|'missing'}>}>}
 *
 * An explainer is STALE if any cited source's current hash differs from the
 * recorded one, or the source is gone (hashOf returns null).
 */
export function evaluateExplainers(explainers, hashOf) {
  return explainers.map((e) => {
    const reasons = [];
    let stale = false;
    for (const src of e.sources || []) {
      const current = hashOf(src.path);
      if (current === null || current === undefined) {
        reasons.push({ path: src.path, status: 'missing' });
        stale = true;
      } else if (current !== src.sha256) {
        reasons.push({ path: src.path, status: 'changed' });
        stale = true;
      } else {
        reasons.push({ path: src.path, status: 'ok' });
      }
    }
    return { slug: e.slug, query: e.query, stale, reasons };
  });
}

function cmdSave(args) {
  const query = takeOption(args, '--query').trim();
  if (!query) {
    process.stderr.write('[brain:explain] save requires --query "..."\n');
    process.exit(1);
  }
  const answerFile = takeOption(args, '--answer-file');
  const actor = takeOption(args, '--actor') || process.env.BRAIN_ACTOR || '';
  const sourcesArg = takeOption(args, '--sources');

  let body;
  if (answerFile) {
    const abs = path.isAbsolute(answerFile) ? answerFile : path.join(ROOT, answerFile);
    if (!exists(abs)) {
      process.stderr.write(`[brain:explain] --answer-file not found: ${answerFile}\n`);
      process.exit(1);
    }
    body = read(abs);
  } else {
    body = fs.readFileSync(0, 'utf8'); // stdin
  }
  if (!body.trim()) {
    process.stderr.write('[brain:explain] empty answer (provide --answer-file or pipe text on stdin)\n');
    process.exit(1);
  }

  const sourcePaths = (sourcesArg || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const sources = [];
  for (const sp of sourcePaths) {
    const h = hashSource(sp);
    if (h === null) {
      process.stderr.write(`[brain:explain] warning: cited source not found, recording with null hash: ${sp}\n`);
    }
    sources.push({ path: sp, sha256: h });
  }

  const slug = slugify(query);
  const dest = path.join(EXPLAINERS_DIR, `${slug}.md`);
  const now = new Date().toISOString();

  let created = now;
  if (exists(dest)) {
    const prev = parseExplainer(read(dest));
    if (prev.created) created = prev.created; // idempotent: preserve original created
  }

  ensureDir(EXPLAINERS_DIR);
  write(dest, serialize({ query, created, updated: now, actor, sources, body }));
  process.stdout.write(`${path.relative(ROOT, dest)}\n`);
}

function cmdCheck(args) {
  const json = takeFlag(args, '--json');
  const strict = takeFlag(args, '--strict');
  const explainers = loadExplainers();
  const results = evaluateExplainers(explainers, hashSource);
  const staleCount = results.filter((r) => r.stale).length;

  if (json) {
    process.stdout.write(JSON.stringify({ total: results.length, stale: staleCount, results }, null, 2) + '\n');
  } else {
    if (!results.length) {
      process.stdout.write('No explainers found.\n');
    }
    for (const r of results) {
      const tag = r.stale ? 'STALE' : 'fresh';
      process.stdout.write(`[${tag}] ${r.slug} — ${r.query}\n`);
      if (r.stale) {
        for (const reason of r.reasons) {
          if (reason.status !== 'ok') process.stdout.write(`    ${reason.status}: ${reason.path}\n`);
        }
      }
    }
    process.stdout.write(`\n${results.length} explainer(s), ${staleCount} stale.\n`);
  }

  if (strict && staleCount > 0) process.exit(1);
}

function cmdList(args) {
  const json = takeFlag(args, '--json');
  const explainers = loadExplainers();
  const results = evaluateExplainers(explainers, hashSource);
  const bySlug = new Map(results.map((r) => [r.slug, r]));

  if (json) {
    const rows = explainers.map((e) => ({
      slug: e.slug,
      query: e.query,
      actor: e.actor,
      created: e.created,
      updated: e.updated,
      sources: e.sources.map((s) => s.path),
      stale: bySlug.get(e.slug)?.stale ?? false
    }));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  if (!explainers.length) {
    process.stdout.write('No explainers found.\n');
    return;
  }
  for (const e of explainers) {
    const stale = bySlug.get(e.slug)?.stale ?? false;
    process.stdout.write(`${stale ? 'stale' : 'fresh'}  ${e.slug} — ${e.query}\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const sub = args.shift();

  if (help || !sub) {
    console.log(usage());
    process.exit(help ? 0 : 1);
  }

  try {
    if (sub === 'save') return cmdSave(args);
    if (sub === 'check') return cmdCheck(args);
    if (sub === 'list') return cmdList(args);
    process.stderr.write(`[brain:explain] unknown subcommand: ${sub}\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`[brain:explain] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
