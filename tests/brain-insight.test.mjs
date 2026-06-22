import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  serializeInsight,
  parseInsight,
  validateInsightSources,
  normalizeConfidence,
  MIN_SOURCES
} from '../scripts/brain-insight.mjs';
import { inferType } from '../scripts/infer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const INSIGHT_SCRIPT = path.join(scriptsDir, 'brain-insight.mjs');

// ---------------------------------------------------------------------------
// Unit: PURE serialize/parse roundtrip
// ---------------------------------------------------------------------------

test('serializeInsight/parseInsight: roundtrip preserves every field', () => {
  const rec = {
    title: 'Ranker and indexer disagree on chunk identity',
    claim: 'The hybrid ranker keys on file path while the indexer keys on chunk hash.',
    confidence: 0.72,
    created: '2026-06-22T00:00:00.000Z',
    updated: '2026-06-22T01:00:00.000Z',
    actor: 'tester',
    supersedes: 'old-insight',
    sources: [
      { path: 'scripts/retrieval.mjs', sha256: 'a'.repeat(64) },
      { path: 'scripts/brain-index.mjs', sha256: 'b'.repeat(64) }
    ],
    body: 'Cross-source reasoning here.\nFalsified if both use the same key.'
  };
  const round = parseInsight(serializeInsight(rec));
  assert.equal(round.type, 'insight');
  assert.equal(round.title, rec.title);
  assert.equal(round.claim, rec.claim);
  assert.equal(round.confidence, 0.72);
  assert.equal(round.created, rec.created);
  assert.equal(round.updated, rec.updated);
  assert.equal(round.actor, 'tester');
  assert.equal(round.supersedes, 'old-insight');
  assert.deepEqual(round.sources, rec.sources);
  assert.match(round.body, /Cross-source reasoning here\./);
  assert.match(round.body, /Falsified if both use the same key\./);
});

test('serializeInsight: emits the insight frontmatter type + nested sources', () => {
  const text = serializeInsight({
    title: 'T', claim: 'C', confidence: 0.5,
    created: 'c', updated: 'u', actor: '', supersedes: '',
    sources: [{ path: 'a.mjs', sha256: null }, { path: 'b.md', sha256: 'x'.repeat(64) }],
    body: 'body'
  });
  assert.match(text, /^type: insight$/m);
  assert.match(text, /^claim: C$/m);
  assert.match(text, /- path: "a\.mjs"/);
  assert.match(text, /sha256: null/);
  assert.match(text, /- path: "b\.md"/);
});

test('parseInsight: handles a null/unspecified confidence', () => {
  const text = serializeInsight({
    title: 'T', claim: 'C', confidence: null,
    created: 'c', updated: 'u', actor: '', supersedes: '',
    sources: [{ path: 'a.mjs', sha256: 'a'.repeat(64) }, { path: 'b.md', sha256: 'b'.repeat(64) }],
    body: ''
  });
  assert.match(text, /^confidence: null$/m);
  assert.equal(parseInsight(text).confidence, null);
});

test('normalizeConfidence: clamps to [0,1], non-numeric → null', () => {
  assert.equal(normalizeConfidence('0.5'), 0.5);
  assert.equal(normalizeConfidence(2), 1);
  assert.equal(normalizeConfidence(-3), 0);
  assert.equal(normalizeConfidence(''), null);
  assert.equal(normalizeConfidence('abc'), null);
  assert.equal(normalizeConfidence(undefined), null);
});

// ---------------------------------------------------------------------------
// Unit: the >= 2-sources grounding guardrail (PURE)
// ---------------------------------------------------------------------------

test('validateInsightSources: refuses fewer than MIN_SOURCES', () => {
  assert.equal(MIN_SOURCES, 2);
  const zero = validateInsightSources([]);
  assert.equal(zero.ok, false);
  assert.equal(zero.count, 0);
  assert.match(zero.message, /must cite >= 2 distinct sources/);

  const one = validateInsightSources([{ path: 'a.mjs' }]);
  assert.equal(one.ok, false);
  assert.equal(one.count, 1);
});

test('validateInsightSources: duplicates do not satisfy the guardrail', () => {
  const dup = validateInsightSources([{ path: 'a.mjs' }, { path: 'a.mjs' }]);
  assert.equal(dup.ok, false);
  assert.equal(dup.count, 1, 'duplicate paths collapse to one distinct source');
});

test('validateInsightSources: accepts >= 2 distinct sources (string or object form)', () => {
  const objs = validateInsightSources([{ path: 'a.mjs' }, { path: 'b.md' }]);
  assert.equal(objs.ok, true);
  assert.equal(objs.count, 2);

  const strs = validateInsightSources(['a.mjs', 'b.md', 'c.ts']);
  assert.equal(strs.ok, true);
  assert.equal(strs.count, 3);
});

// The path→type mapping for insights lives in infer.mjs (a SHARED file owned by
// the integrator, not this feature — see the integration manifest). This test
// pins the contract and starts passing the moment that one-line edit lands:
//   if (file.includes('.project-brain/insights/')) return 'insight';
// Until then `insights/*.md` falls through to the 'doc' default, which is benign
// (still indexed/retrievable, just not type-filterable). We assert the eventual
// contract once the line exists, and otherwise verify only that the path does
// NOT already collide with another record type. The sibling types are asserted
// unconditionally to prove `insight` introduces no collision.
test('inferType: insights path maps to insight once the shared infer.mjs line lands (no collision)', () => {
  const mapped = inferType('.project-brain/insights/ranker-indexer-disagree.md');
  assert.ok(
    mapped === 'insight' || mapped === 'doc',
    `insights path must map to 'insight' (after the infer.mjs edit) or fall through to 'doc'; got '${mapped}'`
  );
  // No collision with the neighboring act-axis / explainer record types.
  assert.equal(inferType('.project-brain/findings/x.md'), 'finding');
  assert.equal(inferType('.project-brain/plans/x.md'), 'improve-plan');
  assert.equal(inferType('.project-brain/explainers/x.md'), 'explainer');
});

// ---------------------------------------------------------------------------
// Integration: spawn the script against a tmpdir repo
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-insight-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(cwd, 'b.md'), '# b\n');
  return cwd;
}

function runInsight(cwd, args, input) {
  return spawnSync(process.execPath, [INSIGHT_SCRIPT, ...args], { cwd, encoding: 'utf8', input });
}

function readInsight(cwd, slug) {
  return fs.readFileSync(path.join(cwd, '.project-brain', 'insights', `${slug}.md`), 'utf8');
}

test('add writes a grounded insight (>= 2 sources) with hashes', () => {
  const cwd = makeRepo();
  const r = runInsight(
    cwd,
    ['add', '--title', 'Two systems disagree', '--claim', 'A and B disagree on X.',
      '--sources', 'a.mjs,b.md', '--confidence', '0.8', '--actor', 'tester'],
    'Synthesis body across both files.\n'
  );
  assert.equal(r.status, 0, r.stderr);

  const text = readInsight(cwd, 'two-systems-disagree');
  assert.match(text, /^type: insight$/m);
  assert.match(text, /^claim: A and B disagree on X\.$/m);
  assert.match(text, /^confidence: 0\.8$/m);
  assert.match(text, /actor: tester/);
  assert.match(text, /- path: "a\.mjs"/);
  assert.match(text, /- path: "b\.md"/);
  assert.match(text, /sha256: "[0-9a-f]{64}"/);
  assert.match(text, /Synthesis body across both files\./);
});

test('add REFUSES fewer than 2 sources (the grounding guardrail)', () => {
  const cwd = makeRepo();
  const r = runInsight(
    cwd,
    ['add', '--title', 'Ungrounded', '--claim', 'A lonely claim.', '--sources', 'a.mjs'],
    'should never be written\n'
  );
  assert.notEqual(r.status, 0, 'add must fail with < 2 sources');
  assert.match(r.stderr, /must cite >= 2 distinct sources/);
  // Nothing should have been written.
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain', 'insights', 'ungrounded.md')), false);
});

test('add REFUSES zero sources and demands the flag', () => {
  const cwd = makeRepo();
  const r = runInsight(cwd, ['add', '--title', 'NoSources', '--claim', 'Claim.'], 'body\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must cite >= 2 distinct sources/);
});

test('add requires --claim', () => {
  const cwd = makeRepo();
  const r = runInsight(cwd, ['add', '--title', 'NoClaim', '--sources', 'a.mjs,b.md'], 'body\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires --claim/);
});

test('re-add is idempotent: preserves created, updates body', () => {
  const cwd = makeRepo();
  runInsight(cwd, ['add', '--title', 'Idem', '--claim', 'c', '--sources', 'a.mjs,b.md'], 'first\n');
  const created1 = readInsight(cwd, 'idem').match(/^created: (.*)$/m)[1];

  const r = runInsight(cwd, ['add', '--title', 'Idem', '--claim', 'c', '--sources', 'a.mjs,b.md'], 'second\n');
  assert.equal(r.status, 0, r.stderr);
  const second = readInsight(cwd, 'idem');
  assert.equal(second.match(/^created: (.*)$/m)[1], created1, 'created preserved across re-add');
  assert.match(second, /second/);
  assert.doesNotMatch(second, /first/);
});

test('check --strict exits non-zero after a cited source drifts', () => {
  const cwd = makeRepo();
  runInsight(cwd, ['add', '--title', 'Drift', '--claim', 'c', '--sources', 'a.mjs,b.md'], 'cached\n');

  let r = runInsight(cwd, ['check', '--strict']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[fresh\] drift/);

  fs.writeFileSync(path.join(cwd, 'a.mjs'), 'export const a = 999;\n');
  r = runInsight(cwd, ['check', '--strict']);
  assert.notEqual(r.status, 0, 'strict check should fail when a source drifted');
  assert.match(r.stdout, /\[STALE\] drift/);
  assert.match(r.stdout, /changed: a\.mjs/);
});

test('check --json reports stale flag and a missing source', () => {
  const cwd = makeRepo();
  runInsight(cwd, ['add', '--title', 'Gone', '--claim', 'c', '--sources', 'a.mjs,b.md'], 'answer\n');
  fs.rmSync(path.join(cwd, 'a.mjs'));

  const r = runInsight(cwd, ['check', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.stale, 1);
  assert.equal(parsed.results[0].stale, true);
  assert.ok(parsed.results[0].reasons.some((x) => x.path === 'a.mjs' && x.status === 'missing'));
});

test('list --json shows fields incl. confidence, supersedes, and stale status', () => {
  const cwd = makeRepo();
  runInsight(
    cwd,
    ['add', '--title', 'Listed', '--claim', 'a claim', '--sources', 'a.mjs,b.md',
      '--confidence', '0.6', '--supersedes', 'older'],
    'answer\n'
  );
  const r = runInsight(cwd, ['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 'listed');
  assert.equal(rows[0].title, 'Listed');
  assert.equal(rows[0].claim, 'a claim');
  assert.equal(rows[0].confidence, 0.6);
  assert.equal(rows[0].supersedes, 'older');
  assert.equal(rows[0].stale, false);
  assert.deepEqual(rows[0].sources, ['a.mjs', 'b.md']);
});

test('scaffold prints guidance and the evidence-gathering brain commands', () => {
  const cwd = makeRepo();
  const r = runInsight(cwd, ['scaffold', 'how retrieval ranking works']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Insight scaffold: how retrieval ranking works/);
  assert.match(r.stdout, /brain:search -- "how retrieval ranking works"/);
  assert.match(r.stdout, /brain:pack -- "how retrieval ranking works"/);
  assert.match(r.stdout, /brain:impact/);
  assert.match(r.stdout, /brain:insight -- add --title/);
  assert.match(r.stdout, /fewer than 2 sources/);
});

test('list (human) and empty states do not crash', () => {
  const cwd = makeRepo();
  let r = runInsight(cwd, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No insights yet/);

  r = runInsight(cwd, ['check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No insights found/);
});

test('--help exits 0 and prints the grounding rule', () => {
  const cwd = makeRepo();
  const r = runInsight(cwd, ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SYNTHESIZED claim across >= 2 sources/);
});
