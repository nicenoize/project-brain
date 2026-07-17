/**
 * Shared (de)serialization for the act-axis record types: `finding` and
 * `improve-plan` (see decisions/0017-build-native-improve-act-axis.md).
 *
 * brain:audit writes findings; brain:improve reads findings and writes plans.
 * Both round-trip through here so the on-disk record shape has a single owner —
 * the same reason infer.mjs centralizes path→type inference.
 *
 * Records live under .project-brain/{findings,plans}/<slug>.md as frontmatter
 * Markdown so the indexer (inferType in infer.mjs) picks them up and they become
 * retrievable via `brain:search --type finding|improve-plan`. The shared parseDoc
 * (common.mjs) is scalar-only and can't read the nested `sources:` list, so these
 * types own their (de)serialization — exactly as explainers do (brain-explain.mjs).
 *
 * Pure + exported so the serializers/parsers are unit-testable without a store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR, exists, read, write, ensureDir, slugify } from './common.mjs';

export const FINDINGS_DIR = path.join(BRAIN_DIR, 'findings');
export const PLANS_DIR = path.join(BRAIN_DIR, 'plans');

// shadcn/improve's audit taxonomy, ported (the one non-duplicative asset).
export const FINDING_CATEGORIES = [
  'correctness', 'security', 'performance', 'testing', 'tech-debt',
  'dependencies', 'dx', 'documentation', 'feature-direction'
];

export const FINDING_STATUSES = ['open', 'planned', 'wontfix', 'resolved'];

export const GRILL_DIR = path.join(BRAIN_DIR, 'grills');

// A grill's verdict is the agent's call after answering the adversarial
// questions: open (not yet decided), proceed (defended — build it),
// revise (issues found — change the plan first), block (don't build it).
export const GRILL_VERDICTS = ['open', 'proceed', 'revise', 'block'];

// What a grill challenges: an act-axis finding/plan, a decision (ADR), or a
// free-form proposal the agent typed in (no record yet).
export const GRILL_TARGET_TYPES = ['finding', 'improve-plan', 'decision', 'proposal'];

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

/** Parse the nested `sources:` list (`- path:` / `sha256:`) these records share. */
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

// ---------- finding ----------

export function serializeFinding(rec) {
  const lines = ['---'];
  lines.push('type: finding');
  lines.push(`title: ${fmScalar(rec.title || '')}`);
  lines.push(`category: ${fmScalar(rec.category || 'tech-debt')}`);
  lines.push(`status: ${fmScalar(rec.status || 'open')}`);
  lines.push(`impact: ${Number(rec.impact) || 0}`);
  lines.push(`created: ${rec.created}`);
  lines.push(`updated: ${rec.updated}`);
  lines.push(`actor: ${fmScalar(rec.actor || '')}`);
  lines.push(`module: ${fmScalar(rec.module || '')}`);
  // Comma-scalar, not a list: the indexer ignores frontmatter `symbols` (symbols
  // come from the chunker), so this round-trips only through parseFinding.
  lines.push(`symbols: ${fmScalar((rec.symbols || []).join(', '))}`);
  lines.push('sources:');
  for (const s of rec.sources || []) {
    lines.push(`  - path: ${JSON.stringify(s.path)}`);
    lines.push(`    sha256: ${s.sha256 == null ? 'null' : JSON.stringify(s.sha256)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${(rec.body || '').replace(/\s*$/, '')}\n`;
}

export function parseFinding(content) {
  const { fm, body } = splitFrontmatter(content);
  const fmLines = fm.split('\n');
  const sc = parseScalars(fmLines, ['title', 'category', 'status', 'impact', 'created', 'updated', 'actor', 'module', 'symbols']);
  return {
    type: 'finding',
    title: unq(sc.title) || '',
    category: unq(sc.category) || 'tech-debt',
    status: unq(sc.status) || 'open',
    impact: Number(sc.impact) || 0,
    created: (sc.created || '').trim(),
    updated: (sc.updated || '').trim(),
    actor: unq(sc.actor) || '',
    module: unq(sc.module) || '',
    symbols: String(unq(sc.symbols) ?? '').split(',').map(s => s.trim()).filter(Boolean),
    sources: parseSources(fmLines),
    body
  };
}

export function loadFindings() {
  return loadDir(FINDINGS_DIR, 'findings', parseFinding);
}

// A machine-readable occurrence marker kept at the tail of a finding body. It
// lets upsertFinding count how many times a de-duplicated event class recurred
// without adding a frontmatter field (which the indexer would ignore anyway).
const OCCURRENCE_RE = /<!--\s*occurrences:\s*(\d+)\s*-->/i;

/**
 * Upsert a finding by deterministic slug — the single WRITE choke point for
 * PROGRAMMATIC finding producers (the friction sensor, #28), kept inside this
 * owning recorder so record-folder discipline holds (producers never reference a
 * findings/ path themselves; see references/conventions.md#sidecar-discipline).
 *
 * Dedupe: a re-occurrence of the same slug rewrites the SAME file — preserving
 * the original `created`, refreshing `updated`, and bumping the occurrence
 * marker — so one event class = one finding, never a spam of files. Pure disk
 * shape reuses serializeFinding, so friction findings round-trip like any other.
 *
 * @param {object} rec  { slug?, title, category?, status?, impact?, module?, symbols?, sources?, actor?, body?, created? }
 * @param {{dir?:string, now?:string}} [opts]  dir is injectable for tests
 * @returns {{file:string, slug:string, created:string, updated:string, occurrences:number, existed:boolean}}
 */
export function upsertFinding(rec = {}, { dir = FINDINGS_DIR, now = new Date().toISOString() } = {}) {
  const slug = (rec.slug && String(rec.slug).trim()) || slugify(rec.title || 'finding');
  const dest = path.join(dir, `${slug}.md`);
  let created = rec.created || now;
  let occurrences = 1;
  const existed = exists(dest);
  if (existed) {
    const prev = parseFinding(read(dest));
    if (prev.created) created = prev.created; // idempotent: keep the first-seen timestamp
    const m = String(prev.body || '').match(OCCURRENCE_RE);
    occurrences = (m ? Number(m[1]) : 1) + 1;
  }
  let body = String(rec.body || '').replace(OCCURRENCE_RE, '').replace(/\s*$/, '');
  body += `\n\n<!-- occurrences: ${occurrences} -->`;
  ensureDir(dir);
  write(dest, serializeFinding({
    title: rec.title || slug,
    category: rec.category || 'dx',
    status: rec.status || 'open',
    impact: rec.impact,
    created,
    updated: now,
    actor: rec.actor || '',
    module: rec.module || '',
    symbols: rec.symbols || [],
    sources: rec.sources || [],
    body
  }));
  return { file: dest, slug, created, updated: now, occurrences, existed };
}

// ---------- improve-plan ----------

export function serializePlan(rec) {
  const lines = ['---'];
  lines.push('type: improve-plan');
  lines.push(`title: ${fmScalar(rec.title || '')}`);
  lines.push(`finding: ${fmScalar(rec.finding || '')}`);
  lines.push(`category: ${fmScalar(rec.category || 'tech-debt')}`);
  lines.push(`status: ${fmScalar(rec.status || 'draft')}`);
  lines.push(`created: ${rec.created}`);
  lines.push(`updated: ${rec.updated}`);
  lines.push(`actor: ${fmScalar(rec.actor || '')}`);
  lines.push(`module: ${fmScalar(rec.module || '')}`);
  lines.push('---');
  return `${lines.join('\n')}\n${(rec.body || '').replace(/\s*$/, '')}\n`;
}

export function parsePlan(content) {
  const { fm, body } = splitFrontmatter(content);
  const sc = parseScalars(fm.split('\n'), ['title', 'finding', 'category', 'status', 'created', 'updated', 'actor', 'module']);
  return {
    type: 'improve-plan',
    title: unq(sc.title) || '',
    finding: unq(sc.finding) || '',
    category: unq(sc.category) || 'tech-debt',
    status: unq(sc.status) || 'draft',
    created: (sc.created || '').trim(),
    updated: (sc.updated || '').trim(),
    actor: unq(sc.actor) || '',
    module: unq(sc.module) || '',
    body
  };
}

export function loadPlans() {
  return loadDir(PLANS_DIR, 'plans', parsePlan);
}

// ---------- grill (adversarial pre-implementation interview) ----------
//
// A `grill` record captures the act of challenging an idea BEFORE it is built
// (decisions/0021). Like `finding`, it carries a nested `sources:` list (the
// cited evidence the challenges were grounded in), so it shares this module's
// (de)serialization rather than the scalar-only parseDoc. The body is the Q&A:
// the deterministically-generated adversarial questions and the agent's
// answers. brain:grill scaffolds the questions; the agent answers + records.

export function serializeGrill(rec) {
  const lines = ['---'];
  lines.push('type: grill');
  lines.push(`title: ${fmScalar(rec.title || '')}`);
  lines.push(`target: ${fmScalar(rec.target || '')}`);
  lines.push(`targetType: ${fmScalar(rec.targetType || 'proposal')}`);
  lines.push(`category: ${fmScalar(rec.category || 'tech-debt')}`);
  lines.push(`verdict: ${fmScalar(rec.verdict || 'open')}`);
  lines.push(`created: ${rec.created}`);
  lines.push(`updated: ${rec.updated}`);
  lines.push(`actor: ${fmScalar(rec.actor || '')}`);
  lines.push(`module: ${fmScalar(rec.module || '')}`);
  lines.push('sources:');
  for (const s of rec.sources || []) {
    lines.push(`  - path: ${JSON.stringify(s.path)}`);
    lines.push(`    sha256: ${s.sha256 == null ? 'null' : JSON.stringify(s.sha256)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${(rec.body || '').replace(/\s*$/, '')}\n`;
}

export function parseGrill(content) {
  const { fm, body } = splitFrontmatter(content);
  const fmLines = fm.split('\n');
  const sc = parseScalars(fmLines, ['title', 'target', 'targetType', 'category', 'verdict', 'created', 'updated', 'actor', 'module']);
  return {
    type: 'grill',
    title: unq(sc.title) || '',
    target: unq(sc.target) || '',
    targetType: unq(sc.targetType) || 'proposal',
    category: unq(sc.category) || 'tech-debt',
    verdict: unq(sc.verdict) || 'open',
    created: (sc.created || '').trim(),
    updated: (sc.updated || '').trim(),
    actor: unq(sc.actor) || '',
    module: unq(sc.module) || '',
    sources: parseSources(fmLines),
    body
  };
}

export function loadGrills() {
  return loadDir(GRILL_DIR, 'grills', parseGrill);
}

// ---------- shared loader ----------

function loadDir(dir, sub, parse) {
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue; // skip _template.md
    const rec = parse(read(path.join(dir, name)));
    out.push({ slug: name.replace(/\.md$/, ''), file: ['.project-brain', sub, name].join('/'), ...rec });
  }
  return out;
}
