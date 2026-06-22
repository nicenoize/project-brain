import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseGitLog,
  extractReferences,
  serializeHistory,
  parseHistory,
  gitLogArgs
} from '../scripts/brain-why.mjs';
import { inferType } from '../scripts/infer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const WHY_SCRIPT = path.join(scriptsDir, 'brain-why.mjs');

// git --pretty field/record separators mirrored from brain-why.mjs.
const FS = String.fromCharCode(31); // US
const RS = String.fromCharCode(30); // RS

/** Build one delimited git-log block the way `git log --pretty` would. */
function logBlock({ shortSha, sha, date, author, subject, body, files }) {
  const meta = [shortSha, sha, date, author, subject, body].join(FS) + '--FILES--';
  const fileLines = (files || []).map((f) => `\n${f}`).join('');
  return RS + meta + fileLines + '\n';
}

const FIXTURE = [
  logBlock({
    shortSha: '1d7625e',
    sha: '1d7625edeadbeef',
    date: '2026-06-21T10:00:00+00:00',
    author: 'Jane Dev',
    subject: 'feat(retrieval): cross-encoder rerank (C3)',
    body: 'Full stack significant.\n\nCloses #12. Implements ADR 0017 and adr-3.',
    files: ['scripts/retrieval.mjs', 'scripts/rerank.mjs']
  }),
  logBlock({
    shortSha: '457d305',
    sha: '457d305cafef00d',
    date: '2026-06-20T09:30:00+00:00',
    author: 'Bob Builder',
    subject: 'docs(brain): ADR 0014 + measured Phase C results',
    body: 'Fixes #45.',
    files: ['.project-brain/decisions/0014-lexical-candidate-union.md']
  })
].join('');

// ---------------------------------------------------------------------------
// Unit: pure parseGitLog with a FIXTURE git-log string (no real repo)
// ---------------------------------------------------------------------------

test('parseGitLog: parses subject, body, changed files, and references', () => {
  const recs = parseGitLog(FIXTURE);
  assert.equal(recs.length, 2);

  const [a, b] = recs;
  assert.equal(a.shortSha, '1d7625e');
  assert.equal(a.sha, '1d7625edeadbeef');
  assert.equal(a.date, '2026-06-21T10:00:00+00:00');
  assert.equal(a.author, 'Jane Dev');
  assert.equal(a.subject, 'feat(retrieval): cross-encoder rerank (C3)');
  assert.deepEqual(a.changedFiles, ['scripts/retrieval.mjs', 'scripts/rerank.mjs']);
  // ADR 0017, ADR 0003 (from adr-3, zero-padded), Closes #12 — order preserved.
  assert.deepEqual(a.references, ['ADR 0017', 'ADR 0003', 'Closes #12']);

  assert.equal(b.shortSha, '457d305');
  assert.deepEqual(b.references, ['ADR 0014', 'Fixes #45']);
});

test('parseGitLog: empty / whitespace input → []', () => {
  assert.deepEqual(parseGitLog(''), []);
  assert.deepEqual(parseGitLog('   \n  '), []);
});

test('parseGitLog: commit with no body and no files', () => {
  const log = logBlock({
    shortSha: 'abc1234',
    sha: 'abc1234full',
    date: '2026-01-01T00:00:00+00:00',
    author: 'Solo',
    subject: 'chore: init',
    body: '',
    files: []
  });
  const [rec] = parseGitLog(log);
  assert.equal(rec.subject, 'chore: init');
  assert.equal(rec.body, '');
  assert.deepEqual(rec.changedFiles, []);
  assert.deepEqual(rec.references, []);
});

test('extractReferences: ADR + Closes/Fixes/Resolves variants, de-duped', () => {
  assert.deepEqual(extractReferences('ADR0014'), ['ADR 0014']);
  assert.deepEqual(extractReferences('See ADR 17 and ADR-17'), ['ADR 0017']);
  assert.deepEqual(
    extractReferences('closes #1 RESOLVES #7 fix #99 closed #1'),
    ['Closes #1', 'Resolves #7', 'Fixes #99']
  );
  assert.deepEqual(extractReferences('no refs here'), []);
  assert.deepEqual(extractReferences(''), []);
});

// ---------------------------------------------------------------------------
// Unit: serialize → parse round-trip
// ---------------------------------------------------------------------------

test('serializeHistory/parseHistory: round-trips scalars + references', () => {
  const [rec] = parseGitLog(FIXTURE);
  const md = serializeHistory(rec);

  assert.match(md, /^type: history$/m);
  assert.match(md, /^sha: 1d7625e$/m);
  assert.match(md, /^date: 2026-06-21T10:00:00\+00:00$/m);
  assert.match(md, /^subject: /m);
  // changed-files list rendered in the body
  assert.match(md, /## Changed files/);
  assert.match(md, /- scripts\/retrieval\.mjs/);

  const back = parseHistory(md);
  assert.equal(back.sha, '1d7625e');
  assert.equal(back.fullSha, '1d7625edeadbeef');
  assert.equal(back.date, '2026-06-21T10:00:00+00:00');
  assert.equal(back.author, 'Jane Dev');
  assert.equal(back.subject, 'feat(retrieval): cross-encoder rerank (C3)');
  assert.deepEqual(back.references, ['ADR 0017', 'ADR 0003', 'Closes #12']);
});

test('serializeHistory: includes PR body section when present', () => {
  const md = serializeHistory({
    shortSha: 'aaa', sha: 'aaaa', date: '2026-01-01', author: 'x',
    subject: 's', body: 'b', changedFiles: ['f.mjs'],
    references: ['Closes #5'], prBody: 'PR title\n\nwhy we did it'
  });
  assert.match(md, /## Pull request/);
  assert.match(md, /why we did it/);
});

// ---------------------------------------------------------------------------
// Unit: gitLogArgs shape + infer.mjs path → type mapping
// ---------------------------------------------------------------------------

test('gitLogArgs: includes name-only, limit, and since range', () => {
  const args = gitLogArgs({ limit: 5, since: 'v1.0.0' });
  assert.ok(args.includes('log'));
  assert.ok(args.includes('--name-only'));
  assert.ok(args.includes('-n5'));
  assert.ok(args.includes('v1.0.0..HEAD'));
  assert.ok(args.some((a) => a.startsWith('--pretty=format:')));

  const bare = gitLogArgs({});
  assert.ok(!bare.some((a) => a.startsWith('-n')));
  assert.ok(!bare.some((a) => a.includes('..HEAD')));
});

// The history record type is registered in infer.mjs (decisions/0019); a history
// path classifies as 'history' and must not disturb the existing taxonomy.
test('inferType: history path resolves to history without colliding', () => {
  assert.equal(inferType('.project-brain/history/1d7625e.md'), 'history');
  // Existing brain types still resolve correctly (the new line must not disturb them).
  assert.equal(inferType('.project-brain/decisions/0001-x.md'), 'decision');
  assert.equal(inferType('.project-brain/findings/x.md'), 'finding');
  assert.equal(inferType('.project-brain/plans/x.md'), 'improve-plan');
  assert.equal(inferType('.project-brain/explainers/x.md'), 'explainer');
  assert.equal(inferType('.project-brain/insights/x.md'), 'insight');
});

// ---------------------------------------------------------------------------
// Integration: real git repo in a tmpdir + `brain:why ingest`
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

test('ingest writes a history record from a real commit', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-why-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'hello\n');
  git(cwd, ['add', 'file.txt']);
  git(cwd, ['commit', '-q', '-m', 'feat: first commit\n\nCloses #1. See ADR 0007.']);

  const r = spawnSync(process.execPath, [WHY_SCRIPT, 'ingest'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  const histDir = path.join(cwd, '.project-brain', 'history');
  assert.ok(fs.existsSync(histDir), 'history dir created');
  const files = fs.readdirSync(histDir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 1, 'one history record written');

  const text = fs.readFileSync(path.join(histDir, files[0]), 'utf8');
  assert.match(text, /^type: history$/m);
  assert.match(text, /^author: Test User$/m);
  assert.match(text, /feat: first commit/);
  assert.match(text, /- ADR 0007/);
  assert.match(text, /- Closes #1/);
  assert.match(text, /- file\.txt/);

  // The record filename is the short sha, written under .project-brain/history/
  // so the manifest's infer.mjs line classifies it as `history` once applied.
  const rel = `.project-brain/history/${files[0]}`;
  assert.ok(rel.includes('.project-brain/history/'));
});

test('ingest --json reports the count', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-why-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  git(cwd, ['add', 'a.txt']);
  git(cwd, ['commit', '-q', '-m', 'chore: a']);

  const r = spawnSync(process.execPath, [WHY_SCRIPT, 'ingest', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ingested, 1);
  assert.equal(parsed.files.length, 1);
});

test('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [WHY_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain:why/);
  assert.match(r.stdout, /ingest/);
});
