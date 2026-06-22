/**
 * brain:audit — the act-axis FRONT-END: a 9-category audit scaffold + finding writer.
 *
 * Philosophy (ported from shadcn/improve): use the most capable model for the
 * part where intelligence compounds — judging what's worth doing. So this script
 * is a SCAFFOLDER, not an analyzer (like brain:adr): `run` prints the taxonomy
 * checklist + the brain commands to gather evidence; the agent investigates, then
 * records each problem with `add`, which writes an indexed `finding` record.
 *
 * Findings live at .project-brain/findings/<slug>.md and become retrievable via
 * `brain:search --type finding`. brain:improve turns them into enriched plans.
 * See decisions/0017-build-native-improve-act-axis.md.
 *
 * Subcommands:
 *   run  [--categories a,b | --quick]      print the audit checklist + evidence commands
 *   add  --title "..." --category security [--impact 1-5] [--symbols a,b]
 *        [--module m] [--sources a.mjs,b/c.md] [--status open] [--actor X]
 *        [--body "..." | --body-file <path> | stdin]
 *   list [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, ensureDir, exists, read, write, slugify, takeFlag, takeOption
} from './common.mjs';
import { hashSource } from './brain-explain.mjs';
import {
  FINDINGS_DIR, FINDING_CATEGORIES, FINDING_STATUSES,
  serializeFinding, parseFinding, loadFindings
} from './findings.mjs';

// What each category looks for + how to gather evidence with brain commands.
const CATEGORY_GUIDE = {
  correctness: {
    look: 'Logic errors, unhandled edge cases, race conditions, swallowed errors, off-by-one.',
    evidence: ['brain:impact <Symbol>', 'brain:search -- "error handling <area>"']
  },
  security: {
    look: 'Injection, hard-coded secrets, missing authz, unsafe exec/eval, supply-chain risk.',
    evidence: ['brain:guard (BRAIN_GUARD_SECURITY=1)', 'brain:search -- "auth | secret | exec"']
  },
  performance: {
    look: 'Hot-path O(n^2), N+1 queries, sync I/O on the request path, missing memoization/caching.',
    evidence: ['brain:impact <HotSymbol>', 'brain:search -- "<hot path>"']
  },
  testing: {
    look: 'Critical paths without tests, untested branches, flaky/over-mocked tests.',
    evidence: ['brain:impact <Symbol>  (Tests section)', 'list tests/ for the touched module']
  },
  'tech-debt': {
    look: 'Duplication, large mixed-responsibility files, dead code, TODO/FIXME, leaky abstractions.',
    evidence: ['brain:search -- "<duplicated concept>"', 'grep -rn "TODO|FIXME"']
  },
  dependencies: {
    look: 'Unpinned/outdated/vulnerable deps, unused deps, a heavy dep for a one-liner (ponytail rung 4).',
    evidence: ['npm audit', 'review package.json against actual usage']
  },
  dx: {
    look: 'Confusing setup, missing scripts, unclear errors, slow feedback loops.',
    evidence: ['read README.md / CONTRIBUTING.md', 'brain:health']
  },
  documentation: {
    look: 'Stale or missing docs, undocumented decisions, drift between code and .project-brain/.',
    evidence: ['brain:verify', 'brain:explain check', 'brain:link-check']
  },
  'feature-direction': {
    look: 'Half-built features, scope mismatch, abandoned work, contradictory intent.',
    evidence: ['read .project-brain/active_state.md', 'brain:search -- "<feature>"']
  }
};

const QUICK_CATEGORIES = ['correctness', 'security', 'testing'];

function usage() {
  return [
    'Usage:',
    '  npm run brain:audit -- run [--categories a,b | --quick]',
    '  npm run brain:audit -- add --title "..." --category <cat> [--impact 1-5]',
    '         [--symbols a,b] [--module m] [--sources a.mjs,b/c.md] [--status open] [--actor X]',
    '         [--body "..." | --body-file <path>]   (body also read from stdin if piped)',
    '  npm run brain:audit -- list [--json]',
    '',
    `Categories: ${FINDING_CATEGORIES.join(', ')}`
  ].join('\n');
}

function cmdRun(args) {
  const quick = takeFlag(args, '--quick');
  const only = (takeOption(args, '--categories') || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  let categories = FINDING_CATEGORIES;
  if (quick) categories = QUICK_CATEGORIES;
  else if (only.length) {
    const unknown = only.filter(c => !FINDING_CATEGORIES.includes(c));
    if (unknown.length) process.stderr.write(`[brain:audit] unknown categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}\n`);
    categories = only.filter(c => FINDING_CATEGORIES.includes(c));
    if (!categories.length) { process.stderr.write(`[brain:audit] no valid categories; pick from: ${FINDING_CATEGORIES.join(', ')}\n`); process.exit(1); }
  }

  const out = [];
  out.push(`# Audit scaffold (${categories.length}/${FINDING_CATEGORIES.length} categories)`);
  out.push('');
  out.push('Investigate each category below, then record every problem you confirm with:');
  out.push('  npm run brain:audit -- add --title "..." --category <cat> --impact <1-5> \\');
  out.push('         --symbols <Sym1,Sym2> --module <m> --sources <file1,file2> --body "evidence + fix"');
  out.push('');
  out.push('Cite the symbols/files you actually inspected in --sources: they become the staleness');
  out.push('anchors brain:improve reconcile uses to retire a finding once the code moves on.');
  out.push('');
  for (const cat of categories) {
    const g = CATEGORY_GUIDE[cat];
    out.push(`## ${cat}`);
    out.push(`- Look for: ${g.look}`);
    out.push(`- Evidence: ${g.evidence.map(e => `\`${e}\``).join(' · ')}`);
    out.push('');
  }
  process.stdout.write(out.join('\n').replace(/\n+$/, '\n'));
}

function readBody(args) {
  const inline = takeOption(args, '--body');
  if (inline) return inline;
  const bodyFile = takeOption(args, '--body-file');
  if (bodyFile) {
    const abs = path.isAbsolute(bodyFile) ? bodyFile : path.join(ROOT, bodyFile);
    if (!exists(abs)) { process.stderr.write(`[brain:audit] --body-file not found: ${bodyFile}\n`); process.exit(1); }
    return read(abs);
  }
  // Read piped stdin only; never block on an interactive terminal.
  if (!process.stdin.isTTY) {
    try { const s = fs.readFileSync(0, 'utf8'); if (s.trim()) return s; } catch { /* no stdin */ }
  }
  return '_No description provided. Re-run `brain:audit add` with --body to add evidence and a fix._';
}

function cmdAdd(args) {
  const title = takeOption(args, '--title').trim();
  if (!title) { process.stderr.write('[brain:audit] add requires --title "..."\n'); process.exit(1); }

  let category = (takeOption(args, '--category') || 'tech-debt').trim();
  if (!FINDING_CATEGORIES.includes(category)) {
    process.stderr.write(`[brain:audit] warning: non-standard category "${category}" (standard: ${FINDING_CATEGORIES.join(', ')})\n`);
  }

  let status = (takeOption(args, '--status') || 'open').trim();
  if (!FINDING_STATUSES.includes(status)) {
    process.stderr.write(`[brain:audit] warning: non-standard status "${status}" (standard: ${FINDING_STATUSES.join(', ')})\n`);
  }

  const impactRaw = takeOption(args, '--impact');
  const impact = Math.min(5, Math.max(0, Number(impactRaw) || 3));
  const actor = takeOption(args, '--actor') || process.env.BRAIN_ACTOR || '';
  const module = takeOption(args, '--module').trim();
  const symbols = (takeOption(args, '--symbols') || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const sourcePaths = (takeOption(args, '--sources') || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const body = readBody(args);

  const sources = [];
  for (const sp of sourcePaths) {
    const h = hashSource(sp);
    if (h === null) process.stderr.write(`[brain:audit] warning: cited source not found, recording with null hash: ${sp}\n`);
    sources.push({ path: sp, sha256: h });
  }

  const slug = slugify(title);
  const dest = path.join(FINDINGS_DIR, `${slug}.md`);
  const now = new Date().toISOString();
  let created = now;
  if (exists(dest)) {
    const prev = parseFinding(read(dest));
    if (prev.created) created = prev.created; // idempotent: preserve original created
  }

  ensureDir(FINDINGS_DIR);
  write(dest, serializeFinding({ title, category, status, impact, created, updated: now, actor, module, symbols, sources, body }));
  process.stdout.write(`${path.relative(ROOT, dest)}\n`);
}

function cmdList(args) {
  const json = takeFlag(args, '--json');
  const findings = loadFindings();
  if (json) {
    process.stdout.write(JSON.stringify(findings.map(f => ({
      slug: f.slug, title: f.title, category: f.category, status: f.status,
      impact: f.impact, module: f.module, symbols: f.symbols, file: f.file
    })), null, 2) + '\n');
    return;
  }
  if (!findings.length) { process.stdout.write('No findings yet. Run `brain:audit -- run` to start an audit.\n'); return; }
  const order = { open: 0, planned: 1, wontfix: 2, resolved: 3 };
  findings.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.impact - a.impact);
  for (const f of findings) {
    process.stdout.write(`[${f.status}] (impact ${f.impact}) ${f.slug} — ${f.category}: ${f.title}\n`);
  }
  process.stdout.write(`\n${findings.length} finding(s).\n`);
}

function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const sub = args.shift();
  if (help || !sub) { console.log(usage()); process.exit(help ? 0 : 1); }
  try {
    if (sub === 'run') return cmdRun(args);
    if (sub === 'add') return cmdAdd(args);
    if (sub === 'list') return cmdList(args);
    process.stderr.write(`[brain:audit] unknown subcommand: ${sub}\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`[brain:audit] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly; importing must not parse argv / exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
