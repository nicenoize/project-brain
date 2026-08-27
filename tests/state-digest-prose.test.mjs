/**
 * The state digest must summarize a file that never adopted its schema.
 *
 * WHY. On a repo whose active_state.md is prose — `## Developers`,
 * `## Active Work`, `## Known Warts` — the digest reported "Workstreams — 0
 * active / Leases — 0 open" and stopped: 547 bytes of nothing out of 51 KB. It
 * did not COST tokens; it failed to SAVE them, because an agent that actually
 * needed the state then read all 51 KB (≈12,957 tokens) raw. A tool that only
 * understands the structure it invented is useless on every repo that did not
 * adopt it — the same defect as a whitelist of directory names, or a lease
 * board that stays empty until everyone declares intent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStateDigest, summarizeProseSections, CANONICAL_SECTIONS
} from '../scripts/brain-state-digest.mjs';

const PROSE = `# Active State

## Developers
- ana — active developer.
- ben — active developer.

## Active Work
- **AWAITING REVIEW** epic #2569 complete on the epic branch.
- **RELEASING** task management epic #2505 (12 of 15 issues).
Some prose that is not a bullet at all.

## Blockers
- branch protection must be set in repo settings

## Known Warts
Migration number collisions at 0111 / 0115.
- 0111: two files raced on the same number

## Overlaps / Conflict Risks
- none recorded

## Last Sync
2026-08-27
`;

test('summarizeProseSections: reports the sections the schema does not know', () => {
  const r = summarizeProseSections(PROSE);
  assert.deepEqual(r.sections.map((s) => s.heading), ['Developers', 'Active Work', 'Known Warts']);
  // Blockers, Overlaps and Last Sync are already reported structurally and must
  // not be repeated — including "Overlaps / Conflict Risks", which is the
  // canonical section wearing a longer name.
  assert.ok(!r.sections.some((s) => /Overlap|Blocker|Last Sync/i.test(s.heading)));
  assert.equal(r.sections[0].lines, 2);
  assert.deepEqual(r.sections[0].shown, ['- ana — active developer.', '- ben — active developer.']);
});

test('summarizeProseSections: bullets win, but a bulletless section is not empty', () => {
  const r = summarizeProseSections(PROSE);
  const work = r.sections.find((s) => s.heading === 'Active Work');
  // Three lines, two of them bullets: the bullets are the point of the prose.
  assert.equal(work.lines, 3);
  assert.equal(work.shown.length, 2);
  assert.ok(work.shown.every((l) => l.startsWith('- ')));

  const plain = summarizeProseSections('## Notes\nJust a paragraph.\nAnd another.\n');
  assert.equal(plain.sections[0].shown[0], 'Just a paragraph.');
});

test('summarizeProseSections: counts are honest about what was left out', () => {
  const many = ['# S'];
  for (let i = 0; i < 12; i++) many.push(`## Section ${i}`, `- line for ${i}`);
  const r = summarizeProseSections(many.join('\n'), { maxSections: 4 });
  assert.equal(r.sections.length, 4);
  assert.equal(r.omittedSections, 8, 'a reader must be able to tell the view is partial');
  assert.equal(r.totalLines, 12);
});

test('summarizeProseSections: degenerate input never throws', () => {
  for (const input of ['', '   ', null, undefined, '# only a title\n']) {
    const r = summarizeProseSections(input);
    assert.deepEqual(r.sections, []);
    assert.equal(r.totalLines, 0);
  }
  // A heading with no body is not a section worth reporting.
  assert.deepEqual(summarizeProseSections('## Empty\n\n## Also Empty\n').sections, []);
});

test('buildStateDigest: prose is reported, and a canonical file is untouched', () => {
  const state = { workstreams: [], leases: [], blockers: [], overlaps: [], sessions: [] };

  // Without the raw markdown the digest is byte-identical to before — a repo
  // that uses the tables must not pay for this feature.
  const before = buildStateDigest(state, { now: 0 });
  assert.ok(!before.includes('Other sections'));

  const withProse = buildStateDigest(state, { now: 0, markdown: PROSE });
  assert.match(withProse, /Other sections in active_state\.md \(3, \d+ line\(s\) total\)/);
  assert.match(withProse, /## Developers \(2 line\(s\)\)/);
  assert.match(withProse, /ana — active developer/);
  assert.match(withProse, /excerpt only — open \.project-brain\/active_state\.md/);

  // The structured answer comes first and survives; prose is appended.
  assert.ok(withProse.indexOf('Workstreams —') < withProse.indexOf('Other sections'));

  // A canonical file (tables, no unknown headings) produces no prose block.
  const canonical = buildStateDigest(state, {
    now: 0,
    markdown: '# Active State\n\n## Workstreams\n\n## File Leases\n\n## Blockers\n\n## Last Sync\n'
  });
  assert.equal(canonical, before, 'a canonical file must be byte-identical to before');
});

test('buildStateDigest: the byte budget still wins over prose', () => {
  const state = { workstreams: [], leases: [], blockers: [], overlaps: [], sessions: [] };
  const huge = ['# S'];
  for (let i = 0; i < 40; i++) huge.push(`## Section ${i}`, `- ${'x'.repeat(300)}`);
  const out = buildStateDigest(state, { now: 0, markdown: huge.join('\n'), budgetBytes: 900 });
  assert.ok(Buffer.byteLength(out, 'utf8') <= 900, `budget blown: ${Buffer.byteLength(out, 'utf8')} B`);
  // And the structured half — the part the schema is sure about — survives the cap.
  assert.match(out, /Workstreams —/);
});

test('CANONICAL_SECTIONS is frozen — two digests must not disagree about what is known', () => {
  assert.ok(CANONICAL_SECTIONS.includes('workstreams'));
  assert.ok(CANONICAL_SECTIONS.includes('file leases'));
  assert.throws(() => { CANONICAL_SECTIONS.push('nope'); });
});
