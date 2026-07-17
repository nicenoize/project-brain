import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure exports — importing the script must NOT run its CLI (isMain guard).
import { stagedPathsFromEnvelope } from '../scripts/brain-stage-dirty.mjs';
import {
  dirtyPathFor, readDirtyFiles, appendDirtyFile, clearDirtyFiles
} from '../scripts/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(here, '..', 'scripts', 'brain-stage-dirty.mjs');

// ---------------------------------------------------------------------------
// dirtyPathFor — PURE normalisation / filtering
// ---------------------------------------------------------------------------

test('dirtyPathFor: keeps relative source/doc paths, strips ./', () => {
  assert.equal(dirtyPathFor('scripts/brain-sync.mjs'), 'scripts/brain-sync.mjs');
  assert.equal(dirtyPathFor('./README.md'), 'README.md');
  assert.equal(dirtyPathFor('lib/a.ts'), 'lib/a.ts');
});

test('dirtyPathFor: absolute inside root → repo-relative; outside root → ""', () => {
  const root = '/repo';
  assert.equal(dirtyPathFor('/repo/scripts/x.mjs', { root }), 'scripts/x.mjs');
  assert.equal(dirtyPathFor('/elsewhere/x.mjs', { root }), '');
  assert.equal(dirtyPathFor('/etc/passwd', { root }), '');
});

test('dirtyPathFor: excludes vendored / build / brain-internal / generated', () => {
  for (const p of [
    'node_modules/foo/index.js',
    '.git/config',
    'dist/bundle.js',
    'build/out.js',
    'coverage/lcov.info',
    'vendor/lib.go',
    '.project-brain/.dirty-files',      // must never stage its own bookkeeping
    '.project-brain/decisions/0001.md', // brain docs: sync owns them, avoid loop
    'package-lock.json',
    'sub/yarn.lock',
    '',
    '   '
  ]) {
    assert.equal(dirtyPathFor(p), '', p);
  }
});

test('dirtyPathFor: rejects parent-escaping relative paths', () => {
  assert.equal(dirtyPathFor('../outside.ts'), '');
});

// ---------------------------------------------------------------------------
// readDirtyFiles / appendDirtyFile / clearDirtyFiles — the shared primitive
// ---------------------------------------------------------------------------

function tmpDirtyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dirty-'));
  return path.join(dir, '.dirty-files');
}

test('appendDirtyFile: appends, dedups, and is round-tripped by readDirtyFiles', () => {
  const p = tmpDirtyPath();
  assert.equal(readDirtyFiles(p).length, 0);          // missing → []
  assert.equal(appendDirtyFile('scripts/a.mjs', p), true);
  assert.equal(appendDirtyFile('scripts/b.mjs', p), true);
  assert.equal(appendDirtyFile('scripts/a.mjs', p), false); // duplicate → no-op
  assert.deepEqual(readDirtyFiles(p), ['scripts/a.mjs', 'scripts/b.mjs']);
  assert.equal(appendDirtyFile('', p), false);        // empty → no-op
});

test('readDirtyFiles: dedups + trims a hand-written/torn file, corrupt-safe', () => {
  const p = tmpDirtyPath();
  fs.writeFileSync(p, 'a.ts\n a.ts \n\nb.ts\n');
  assert.deepEqual(readDirtyFiles(p), ['a.ts', 'b.ts']);
});

test('clearDirtyFiles: removes the list; absent → no throw', () => {
  const p = tmpDirtyPath();
  appendDirtyFile('x.ts', p);
  clearDirtyFiles(p);
  assert.equal(fs.existsSync(p), false);
  clearDirtyFiles(p); // second call on absent file must not throw
  assert.deepEqual(readDirtyFiles(p), []);
});

// ---------------------------------------------------------------------------
// stagedPathsFromEnvelope — PURE decision core
// ---------------------------------------------------------------------------

test('stagedPathsFromEnvelope: Edit/Write/MultiEdit → file_path (filtered)', () => {
  const root = '/repo';
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    assert.deepEqual(
      stagedPathsFromEnvelope({ tool_name: tool, tool_input: { file_path: '/repo/scripts/x.mjs' } }, { root }),
      ['scripts/x.mjs'],
      tool
    );
  }
});

test('stagedPathsFromEnvelope: non-edit tools and junk paths → []', () => {
  assert.deepEqual(stagedPathsFromEnvelope({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } }), []);
  assert.deepEqual(stagedPathsFromEnvelope({ tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  assert.deepEqual(stagedPathsFromEnvelope({ tool_name: 'Edit', tool_input: { file_path: 'node_modules/a.js' } }), []);
  assert.deepEqual(stagedPathsFromEnvelope({}), []);
  assert.deepEqual(stagedPathsFromEnvelope(null), []);
});

// ---------------------------------------------------------------------------
// CLI hook — ALWAYS exit 0, appends on valid input, never blocks
// ---------------------------------------------------------------------------

function freshRepo({ withBrain = true } = {}) {
  // realpath so an absolute file_path matches the child's process.cwd() on
  // macOS, where os.tmpdir() is a /var → /private/var symlink.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-stage-hook-')));
  if (withBrain) fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  return cwd;
}
const runHook = (cwd, envelope, { rawInput } = {}) =>
  spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd, encoding: 'utf8',
    input: rawInput !== undefined ? rawInput : JSON.stringify(envelope)
  });
const dirtyOf = (cwd) => path.join(cwd, '.project-brain', '.dirty-files');

test('CLI: Edit envelope → path staged in .dirty-files, exit 0', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'scripts', 'a.mjs') } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(dirtyOf(cwd), 'utf8').trim().split('\n'), ['scripts/a.mjs']);
});

test('CLI: repeated edits dedup within the staged list', () => {
  const cwd = freshRepo();
  runHook(cwd, { tool_name: 'Write', tool_input: { file_path: 'scripts/a.mjs' } });
  runHook(cwd, { tool_name: 'Edit', tool_input: { file_path: 'scripts/a.mjs' } });
  runHook(cwd, { tool_name: 'Edit', tool_input: { file_path: 'scripts/b.mjs' } });
  assert.deepEqual(fs.readFileSync(dirtyOf(cwd), 'utf8').trim().split('\n'), ['scripts/a.mjs', 'scripts/b.mjs']);
});

test('CLI: malformed stdin → exit 0, no crash, nothing staged (must not block)', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, null, { rawInput: '{not valid json' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(dirtyOf(cwd)), false);
});

test('CLI: empty stdin → exit 0, nothing staged', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, null, { rawInput: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(dirtyOf(cwd)), false);
});

test('CLI: missing brain dir → exit 0 and does NOT create .project-brain', () => {
  const cwd = freshRepo({ withBrain: false });
  const r = runHook(cwd, { tool_name: 'Edit', tool_input: { file_path: 'scripts/a.mjs' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain')), false);
});

test('CLI: non-edit tool → exit 0, nothing staged', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, { tool_name: 'Read', tool_input: { file_path: 'scripts/a.mjs' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(dirtyOf(cwd)), false);
});
