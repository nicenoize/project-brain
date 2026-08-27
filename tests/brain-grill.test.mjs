import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure exports — importing the script must NOT run its CLI (isMain guard).
import {
  generateChallenges, renderInterview, STAKEHOLDER_LENSES, LENS_IDS,
  resolveLenses, parseLensVerdicts, lensConflict, splitInterviews, mergeSplitAnswers
} from '../scripts/brain-grill.mjs';
import { serializeGrill, parseGrill, GRILL_VERDICTS } from '../scripts/findings.mjs';
import { inferType } from '../scripts/infer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const GRILL_SCRIPT = path.join(scriptsDir, 'brain-grill.mjs');

// ---------------------------------------------------------------------------
// inferType registration
// ---------------------------------------------------------------------------

test('inferType: .project-brain/grills/*.md → grill', () => {
  assert.equal(inferType('.project-brain/grills/grill-fix-x.md'), 'grill');
});

// ---------------------------------------------------------------------------
// grill record (de)serialization
// ---------------------------------------------------------------------------

test('grill roundtrip preserves every field incl. nested sources', () => {
  const rec = {
    title: 'Cache hybridScore',
    target: 'cache-hybridscore',
    targetType: 'finding',
    category: 'performance',
    verdict: 'revise',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    actor: 'tester',
    module: 'scripts/retrieval',
    sources: [{ path: 'scripts/retrieval.mjs', sha256: 'a'.repeat(64) }, { path: 'gone.mjs', sha256: null }],
    body: '## Contract\n1. q\n   - **A:** answer\n'
  };
  const md = serializeGrill(rec);
  assert.match(md, /^type: grill$/m);
  assert.match(md, /^verdict: revise$/m);

  const back = parseGrill(md);
  assert.equal(back.title, rec.title);
  assert.equal(back.target, rec.target);
  assert.equal(back.targetType, 'finding');
  assert.equal(back.category, 'performance');
  assert.equal(back.verdict, 'revise');
  assert.equal(back.module, 'scripts/retrieval');
  assert.equal(back.sources.length, 2);
  assert.equal(back.sources[0].path, 'scripts/retrieval.mjs');
  assert.equal(back.sources[0].sha256, 'a'.repeat(64));
  assert.equal(back.sources[1].sha256, null);
  assert.match(back.body, /answer/);
});

test('grill verdict vocabulary is the documented set', () => {
  assert.deepEqual(GRILL_VERDICTS, ['open', 'proceed', 'revise', 'block']);
});

// ---------------------------------------------------------------------------
// generateChallenges — the pure adversarial-question core
// ---------------------------------------------------------------------------

test('generateChallenges: blast-radius produces grounded contract + test questions', () => {
  const challenges = generateChallenges({
    targetType: 'finding',
    category: 'performance',
    blast: [
      { symbol: 'hybridScore', callerFiles: ['a.mjs', 'b.mjs'], testFiles: ['x.test.mjs'], crossInbound: [{ from: 'workers', kind: 'http-client' }] },
      { symbol: 'tfidfScore', callerFiles: ['c.mjs'], testFiles: [], crossInbound: [] }
    ]
  });
  const text = JSON.stringify(challenges);
  // contract question names the symbol + caller count
  assert.match(text, /hybridScore/);
  assert.match(text, /2 caller file/);
  // cross-project consumer surfaced
  assert.match(text, /workers via http-client/);
  // symbol with dependents but no tests → "regression test you will add"
  assert.match(text, /no tests in the index/);
  // category bank present
  assert.ok(challenges.some(c => c.section === 'Performance'));
  // generic always present
  assert.ok(challenges.some(c => c.section === 'Fundamentals'));
});

test('generateChallenges: ADRs and related findings become explicit challenges', () => {
  const challenges = generateChallenges({
    targetType: 'finding',
    category: 'correctness',
    adrs: [{ decision: '0014-lexical-candidate-union', title: 'Lexical union' }],
    relatedFindings: [{ slug: 'other-bug', title: 'Other bug', status: 'open' }]
  });
  const text = JSON.stringify(challenges);
  assert.match(text, /0014-lexical-candidate-union/);
  assert.match(text, /supersede/);
  assert.match(text, /other-bug/);
  assert.ok(challenges.some(c => c.section === 'Decisions'));
  assert.ok(challenges.some(c => c.section === 'Conflicts'));
});

test('generateChallenges: with no evidence still asks category + generic (model-free path)', () => {
  const challenges = generateChallenges({ targetType: 'proposal', category: 'security' });
  assert.ok(challenges.length >= 6); // 2 security + 5 generic
  assert.ok(challenges.some(c => c.section === 'Security'));
  assert.ok(challenges.some(c => c.section === 'Fundamentals'));
  // No fabricated contract/decision questions without evidence.
  assert.ok(!challenges.some(c => c.section === 'Contract'));
  assert.ok(!challenges.some(c => c.section === 'Decisions'));
});

test('renderInterview: numbers questions sequentially across sections + emits answer slots', () => {
  const challenges = generateChallenges({ targetType: 'proposal', category: 'testing' });
  const md = renderInterview({ title: 'T', target: 't', targetType: 'proposal', category: 'testing' }, challenges);
  assert.match(md, /^# Grill: T$/m);
  assert.match(md, /^## Testing$/m);
  assert.match(md, /^## Fundamentals$/m);
  assert.match(md, /\*\*A:\*\*/);
  assert.match(md, /## Verdict/);
  // Sequential numbering: there is a "1." and the count matches challenges.
  const nums = (md.match(/^\d+\. /gm) || []).length;
  assert.equal(nums, challenges.length);
});

// ---------------------------------------------------------------------------
// CLI: save → check staleness lifecycle (reuses evaluateExplainers/hashSource)
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grill-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 1;\n');
  return cwd;
}
function runGrill(cwd, args, input) {
  return spawnSync(process.execPath, [GRILL_SCRIPT, ...args], { cwd, encoding: 'utf8', input });
}

test('CLI save writes a grill record; check reports fresh, then STALE after source drift', () => {
  const cwd = makeRepo();
  const save = runGrill(cwd, ['save', '--title', 'Cache it', '--target-type', 'proposal', '--category', 'performance', '--verdict', 'proceed', '--sources', 'src.mjs'], 'A: defended.\n');
  assert.equal(save.status, 0, save.stderr);
  assert.match(save.stdout, /\.project-brain\/grills\/grill-cache-it\.md/);

  const fresh = runGrill(cwd, ['check', '--json']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).stale, 0);

  // Mutate the cited source → grill goes stale.
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 2;\n');
  const stale = runGrill(cwd, ['check', '--json']);
  assert.equal(JSON.parse(stale.stdout).stale, 1);
  // --strict exits non-zero on stale.
  const strict = runGrill(cwd, ['check', '--strict']);
  assert.equal(strict.status, 1);
});

test('CLI list shows the verdict and is JSON-clean', () => {
  const cwd = makeRepo();
  runGrill(cwd, ['save', '--title', 'Ship X', '--verdict', 'block', '--sources', 'src.mjs'], 'no.\n');
  const list = runGrill(cwd, ['list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  const rows = JSON.parse(list.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'block');
});

/* ---------------------------------------------------------------------------
 * Stakeholder lenses — the second grill axis.
 *
 * The category bank asks how the CODE fails. These ask whose INTERESTS the
 * plan trades against, which finds different things: a change can be correct,
 * fast and tested and still be wrong because it moves cost onto whoever runs
 * it at 3am. The value is the DISAGREEMENT, not the extra questions, so the
 * conflict machinery gets the same test attention as the bank itself.
 * ------------------------------------------------------------------------ */

test('lenses: every lens declares who it speaks for and what they lose', () => {
  assert.ok(LENS_IDS.length >= 5, 'a single-lens bank is not a second axis');
  for (const id of LENS_IDS) {
    const l = STAKEHOLDER_LENSES[id];
    assert.ok(l.who && l.who.length > 10, `${id}: missing 'who'`);
    // `stake` is what makes an answerer argue against a real interest instead
    // of role-playing a job title — an empty one guts the lens.
    assert.ok(l.stake && l.stake.length > 10, `${id}: missing 'stake'`);
    assert.ok(Array.isArray(l.questions) && l.questions.length >= 2, `${id}: too few questions`);
    for (const q of l.questions) assert.match(q, /\?/, `${id}: not a question: ${q}`);
  }
  // Frozen: a lens bank mutated at runtime would make two grills incomparable.
  assert.throws(() => { STAKEHOLDER_LENSES.user = null; });
});

test('resolveLenses: opt-in by default, "all" expands, order is declared not typed', () => {
  assert.deepEqual(resolveLenses('').ids, [], 'lenses must stay opt-in');
  assert.deepEqual(resolveLenses(undefined).ids, []);
  assert.deepEqual(resolveLenses('all').ids, [...LENS_IDS]);
  assert.deepEqual(resolveLenses('ALL').ids, [...LENS_IDS]);
  // Typed in reverse, returned in declared order → two runs are comparable.
  const rev = [...LENS_IDS].reverse().join(',');
  assert.deepEqual(resolveLenses(rev).ids, [...LENS_IDS]);
  assert.deepEqual(resolveLenses('user, user ,USER').ids, ['user']);
});

test('resolveLenses: an unknown lens is reported, never silently dropped', () => {
  // A typo that quietly removes a perspective is the exact failure this axis
  // exists to prevent, so it surfaces rather than degrading to fewer lenses.
  const r = resolveLenses('maintainer,maintaner,payer');
  assert.deepEqual(r.ids, ['maintainer', 'payer']);
  assert.deepEqual(r.unknown, ['maintaner']);
});

test('generateChallenges: lenses add their own sections and only when asked', () => {
  const without = generateChallenges({ category: 'correctness' });
  assert.ok(!without.some((c) => c.section.startsWith('Lens:')), 'lenses leaked in unasked');

  const withLens = generateChallenges({ category: 'correctness', lenses: ['maintainer', 'payer'] });
  const sections = [...new Set(withLens.map((c) => c.section))];
  assert.ok(sections.includes('Lens: maintainer'));
  assert.ok(sections.includes('Lens: payer'));
  // The existing bank is untouched — this is an added axis, not a replacement.
  assert.ok(sections.includes('Correctness'));
  assert.ok(sections.includes('Fundamentals'));
  // People before platitudes: lenses precede the generic bank.
  assert.ok(
    sections.indexOf('Lens: maintainer') < sections.indexOf('Fundamentals'),
    'lens sections must come before the generic bank'
  );
  // An unknown id in the array is skipped rather than rendering an empty section.
  assert.deepEqual(
    generateChallenges({ lenses: ['nope'] }).filter((c) => c.section.startsWith('Lens:')),
    []
  );
});

test('renderInterview: a per-lens verdict block, or none at all', () => {
  const meta = { title: 'T', lenses: ['maintainer', 'on-call'] };
  const md = renderInterview(meta, generateChallenges({ lenses: meta.lenses }));
  assert.match(md, /## Verdict per lens/);
  assert.match(md, /- \*\*maintainer\*\* — .+; loses: /);
  assert.match(md, /maintainer: proceed\|revise\|block/);
  assert.match(md, /on-call: proceed\|revise\|block/);
  // The instruction that carries the whole idea must survive edits to the text.
  assert.match(md, /do not\n?\s*harmonise them/);
  assert.match(md, /One lens blocking is enough to stop/);

  const plain = renderInterview({ title: 'T' }, generateChallenges({}));
  assert.doesNotMatch(plain, /Verdict per lens/, 'lens block appeared without lenses');
  assert.match(plain, /## Verdict/, 'the overall verdict must still be there');
});

test('parseLensVerdicts: tolerant of shape, silent on unanswered', () => {
  const body = [
    '- **maintainer**: block — the schema becomes load-bearing',
    'on-call — proceed',
    '  payer verdict: REVISE',
    'user: definitely maybe'                       // not a verdict word
  ].join('\n');
  const v = parseLensVerdicts(body);
  assert.equal(v.maintainer, 'block');
  assert.equal(v['on-call'], 'proceed');
  assert.equal(v.payer, 'revise');
  // Unanswered comes back null — never assumed to agree, which would let a
  // lens nobody thought about vote 'proceed' by default.
  assert.equal(v.user, null);
  assert.equal(v.newcomer, null);
});

test('lensConflict: disagreement is the signal, and block outranks', () => {
  const agree = lensConflict({ maintainer: 'proceed', payer: 'proceed' });
  assert.equal(agree.conflict, false);
  assert.equal(agree.worst, 'proceed');
  assert.equal(agree.answered, 2);

  const split = lensConflict({ maintainer: 'block', payer: 'proceed', 'on-call': 'revise' });
  assert.equal(split.conflict, true);
  assert.equal(split.worst, 'block', 'one veto is enough to stop');
  assert.deepEqual(split.split.block, ['maintainer']);

  // A lens left blank is missing, not agreeing.
  const partial = lensConflict({ maintainer: 'revise', payer: null });
  assert.deepEqual(partial.missing, ['payer']);
  assert.equal(partial.answered, 1);
  assert.equal(partial.conflict, false, 'one answer cannot disagree with itself');

  const empty = lensConflict({});
  assert.equal(empty.worst, null);
  assert.equal(empty.conflict, false);
});

test('brain-grill.mjs save: a blocking lens is never outranked in silence', () => {
  // The whole point of asking several perspectives is to let one neglected
  // interest veto. Recording an overall `proceed` over a lens that said `block`
  // without saying so would quietly undo that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grill-lens-'));
  try {
    const answers = path.join(dir, 'answers.md');
    fs.writeFileSync(answers, [
      '- maintainer: block — the schema becomes load-bearing across twelve repos',
      '- payer: proceed — two weeks, and it unblocks the pitch',
      '- on-call: revise — no signal when pooling silently degrades'
    ].join('\n') + '\n');
    const r = spawnSync(process.execPath, [
      GRILL_SCRIPT, 'save', '--title', 'Lens conflict fixture', '--verdict', 'proceed',
      '--body-file', answers
    ], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: dir }, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Lenses \(3 answered\)/);
    assert.match(r.stdout, /block: maintainer/);
    assert.match(r.stdout, /CONFLICT: the lenses do not agree/);
    assert.match(r.stdout, /WARNING: overall verdict is `proceed` while maintainer said `block`/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brain-grill.mjs save: no lens answers → no lens noise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grill-nolens-'));
  try {
    const answers = path.join(dir, 'answers.md');
    fs.writeFileSync(answers, 'Plain prose with no per-lens verdict lines at all.\n');
    const r = spawnSync(process.execPath, [
      GRILL_SCRIPT, 'save', '--title', 'No lenses', '--verdict', 'proceed', '--body-file', answers
    ], { cwd: dir, encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: dir }, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Lenses \(/);
    assert.doesNotMatch(r.stdout, /CONFLICT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brain-grill.mjs scaffold: an unknown --lens fails loudly', () => {
  const r = spawnSync(process.execPath, [GRILL_SCRIPT, 'scaffold', '--title', 'X', '--lens', 'maintaner'], {
    cwd: path.resolve(here, '..'), encoding: 'utf8', timeout: 30000
  });
  assert.equal(r.status, 2, 'a typo must not silently drop a perspective');
  assert.match(r.stderr, /unknown lens\(es\): maintaner/);
  assert.match(r.stderr, /--lens all/);
});

/* ---------------------------------------------------------------------------
 * --split: independence, not just separate paragraphs.
 *
 * One agent answering seven lenses in sequence harmonises them — by the time it
 * writes the maintainer's verdict it knows what it wrote for the user's, and a
 * critique that already agrees with itself is the thing this axis exists to
 * prevent. Independence needs separate CONTEXTS. The brain spawns nothing: it
 * prepares N briefs and merges N answers (ADR 0030).
 * ------------------------------------------------------------------------ */

test('splitInterviews: one self-contained brief per lens, or none', () => {
  const meta = { title: 'Pooled calibration', target: 'pooled', lenses: ['maintainer', 'payer'] };
  const input = { category: 'feature-direction', lenses: meta.lenses };
  const briefs = splitInterviews(meta, input);
  assert.equal(briefs.length, 2);
  assert.deepEqual(briefs.map((b) => b.lens), ['maintainer', 'payer']);
  assert.deepEqual(briefs.map((b) => b.filename), ['pooled.maintainer.md', 'pooled.payer.md']);

  for (const b of briefs) {
    // Each brief states WHO it speaks for and what they lose — an answerer who
    // has to infer their own position argues about a job title.
    assert.match(b.body, new RegExp(`# Grill \\(${b.lens}\\)`));
    assert.match(b.body, /You are answering as/);
    assert.match(b.body, /What you lose if this plan is wrong/);
    // Independence is stated, not implied.
    assert.match(b.body, /you cannot see their answers/);
    // No other lens leaks in — that would let one brief anchor the next.
    const others = ['maintainer', 'payer'].filter((l) => l !== b.lens);
    for (const o of others) assert.ok(!b.body.includes(`## Lens: ${o}`), `${b.lens} leaked ${o}`);
    // One verdict line, its own, and no overall verdict to tempt them with.
    assert.match(b.body, new RegExp(`${b.lens}: proceed\\|revise\\|block`));
    assert.ok(!/_proceed_ \(defended/.test(b.body), 'a split brief must not carry the overall verdict');
    // The save instruction would be wrong here: they are one of N.
    assert.match(b.body, /Do not record an overall verdict/);
    assert.ok(!b.body.includes('brain:grill -- save'), 'a split brief must not tell its reader to save');
  }

  assert.deepEqual(splitInterviews({ title: 'x' }, {}), [], 'no lenses → no split');
  assert.deepEqual(splitInterviews({ title: 'x', lenses: ['nope'] }, {}), []);
});

test('mergeSplitAnswers: answers stay separated, unanswered stays unanswered', () => {
  const r = mergeSplitAnswers([
    { lens: 'maintainer', text: '## Your verdict\nmaintainer: block — schema across twelve repos' },
    { lens: 'payer', text: '## Your verdict\npayer: proceed — two weeks' },
    { lens: 'on-call', text: 'I ran out of time.' }
  ]);
  assert.deepEqual(r.lenses, ['maintainer', 'payer', 'on-call']);
  // Every answer keeps its own heading: merging must not blend the voices.
  assert.match(r.body, /## Answers — maintainer/);
  assert.match(r.body, /## Answers — payer/);
  assert.match(r.body, /- maintainer: block/);
  assert.match(r.body, /- payer: proceed/);
  // A brief nobody answered is recorded as unanswered, never as agreement.
  assert.deepEqual(r.missing, ['on-call']);
  assert.match(r.body, /No verdict line found for: on-call/);
  assert.ok(!/on-call: proceed/.test(r.body));

  // And the merged body is what lensConflict reads, so the round trip holds.
  const c = lensConflict(parseLensVerdicts(r.body, ['maintainer', 'payer', 'on-call']));
  assert.equal(c.conflict, true);
  assert.equal(c.worst, 'block');
  assert.deepEqual(c.missing, ['on-call']);

  assert.deepEqual(mergeSplitAnswers([]).lenses, []);
});

test('parseLensVerdicts: the TEMPLATE line is not an answer', () => {
  // Found end-to-end: an answered brief still contains the scaffold's
  // placeholder `maintainer: proceed|revise|block — _why…_`, which was the
  // FIRST match and made every lens report `proceed` regardless of what the
  // reviewer wrote. A merge said "proceed: maintainer" over a brief saying
  // `block` — a verdict tool reporting the opposite of the verdict.
  const answered = [
    'maintainer: proceed|revise|block — _why, in one sentence_',
    'maintainer: block — the schema becomes load-bearing'
  ].join('\n');
  assert.equal(parseLensVerdicts(answered, ['maintainer']).maintainer, 'block');

  // An untouched template is unanswered, not a proceed.
  assert.equal(
    parseLensVerdicts('payer: proceed|revise|block — _why, in one sentence_', ['payer']).payer,
    null
  );
  // A real answer still parses in every shape it was already accepting.
  assert.equal(parseLensVerdicts('- **payer**: proceed — fine', ['payer']).payer, 'proceed');
  assert.equal(parseLensVerdicts('payer — REVISE', ['payer']).payer, 'revise');
});
