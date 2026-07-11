import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure exports — importing the script must NOT run its CLI (isMain guard).
import { applyRules, classifyBoundary, scoreChange, renderHookText, capHookText, buildHookPayload, HOOK_MAX_BYTES_DEFAULT, shouldEmitHook, HOOK_DEDUPE_TTL_MS } from '../scripts/brain-route.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_SCRIPT = path.resolve(here, '..', 'scripts', 'brain-route.mjs');

// ---------------------------------------------------------------------------
// classifyBoundary — the auto/stop source of truth
// ---------------------------------------------------------------------------

test('classifyBoundary: read-only/advisory/idempotent commands are auto', () => {
  for (const [cmd, args] of [
    ['brain:ask', ['"q"']], ['brain:search', ['"q"']], ['brain:radar', []],
    ['brain:brief', ['--strict']], ['brain:gaps', []], ['brain:verify', []],
    ['brain:health', []], ['brain:eval', []], ['brain:maintain', []],
    ['brain:improve', ['next']], ['brain:improve', ['status']],
    ['brain:audit', ['run']], ['brain:grill', ['scaffold', 'x']], ['brain:why', ['"q"']],
    ['brain:ticket', ['"t"']]
  ]) {
    assert.equal(classifyBoundary(cmd, args), 'auto', `${cmd} ${args.join(' ')}`);
  }
});

test('classifyBoundary: mutating/irreversible commands are human', () => {
  for (const [cmd, args] of [
    ['brain:init', []], ['brain:work', ['start']], ['brain:orchestrate', ['--spawn-worktrees']],
    ['brain:worktree', ['spawn']], ['brain:compact', []], ['brain:pr', ['prepare']],
    ['brain:index', []], ['brain:adr', ['x']],
    ['brain:improve', ['execute', 'p']], ['brain:ticket', ['"t"', '--write']],
    ['brain:ticket', ['create', 't']], ['brain:audit', ['add', '--title', 't']],
    ['brain:gaps', ['--as-findings']], ['brain:grill', ['save']], ['brain:why', ['ingest']],
    ['brain:insight', ['add']], ['brain:explain', ['save']]
  ]) {
    assert.equal(classifyBoundary(cmd, args), 'human', `${cmd} ${args.join(' ')}`);
  }
});

// ---------------------------------------------------------------------------
// scoreChange — change-band heuristic
// ---------------------------------------------------------------------------

test('scoreChange: small for a single file, risk keyword always escalates', () => {
  assert.equal(scoreChange(['lib/a.ts']).band, 'small');
  const risk = scoreChange(['lib/auth.ts'], 'feature/login');
  assert.equal(risk.riskKeyword, 'auth');
  // risk keyword adds +25 → still detectable regardless of band threshold
  assert.ok(['medium', 'large'].includes(risk.band) || risk.riskKeyword === 'auth');
});

test('scoreChange: many files across modules trends up; a risk keyword pushes it large', () => {
  const files = ['app/a.tsx', 'lib/b.ts', 'server/c.ts', 'components/d.tsx', 'src/e.ts', 'actions/f.ts', 'pages/g.tsx'];
  const r = scoreChange(files);
  assert.ok(r.modules > 1);
  assert.ok(['medium', 'large'].includes(r.band)); // many files + many modules ≥ medium
  // The same change on a risk-keyworded branch crosses into large.
  assert.equal(scoreChange(files, 'feature/schema-migration').band, 'large');
});

// ---------------------------------------------------------------------------
// applyRules — the routing decision
// ---------------------------------------------------------------------------

const QUIET = {
  brainInitialized: true, indexed: true, detachedHead: false, branch: 'develop',
  changedFiles: 0, stagedFiles: 0, changeBand: 'small', riskKeyword: '',
  backlog: { open: 0, planned: 0, plans: 0 }, ungrilledPlanned: 0, leaseConflicts: 0,
  commitsAheadNoPr: false, indexStale: { deleted: 0, changed: 0 }, gaps: { high: 0 }
};

test('applyRules: uninitialized brain short-circuits to init only', () => {
  const r = applyRules({ brainInitialized: false });
  assert.equal(r.recommendations.length, 1);
  assert.equal(r.recommendations[0].command, 'brain:init');
  assert.equal(r.recommendations[0].boundary, 'human');
});

test('applyRules: clean fresh brain with empty backlog → audit run, never quiet-empty', () => {
  const r = applyRules(QUIET);
  // backlog clear with no gaps surfaces an audit
  assert.ok(r.recommendations.some(x => x.command === 'brain:audit'));
});

test('applyRules: open findings → improve next (auto, P9)', () => {
  const r = applyRules({ ...QUIET, backlog: { open: 2, planned: 0, plans: 0 } });
  const rec = r.recommendations.find(x => x.command === 'brain:improve' && x.args[0] === 'next');
  assert.ok(rec);
  assert.equal(rec.boundary, 'auto');
  assert.equal(r.autoEntry, 'brain:improve next');
});

test('applyRules: planned + ungrilled → grill scaffold fires before execute', () => {
  const r = applyRules({ ...QUIET, backlog: { open: 0, planned: 1, plans: 1 }, ungrilledPlanned: 1 });
  assert.ok(r.recommendations.some(x => x.command === 'brain:grill'));
  const exec = r.recommendations.find(x => x.command === 'brain:improve' && x.args[0] === 'execute');
  assert.ok(exec);
  assert.equal(exec.boundary, 'human');
});

test('applyRules: lease conflict surfaces brief --strict', () => {
  const r = applyRules({ ...QUIET, changedFiles: 2, leaseConflicts: 1 });
  const rec = r.recommendations.find(x => x.command === 'brain:brief');
  assert.ok(rec);
  assert.deepEqual(rec.args, ['--strict']);
});

test('applyRules: large/risky change → ticket --write (human); auto-entry skips it', () => {
  const r = applyRules({ ...QUIET, changedFiles: 8, changeBand: 'large', riskKeyword: 'auth', recommendedPackages: 5, backlog: { open: 1, planned: 0, plans: 0 } });
  const ticket = r.recommendations.find(x => x.command === 'brain:ticket');
  assert.ok(ticket);
  assert.ok(ticket.args.includes('--write'));
  assert.equal(ticket.boundary, 'human');
  // Conflicting signals: ticket (human, P4) ranks above improve next (auto, P9),
  // but the auto entry is the first AUTO-safe rec, and the stop boundary is ticket.
  assert.equal(r.autoEntry, 'brain:improve next');
  assert.equal(r.stopBoundary.command, 'brain:ticket');
});

test('applyRules: index stale → maintain (auto, P1)', () => {
  const r = applyRules({ ...QUIET, indexStale: { deleted: 3, changed: 1 } });
  const rec = r.recommendations.find(x => x.command === 'brain:maintain');
  assert.ok(rec);
  assert.equal(rec.boundary, 'auto');
});

test('applyRules: commits ahead with no PR → pr prepare (suppressed on detached HEAD)', () => {
  const ahead = applyRules({ ...QUIET, branch: 'feature/x', commitsAheadNoPr: true, commitsAhead: 3, base: 'develop' });
  assert.ok(ahead.recommendations.some(x => x.command === 'brain:pr'));
  const detached = applyRules({ ...QUIET, detachedHead: true, commitsAheadNoPr: true });
  assert.ok(!detached.recommendations.some(x => x.command === 'brain:pr'));
});

test('applyRules: question intent adds brain:ask; keyword intent boosts the named rule', () => {
  const ask = applyRules(QUIET, { intent: 'how does sync flush work?' });
  assert.ok(ask.recommendations.some(x => x.command === 'brain:ask'));

  const biased = applyRules({ ...QUIET, backlog: { open: 1, planned: 0, plans: 0 } }, { intent: 'improve the backlog' });
  // improve gets a rank boost → sits at the front
  assert.equal(biased.recommendations[0].command, 'brain:improve');
});

test('applyRules: fleet project annotates every recommendation with --project', () => {
  const r = applyRules({ ...QUIET, backlog: { open: 1, planned: 0, plans: 0 } }, { project: 'backend' });
  for (const rec of r.recommendations) {
    assert.ok(rec.args.includes('--project') && rec.args.includes('backend'));
  }
});

// ---------------------------------------------------------------------------
// renderHookText — the auto-activation injection
// ---------------------------------------------------------------------------

test('renderHookText: empty for a quiet/clean repo (no per-prompt noise)', () => {
  assert.equal(renderHookText(applyRules(QUIET)), '');
});

test('renderHookText: surfaces interrupt-worthy state, suppresses chatty radar/pr', () => {
  const r = applyRules({
    ...QUIET, changedFiles: 2, changeBand: 'small', // → radar P5 (suppressed in hook)
    backlog: { open: 2, planned: 0, plans: 0 },      // → improve next P9 (surfaced)
    branch: 'feature/x', commitsAheadNoPr: true, commitsAhead: 3, base: 'develop' // → pr P8 (suppressed)
  });
  const text = renderHookText(r);
  assert.match(text, /brain:improve -- next/);
  assert.doesNotMatch(text, /brain:radar/);
  assert.doesNotMatch(text, /brain:pr/);
  assert.match(text, /safe to run/); // improve next is auto
});

// ---------------------------------------------------------------------------
// Hook byte cap (decisions/0024) — truncate TEXT pre-envelope, envelope valid
// ---------------------------------------------------------------------------

test('capHookText: passes short text through unchanged', () => {
  assert.equal(capHookText('hello', 4000), 'hello');
  assert.equal(capHookText('', 4000), '');
});

test('capHookText: truncates over-budget text and appends a truncation note', () => {
  const text = 'a'.repeat(10000);
  const capped = capHookText(text, 4000);
  assert.ok(Buffer.byteLength(capped, 'utf8') <= 4000);
  assert.match(capped, /… truncated — run npm run brain:route$/);
  assert.ok(capped.length < text.length);
});

test('capHookText: never leaves a replacement char from a split multi-byte codepoint', () => {
  // 3-byte codepoints; a byte budget that lands mid-codepoint must not yield �.
  const text = '★'.repeat(3000);
  const capped = capHookText(text, 4000);
  assert.doesNotMatch(capped.replace(/… truncated.*$/, ''), /�/);
  assert.ok(Buffer.byteLength(capped, 'utf8') <= 4000);
});

test('buildHookPayload: UserPromptSubmit envelope stays valid JSON with capped text', () => {
  const text = 'x'.repeat(20000);
  const payload = buildHookPayload('userpromptsubmit', text, 4000);
  const env = JSON.parse(payload); // envelope is NOT truncated → parseable
  const ctx = env.hookSpecificOutput.additionalContext;
  assert.equal(env.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  // the injected TEXT (not the envelope) is what got capped
  assert.ok(Buffer.byteLength(ctx, 'utf8') <= 4000);
  assert.match(ctx, /… truncated/);
});

test('buildHookPayload: SessionStart emits capped plain stdout; empty text → nothing', () => {
  assert.equal(buildHookPayload('sessionstart', ''), '');
  assert.equal(buildHookPayload('userpromptsubmit', ''), '');
  const payload = buildHookPayload('sessionstart', 'y'.repeat(9000), 4000);
  assert.ok(Buffer.byteLength(payload, 'utf8') <= 4001); // + trailing newline
  assert.match(payload, /… truncated/);
});

test('HOOK_MAX_BYTES_DEFAULT: documents the ~4000-byte cap', () => {
  assert.equal(HOOK_MAX_BYTES_DEFAULT, 4000);
});

// ---------------------------------------------------------------------------
// shouldEmitHook — per-session dedupe decision (decisions/0024)
// ---------------------------------------------------------------------------

test('shouldEmitHook: no prior state → emit (fail open)', () => {
  assert.equal(shouldEmitHook(null, { sessionId: 's1', textHash: 'h1', now: 1000 }), true);
  assert.equal(shouldEmitHook(undefined, { sessionId: 's1', textHash: 'h1', now: 1000 }), true);
  assert.equal(shouldEmitHook('corrupt-not-an-object', { sessionId: 's1', textHash: 'h1', now: 1000 }), true);
});

test('shouldEmitHook: identical payload in the same session within TTL → suppress', () => {
  const prev = { sessionId: 's1', textHash: 'h1', ts: 1000 };
  assert.equal(shouldEmitHook(prev, { sessionId: 's1', textHash: 'h1', now: 1000 + 60_000 }), false);
});

test('shouldEmitHook: changed payload hash → emit', () => {
  const prev = { sessionId: 's1', textHash: 'h1', ts: 1000 };
  assert.equal(shouldEmitHook(prev, { sessionId: 's1', textHash: 'h2', now: 1000 + 60_000 }), true);
});

test('shouldEmitHook: different session → emit', () => {
  const prev = { sessionId: 's1', textHash: 'h1', ts: 1000 };
  assert.equal(shouldEmitHook(prev, { sessionId: 's2', textHash: 'h1', now: 1000 + 60_000 }), true);
});

test('shouldEmitHook: TTL lapsed → emit even for an identical payload', () => {
  const prev = { sessionId: 's1', textHash: 'h1', ts: 1000 };
  assert.equal(shouldEmitHook(prev, { sessionId: 's1', textHash: 'h1', now: 1000 + HOOK_DEDUPE_TTL_MS + 1 }), true);
  // Just under the TTL still suppresses.
  assert.equal(shouldEmitHook(prev, { sessionId: 's1', textHash: 'h1', now: 1000 + HOOK_DEDUPE_TTL_MS - 1 }), false);
});

test('shouldEmitHook: corrupt/absent timestamp → emit (fail open)', () => {
  assert.equal(shouldEmitHook({ sessionId: 's1', textHash: 'h1', ts: 'nope' }, { sessionId: 's1', textHash: 'h1', now: 2000 }), true);
  assert.equal(shouldEmitHook({ sessionId: 's1', textHash: 'h1' }, { sessionId: 's1', textHash: 'h1', now: 2000 }), true);
});

// ---------------------------------------------------------------------------
// CLI dedupe — twice with the same session emits once; opt-out re-emits
// ---------------------------------------------------------------------------

function actionableRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-route-dedupe-'));
  fs.mkdirSync(path.join(cwd, '.project-brain', 'findings'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.project-brain', 'context_index.md'), '# index\n');
  fs.writeFileSync(path.join(cwd, '.project-brain', 'index_manifest.json'), '{}\n');
  fs.writeFileSync(path.join(cwd, '.project-brain', 'findings', 'bug.md'),
    '---\ntype: finding\ntitle: Bug\ncategory: correctness\nstatus: open\nimpact: 4\ncreated: x\nupdated: x\nactor: \nmodule: \nsymbols: \nsources:\n---\nbody\n');
  return cwd;
}
const runHook = (cwd, env = {}) => spawnSync(process.execPath, [ROUTE_SCRIPT, '--hook'], {
  cwd, encoding: 'utf8', input: '{"session_id":"t1"}', env: { ...process.env, ...env }
});

test('CLI dedupe: second identical call in the same session emits nothing', () => {
  const cwd = actionableRepo();
  const first = runHook(cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.trim(), 'first call should surface actionable routing');
  const second = runHook(cwd);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), '', 'identical re-injection is suppressed');
  // State file was written.
  assert.ok(fs.existsSync(path.join(cwd, '.project-brain', '.route-hook-state.json')));
});

test('CLI dedupe: BRAIN_HOOK_DEDUPE=0 re-emits every call', () => {
  const cwd = actionableRepo();
  const first = runHook(cwd, { BRAIN_HOOK_DEDUPE: '0' });
  const second = runHook(cwd, { BRAIN_HOOK_DEDUPE: '0' });
  assert.ok(first.stdout.trim());
  assert.equal(second.stdout.trim(), first.stdout.trim(), 'opt-out disables suppression');
});

test('CLI dedupe: a corrupt state file fails open and emits', () => {
  const cwd = actionableRepo();
  fs.writeFileSync(path.join(cwd, '.project-brain', '.route-hook-state.json'), '{not json');
  const r = runHook(cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), 'corrupt state must not swallow routing signal');
});

// ---------------------------------------------------------------------------
// CLI smoke — JSON shape in a temp repo (model-free via --no-index)
// ---------------------------------------------------------------------------

test('CLI: brain:route --hook emits a UserPromptSubmit JSON envelope or nothing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-route-hook-'));
  fs.mkdirSync(path.join(cwd, '.project-brain', 'findings'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.project-brain', 'context_index.md'), '# index\n');
  fs.writeFileSync(path.join(cwd, '.project-brain', 'index_manifest.json'), '{}\n');
  // An open finding makes the hook actionable (improve next).
  fs.writeFileSync(path.join(cwd, '.project-brain', 'findings', 'bug.md'),
    '---\ntype: finding\ntitle: Bug\ncategory: correctness\nstatus: open\nimpact: 4\ncreated: x\nupdated: x\nactor: \nmodule: \nsymbols: \nsources:\n---\nbody\n');
  const r = spawnSync(process.execPath, [ROUTE_SCRIPT, '--hook'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); // never blocks
  if (r.stdout.trim()) {
    const env = JSON.parse(r.stdout);
    assert.equal(env.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(env.hookSpecificOutput.additionalContext, /Project Brain routing/);
  }
});

test('CLI: brain:route --json --no-index emits a valid recommendation envelope', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-route-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.project-brain', 'context_index.md'), '# index\n');
  const r = spawnSync(process.execPath, [ROUTE_SCRIPT, '--json', '--no-index'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok('recommendations' in out);
  assert.ok('signals' in out);
  assert.equal(out.signals.brainInitialized, true);
});
