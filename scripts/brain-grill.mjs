/**
 * brain:grill — adversarial pre-implementation interview (the GRILL axis).
 *
 * The brain already FINDS problems (brain:audit / brain:gaps) and SYNTHESIZES
 * across sources (brain:insight). What it lacked is a primitive that CHALLENGES
 * an idea *before* it is built — Matt Pocock's "Grill Me" applied to a brain
 * that can ground its questions. The brain's edge over a generic "grill me"
 * skill: the questions are generated DETERMINISTICALLY from the index — real
 * blast-radius (buildImpact), governing ADRs, the tests that cover the symbol,
 * and conflicting open findings — so the interview is specific, not generic.
 *
 * Like brain:audit / brain:adr / brain:insight, this is a SCAFFOLD + RECORDER:
 * `scaffold` prints the grounded questions; the AGENT answers them (that is the
 * judgment a CLI can't supply); `save` records the Q&A as a durable `grill`
 * record. No LLM on the hot path — the question generator is pure.
 *
 * Grills live at .project-brain/grills/<slug>.md (frontmatter Markdown), are
 * indexed (inferType in infer.mjs → 'grill') and retrievable via
 * `brain:search --type grill`. Each cited source is { path, sha256 } captured at
 * save time, so a grill goes STALE when its evidence drifts — the same staleness
 * invalidation explainers / findings / insights use (evaluateExplainers +
 * hashSource from brain-explain.mjs). See decisions/0021-grill-adversarial-axis.md.
 *
 * Subcommands:
 *   scaffold <finding|plan|decision-slug | --title "proposal">
 *            [--category c] [--lens a,b|all] [--context] [--max-symbols N] [--json]
 *   save     [--target <slug>] [--title "..."] [--target-type t] [--category c]
 *            [--module m] [--verdict open|proceed|revise|block]
 *            [--sources a.mjs,b/c.md] [--actor X]
 *            [--body "..." | --body-file <path> | stdin]
 *   check    [--json] [--strict]
 *   list     [--json]
 *
 * The PURE question generator `generateChallenges(...)` and `renderInterview(...)`
 * are exported so the adversarial logic is unit-testable with fixture data — no
 * real index, embedder, or model required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, BRAIN_DIR, ensureDir, exists, read, write, slugify, takeFlag, takeOption
} from './common.mjs';
import { hashSource, evaluateExplainers } from './brain-explain.mjs';
import {
  GRILL_DIR, GRILL_VERDICTS, GRILL_TARGET_TYPES,
  FINDING_CATEGORIES,
  serializeGrill, parseGrill, loadGrills,
  loadFindings, loadPlans
} from './findings.mjs';

const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');

// ---------------------------------------------------------------------------
// Pure adversarial-question generator (unit-testable; no I/O, no model).
// ---------------------------------------------------------------------------

// Per-category adversarial prompts. Small + curated, mirroring brain:audit's
// CATEGORY_GUIDE. The agent must DEFEND against each before building.
const CATEGORY_CHALLENGES = {
  correctness: [
    'What is the edge case you are NOT handling — empty, null, concurrent access, partial failure, retry?',
    'If this change is subtly wrong, which test catches it before production — and does that test exist yet?'
  ],
  security: [
    'What untrusted input reaches this path, and exactly where is it validated / escaped?',
    'Does this widen the attack surface (new exec/eval, secret handling, authz decision, deserialization)?'
  ],
  performance: [
    'What is the measured baseline, and what evidence proves THIS is the bottleneck (not a premature optimization)?',
    'What is the complexity / allocation profile at 10× the current data volume?'
  ],
  testing: [
    'Which untested branch does this add, and what is the smallest test that fails on the current code?',
    'Are you testing behavior, or are the tests so mocked they would pass even if the logic were wrong?'
  ],
  'tech-debt': [
    'Is this the simplest thing that works, or are you adding abstraction for a future that may never arrive (YAGNI)?',
    'Will this leave the module more cohesive or less — does responsibility stay in one place?'
  ],
  dependencies: [
    'Does this pull a new dependency for something the standard library or an existing dep already does (ponytail rung 4)?',
    'Have you justified the dependency: maintenance, supply-chain risk, and the cost of removing it later?'
  ],
  dx: [
    'Will the next agent or human understand this without you in the room — names, errors, setup?',
    'Does this shorten or lengthen the feedback loop for whoever works here next?'
  ],
  documentation: [
    'Which .project-brain/ doc goes stale the moment this merges, and will you update it in the same change?',
    'Is the decision behind this change written down, or only in your head right now?'
  ],
  'feature-direction': [
    'Does this match the intent in active_state.md / the product plan, or is it scope drift?',
    'Is this finishing something half-built, or starting a third half-built thing?'
  ]
};

/**
 * STAKEHOLDER LENSES — the second axis of the grill.
 *
 * The category bank above asks how the CODE fails: correctness, security,
 * performance. This bank asks whose INTERESTS the plan trades against, which is
 * a different question and finds different things. A change can be correct,
 * fast, tested, and still be the wrong change because it quietly moves cost
 * onto the person who has to run it at 3am, or onto whoever inherits it.
 *
 * The payoff is NOT the union of the questions. Eleven lenses times seven
 * questions is seventy-seven questions nobody answers honestly, and a grill
 * where every lens says "proceed" has told you nothing. The payoff is
 * DISAGREEMENT: each lens returns its own verdict, and a plan the maintainer
 * blocks while the product side proceeds is exactly the conversation that has
 * to happen before the code exists. `lensConflict()` below is the output.
 *
 * Kept deliberately small and non-overlapping — a lens that duplicates a
 * category bank earns nothing and costs the reader attention. `stake` names
 * what this person loses when the plan is wrong; it is printed with the
 * questions so the answerer argues against a real interest, not a job title.
 */
export const STAKEHOLDER_LENSES = Object.freeze({
  user: {
    who: 'The person the software is for',
    stake: 'their task gets slower, or stops working the way they learned it',
    questions: [
      'Whose task gets HARDER because of this — and did you weigh that against whose gets easier?',
      'If this ships and nobody notices, was it worth building? Name the user-visible difference in one sentence.'
    ]
  },
  'on-call': {
    who: 'Whoever is woken at 3am when this breaks',
    stake: 'a failure they cannot diagnose from the outside',
    questions: [
      'When this fails at 3am, what exactly is in the logs — and is it enough to act on without reading the source?',
      'Does this add a new way to fail silently: a swallowed error, a retry that hides a real fault, a default that masks a missing value?'
    ]
  },
  maintainer: {
    who: 'Whoever owns this file in a year (probably you, having forgotten)',
    stake: 'the ability to change it safely without archaeology',
    questions: [
      'What will be impossible to change later because of a decision you are making now — a schema, a public name, a wire format?',
      'Is the REASON for this written where the next reader will look, or only in the diff and this conversation?'
    ]
  },
  newcomer: {
    who: 'The next agent or engineer arriving with zero context',
    stake: 'hours spent inferring what a sentence could have told them',
    questions: [
      'Could someone with no context tell from the code alone what this is for and what it must never do?',
      'How many files must they read before they can safely change this one? If the answer is more than three, say why that is acceptable.'
    ]
  },
  integrator: {
    who: 'Whoever consumes this from outside — another repo, service, or client',
    stake: 'their build breaking on a change they never saw',
    questions: [
      'What in this change is now part of a contract someone else depends on — and did you mean to promise it?',
      'If a downstream consumer is on the old shape, do they break loudly, break quietly, or keep working? Only one of those is acceptable.'
    ]
  },
  support: {
    who: 'Whoever has to explain to a user why it did that',
    stake: 'behaviour they cannot account for',
    questions: [
      'When a user asks "why did it do that", can the answer be reconstructed from what this records — or only guessed?',
      'Does this add behaviour that is correct but surprising? Surprising costs support time forever; correct only costs it once.'
    ]
  },
  payer: {
    who: 'Whoever funds the time — you, on a bootstrap',
    stake: 'the weeks this costs and the thing not built instead',
    questions: [
      'What are you NOT building this week because of this? Is that trade the one you would make deliberately?',
      'What is the cheapest experiment that would tell you this is worth building at all — and why are you skipping it?'
    ]
  }
});

/** PURE. Lens ids in a stable, documented order. */
export const LENS_IDS = Object.freeze(Object.keys(STAKEHOLDER_LENSES));

/**
 * PURE. Resolve a --lens value into lens ids.
 * '' → [] (opt-in: the grill stays exactly as it was). 'all' → every lens.
 * Unknown names are RETURNED as `unknown`, never silently dropped — a typo that
 * quietly removes a perspective is the failure mode this whole feature exists
 * to prevent.
 * @returns {{ids: string[], unknown: string[]}}
 */
export function resolveLenses(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ids: [], unknown: [] };
  if (raw.toLowerCase() === 'all') return { ids: [...LENS_IDS], unknown: [] };
  const ids = [];
  const unknown = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const key = part.toLowerCase();
    if (STAKEHOLDER_LENSES[key]) { if (!ids.includes(key)) ids.push(key); }
    else if (!unknown.includes(part)) unknown.push(part);
  }
  // Stable order: the declared order, not the order they were typed.
  return { ids: LENS_IDS.filter((id) => ids.includes(id)), unknown };
}

/**
 * PURE. Read the per-lens verdict lines back out of an answered grill body.
 * Tolerant of case and surrounding prose; a lens the answerer left blank comes
 * back as null rather than being assumed to agree.
 * @returns {Record<string, string|null>} lens id → proceed|revise|block|null
 */
export function parseLensVerdicts(body, ids = LENS_IDS) {
  const text = String(body || '');
  const out = {};
  for (const id of ids) {
    const re = new RegExp(`^\\s*-?\\s*\\*{0,2}${id.replace(/[-]/g, '\\-')}\\*{0,2}\\s*(?:verdict)?\\s*[:\u2014-]\\s*\\*{0,2}(proceed|revise|block)\\*{0,2}`, 'im');
    const m = text.match(re);
    out[id] = m ? m[1].toLowerCase() : null;
  }
  return out;
}

const VERDICT_RANK = Object.freeze({ proceed: 0, revise: 1, block: 2 });

/**
 * PURE. Where do the lenses disagree, and what does that mean?
 *
 * `conflict` is true when two lenses reach different verdicts — that is the
 * signal worth a human's attention, and it is the reason to run more than one
 * lens at all. `worst` drives the overall recommendation: one lens blocking is
 * enough to stop, because the whole point of asking is to let a single
 * neglected interest veto.
 *
 * @returns {{answered: number, missing: string[], conflict: boolean,
 *            worst: string|null, split: Record<string, string[]>}}
 */
export function lensConflict(verdicts = {}) {
  const entries = Object.entries(verdicts);
  const split = { proceed: [], revise: [], block: [] };
  const missing = [];
  for (const [id, v] of entries) {
    if (v && split[v]) split[v].push(id);
    else missing.push(id);
  }
  const present = Object.keys(split).filter((k) => split[k].length);
  const worst = present.length
    ? present.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a))
    : null;
  return {
    answered: entries.length - missing.length,
    missing,
    conflict: present.length > 1,
    worst,
    split
  };
}

// Always-asked, idea-agnostic challenges (Pocock's "flush out issues" core).
const GENERIC_CHALLENGES = [
  'What is the simplest version that could possibly work — and why are you not shipping THAT first?',
  'What is the single load-bearing assumption here? If it is false, does the whole approach collapse?',
  'What breaks at scale, under failure, or under concurrent use that works fine in your local test?',
  'What is the rollback plan if this is merged and turns out wrong — revert, flag, migration-down?',
  'What would a skeptical reviewer reject this for? Pre-empt their strongest objection now.'
];

/**
 * Generate the adversarial interview as a list of { section, question } from
 * already-loaded, grounded evidence. PURE — every input is passed in.
 *
 * @param {object} input
 * @param {string} [input.targetType]   finding|improve-plan|decision|proposal
 * @param {string} [input.category]     a FINDING_CATEGORIES value (tunes the bank)
 * @param {string} [input.title]        what's being grilled (for phrasing)
 * @param {string} [input.module]
 * @param {Array<{symbol,callerFiles:string[],testFiles:string[],crossInbound:Array<{from,kind}>}>} [input.blast]
 * @param {Array<{decision,title}>} [input.adrs]            governing ADRs
 * @param {Array<{slug,title,status}>} [input.relatedFindings]  same-module open/planned findings
 * @param {string[]} [input.lenses]     STAKEHOLDER_LENSES ids to also ask as
 *                                      (opt-in; see resolveLenses)
 * @returns {Array<{section,question}>}
 */
export function generateChallenges(input = {}) {
  const out = [];
  const push = (section, question) => out.push({ section, question });

  // 1. Contract / blast-radius — the brain's grounded, specific questions.
  for (const b of input.blast || []) {
    const sym = b.symbol;
    const callers = (b.callerFiles || []).filter(Boolean);
    const tests = (b.testFiles || []).filter(Boolean);
    const cross = b.crossInbound || [];
    if (callers.length) {
      push('Contract', `\`${sym}\` has ${callers.length} caller file(s) (${preview(callers)}). How does your change preserve their contract — signature, return shape, error behavior?`);
    }
    if (cross.length) {
      push('Contract', `Cross-project consumer(s) couple to \`${sym}\`: ${cross.map(c => `${c.from} via ${c.kind}`).join(', ')}. Does your change keep that wire/schema shape, or do those consumers need a coordinated update?`);
    }
    if (tests.length) {
      push('Tests', `Tests cover \`${sym}\` (${preview(tests)}). Do they still pass, and which NEW case proves the fix rather than just re-passing?`);
    } else if (callers.length || cross.length) {
      push('Tests', `\`${sym}\` has no tests in the index but has dependents. What is the regression test you will add before changing it?`);
    }
  }

  // 2. Governing decisions — respect or supersede, explicitly.
  for (const adr of input.adrs || []) {
    push('Decisions', `ADR ${adr.decision}${adr.title ? ` (${adr.title})` : ''} governs this area. Does your change respect it — or must it supersede it, and did you write the superseding ADR?`);
  }

  // 3. Conflicts with other open work.
  for (const f of input.relatedFindings || []) {
    push('Conflicts', `Open ${f.status} finding \`${f.slug}\`${f.title ? ` (${f.title})` : ''} touches the same module. Does your change conflict with it, subsume it, or depend on it landing first?`);
  }

  // 4. Category-tuned bank.
  const cat = String(input.category || '').toLowerCase();
  for (const q of CATEGORY_CHALLENGES[cat] || []) push(capitalize(cat), q);

  // 5. Stakeholder lenses (opt-in via --lens). Placed BEFORE the generic bank
  //    so an answerer working top-down meets the people before the platitudes.
  for (const id of input.lenses || []) {
    const lens = STAKEHOLDER_LENSES[id];
    if (!lens) continue;
    for (const q of lens.questions) push(`Lens: ${id}`, q);
  }

  // 6. Generic, always-asked challenges.
  for (const q of GENERIC_CHALLENGES) push('Fundamentals', q);

  return out;
}

/** Render the grounded interview as Markdown the agent fills in. PURE. */
export function renderInterview(meta, challenges) {
  const lines = [];
  lines.push(`# Grill: ${meta.title || meta.target || 'proposal'}`);
  lines.push('');
  const tags = [
    meta.targetType && `target: ${meta.targetType}`,
    meta.target && meta.target !== meta.title && `\`${meta.target}\``,
    meta.category && `category: ${meta.category}`,
    meta.module && `module: ${meta.module}`
  ].filter(Boolean).join(' · ');
  if (tags) lines.push(`> ${tags}`);
  lines.push('');
  lines.push('Answer every question HONESTLY before you implement. The goal is to');
  lines.push('flush out issues now, when they are cheap. When done, record the');
  lines.push('interview + your verdict:');
  lines.push('');
  lines.push(`  npm run brain:grill -- save --target ${meta.target ? `"${meta.target}"` : '"<id>"'} --verdict proceed|revise|block \\`);
  lines.push('         --sources <the files you actually inspected> --body-file answers.md');
  lines.push('');

  if (!challenges.length) {
    lines.push('_No questions generated — provide a target or --title._');
    return lines.join('\n') + '\n';
  }

  // Group by section, preserving first-seen order.
  const order = [];
  const bySection = new Map();
  for (const c of challenges) {
    if (!bySection.has(c.section)) { bySection.set(c.section, []); order.push(c.section); }
    bySection.get(c.section).push(c.question);
  }
  let n = 0;
  for (const section of order) {
    lines.push(`## ${section}`);
    for (const q of bySection.get(section)) {
      n += 1;
      lines.push(`${n}. ${q}`);
      lines.push('   - **A:** ');
    }
    lines.push('');
  }
  const lenses = (meta.lenses || []).filter((id) => STAKEHOLDER_LENSES[id]);
  if (lenses.length) {
    lines.push('## Verdict per lens');
    lines.push('');
    lines.push('One line each. Answer AS that person, not about them — and do not');
    lines.push('harmonise them. Where two lenses disagree is the finding; a grill in');
    lines.push('which every lens says proceed has told you nothing.');
    lines.push('');
    for (const id of lenses) {
      const l = STAKEHOLDER_LENSES[id];
      lines.push(`- **${id}** — ${l.who}; loses: ${l.stake}`);
      lines.push(`  - ${id}: proceed|revise|block — _why, in one sentence_`);
    }
    lines.push('');
  }
  lines.push('## Verdict');
  lines.push('_proceed_ (defended — build it) · _revise_ (issues found — change the plan first) · _block_ (do not build it)');
  if (lenses.length) {
    lines.push('');
    lines.push('One lens blocking is enough to stop: the reason to ask several is to let');
    lines.push('a single neglected interest veto.');
  }
  return lines.join('\n').replace(/\n+$/, '\n') + '\n';
}

function preview(list, max = 3) {
  const shown = list.slice(0, max).map(f => `\`${f}\``).join(', ');
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ---------------------------------------------------------------------------
// Evidence gathering (I/O; mostly model-free — degrades gracefully).
// ---------------------------------------------------------------------------

/** Governing ADRs whose frontmatter `module` matches, read straight from disk (no index needed). */
function loadGoverningAdrs(module) {
  if (!module || !exists(DECISIONS_DIR)) return [];
  const aliases = new Set([module, lastSegment(module)].filter(Boolean));
  const out = [];
  let names;
  try { names = fs.readdirSync(DECISIONS_DIR); } catch { return []; }
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue;
    const text = read(path.join(DECISIONS_DIR, name));
    const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let recModule = '';
    let title = '';
    if (fm) {
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^(module|title):\s*(.*)$/);
        if (m) { if (m[1] === 'module') recModule = m[2].trim(); else title = m[2].trim().replace(/^["']|["']$/g, ''); }
      }
    }
    if (!recModule || !aliases.has(recModule)) continue;
    if (!title) { const h = (fm ? fm[2] : text).match(/^#\s+(.+)$/m); if (h) title = h[1].trim(); }
    out.push({ decision: name.replace(/\.md$/, ''), title });
  }
  return out;
}

/** Same-module open/planned findings (excluding the one being grilled). No model. */
function relatedFindingsFor(module, excludeSlug) {
  if (!module) return [];
  return loadFindings()
    .filter(f => f.module === module && (f.status === 'open' || f.status === 'planned') && f.slug !== excludeSlug)
    .map(f => ({ slug: f.slug, title: f.title, status: f.status }));
}

const lastSegment = (m) => String(m || '').split('/').filter(Boolean).pop() || '';

/**
 * Open the index once (soft-null on any failure — no index, blocked model
 * download, etc.) and return { embedder, store, records }. Mirrors
 * brain-radar.mjs#openIndex so blast-radius gathering shares the same shape.
 */
async function openIndex() {
  try {
    const { openEmbedder } = await import('./embed.mjs');
    const { openStore } = await import('./store.mjs');
    const embedder = openEmbedder();
    const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
    const records = await store.getAll();
    return { embedder, store, records };
  } catch { return null; }
}

/** Build the blast input for generateChallenges from the open index (capped, soft). */
async function buildBlast(symbols, index, opts = {}) {
  if (!index || !symbols.length) return [];
  const max = Number(opts.maxSymbols || process.env.BRAIN_GRILL_MAX_SYMBOLS || 6);
  let buildImpact, listIndexableFiles;
  try {
    ({ buildImpact } = await import('./brain-impact.mjs'));
    ({ listIndexableFiles } = await import('./common.mjs'));
  } catch { return []; }
  let indexable = [];
  try { indexable = await listIndexableFiles(); } catch { /* soft */ }
  const out = [];
  for (const symbol of symbols.slice(0, max)) {
    try {
      const impact = await buildImpact(symbol, index.records, index.store, index.embedder, {
        root: ROOT, indexable, crossProject: true
      });
      out.push({
        symbol,
        callerFiles: dedupeFiles(impact.callers),
        testFiles: dedupeFiles(impact.tests),
        crossInbound: (impact.crossProjectEdges?.toOwner || []).map(e => ({ from: e.from, kind: e.kind }))
      });
    } catch { /* skip this symbol */ }
  }
  return out;
}

function dedupeFiles(recs) { return [...new Set((recs || []).map(r => r && r.file).filter(Boolean))]; }

/** Optional retrieved context primer (only under --context; needs the index). */
async function buildContextPrimer(query, opts = {}) {
  try {
    const { packPrompt } = await import('./brain-pack.mjs');
    const packed = await packPrompt(query, { maxTokens: Number(opts.maxTokens || 1200), mode: 'for-agent', forAgent: 'reviewer', actor: opts.actor || '' });
    return packed?.prompt || '';
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Target resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve a positional id to a grill target. Tries finding → plan → decision,
 * falling back to a free-form proposal. Returns the metadata + the symbols/
 * sources that drive evidence gathering.
 */
function resolveTarget(id, opts = {}) {
  if (!id) {
    return { targetType: 'proposal', target: opts.title || '', title: opts.title || '', category: opts.category || 'tech-debt', module: opts.module || '', symbols: [], sources: [] };
  }
  const findings = loadFindings();
  const finding = findings.find(f => f.slug === id) || findings.find(f => f.slug === slugify(id));
  if (finding) {
    return { targetType: 'finding', target: finding.slug, title: finding.title, category: finding.category, module: finding.module, symbols: finding.symbols || [], sources: (finding.sources || []).map(s => s.path) };
  }
  const plans = loadPlans();
  const plan = plans.find(p => p.slug === id) || plans.find(p => p.slug === `improve-${id}`) || plans.find(p => p.slug === slugify(id));
  if (plan) {
    const src = findings.find(f => f.slug === plan.finding);
    return { targetType: 'improve-plan', target: plan.slug, title: plan.title, category: plan.category, module: plan.module || src?.module || '', symbols: src?.symbols || [], sources: (src?.sources || []).map(s => s.path) };
  }
  // Decision (ADR) by slug.
  const adrFile = path.join(DECISIONS_DIR, `${id}.md`);
  if (exists(adrFile)) {
    const text = read(adrFile);
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    let module = '';
    if (fm) { const m = fm[1].match(/^module:\s*(.*)$/m); if (m) module = m[1].trim(); }
    const h = text.match(/^#\s+(.+)$/m);
    return { targetType: 'decision', target: id, title: h ? h[1].trim() : id, category: opts.category || 'documentation', module, symbols: [], sources: [`.project-brain/decisions/${id}.md`] };
  }
  // Free-form proposal.
  return { targetType: 'proposal', target: id, title: opts.title || id, category: opts.category || 'tech-debt', module: opts.module || '', symbols: [], sources: [] };
}

// ---------------------------------------------------------------------------
// Subcommands.
// ---------------------------------------------------------------------------

async function cmdScaffold(args) {
  const json = takeFlag(args, '--json');
  const withContext = takeFlag(args, '--context');
  const maxSymbols = Number(takeOption(args, '--max-symbols')) || undefined;
  const category = (takeOption(args, '--category') || '').trim();
  const title = takeOption(args, '--title').trim();
  const moduleOpt = takeOption(args, '--module').trim();
  const lensOpt = (takeOption(args, '--lens') || '').trim();
  const { ids: lenses, unknown: unknownLenses } = resolveLenses(lensOpt);
  if (unknownLenses.length) {
    // A typo must never silently remove a perspective — that is the exact
    // failure this feature exists to prevent.
    process.stderr.write(
      `[brain:grill] unknown lens(es): ${unknownLenses.join(', ')}\n` +
      `Known: ${LENS_IDS.join(', ')} (or --lens all)\n`
    );
    process.exit(2);
  }
  const id = args.find(a => !a.startsWith('-')) || '';

  const meta = resolveTarget(id, { title, category, module: moduleOpt });
  if (category) meta.category = category;
  if (moduleOpt) meta.module = moduleOpt;

  const adrs = loadGoverningAdrs(meta.module);
  const relatedFindings = relatedFindingsFor(meta.module, meta.targetType === 'finding' ? meta.target : '');

  // Blast-radius needs the index; everything else is model-free.
  let blast = [];
  let primer = '';
  if (meta.symbols.length || withContext) {
    const index = await openIndex();
    if (index) {
      blast = await buildBlast(meta.symbols, index, { maxSymbols });
      if (withContext) primer = await buildContextPrimer(`${meta.title} ${meta.module}`.trim(), { actor: process.env.BRAIN_ACTOR });
      try { await index.store.close?.(); } catch { /* soft */ }
    }
  }

  meta.lenses = lenses;
  const challenges = generateChallenges({
    targetType: meta.targetType, category: meta.category, title: meta.title,
    module: meta.module, blast, adrs, relatedFindings, lenses
  });

  if (json) {
    process.stdout.write(JSON.stringify({
      target: meta.target, targetType: meta.targetType, category: meta.category, module: meta.module,
      symbols: meta.symbols, sources: meta.sources,
      evidence: { blast: blast.length, adrs: adrs.length, relatedFindings: relatedFindings.length, indexed: blast.length > 0 },
      challenges
    }, null, 2) + '\n');
    return;
  }

  let body = renderInterview(meta, challenges);
  if (primer) body += `\n## Retrieved context\n\n${primer.trim()}\n`;
  if (!blast.length && meta.symbols.length) {
    body += '\n> _No blast-radius questions: the index was unavailable or the symbols are not indexed. Run `brain:index` for grounded contract questions._\n';
  }
  process.stdout.write(body);
}

function readBody(args) {
  const inline = takeOption(args, '--body');
  if (inline) return inline;
  const bodyFile = takeOption(args, '--body-file');
  if (bodyFile) {
    const abs = path.isAbsolute(bodyFile) ? bodyFile : path.join(ROOT, bodyFile);
    if (!exists(abs)) { process.stderr.write(`[brain:grill] --body-file not found: ${bodyFile}\n`); process.exit(1); }
    return read(abs);
  }
  if (!process.stdin.isTTY) {
    try { const s = fs.readFileSync(0, 'utf8'); if (s.trim()) return s; } catch { /* no stdin */ }
  }
  return '_No answers recorded. Re-run `brain:grill save` with --body / --body-file or piped stdin._';
}

function cmdSave(args) {
  const target = takeOption(args, '--target').trim();
  const titleOpt = takeOption(args, '--title').trim();
  const title = titleOpt || target;
  if (!title) { process.stderr.write('[brain:grill] save requires --target <id> or --title "..."\n'); process.exit(1); }

  let targetType = (takeOption(args, '--target-type') || '').trim();
  let category = (takeOption(args, '--category') || 'tech-debt').trim();
  let module = takeOption(args, '--module').trim();

  // If --target resolves to a known finding/plan/decision, inherit its metadata
  // (the agent need not retype target-type/category/module).
  if (target) {
    const meta = resolveTarget(target, {});
    if (!targetType) targetType = meta.targetType;
    if (category === 'tech-debt' && meta.category) category = meta.category;
    if (!module && meta.module) module = meta.module;
  }
  if (!targetType) targetType = 'proposal';
  if (!GRILL_TARGET_TYPES.includes(targetType)) {
    process.stderr.write(`[brain:grill] warning: non-standard target-type "${targetType}" (standard: ${GRILL_TARGET_TYPES.join(', ')})\n`);
  }
  if (!FINDING_CATEGORIES.includes(category)) {
    process.stderr.write(`[brain:grill] warning: non-standard category "${category}" (standard: ${FINDING_CATEGORIES.join(', ')})\n`);
  }

  let verdict = (takeOption(args, '--verdict') || 'open').trim();
  if (!GRILL_VERDICTS.includes(verdict)) {
    process.stderr.write(`[brain:grill] warning: non-standard verdict "${verdict}" (standard: ${GRILL_VERDICTS.join(', ')})\n`);
  }

  const actor = takeOption(args, '--actor') || process.env.BRAIN_ACTOR || '';
  const sourcePaths = (takeOption(args, '--sources') || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const body = readBody(args);

  const sources = [];
  for (const sp of sourcePaths) {
    const h = hashSource(sp);
    if (h === null) process.stderr.write(`[brain:grill] warning: cited source not found, recording with null hash: ${sp}\n`);
    sources.push({ path: sp, sha256: h });
  }

  const slug = slugify(`grill ${title}`);
  const dest = path.join(GRILL_DIR, `${slug}.md`);
  const now = new Date().toISOString();
  let created = now;
  if (exists(dest)) { const prev = parseGrill(read(dest)); if (prev.created) created = prev.created; }

  ensureDir(GRILL_DIR);
  write(dest, serializeGrill({ title, target, targetType, category, verdict, created, updated: now, actor, module, sources, body }));
  process.stdout.write(`${path.relative(ROOT, dest)}\n`);

  // Stakeholder lenses: the disagreement is the product. Reading it back out of
  // the answered body (rather than asking for it again on the command line)
  // keeps one source of truth — the interview the answerer actually filled in.
  const lensVerdicts = parseLensVerdicts(body);
  const answered = Object.fromEntries(Object.entries(lensVerdicts).filter(([, v]) => v));
  if (Object.keys(answered).length) {
    const c = lensConflict(answered);
    const parts = ['proceed', 'revise', 'block']
      .filter((v) => c.split[v].length)
      .map((v) => `${v}: ${c.split[v].join(', ')}`);
    process.stdout.write(`\nLenses (${c.answered} answered) — ${parts.join(' · ')}\n`);
    if (c.conflict) {
      process.stdout.write(
        `CONFLICT: the lenses do not agree. That disagreement is the finding — resolve it in the\n` +
        `plan before building, not by averaging the verdicts.\n`
      );
    } else {
      process.stdout.write('No disagreement between the lenses answered — which is only informative if you answered them independently.\n');
    }
    if (c.worst === 'block' && verdict === 'proceed') {
      // Never silently outrank a lens: one neglected interest gets a veto, and
      // an overall `proceed` recorded over a blocking lens is the exact thing
      // this axis exists to catch.
      process.stdout.write(
        `\nWARNING: overall verdict is \`proceed\` while ${c.split.block.join(', ')} said \`block\`.\n` +
        `Either answer that objection in the body or change the verdict — the record now shows both.\n`
      );
    }
  }
}

function cmdCheck(args) {
  const json = takeFlag(args, '--json');
  const strict = takeFlag(args, '--strict');
  const grills = loadGrills();
  const results = evaluateExplainers(grills.map(g => ({ slug: g.slug, query: g.title, sources: g.sources })), hashSource);
  const staleCount = results.filter(r => r.stale).length;

  if (json) {
    process.stdout.write(JSON.stringify({ total: results.length, stale: staleCount, results }, null, 2) + '\n');
  } else {
    if (!results.length) process.stdout.write('No grills found.\n');
    for (const r of results) {
      process.stdout.write(`[${r.stale ? 'STALE' : 'fresh'}] ${r.slug} — ${r.query}\n`);
      if (r.stale) for (const reason of r.reasons) if (reason.status !== 'ok') process.stdout.write(`    ${reason.status}: ${reason.path}\n`);
    }
    if (results.length) process.stdout.write(`\n${results.length} grill(s), ${staleCount} stale.\n`);
  }
  if (strict && staleCount > 0) process.exit(1);
}

function cmdList(args) {
  const json = takeFlag(args, '--json');
  const grills = loadGrills();
  const results = evaluateExplainers(grills.map(g => ({ slug: g.slug, query: g.title, sources: g.sources })), hashSource);
  const bySlug = new Map(results.map(r => [r.slug, r]));
  if (json) {
    process.stdout.write(JSON.stringify(grills.map(g => ({
      slug: g.slug, title: g.title, target: g.target, targetType: g.targetType,
      category: g.category, verdict: g.verdict, module: g.module, file: g.file,
      stale: bySlug.get(g.slug)?.stale ?? false
    })), null, 2) + '\n');
    return;
  }
  if (!grills.length) { process.stdout.write('No grills yet. Run `brain:grill -- scaffold <finding|plan|decision>`.\n'); return; }
  for (const g of grills) {
    const stale = bySlug.get(g.slug)?.stale ? ' (stale)' : '';
    process.stdout.write(`[${g.verdict}] ${g.slug} — ${g.targetType}: ${g.title}${stale}\n`);
  }
  process.stdout.write(`\n${grills.length} grill(s).\n`);
}

function usage() {
  return [
    'Usage:',
    '  npm run brain:grill -- scaffold <finding|plan|decision-slug> [--category c] [--lens a,b|all] [--context] [--max-symbols N] [--json]',
    `     --lens: also grill AS a stakeholder — ${LENS_IDS.join(', ')} (or all). Each returns its own verdict; where they disagree is the finding.`,
    '  npm run brain:grill -- scaffold --title "free-form proposal" [--category c] [--module m]',
    '  npm run brain:grill -- save [--target <id>] [--title "..."] [--target-type t] [--category c] [--module m]',
    '         [--verdict open|proceed|revise|block] [--sources a.mjs,b/c.md] [--actor X] [--body "..." | --body-file <path>]',
    '  npm run brain:grill -- check [--json] [--strict]',
    '  npm run brain:grill -- list [--json]',
    '',
    `Categories: ${FINDING_CATEGORIES.join(', ')}`,
    `Verdicts: ${GRILL_VERDICTS.join(', ')}`
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const sub = args.shift();
  if (help || !sub) { console.log(usage()); process.exit(help ? 0 : 1); }
  try {
    if (sub === 'scaffold') return await cmdScaffold(args);
    if (sub === 'save') return cmdSave(args);
    if (sub === 'check') return cmdCheck(args);
    if (sub === 'list') return cmdList(args);
    process.stderr.write(`[brain:grill] unknown subcommand: ${sub}\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`[brain:grill] ${error.message || error}\n`);
    process.exit(1);
  }
}

// MANDATORY isMain guard: importing this module (e.g. from tests) must NOT run
// the CLI, open the store, or call process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
