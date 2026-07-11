import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure exports — importing the script must NOT run its CLI (isMain guard).
import {
  looksLikeRawSearch, looksLikeRawSourceRead, classifyToolNudge,
  shouldNudge, recordNudge, indexFresh, buildPreToolPayload, nudgeText, NUDGE_TTL_MS
} from '../scripts/brain-route-tool.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL_SCRIPT = path.resolve(here, '..', 'scripts', 'brain-route-tool.mjs');

// ---------------------------------------------------------------------------
// looksLikeRawSearch — grep/rg/ag/ack/find/git-grep over the repo
// ---------------------------------------------------------------------------

test('looksLikeRawSearch: recognises real code searches', () => {
  for (const cmd of [
    'grep -r "hybridScore" scripts/',
    'grep -rn foo lib/',
    'grep --include=*.ts foo .',
    'grep foo bar.ts',            // pattern + explicit file
    'rg hybridScore',
    'rg -n "foo" src',
    'ag TODO',
    'ack pattern',
    'find . -name "*.ts"',
    'find src -type f',
    'git grep hybridScore',
    'FOO=1 grep -r x scripts/',   // leading env assignment
    'sudo grep -R x /repo',       // wrapper
    'cd repo && rg foo'           // second segment, not piped
  ]) {
    assert.equal(looksLikeRawSearch(cmd), true, cmd);
  }
});

test('looksLikeRawSearch: ignores non-searches and piped filters', () => {
  for (const cmd of [
    '',
    'npm test',
    'echo grep is great',
    'ls -la',
    'npm ls | grep foo',          // grep filters piped output → not a repo search
    'cat file.ts | grep bar',
    'git status | grep modified',
    'grep foo',                   // bare grep reads STDIN (no path / recursion)
    'find . -delete'              // no predicate / not a code hunt
  ]) {
    assert.equal(looksLikeRawSearch(cmd), false, cmd);
  }
});

test('looksLikeRawSearch: RTK-style wrapped command line still matches (coordination note #25)', () => {
  // A PreToolUse rewrite may prefix the real command; the search binary is no
  // longer the first token but still appears after a wrapper/operator.
  assert.equal(looksLikeRawSearch('rtklog && grep -r hybridScore scripts/'), true);
  assert.equal(looksLikeRawSearch('env TZ=UTC grep -rn foo lib/'), true);
});

// ---------------------------------------------------------------------------
// looksLikeRawSourceRead — indexed source/doc files only
// ---------------------------------------------------------------------------

test('looksLikeRawSourceRead: true for source + doc files', () => {
  for (const p of [
    'scripts/brain-route.mjs', 'src/app/page.tsx', 'lib/foo.ts', 'main.py',
    'pkg/server.go', 'README.md', 'docs/guide.mdx', '/abs/path/to/x.rs'
  ]) {
    assert.equal(looksLikeRawSourceRead(p), true, p);
  }
});

test('looksLikeRawSourceRead: false for generated / vendored / brain-internal / non-source', () => {
  for (const p of [
    '', 'package-lock.json', 'yarn.lock', 'node_modules/x/index.js',
    'dist/bundle.js', '.git/config', '.project-brain/context_index.md',
    'coverage/lcov.info', 'logo.png', 'data.csv', 'notes.txt', 'Cargo.lock'
  ]) {
    assert.equal(looksLikeRawSourceRead(p), false, p);
  }
});

// ---------------------------------------------------------------------------
// classifyToolNudge — envelope → pattern class, surface-scoped
// ---------------------------------------------------------------------------

test('classifyToolNudge: Bash raw search → rawSearch', () => {
  const env = { tool_name: 'Bash', tool_input: { command: 'grep -r foo scripts/' } };
  assert.equal(classifyToolNudge(env), 'rawSearch');
  assert.equal(classifyToolNudge(env, { surface: 'bash' }), 'rawSearch');
  assert.equal(classifyToolNudge(env, { surface: 'read' }), null); // scoped out
});

test('classifyToolNudge: Read of source → rawSourceRead; Glob source pattern → rawSearch', () => {
  assert.equal(classifyToolNudge({ tool_name: 'Read', tool_input: { file_path: 'lib/a.ts' } }), 'rawSourceRead');
  assert.equal(classifyToolNudge({ tool_name: 'Read', tool_input: { file_path: 'lib/a.ts' } }, { surface: 'bash' }), null);
  assert.equal(classifyToolNudge({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }), 'rawSearch');
  assert.equal(classifyToolNudge({ tool_name: 'Glob', tool_input: { pattern: '**/*.{ts,tsx}' } }), 'rawSearch');
});

test('classifyToolNudge: null for irrelevant tools / inputs / junk', () => {
  assert.equal(classifyToolNudge({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }), null);
  assert.equal(classifyToolNudge({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
  assert.equal(classifyToolNudge({ tool_name: 'Read', tool_input: { file_path: 'package-lock.json' } }), null);
  assert.equal(classifyToolNudge({}), null);
  assert.equal(classifyToolNudge(null), null);
});

// ---------------------------------------------------------------------------
// shouldNudge / recordNudge — per-session-per-class dedup
// ---------------------------------------------------------------------------

test('shouldNudge: no patternClass → never nudge', () => {
  assert.equal(shouldNudge(null, { sessionId: 's', patternClass: null, now: 1 }), false);
});

test('shouldNudge: no state / new session / unseen class → nudge (fail open)', () => {
  assert.equal(shouldNudge(null, { sessionId: 's', patternClass: 'rawSearch', now: 1 }), true);
  assert.equal(shouldNudge('junk', { sessionId: 's', patternClass: 'rawSearch', now: 1 }), true);
  assert.equal(shouldNudge({ toolNudges: { sessionId: 'OTHER', rawSearch: 1 } }, { sessionId: 's', patternClass: 'rawSearch', now: 2 }), true);
  assert.equal(shouldNudge({ toolNudges: { sessionId: 's', rawSourceRead: 1 } }, { sessionId: 's', patternClass: 'rawSearch', now: 2 }), true);
});

test('shouldNudge: same class same session within TTL → suppress; after TTL → re-nudge', () => {
  const prev = { toolNudges: { sessionId: 's', rawSearch: 1000 } };
  assert.equal(shouldNudge(prev, { sessionId: 's', patternClass: 'rawSearch', now: 1000 + 60_000 }), false);
  assert.equal(shouldNudge(prev, { sessionId: 's', patternClass: 'rawSearch', now: 1000 + NUDGE_TTL_MS + 1 }), true);
});

test('shouldNudge: prompt-hook state coexists (top-level keys ignored)', () => {
  // The shared file also carries {sessionId,textHash,ts} for the prompt hook.
  const prev = { sessionId: 's', textHash: 'h', ts: 1000, toolNudges: { sessionId: 's', rawSearch: 1000 } };
  assert.equal(shouldNudge(prev, { sessionId: 's', patternClass: 'rawSearch', now: 1000 + 1 }), false);
  assert.equal(shouldNudge(prev, { sessionId: 's', patternClass: 'rawSourceRead', now: 1000 + 1 }), true);
});

test('recordNudge: fresh session resets; same session accumulates classes', () => {
  const a = recordNudge(undefined, { sessionId: 's', patternClass: 'rawSearch', now: 10 });
  assert.deepEqual(a, { sessionId: 's', rawSearch: 10 });
  const b = recordNudge(a, { sessionId: 's', patternClass: 'rawSourceRead', now: 20 });
  assert.deepEqual(b, { sessionId: 's', rawSearch: 10, rawSourceRead: 20 });
  const c = recordNudge(b, { sessionId: 'NEW', patternClass: 'rawSearch', now: 30 });
  assert.deepEqual(c, { sessionId: 'NEW', rawSearch: 30 }); // reset — old classes dropped
});

// ---------------------------------------------------------------------------
// indexFresh — stat-level existence, no store load
// ---------------------------------------------------------------------------

test('indexFresh: manifest + non-empty index → true; missing/empty → false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-idx-'));
  const brain = path.join(dir, '.project-brain');
  fs.mkdirSync(brain, { recursive: true });
  assert.equal(indexFresh(brain), false, 'no manifest');
  fs.writeFileSync(path.join(brain, 'index_manifest.json'), '{}');
  assert.equal(indexFresh(brain), false, 'manifest but no index blob');
  fs.writeFileSync(path.join(brain, 'search_index.json'), 'x'.repeat(2048));
  assert.equal(indexFresh(brain), true, 'manifest + fat index');
  // vector-db variant
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-idx2-'));
  const brain2 = path.join(dir2, '.project-brain');
  fs.mkdirSync(path.join(brain2, 'vector-db'), { recursive: true });
  fs.writeFileSync(path.join(brain2, 'index_manifest.json'), '{}');
  assert.equal(indexFresh(brain2), true, 'manifest + vector-db dir');
});

// ---------------------------------------------------------------------------
// buildPreToolPayload / nudgeText — never a permissionDecision (can't block)
// ---------------------------------------------------------------------------

test('buildPreToolPayload: additionalContext only, valid JSON, no deny', () => {
  assert.equal(buildPreToolPayload(''), '');
  const payload = buildPreToolPayload(nudgeText('rawSearch'));
  const env = JSON.parse(payload);
  assert.equal(env.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(env.hookSpecificOutput.additionalContext, /brain:search/);
  assert.equal('permissionDecision' in env.hookSpecificOutput, false); // cannot block a tool call
});

// ---------------------------------------------------------------------------
// CLI — ALWAYS exit 0, fail-open on every path (the core acceptance criterion)
// ---------------------------------------------------------------------------

function freshRepo({ withIndex = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tool-hook-'));
  const brain = path.join(cwd, '.project-brain');
  fs.mkdirSync(brain, { recursive: true });
  if (withIndex) {
    fs.writeFileSync(path.join(brain, 'index_manifest.json'), '{}');
    fs.writeFileSync(path.join(brain, 'search_index.json'), 'x'.repeat(2048));
  }
  return cwd;
}
const runHook = (cwd, envelope, { surface = 'bash', env = {}, rawInput } = {}) =>
  spawnSync(process.execPath, [TOOL_SCRIPT, '--surface', surface], {
    cwd, encoding: 'utf8',
    input: rawInput !== undefined ? rawInput : JSON.stringify(envelope),
    env: { ...process.env, ...env }
  });

test('CLI: fresh index + raw search → emits a PreToolUse additionalContext nudge, exit 0', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'grep -r hybridScore scripts/' } });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  assert.equal(env.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(env.hookSpecificOutput.additionalContext, /brain:search/);
});

test('CLI: missing index → no nudge, exit 0 (never blocks)', () => {
  const cwd = freshRepo({ withIndex: false });
  const r = runHook(cwd, { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'grep -r foo scripts/' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});

test('CLI: malformed stdin → no crash, no nudge, exit 0 (must not block the tool call)', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, null, { rawInput: '{not valid json' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});

test('CLI: empty stdin → exit 0, silent', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, null, { rawInput: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});

test('CLI: non-search Bash command → silent exit 0', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});

test('CLI: session dedup — second identical class is suppressed, opt-out re-emits', () => {
  const cwd = freshRepo();
  const envelope = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'grep -r foo scripts/' } };
  const first = runHook(cwd, envelope);
  assert.ok(first.stdout.trim(), 'first nudge fires');
  const second = runHook(cwd, envelope);
  assert.equal(second.stdout.trim(), '', 'same class same session suppressed');
  // A different class in the same session still nudges.
  const read = runHook(cwd, { session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'lib/a.ts' } }, { surface: 'read' });
  assert.ok(read.stdout.trim(), 'different pattern class nudges independently');
  // Opt-out re-emits.
  const optOut = runHook(cwd, envelope, { env: { BRAIN_TOOL_NUDGE_DEDUPE: '0' } });
  assert.ok(optOut.stdout.trim(), 'BRAIN_TOOL_NUDGE_DEDUPE=0 re-emits');
  // State file is the SHARED one (#22), not a second file.
  assert.ok(fs.existsSync(path.join(cwd, '.project-brain', '.route-hook-state.json')));
  assert.equal(fs.existsSync(path.join(cwd, '.project-brain', '.route-tool-hook-state.json')), false);
});

test('CLI: --surface read ignores Bash envelopes (matcher scoping)', () => {
  const cwd = freshRepo();
  const r = runHook(cwd, { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'grep -r foo scripts/' } }, { surface: 'read' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
});
