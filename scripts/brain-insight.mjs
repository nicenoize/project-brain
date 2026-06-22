/**
 * brain:insight — synthesized cross-source insights (synthesis axis, GATED).
 *
 * A durable record type for SYNTHESIZED claims that span MULTIPLE sources, not
 * raw chunks. Like brain:adr / brain:audit, this command is a SCAFFOLD + recorder:
 * it does NOT call an LLM. The agent does the synthesis (using brain:search /
 * pack / impact to gather evidence); the command records the result with
 * guardrails. This keeps the brain extractive and the LLM at the edge.
 *
 * Where an `explainer` caches one answer to one question, an `insight` is a
 * higher-order claim derived by reasoning ACROSS sources ("the retrieval ranker
 * and the indexer disagree on chunk identity"). To protect the trust axis from
 * hallucinated claims, an insight MUST cite >= 2 sources — an ungrounded
 * synthesis is refused.
 *
 * Records live at .project-brain/insights/<slug>.md as frontmatter Markdown so
 * the indexer (inferType in infer.mjs) picks them up and they become retrievable
 * via `brain:search --type insight`. Like explainers/findings, each source is
 * stored as { path, sha256 } captured at save time; if a cited source drifts (or
 * is gone), the insight is STALE — the same staleness invalidation explainers and
 * findings use (evaluateExplainers + hashSource from brain-explain.mjs).
 *
 * Subcommands:
 *   add      --title "..." --claim "..." --sources a.mjs,b/c.md
 *            [--confidence 0.0-1.0] [--supersedes <slug>] [--actor X]
 *            [--body "..." | --body-file <path> | stdin]
 *   check    [--json] [--strict]
 *   list     [--json]
 *   scaffold "<topic>"
 *
 * Deliberately out of scope for v1: NO automatic generation, NO retrieval ranking
 * boost (a search boost for insights is an eval-gated follow-up, per the repo rule
 * that any ranking change must pass `brain:eval:compare --hard-only`). Opt-in only.
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
  slugify,
  takeFlag,
  takeOption
} from './common.mjs';
import { hashSource, evaluateExplainers } from './brain-explain.mjs';

export const INSIGHTS_DIR = path.join(BRAIN_DIR, 'insights');

// An insight must be grounded in at least this many cited sources, else it is a
// single-source answer (use brain:explain) or an ungrounded claim (refused).
export const MIN_SOURCES = 2;

function usage() {
  return [
    'Usage:',
    '  npm run brain:insight -- add --title "..." --claim "..." --sources a.mjs,b/c.md \\',
    '         [--confidence 0.0-1.0] [--supersedes <slug>] [--actor X] \\',
    '         [--body "..." | --body-file <path>]   (body also read from stdin if piped)',
    '  npm run brain:insight -- check [--json] [--strict]',
    '  npm run brain:insight -- list [--json]',
    '  npm run brain:insight -- scaffold "<topic>"',
    '',
    `An insight is a SYNTHESIZED claim across >= ${MIN_SOURCES} sources. The agent does the`,
    'synthesis (gather evidence with brain:search / brain:pack / brain:impact); this',
    'command only records it with a grounding guardrail. It never calls an LLM.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PURE (de)serialization — unit-testable without a store, modeled on
// serializeFinding/parseFinding (findings.mjs) and explainer (brain-explain.mjs).
// The shared parseDoc (common.mjs) is scalar-only and can't read the nested
// `sources:` list, so this record type owns its (de)serialization.
// ---------------------------------------------------------------------------

/** Render a frontmatter scalar: plain tokens bare, anything else JSON-quoted. */
function fmScalar(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  if (/^[A-Za-z0-9 _\-:/.,()]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/** Inverse of fmScalar: unwrap a JSON-quoted value, else strip stray quotes. */
function unq(value) {
  const t = String(value ?? '').trim();
  if (t === 'null') return null;
  try { return JSON.parse(t); } catch { return t.replace(/^["']|["']$/g, ''); }
}

/** Split the `---\n<fm>\n---\n<body>` envelope. */
function splitFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: '', body: content };
  return { fm: m[1], body: m[2] || '' };
}

/** Pull the requested scalar keys out of frontmatter lines (order-independent). */
function parseScalars(fmLines, keys) {
  const out = {};
  for (const line of fmLines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && keys.includes(kv[1])) out[kv[1]] = kv[2];
  }
  return out;
}

/** Parse the nested `sources:` list (`- path:` / `sha256:`) this record shares. */
function parseSources(fmLines) {
  const sources = [];
  let inSources = false;
  let cur = null;
  for (const line of fmLines) {
    if (/^sources:\s*$/.test(line)) { inSources = true; continue; }
    if (!inSources) continue;
    const p = line.match(/^\s*-\s*path:\s*(.*)$/);
    if (p) { cur = { path: unq(p[1]), sha256: null }; sources.push(cur); continue; }
    const s = line.match(/^\s*sha256:\s*(.*)$/);
    if (s && cur) { cur.sha256 = unq(s[1]); continue; }
    if (/^\S/.test(line)) inSources = false; // a new top-level key ends the list
  }
  return sources;
}

/** Clamp a confidence into [0,1]; non-numeric → null (unspecified). */
export function normalizeConfidence(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

export function serializeInsight(rec) {
  const conf = normalizeConfidence(rec.confidence);
  const lines = ['---'];
  lines.push('type: insight');
  lines.push(`title: ${fmScalar(rec.title || '')}`);
  lines.push(`claim: ${fmScalar(rec.claim || '')}`);
  lines.push(`confidence: ${conf === null ? 'null' : conf}`);
  lines.push(`created: ${rec.created}`);
  lines.push(`updated: ${rec.updated}`);
  lines.push(`actor: ${fmScalar(rec.actor || '')}`);
  lines.push(`supersedes: ${fmScalar(rec.supersedes || '')}`);
  lines.push('sources:');
  for (const s of rec.sources || []) {
    lines.push(`  - path: ${JSON.stringify(s.path)}`);
    lines.push(`    sha256: ${s.sha256 == null ? 'null' : JSON.stringify(s.sha256)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${(rec.body || '').replace(/\s*$/, '')}\n`;
}

export function parseInsight(content) {
  const { fm, body } = splitFrontmatter(content);
  const fmLines = fm.split('\n');
  const sc = parseScalars(fmLines, ['title', 'claim', 'confidence', 'created', 'updated', 'actor', 'supersedes']);
  return {
    type: 'insight',
    title: unq(sc.title) || '',
    claim: unq(sc.claim) || '',
    confidence: normalizeConfidence(sc.confidence),
    created: (sc.created || '').trim(),
    updated: (sc.updated || '').trim(),
    actor: unq(sc.actor) || '',
    supersedes: unq(sc.supersedes) || '',
    sources: parseSources(fmLines),
    body
  };
}

/**
 * PURE: validate the grounding guardrail. An insight must cite >= MIN_SOURCES
 * distinct source paths. Returns { ok, count, message }.
 *
 * Exported so the guardrail is unit-testable without spawning the CLI.
 */
export function validateInsightSources(sources) {
  const paths = (sources || [])
    .map((s) => ((typeof s === 'string' ? s : s && s.path) || '').trim())
    .filter(Boolean);
  const count = new Set(paths).size; // distinct non-empty paths
  if (count < MIN_SOURCES) {
    return {
      ok: false,
      count,
      message: `[brain:insight] refusing: an insight must cite >= ${MIN_SOURCES} distinct sources (got ${count}). `
        + 'A synthesized claim must be grounded in multiple sources to protect the trust axis '
        + 'from hallucination. For a single-source answer, use brain:explain instead.'
    };
  }
  return { ok: true, count, message: '' };
}

/** Load every insight record from disk as { slug, file, ...record }. */
function loadInsights() {
  if (!exists(INSIGHTS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(INSIGHTS_DIR).sort()) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue; // skip _template.md
    const rec = parseInsight(read(path.join(INSIGHTS_DIR, name)));
    out.push({ slug: name.replace(/\.md$/, ''), file: ['.project-brain', 'insights', name].join('/'), ...rec });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function readBody(args) {
  const inline = takeOption(args, '--body');
  if (inline) return inline;
  const bodyFile = takeOption(args, '--body-file');
  if (bodyFile) {
    const abs = path.isAbsolute(bodyFile) ? bodyFile : path.join(ROOT, bodyFile);
    if (!exists(abs)) { process.stderr.write(`[brain:insight] --body-file not found: ${bodyFile}\n`); process.exit(1); }
    return read(abs);
  }
  // Read piped stdin only; never block on an interactive terminal.
  if (!process.stdin.isTTY) {
    try { const s = fs.readFileSync(0, 'utf8'); if (s.trim()) return s; } catch { /* no stdin */ }
  }
  return '';
}

function cmdAdd(args) {
  const title = takeOption(args, '--title').trim();
  if (!title) { process.stderr.write('[brain:insight] add requires --title "..."\n'); process.exit(1); }

  const claim = takeOption(args, '--claim').trim();
  if (!claim) { process.stderr.write('[brain:insight] add requires --claim "..." (the synthesized claim in one sentence)\n'); process.exit(1); }

  const confidence = normalizeConfidence(takeOption(args, '--confidence'));
  const supersedes = takeOption(args, '--supersedes').trim();
  const actor = takeOption(args, '--actor') || process.env.BRAIN_ACTOR || '';
  const sourcePaths = (takeOption(args, '--sources') || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  // GUARDRAIL: refuse an ungrounded insight BEFORE writing anything.
  const check = validateInsightSources(sourcePaths.map((p) => ({ path: p })));
  if (!check.ok) {
    process.stderr.write(`${check.message}\n`);
    process.exit(1);
  }

  // Read body AFTER the guardrail so a refused insight never consumes stdin.
  const body = readBody(args)
    || '_No synthesis body provided. Re-run `brain:insight add` with --body to record the reasoning across sources._';

  const sources = [];
  for (const sp of sourcePaths) {
    const h = hashSource(sp);
    if (h === null) process.stderr.write(`[brain:insight] warning: cited source not found, recording with null hash: ${sp}\n`);
    sources.push({ path: sp, sha256: h });
  }

  const slug = slugify(title);
  const dest = path.join(INSIGHTS_DIR, `${slug}.md`);
  const now = new Date().toISOString();
  let created = now;
  if (exists(dest)) {
    const prev = parseInsight(read(dest));
    if (prev.created) created = prev.created; // idempotent: preserve original created
  }

  ensureDir(INSIGHTS_DIR);
  write(dest, serializeInsight({ title, claim, confidence, created, updated: now, actor, supersedes, sources, body }));
  process.stdout.write(`${path.relative(ROOT, dest)}\n`);
}

function cmdCheck(args) {
  const json = takeFlag(args, '--json');
  const strict = takeFlag(args, '--strict');
  const insights = loadInsights();
  // Reuse the explainer staleness machinery verbatim (sources are { path, sha256 }).
  const results = evaluateExplainers(insights, hashSource);
  const staleCount = results.filter((r) => r.stale).length;

  if (json) {
    process.stdout.write(JSON.stringify({ total: results.length, stale: staleCount, results }, null, 2) + '\n');
  } else {
    if (!results.length) process.stdout.write('No insights found.\n');
    for (const r of results) {
      const tag = r.stale ? 'STALE' : 'fresh';
      process.stdout.write(`[${tag}] ${r.slug} — ${r.query || ''}\n`);
      if (r.stale) {
        for (const reason of r.reasons) {
          if (reason.status !== 'ok') process.stdout.write(`    ${reason.status}: ${reason.path}\n`);
        }
      }
    }
    if (results.length) process.stdout.write(`\n${results.length} insight(s), ${staleCount} stale.\n`);
  }

  if (strict && staleCount > 0) process.exit(1);
}

function cmdList(args) {
  const json = takeFlag(args, '--json');
  const insights = loadInsights();
  // evaluateExplainers reads e.sources/e.slug — insights expose both.
  const results = evaluateExplainers(insights, hashSource);
  const bySlug = new Map(results.map((r) => [r.slug, r]));

  if (json) {
    const rows = insights.map((e) => ({
      slug: e.slug,
      title: e.title,
      claim: e.claim,
      confidence: e.confidence,
      actor: e.actor,
      supersedes: e.supersedes,
      created: e.created,
      updated: e.updated,
      sources: e.sources.map((s) => s.path),
      stale: bySlug.get(e.slug)?.stale ?? false
    }));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  if (!insights.length) {
    process.stdout.write('No insights yet. Run `brain:insight -- scaffold "<topic>"` to start.\n');
    return;
  }
  for (const e of insights) {
    const stale = bySlug.get(e.slug)?.stale ?? false;
    const conf = e.confidence === null ? '—' : e.confidence.toFixed(2);
    process.stdout.write(`${stale ? 'stale' : 'fresh'}  (conf ${conf}) ${e.slug} — ${e.title}\n`);
  }
  process.stdout.write(`\n${insights.length} insight(s).\n`);
}

function cmdScaffold(args) {
  const topic = (args.join(' ') || '').trim();
  if (!topic) { process.stderr.write('[brain:insight] scaffold requires a "<topic>"\n'); process.exit(1); }

  const out = [];
  out.push(`# Insight scaffold: ${topic}`);
  out.push('');
  out.push('An insight is a SYNTHESIZED claim that spans MULTIPLE sources — a conclusion you');
  out.push('reach by reasoning across the codebase, not a quote from one chunk. You (the agent)');
  out.push('do the synthesis; this command only records it, and refuses anything citing');
  out.push(`fewer than ${MIN_SOURCES} sources so the claim stays grounded.`);
  out.push('');
  out.push('## 1. Gather evidence (use the brain, do not guess)');
  out.push(`- \`npm run brain:search -- "${topic}"\`            — find the relevant records/files`);
  out.push(`- \`npm run brain:pack -- "${topic}" --max-tokens 3000\` — assemble a budgeted context blob`);
  out.push('- `npm run brain:impact -- <Symbol>`              — blast-radius when a symbol is central');
  out.push('- Read the exact files the above return before concluding anything.');
  out.push('');
  out.push('## 2. Synthesize');
  out.push('- State ONE claim that no single source states on its own.');
  out.push('- Note where the sources agree, disagree, or leave a gap.');
  out.push(`- Pick the >= ${MIN_SOURCES} files that actually back the claim — they become the staleness`);
  out.push('  anchors (if they drift, `brain:insight check` flags the insight STALE).');
  out.push('- Assign a calibrated --confidence 0.0-1.0 (lower it when the evidence is thin).');
  out.push('');
  out.push('## 3. Record it');
  out.push('  npm run brain:insight -- add --title "..." --claim "one-sentence claim" \\');
  out.push('         --sources <file1,file2,...> --confidence 0.7 \\');
  out.push('         --body "the cross-source reasoning + what would falsify it"');
  out.push('');
  out.push('Supersede an earlier insight with --supersedes <slug> when this one replaces it.');
  process.stdout.write(out.join('\n').replace(/\n+$/, '\n'));
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
    if (sub === 'add') return cmdAdd(args);
    if (sub === 'check') return cmdCheck(args);
    if (sub === 'list') return cmdList(args);
    if (sub === 'scaffold') return cmdScaffold(args);
    process.stderr.write(`[brain:insight] unknown subcommand: ${sub}\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`[brain:insight] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
