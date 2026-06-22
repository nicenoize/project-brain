/**
 * brain:learn — turn real usage into a self-growing benchmark (the LEARNING axis).
 *
 * The brain's superpower is its paired-bootstrap eval gate (brain:eval:compare).
 * This command makes the BENCHMARK learn from real usage, WITHOUT ever changing
 * retrieval ranking. Ranking changes stay human-approved + eval-gated — that is
 * the whole house discipline. Here we only grow the *measurement*:
 *
 *   capture  — record a candidate eval case (query → the files that actually
 *              proved useful) into .project-brain/.eval-candidates/<hash>.json
 *              (gitignored staging). De-duped by query; repeated captures of the
 *              same query bump a `uses` counter and union the used files.
 *   promote  — review staged candidates and APPEND de-duped, well-formed ones to
 *              .project-brain/eval.json in its EXACT existing shape
 *              ({ query, expectedFiles?, ... }). This additively grows the eval
 *              set from usage. --dry-run previews; --min-uses N gates on evidence.
 *   suggest  — from recent misses, OUTPUT a recommended A/B (which env knob to
 *              try via brain:eval:compare). It NEVER applies a ranking change and
 *              NEVER runs anything automatically — it just prints the experiment.
 *
 * CRITICAL: nothing here changes retrieval ranking or runs on its own.
 * eval.json growth is additive measurement; promotion is explicit + reviewable.
 * This is the honest, safe slice of "learning from outcomes".
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
  takeFlag,
  takeOption
} from './common.mjs';

export const CANDIDATES_DIR = path.join(BRAIN_DIR, '.eval-candidates');
export const EVAL_PATH = path.join(BRAIN_DIR, 'eval.json');

function usage() {
  return [
    'Usage:',
    '  npm run brain:learn -- capture --query "..." --used <file1,file2> [--from-session <id>] [--json]',
    '  npm run brain:learn -- promote [--min-uses N] [--dry-run] [--json]',
    '  npm run brain:learn -- suggest [--json]',
    '',
    'capture records a usage-proven {query → files} case into staging',
    '  (.project-brain/.eval-candidates/, gitignored). promote appends de-duped,',
    '  well-formed candidates to .project-brain/eval.json (additive measurement).',
    '  suggest prints a recommended A/B for brain:eval:compare — it never changes',
    '  ranking and never runs anything.'
  ].join('\n');
}

// --- pure helpers (unit-tested) ------------------------------------------

/** Normalize a query for dedupe comparison (case/space-insensitive). */
export function normalizeQuery(query) {
  return String(query || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Stable staging filename for a candidate (dedupe key = normalized query). */
export function candidateHash(query) {
  return sha256(normalizeQuery(query)).slice(0, 16);
}

/** Split a comma/newline list into trimmed, de-duped, non-empty entries (order-preserving). */
export function splitList(value) {
  const out = [];
  const seen = new Set();
  for (const raw of String(value || '').split(/[,\n]/)) {
    const v = raw.trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/**
 * PURE: de-dupe a list of raw candidate objects by normalized query, merging
 * their `used` file lists (union, order-preserving) and summing `uses`. The most
 * recent `created`/`fromSession`/`query` spelling wins for display fields. Input
 * order is "oldest first"; later duplicates merge into the earlier record.
 *
 * @param {Array<{query, used?, uses?, created?, fromSession?}>} candidates
 * @returns {Array<{query, used:string[], uses:number, created?, fromSession?}>}
 */
export function dedupeCandidates(candidates = []) {
  const byKey = new Map();
  for (const cand of candidates) {
    if (!cand || !String(cand.query || '').trim()) continue;
    const key = normalizeQuery(cand.query);
    const used = Array.isArray(cand.used) ? cand.used.filter(Boolean) : [];
    const uses = Number.isFinite(cand.uses) ? cand.uses : 1;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        query: String(cand.query).trim(),
        used: [...new Set(used)],
        uses,
        created: cand.created || '',
        fromSession: cand.fromSession || ''
      });
      continue;
    }
    // union used files, keep order, sum uses, take latest non-empty metadata
    const merged = new Set(existing.used);
    for (const f of used) merged.add(f);
    existing.used = [...merged];
    existing.uses += uses;
    if (cand.query) existing.query = String(cand.query).trim();
    if (cand.created) existing.created = cand.created;
    if (cand.fromSession) existing.fromSession = cand.fromSession;
  }
  return [...byKey.values()];
}

/**
 * PURE: convert a (deduped) candidate into an eval.json case in the EXACT
 * existing shape: { query, expectedFiles }. We deliberately set expectedFiles
 * ONLY (no expectedSymbols) — file-level cases keep dense recall honest and
 * match the hard-case discipline (docs/eval-methodology.md). A `note` records
 * provenance; it is NOT prefixed "Hard:" so usage-learned cases don't silently
 * enter the curated hard subset without a human's review.
 *
 * @returns {{query:string, expectedFiles:string[], note:string}|null} null when malformed.
 */
export function toEvalCase(candidate) {
  if (!candidate) return null;
  const query = String(candidate.query || '').trim();
  const expectedFiles = (Array.isArray(candidate.used) ? candidate.used : [])
    .map((f) => String(f).trim())
    .filter(Boolean);
  if (!query || !expectedFiles.length) return null;
  const note = `learned: captured from usage (${candidate.uses || 1} use${(candidate.uses || 1) === 1 ? '' : 's'})`;
  return { query, expectedFiles: [...new Set(expectedFiles)], note };
}

/**
 * PURE: merge candidates into an existing eval-case array, additively and
 * idempotently. Preserves eval.json invariants enforced by tests/eval-cases.mjs:
 * unique queries (dedupe by normalized query against BOTH existing cases and
 * each other), shape { query, expectedFiles, ... }. Existing cases are never
 * mutated or reordered; only new, well-formed, non-duplicate cases are appended.
 * Has NO retrieval/ranking side effects — it's a data transform.
 *
 * @param {Array} existing  current eval.json array
 * @param {Array} candidates raw candidate objects (will be deduped internally)
 * @param {{minUses?:number}} opts
 * @returns {{merged:Array, added:Array, skipped:Array}}
 *   skipped entries: { query, reason: 'duplicate'|'malformed'|'min-uses' }
 */
export function mergeIntoEval(existing = [], candidates = [], opts = {}) {
  const minUses = Number.isFinite(opts.minUses) ? opts.minUses : 1;
  const seen = new Set((existing || []).map((c) => normalizeQuery(c?.query)));
  const merged = [...(existing || [])];
  const added = [];
  const skipped = [];

  for (const cand of dedupeCandidates(candidates)) {
    const key = normalizeQuery(cand.query);
    if ((cand.uses || 1) < minUses) {
      skipped.push({ query: cand.query, reason: 'min-uses' });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ query: cand.query, reason: 'duplicate' });
      continue;
    }
    const evalCase = toEvalCase(cand);
    if (!evalCase) {
      skipped.push({ query: cand.query, reason: 'malformed' });
      continue;
    }
    seen.add(key);
    merged.push(evalCase);
    added.push(evalCase);
  }
  return { merged, added, skipped };
}

// Env knobs that can be A/B-tested via brain:eval:compare without code changes.
// Drawn from the documented opt-in retrieval flags (SKILL.md / docs). Each entry
// is an experiment the HUMAN runs — suggest never sets these.
export const AB_KNOBS = [
  {
    env: 'BRAIN_LEXICAL_UNION=1 BRAIN_RERANK=1',
    why: 'BM25 routes vocabulary-mismatch targets into the candidate pool, then a local cross-encoder re-judges the top 20. The measured win for "sibling files outrank the owning module" misses (docs/eval-failure-analysis.md). Try this pair first.'
  },
  {
    env: 'BRAIN_RERANK=1',
    why: 'Cross-encoder rerank alone — re-judges the top dense candidates when the right file is in the pool but outranked.'
  },
  {
    env: 'BRAIN_GRAPH_EXPAND=1',
    why: 'One-hop graph expansion surfaces code wired to the answer (shared imports / symbol references) that does not embed near the query. Heavier; worth it when structure adjacency matters.'
  },
  {
    env: 'BRAIN_CONTEXTUAL_CHUNKS=1',
    why: 'Prepends a deterministic situating prefix to each chunk\'s embedding input so the dense vector carries the chunk\'s location/identity. Requires a forced re-index before measuring.'
  },
  {
    env: 'BRAIN_LOCAL_EMBED_MODEL=Xenova/bge-small-en-v1.5',
    why: 'A drop-in 384-dim alternative embedder. Statistically indistinguishable from MiniLM on this repo\'s hard subset, but worth re-A/B-testing once the eval set has grown enough new cases. Requires a forced re-index.'
  }
];

/** PURE: pick an A/B recommendation given how many recent misses exist. */
export function recommendAB(missCount) {
  const primary = AB_KNOBS[0];
  return {
    misses: missCount,
    recommend: primary.env,
    why: primary.why,
    alternatives: AB_KNOBS.slice(1),
    procedure: [
      'BRAIN_QUIET=1 npm run brain:eval -- --hard-only --out /tmp/baseline.json',
      `# apply the change for the run below, e.g.:  ${primary.env} \\`,
      'BRAIN_QUIET=1 npm run brain:eval -- --hard-only --out /tmp/variant.json',
      'npm run brain:eval:compare -- /tmp/baseline.json /tmp/variant.json --hard-only'
    ]
  };
}

// --- staging I/O ----------------------------------------------------------

/** Load every staged candidate, oldest-first (by `created`, then filename). */
export function loadCandidates() {
  if (!exists(CANDIDATES_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(CANDIDATES_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(read(path.join(CANDIDATES_DIR, name)));
      out.push({ _file: name, ...rec });
    } catch {
      // Skip a corrupt staging file rather than failing the whole command.
    }
  }
  out.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')) || String(a._file).localeCompare(String(b._file)));
  return out;
}

function loadEval() {
  if (!exists(EVAL_PATH)) return [];
  try {
    const data = JSON.parse(read(EVAL_PATH));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    throw new Error(`eval.json is not valid JSON (${error.message}); refusing to touch it`);
  }
}

// --- subcommands ----------------------------------------------------------

function cmdCapture(args) {
  const json = takeFlag(args, '--json');
  const query = takeOption(args, '--query').trim();
  const usedArg = takeOption(args, '--used');
  const fromSession = takeOption(args, '--from-session').trim();
  if (!query) { process.stderr.write('[brain:learn] capture requires --query "..."\n'); process.exit(1); }
  const used = splitList(usedArg);
  if (!used.length) { process.stderr.write('[brain:learn] capture requires --used <file1,file2> (the files that proved useful)\n'); process.exit(1); }

  ensureDir(CANDIDATES_DIR);
  const dest = path.join(CANDIDATES_DIR, `${candidateHash(query)}.json`);
  const now = new Date().toISOString();

  let record = { query, used, uses: 1, created: now, updated: now, fromSession: fromSession || '' };
  if (exists(dest)) {
    // De-dupe by query: bump uses, union used files, preserve created.
    try {
      const prev = JSON.parse(read(dest));
      const mergedUsed = [...new Set([...(Array.isArray(prev.used) ? prev.used : []), ...used])];
      record = {
        query,
        used: mergedUsed,
        uses: (Number.isFinite(prev.uses) ? prev.uses : 1) + 1,
        created: prev.created || now,
        updated: now,
        fromSession: fromSession || prev.fromSession || ''
      };
    } catch { /* corrupt prior file → overwrite with fresh record */ }
  }

  write(dest, JSON.stringify(record, null, 2) + '\n');
  const rel = path.relative(ROOT, dest);
  if (json) {
    process.stdout.write(JSON.stringify({ captured: rel, query: record.query, used: record.used, uses: record.uses }, null, 2) + '\n');
  } else {
    process.stdout.write(`captured candidate (uses=${record.uses}): ${rel}\n  query: ${record.query}\n  used:  ${record.used.join(', ')}\n`);
    process.stdout.write('Staging only — run `brain:learn promote` to add reviewed cases to eval.json.\n');
  }
}

function cmdPromote(args) {
  const json = takeFlag(args, '--json');
  const dryRun = takeFlag(args, '--dry-run');
  const minUses = Math.max(1, Number(takeOption(args, '--min-uses')) || 1);

  const candidates = loadCandidates();
  const existing = loadEval();
  const { merged, added, skipped } = mergeIntoEval(existing, candidates, { minUses });

  if (!dryRun && added.length) {
    // Append additively, preserving the exact existing shape + 2-space indent.
    write(EVAL_PATH, JSON.stringify(merged, null, 2) + '\n');
    // Clear only the staged files we actually promoted (by query); leave
    // skipped (e.g. below --min-uses) candidates in staging for later.
    const promotedKeys = new Set(added.map((c) => normalizeQuery(c.query)));
    for (const cand of candidates) {
      if (promotedKeys.has(normalizeQuery(cand.query)) && cand._file) {
        try { fs.rmSync(path.join(CANDIDATES_DIR, cand._file)); } catch { /* best effort */ }
      }
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      dryRun,
      minUses,
      candidates: candidates.length,
      existing: existing.length,
      promoted: added.length,
      total: dryRun ? existing.length + added.length : merged.length,
      added: added.map((c) => c.query),
      skipped
    }, null, 2) + '\n');
    return;
  }

  if (!candidates.length) { process.stdout.write('No staged candidates. Capture some with `brain:learn capture`.\n'); return; }
  const verb = dryRun ? 'would promote' : 'promoted';
  process.stdout.write(`${dryRun ? '[dry-run] ' : ''}${verb} ${added.length} candidate(s) into eval.json (${existing.length} → ${existing.length + added.length} cases).\n`);
  for (const c of added) process.stdout.write(`  + ${c.query}  →  ${c.expectedFiles.join(', ')}\n`);
  const byReason = skipped.reduce((m, s) => { (m[s.reason] ||= []).push(s.query); return m; }, {});
  for (const [reason, qs] of Object.entries(byReason)) {
    process.stdout.write(`  (skipped ${qs.length} — ${reason})\n`);
  }
  if (dryRun) process.stdout.write('Dry run: eval.json unchanged. Re-run without --dry-run to apply.\n');
  else if (added.length) process.stdout.write('eval.json grew (additive measurement). Ranking is unchanged — validate any ranking idea with `brain:eval:compare`.\n');
}

function cmdSuggest(args) {
  const json = takeFlag(args, '--json');
  // "Recent misses" proxy: staged candidates are exactly the cases real usage
  // produced — the queries the brain should be measured against. We don't run
  // retrieval here (this command must not execute anything heavy or change
  // ranking); we surface the experiment for the human to run.
  const candidates = dedupeCandidates(loadCandidates());
  const rec = recommendAB(candidates.length);

  if (json) {
    process.stdout.write(JSON.stringify({ ...rec, sampleQueries: candidates.slice(0, 5).map((c) => c.query) }, null, 2) + '\n');
    return;
  }

  process.stdout.write('# brain:learn suggest — recommended A/B (human runs it; ranking stays eval-gated)\n\n');
  process.stdout.write(`Staged usage cases available to grow the eval set: ${rec.misses}\n`);
  process.stdout.write(rec.misses
    ? '(promote them first with `brain:learn promote` so the experiment is measured on real usage)\n\n'
    : '(no staged cases yet — capture real usage with `brain:learn capture` to ground the eval set)\n\n');
  process.stdout.write(`Recommended knob to A/B-test:\n  ${rec.recommend}\n  why: ${rec.why}\n\n`);
  process.stdout.write('Procedure (nothing below is run for you):\n');
  for (const line of rec.procedure) process.stdout.write(`  ${line}\n`);
  process.stdout.write('\nAlternatives:\n');
  for (const alt of rec.alternatives) process.stdout.write(`  - ${alt.env}\n      ${alt.why}\n`);
  process.stdout.write('\nThis is a recommendation only. It does NOT apply any ranking change and does NOT run automatically.\n');
}

function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const sub = args.shift();
  if (help || !sub) { console.log(usage()); process.exit(help ? 0 : 1); }
  try {
    if (sub === 'capture') return cmdCapture(args);
    if (sub === 'promote') return cmdPromote(args);
    if (sub === 'suggest') return cmdSuggest(args);
    process.stderr.write(`[brain:learn] unknown subcommand: ${sub}\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`[brain:learn] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
