import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeFlag, takeOption, peekOption, splitEnv, unknownFlags } from '../scripts/common.mjs';

test('takeFlag removes the flag and returns true when present', () => {
  const args = ['--a', '--b', 'val'];
  assert.equal(takeFlag(args, '--a'), true);
  assert.deepEqual(args, ['--b', 'val']);
});

test('takeFlag returns false and leaves argv untouched when absent', () => {
  const args = ['--b', 'val'];
  assert.equal(takeFlag(args, '--a'), false);
  assert.deepEqual(args, ['--b', 'val']);
});

test('takeOption removes name+value pair and returns value', () => {
  const args = ['--name', 'value', '--other'];
  assert.equal(takeOption(args, '--name'), 'value');
  assert.deepEqual(args, ['--other']);
});

test('takeOption returns empty string when missing', () => {
  const args = ['--other'];
  assert.equal(takeOption(args, '--name'), '');
  assert.deepEqual(args, ['--other']);
});

test('peekOption returns value without mutating argv', () => {
  const args = ['--name', 'value'];
  assert.equal(peekOption(args, '--name'), 'value');
  assert.deepEqual(args, ['--name', 'value']);
});

test('splitEnv splits comma/newline and trims, drops empties', () => {
  process.env.__BRAIN_TEST_SPLITENV = 'a, b\n c,,';
  assert.deepEqual(splitEnv('__BRAIN_TEST_SPLITENV'), ['a', 'b', 'c']);
  delete process.env.__BRAIN_TEST_SPLITENV;
});

test('splitEnv on missing env returns empty array', () => {
  delete process.env.__BRAIN_TEST_MISSING;
  assert.deepEqual(splitEnv('__BRAIN_TEST_MISSING'), []);
});

/* Registration drift.
   A consumer updates by pulling the skill checkout and the CODE arrives — but
   package.json only changes when the installer runs. Pull without
   `brain:update-skill` and the new commands exist on disk and are unreachable:
   npm answers "Missing script: brain:overview" and names no cause. That
   happened three times in one week, twice to me. The detector also caught that
   this repo's OWN package.json was missing three scripts it ships to others. */
test('missingBrainScripts: names what the host cannot reach', async () => {
  const { missingBrainScripts, mergePackageScripts } = await import('../scripts/common.mjs');

  // A host that has never been set up is missing everything.
  const bare = missingBrainScripts({});
  assert.ok(bare.length > 10, `expected a full list, got ${bare.length}`);
  assert.ok(bare.includes('brain:overview'), 'the newest command must be reported');
  assert.deepEqual(bare, [...bare].sort(), 'stable order — a diff of this must be readable');

  // A host the installer has just run is missing nothing.
  const installed = {};
  mergePackageScripts(installed);
  assert.deepEqual(missingBrainScripts(installed), []);

  // Remove one and it is named, alone.
  const drifted = { scripts: { ...installed.scripts } };
  delete drifted.scripts['brain:overview'];
  assert.deepEqual(missingBrainScripts(drifted), ['brain:overview']);

  // Unrelated host scripts are none of our business.
  assert.deepEqual(missingBrainScripts({ scripts: { ...installed.scripts, dev: 'vite' } }), []);
});

/* chunkText emitted the tail of EVERY file one character at a time.
   With fewer than `overlap` characters left, `slice.length - overlap` goes
   negative, `Math.max(1, …)` clamps the step to 1, and the loop crawls to the
   end producing a chunk per character. A 28 KB document yielded 270 chunks
   averaging 103 characters, of which 250 were crumbs — the shortest were ".",
   ")." and "7).". They competed for space in the dense candidate pool, and are
   why a 3,456-file repo held 108,159 records where chunking predicts ~9,850. */
test('chunkText: the tail is one chunk, not one chunk per character', async () => {
  const { chunkText } = await import('../scripts/common.mjs');

  // Text whose length leaves a tail shorter than the overlap.
  const body = 'x'.repeat(1800 + 100);
  const chunks = chunkText(body, 1800, 250);
  assert.ok(chunks.length <= 3, `tail crawl: ${chunks.length} chunks for ${body.length} chars`);
  assert.ok(chunks.every((c) => c.length > 1), 'no single-character chunks');

  // The pathological shape from the field: a long document, measured.
  const doc = 'para\n\n'.repeat(5000);           // ~30 KB
  const real = chunkText(doc);
  const avg = doc.length / real.length;
  assert.ok(avg > 800, `average chunk ${Math.round(avg)} chars — far below the 1800 cap`);
  assert.ok(real.length < 40, `${real.length} chunks for ${doc.length} chars is a crawl`);

  // Every character of the source still appears somewhere: the fix must not
  // silently drop the tail it used to shred.
  assert.ok(real.join('').includes('para'), 'content survived');
  assert.ok(
    chunkText('short').join('') === 'short',
    'a document shorter than one chunk is returned whole'
  );
});

test('chunkText: degenerate input, and overlap larger than the text', async () => {
  const { chunkText } = await import('../scripts/common.mjs');
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  // Overlap wider than the whole document is the exact condition that made the
  // step negative; it must terminate with one chunk, not 250.
  const c = chunkText('a'.repeat(100), 1800, 250);
  assert.equal(c.length, 1);
  assert.equal(c[0].length, 100);
});

const EVAL_FLAGS = ['--file=', '--top-k=', '--out=', '--hard-only', '--diagnose'];

test('unknownFlags accepts every known flag, with values in both forms', () => {
  assert.deepEqual(unknownFlags(['--file', 'cases.json', '--top-k=12', '--hard-only'], EVAL_FLAGS), []);
});

test('unknownFlags reports the misspelling that silently ran the wrong eval', () => {
  assert.deepEqual(unknownFlags(['--cases', 'cases.json'], EVAL_FLAGS), ['--cases']);
});

test('unknownFlags does not mistake an option value for a flag', () => {
  assert.deepEqual(unknownFlags(['--file', '--weird-looking-name.json'], EVAL_FLAGS), []);
});

test('unknownFlags ignores positionals and stops at --', () => {
  assert.deepEqual(unknownFlags(['run', '--diagnose', '--', '--passed-through'], EVAL_FLAGS), []);
});

test('unknownFlags reports each stray once, in order', () => {
  assert.deepEqual(unknownFlags(['--nope', '--file', 'x', '--alsoNope=1'], EVAL_FLAGS), ['--nope', '--alsoNope']);
});

test('hash handoff: round-trips, deletes its file, rejects garbage', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { writeHashHandoff, readHashHandoff } = await import('../scripts/common.mjs');
  const dir = fs.mkdtempSync(`${os.tmpdir()}/brain-handoff-`);
  const h = 'a'.repeat(64);
  const file = writeHashHandoff({ 'a.mjs': h, 'b.md': 'not-a-hash' }, dir);
  assert.ok(file && fs.existsSync(file));
  const map = readHashHandoff(file);
  assert.equal(map.get('a.mjs'), h);
  assert.equal(map.has('b.md'), false, 'a malformed hash is dropped, so the index hashes that file itself');
  assert.equal(fs.existsSync(file), false, 'read once, then gone');
  assert.equal(readHashHandoff(file), null, 'a missing handoff means: hash yourself');
  assert.equal(readHashHandoff(''), null);
  fs.writeFileSync(`${dir}/bad.json`, '[1,2]');
  assert.equal(readHashHandoff(`${dir}/bad.json`), null);
});

test('ensureLocalStateIgnored: a nested .gitignore covers local state, keeps user lines, never creates the dir', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ensureLocalStateIgnored, LOCAL_STATE_FILES } = await import('../scripts/common.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ignore-'));

  const absent = path.join(base, 'absent', '.project-brain');
  ensureLocalStateIgnored(absent);
  assert.equal(fs.existsSync(absent), false, 'never creates .project-brain');

  const dir = path.join(base, 'repo', '.project-brain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'my-own-entry'); // no trailing newline
  ensureLocalStateIgnored(dir);
  const text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(text, /^my-own-entry\n/, 'the user line stays, cleanly separated');
  for (const f of LOCAL_STATE_FILES) assert.ok(text.includes(`/${f}\n`), f);

  // A second process (fresh module state is not needed: the file is the truth).
  const again = path.join(base, 'repo2', '.project-brain');
  fs.mkdirSync(again, { recursive: true });
  ensureLocalStateIgnored(again);
  const once = fs.readFileSync(path.join(again, '.gitignore'), 'utf8');
  ensureLocalStateIgnored(again);
  assert.equal(fs.readFileSync(path.join(again, '.gitignore'), 'utf8'), once, 'idempotent');
});

test('ensureLocalStateIgnored: git actually ignores the state files', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { ensureLocalStateIgnored } = await import('../scripts/common.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ignore-git-'));
  if (spawnSync('git', ['init', '-q'], { cwd: repo }).status !== 0) { t.skip('git unavailable'); return; }
  const dir = path.join(repo, '.project-brain');
  fs.mkdirSync(dir);
  ensureLocalStateIgnored(dir);
  for (const f of ['.usage.jsonl', '.decisions.jsonl', '.answer-cache.json']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', `.project-brain/${f}`], { cwd: repo }).status, 0, f);
  }
  assert.notEqual(spawnSync('git', ['check-ignore', '-q', '.project-brain/active_state.md'], { cwd: repo }).status, 0,
    'real brain records are NOT ignored');
});
