import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateExplainers } from '../scripts/brain-explain.mjs';
import { inferType } from '../scripts/infer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const EXPLAIN_SCRIPT = path.join(scriptsDir, 'brain-explain.mjs');

// ---------------------------------------------------------------------------
// Unit: pure evaluateExplainers with an injected hashOf map
// ---------------------------------------------------------------------------

test('evaluateExplainers: fresh when every cited hash matches', () => {
  const explainers = [
    { slug: 'q1', query: 'q1', sources: [{ path: 'a.mjs', sha256: 'aaa' }, { path: 'b.md', sha256: 'bbb' }] }
  ];
  const hashOf = (p) => ({ 'a.mjs': 'aaa', 'b.md': 'bbb' })[p] ?? null;
  const [r] = evaluateExplainers(explainers, hashOf);
  assert.equal(r.stale, false);
  assert.ok(r.reasons.every((x) => x.status === 'ok'));
});

test('evaluateExplainers: stale when one source hash differs', () => {
  const explainers = [
    { slug: 'q1', query: 'q1', sources: [{ path: 'a.mjs', sha256: 'aaa' }, { path: 'b.md', sha256: 'bbb' }] }
  ];
  const hashOf = (p) => ({ 'a.mjs': 'aaa', 'b.md': 'CHANGED' })[p] ?? null;
  const [r] = evaluateExplainers(explainers, hashOf);
  assert.equal(r.stale, true);
  assert.ok(r.reasons.some((x) => x.path === 'b.md' && x.status === 'changed'));
});

test('evaluateExplainers: stale when a source is missing', () => {
  const explainers = [
    { slug: 'q1', query: 'q1', sources: [{ path: 'gone.mjs', sha256: 'aaa' }] }
  ];
  const hashOf = () => null; // missing
  const [r] = evaluateExplainers(explainers, hashOf);
  assert.equal(r.stale, true);
  assert.equal(r.reasons[0].status, 'missing');
});

test('inferType: .project-brain/explainers/*.md → explainer', () => {
  assert.equal(inferType('.project-brain/explainers/how-does-auth-work.md'), 'explainer');
});

// ---------------------------------------------------------------------------
// Integration: spawn the script against a tmpdir repo
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-explain-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(cwd, 'notes.md'), '# notes\n');
  return cwd;
}

function runExplain(cwd, args, input) {
  return spawnSync(process.execPath, [EXPLAIN_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    input
  });
}

function readExplainer(cwd, slug) {
  return fs.readFileSync(path.join(cwd, '.project-brain', 'explainers', `${slug}.md`), 'utf8');
}

test('save writes a frontmatter file with source hashes (from stdin)', () => {
  const cwd = makeRepo();
  const r = runExplain(
    cwd,
    ['save', '--query', 'How does auth work?', '--sources', 'src.mjs,notes.md', '--actor', 'tester'],
    'Auth works via tokens.\n'
  );
  assert.equal(r.status, 0, r.stderr);

  const slug = 'how-does-auth-work';
  const text = readExplainer(cwd, slug);
  assert.match(text, /^type: explainer$/m);
  assert.match(text, /query: "How does auth work\?"/);
  assert.match(text, /actor: "tester"/);
  assert.match(text, /created: \d{4}-\d{2}-\d{2}T/);
  assert.match(text, /updated: \d{4}-\d{2}-\d{2}T/);
  // sources list with real sha256 hashes
  assert.match(text, /- path: "src\.mjs"/);
  assert.match(text, /- path: "notes\.md"/);
  assert.match(text, /sha256: "[0-9a-f]{64}"/);
  // body preserved
  assert.match(text, /Auth works via tokens\./);
});

test('save via --answer-file works', () => {
  const cwd = makeRepo();
  fs.writeFileSync(path.join(cwd, 'ans.txt'), 'From a file.\n');
  const r = runExplain(cwd, ['save', '--query', 'File answer', '--answer-file', 'ans.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readExplainer(cwd, 'file-answer'), /From a file\./);
});

test('re-save is idempotent: preserves created, updates body', () => {
  const cwd = makeRepo();
  runExplain(cwd, ['save', '--query', 'Idem', '--sources', 'src.mjs'], 'first\n');
  const first = readExplainer(cwd, 'idem');
  const createdFirst = first.match(/^created: (.*)$/m)[1];

  // Re-save with different body.
  const r = runExplain(cwd, ['save', '--query', 'Idem', '--sources', 'src.mjs'], 'second\n');
  assert.equal(r.status, 0, r.stderr);
  const second = readExplainer(cwd, 'idem');
  const createdSecond = second.match(/^created: (.*)$/m)[1];

  assert.equal(createdSecond, createdFirst, 'created preserved across re-save');
  assert.match(second, /second/);
  assert.doesNotMatch(second, /first/);
});

test('check --strict exits non-zero after a cited source is mutated', () => {
  const cwd = makeRepo();
  runExplain(cwd, ['save', '--query', 'Drift', '--sources', 'src.mjs'], 'cached answer\n');

  // Fresh first.
  let r = runExplain(cwd, ['check', '--strict']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[fresh\] drift/);

  // Mutate the cited source → stale.
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 999;\n');
  r = runExplain(cwd, ['check', '--strict']);
  assert.notEqual(r.status, 0, 'strict check should fail when stale');
  assert.match(r.stdout, /\[STALE\] drift/);
  assert.match(r.stdout, /changed: src\.mjs/);
});

test('check --json reports stale flag and missing sources', () => {
  const cwd = makeRepo();
  runExplain(cwd, ['save', '--query', 'Gone', '--sources', 'src.mjs'], 'answer\n');
  fs.rmSync(path.join(cwd, 'src.mjs'));

  const r = runExplain(cwd, ['check', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.stale, 1);
  assert.equal(parsed.results[0].stale, true);
  assert.equal(parsed.results[0].reasons[0].status, 'missing');
});

test('list --json shows fresh/stale status', () => {
  const cwd = makeRepo();
  runExplain(cwd, ['save', '--query', 'Listed', '--sources', 'notes.md'], 'answer\n');
  const r = runExplain(cwd, ['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 'listed');
  assert.equal(rows[0].stale, false);
  assert.deepEqual(rows[0].sources, ['notes.md']);
});
