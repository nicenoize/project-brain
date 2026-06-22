import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_SCRIPT = path.resolve(here, '..', 'scripts', 'brain-audit.mjs');

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-audit-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 1;\n');
  return cwd;
}

function runAudit(cwd, args, input) {
  return spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], { cwd, encoding: 'utf8', input });
}

function readFinding(cwd, slug) {
  return fs.readFileSync(path.join(cwd, '.project-brain', 'findings', `${slug}.md`), 'utf8');
}

test('run --quick prints the focused taxonomy with evidence commands', () => {
  const cwd = makeRepo();
  const r = runAudit(cwd, ['run', '--quick']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## correctness/);
  assert.match(r.stdout, /## security/);
  assert.match(r.stdout, /## testing/);
  assert.doesNotMatch(r.stdout, /## performance/); // quick excludes it
  assert.match(r.stdout, /brain:audit -- add/);
});

test('run --categories filters to the requested set', () => {
  const cwd = makeRepo();
  const r = runAudit(cwd, ['run', '--categories', 'security,dependencies']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## security/);
  assert.match(r.stdout, /## dependencies/);
  assert.doesNotMatch(r.stdout, /## correctness/);
});

test('add writes a finding with frontmatter + hashed sources', () => {
  const cwd = makeRepo();
  const r = runAudit(cwd, [
    'add', '--title', 'Hot loop in retrieval', '--category', 'performance', '--impact', '4',
    '--symbols', 'hybridScore,tfidfScore', '--module', 'scripts/retrieval',
    '--sources', 'src.mjs', '--body', 'O(n^2) at line 50.'
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.project-brain\/findings\/hot-loop-in-retrieval\.md/);

  const text = readFinding(cwd, 'hot-loop-in-retrieval');
  assert.match(text, /^type: finding$/m);
  assert.match(text, /category: performance/);
  assert.match(text, /status: open/);
  assert.match(text, /impact: 4/);
  assert.match(text, /symbols: hybridScore, tfidfScore/);
  assert.match(text, /- path: "src\.mjs"/);
  assert.match(text, /sha256: "[0-9a-f]{64}"/);
  assert.match(text, /O\(n\^2\) at line 50\./);
});

test('add then list --json shows the finding', () => {
  const cwd = makeRepo();
  runAudit(cwd, ['add', '--title', 'Missing tests', '--category', 'testing', '--impact', '3', '--body', 'x']);
  const r = runAudit(cwd, ['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 'missing-tests');
  assert.equal(rows[0].category, 'testing');
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].impact, 3);
});

test('add is idempotent: re-add preserves created', () => {
  const cwd = makeRepo();
  runAudit(cwd, ['add', '--title', 'Dup', '--category', 'tech-debt', '--body', 'first']);
  const createdFirst = readFinding(cwd, 'dup').match(/^created: (.*)$/m)[1];
  const r = runAudit(cwd, ['add', '--title', 'Dup', '--category', 'tech-debt', '--body', 'second']);
  assert.equal(r.status, 0, r.stderr);
  const second = readFinding(cwd, 'dup');
  assert.equal(second.match(/^created: (.*)$/m)[1], createdFirst);
  assert.match(second, /second/);
});
