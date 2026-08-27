/**
 * brain:answer + its PreToolUse hook — the AMBIENT delivery of the brain's
 * file-level intelligence to the agent (decisions/0024 budget discipline,
 * decisions/0026 hook contract).
 *
 * Covered:
 *   (1) pure core — priority + truncation (leases survive the tightest budget),
 *       danger/partners/governing/lease selection on fixtures
 *   (2) the CLI on a scripted mkdtemp git repo: exit 0, output within budget
 *   (3) the hook wrapper: malformed stdin → silent 0, a real Edit payload →
 *       a context-only PreToolUse payload carrying the lease warning, session
 *       dedupe, no .project-brain → silent 0, BRAIN_ANSWER_HOOK=0 opt-out
 *   (4) the hard byte budget + the settings wiring
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildAnswer, renderAnswer, dangerFor, partnersFor, foreignLeases, isExpiredLease,
  governingDecisions, answerBudgetBytes, relPath, ANSWER_PRIORITY, TRUNCATION_MARKER
} from '../scripts/brain-answer.mjs';
import {
  targetFiles, shouldEmitAnswer, recordAnswer, ANSWER_HEADER, ANSWER_TTL_MS
} from '../scripts/brain-answer-hook.mjs';
import { BUDGETS, estimateTokens } from '../scripts/footprint.mjs';

const ANSWER_SCRIPT = fileURLToPath(new URL('../scripts/brain-answer.mjs', import.meta.url));
const HOOK_SCRIPT = fileURLToPath(new URL('../scripts/brain-answer-hook.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/claude-code/settings.recommended.json', import.meta.url));

const NOW = Date.parse('2026-08-27T12:00:00Z');
const bytes = (s) => Buffer.byteLength(String(s || ''), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEALTH = [
  {
    file: 'src/a.mjs', score: 8.3, commits: 17, factors: [
      { name: 'churn-percentile', weight: 0.35, raw: 0.98, contribution: 0.343, evidence: 'churn rank #7 of 300' },
      { name: 'fix-density', weight: 0.25, raw: 0.35, contribution: 0.088, evidence: '6 of 17 commits are fix/revert commits (35%)' }
    ]
  },
  {
    file: 'src/b.mjs', score: 9.1, commits: 2, lowConfidence: true, reason: 'insufficient history', factors: [
      { name: 'bus-factor', weight: 0.2, raw: 1, contribution: 0.2, evidence: 'bus factor 1 — ada owns 100% of 2 commits' },
      { name: 'churn-percentile', weight: 0.35, raw: 0.5, contribution: 0.175, evidence: 'churn rank #150 of 300' }
    ]
  },
  { file: 'src/untouched.mjs', score: 9.9, commits: 40, factors: [] }
];

const PAIRS = [
  { a: 'src/a.mjs', b: 'src/partner1.mjs', together: 9, confidence: 0.9 },
  { a: 'src/a.mjs', b: 'src/b.mjs', together: 8, confidence: 0.8 },       // in-set → excluded
  { a: 'src/b.mjs', b: 'src/partner2.mjs', together: 6, confidence: 0.6 },
  { a: 'src/a.mjs', b: 'src/partner3.mjs', together: 5, confidence: 0.5 },
  { a: 'src/b.mjs', b: 'src/partner4.mjs', together: 4, confidence: 0.4 }, // 4th → dropped (max 3)
  { a: 'src/nope.mjs', b: 'src/elsewhere.mjs', together: 9, confidence: 0.99 } // not in set → ignored
];

const LEASES = [
  { target: 'src/a.mjs', project: '', lockedBy: 'agent-b', until: '2026-09-01T00:00:00Z', notes: '' },
  { target: 'src/**', project: '', lockedBy: 'me', until: '2026-09-01T00:00:00Z', notes: 'self' },
  { target: 'src/b.mjs', project: '', lockedBy: 'agent-c', until: '2026-08-01T00:00:00Z', notes: 'expired' },
  { target: 'docs/**', project: '', lockedBy: 'agent-d', until: '', notes: 'no overlap' }
];

const DECISIONS = [
  { id: '0001-a-decision', title: 'A governing decision about the src module', module: 'src', files: ['src/a.mjs'] },
  { id: '0002-b-decision', title: 'Another one', module: 'src', files: ['src/a.mjs', 'src/b.mjs'] }
];

const FULL_INPUTS = {
  files: ['src/a.mjs', 'src/b.mjs'],
  health: HEALTH,
  pairs: PAIRS,
  leases: LEASES,
  decisions: DECISIONS,
  next: { command: 'brain:brief', args: ['--strict'], reason: '1 file(s) leased by someone else — coordinate before editing' },
  actor: 'me',
  now: NOW
};

// ---------------------------------------------------------------------------
// (1) pure core — section selection
// ---------------------------------------------------------------------------

test('dangerFor: highest-scoring file IN THE SET wins, with its strongest factor', () => {
  const d = dangerFor(['src/a.mjs', 'src/b.mjs'], HEALTH);
  assert.equal(d.file, 'src/b.mjs');                     // 9.1 > 8.3
  assert.equal(d.score, 9.1);
  assert.equal(d.lowConfidence, true);
  assert.equal(d.factor.name, 'bus-factor');             // 0.2 > 0.175 contribution
  // src/untouched.mjs scores 9.9 but is not in the set — it must not leak in.
  assert.notEqual(d.file, 'src/untouched.mjs');
});

test('dangerFor: no history for the given files → null', () => {
  assert.equal(dangerFor(['src/ghost.mjs'], HEALTH), null);
  assert.equal(dangerFor([], HEALTH), null);
  assert.equal(dangerFor(['src/a.mjs'], []), null);
});

test('dangerFor: ties break lexicographically (deterministic)', () => {
  const tied = [
    { file: 'src/z.mjs', score: 5, factors: [] },
    { file: 'src/a.mjs', score: 5, factors: [] }
  ];
  assert.equal(dangerFor(['src/z.mjs', 'src/a.mjs'], tied).file, 'src/a.mjs');
});

test('partnersFor: co-change partners NOT in the set, best confidence first, max 3', () => {
  const p = partnersFor(['src/a.mjs', 'src/b.mjs'], PAIRS);
  assert.deepEqual(p.map((x) => x.file), ['src/partner1.mjs', 'src/partner2.mjs', 'src/partner3.mjs']);
  assert.ok(!p.some((x) => x.file === 'src/b.mjs'), 'a file in the set is never its own partner');
  assert.ok(!p.some((x) => x.file === 'src/elsewhere.mjs'), 'partners of unrelated files must not leak');
});

test('partnersFor: a partner reached from two files keeps the HIGHEST confidence', () => {
  const p = partnersFor(['src/a.mjs', 'src/b.mjs'], [
    { a: 'src/a.mjs', b: 'src/shared.mjs', together: 3, confidence: 0.4 },
    { a: 'src/b.mjs', b: 'src/shared.mjs', together: 7, confidence: 0.7 }
  ]);
  assert.equal(p.length, 1);
  assert.equal(p[0].confidence, 0.7);
});

test('isExpiredLease: past TTL expires, absent/unparseable TTL keeps warning (fail safe)', () => {
  assert.equal(isExpiredLease({ until: '2026-08-01T00:00:00Z' }, NOW), true);
  assert.equal(isExpiredLease({ until: '2026-09-01T00:00:00Z' }, NOW), false);
  assert.equal(isExpiredLease({ until: '' }, NOW), false);
  assert.equal(isExpiredLease({ until: 'next sprint' }, NOW), false);
});

test('foreignLeases: self-held / expired / non-overlapping dropped, glob targets matched', () => {
  const got = foreignLeases(['src/a.mjs', 'src/b.mjs'], LEASES, { actor: 'me', now: NOW });
  assert.deepEqual(got.map((l) => l.target), ['src/a.mjs']);
  assert.deepEqual(got[0].files, ['src/a.mjs']);
  assert.equal(got[0].lockedBy, 'agent-b');

  // With NO actor set, the `src/**` lease is foreign too (we cannot prove it is ours).
  const anon = foreignLeases(['src/a.mjs', 'src/b.mjs'], LEASES, { actor: '', now: NOW });
  assert.deepEqual(anon.map((l) => l.target).sort(), ['src/**', 'src/a.mjs']);
  const glob = anon.find((l) => l.target === 'src/**');
  assert.deepEqual(glob.files, ['src/a.mjs', 'src/b.mjs'], 'a glob lease reports every file it covers');
});

test('governingDecisions: module-record glob → alias widening → ADR match, max 2, ranked', () => {
  const records = {
    modules: [{ name: 'core', module: 'core', feature: 'engine', globs: ['src/**'] }],
    decisions: [
      { name: '0001-one', title: 'One', module: 'core' },
      { name: '0002-two', title: 'Two', module: 'engine' },   // matched via the feature alias
      { name: '0003-three', title: 'Three', module: 'core' },
      { name: '0004-four', title: 'Four', module: 'unrelated' }
    ]
  };
  const got = governingDecisions(['src/a.mjs', 'src/b.mjs'], records);
  assert.equal(got.length, 2, 'capped at 2');
  assert.deepEqual(got.map((d) => d.id), ['0001-one', '0002-two']);
  assert.deepEqual(got[0].files, ['src/a.mjs', 'src/b.mjs']);
  assert.ok(!got.some((d) => d.id === '0004-four'), 'an unrelated module must never govern');
});

test('governingDecisions: no module record → path heuristic still finds the ADR', () => {
  const got = governingDecisions(['lib/auth/token.ts'], {
    modules: [],
    decisions: [{ name: '0009-auth', title: 'Auth', module: 'lib/auth' }]
  });
  assert.deepEqual(got.map((d) => d.id), ['0009-auth']);
});

test('governingDecisions: nothing to match → []', () => {
  assert.deepEqual(governingDecisions(['src/a.mjs'], { modules: [], decisions: [] }), []);
  assert.deepEqual(governingDecisions([], {}), []);
});

test('relPath normalizes ./ and backslashes', () => {
  assert.equal(relPath('./src/a.mjs'), 'src/a.mjs');
  assert.equal(relPath('src\\a.mjs'), 'src/a.mjs');
  assert.equal(relPath(''), '');
});

// ---------------------------------------------------------------------------
// (1b) pure core — priority + truncation
// ---------------------------------------------------------------------------

test('buildAnswer: all five sections, emitted in the documented priority order', () => {
  const a = buildAnswer(FULL_INPUTS, { budgetBytes: 4000 });
  assert.equal(a.truncated, false);
  assert.deepEqual(a.dropped, []);
  const keys = a.lines.map((l) =>
    l.startsWith('LEASE:') ? 'leases'
      : l.startsWith('danger:') ? 'danger'
        : l.startsWith('governing:') ? 'governing'
          : l.startsWith('co-change:') ? 'partners'
            : l.startsWith('next:') ? 'next' : '?');
  assert.deepEqual([...new Set(keys)], ANSWER_PRIORITY, 'display order must equal priority order (safety first)');
  assert.ok(a.lines[0].includes('agent-b'), 'the lease line names the holder');
  assert.ok(a.lines.some((l) => l.includes('9.1/10')));
  assert.ok(a.lines.some((l) => l.includes('0001-a-decision')));
  assert.ok(a.lines.some((l) => l.includes('src/partner1.mjs')));
  assert.ok(a.lines.some((l) => l.includes('brain:brief --strict')));
});

test('buildAnswer: the TIGHTEST budget still keeps the lease warning, drops everything else', () => {
  const a = buildAnswer(FULL_INPUTS, { budgetBytes: 1 });
  assert.equal(a.truncated, true);
  assert.deepEqual(a.dropped, ['danger', 'governing', 'partners', 'next']);
  assert.equal(a.lines.length, 1);
  assert.ok(a.lines[0].startsWith('LEASE:'), `leases must never be dropped, got: ${a.lines[0]}`);
  assert.ok(a.lines[0].includes('src/a.mjs') && a.lines[0].includes('agent-b'));
});

test('buildAnswer: sections drop from the TAIL of the priority order as the budget shrinks', () => {
  const full = buildAnswer(FULL_INPUTS, { budgetBytes: 4000 });
  const seen = [];
  // Walk the budget down and record which sections survive at each step.
  for (const budget of [4000, 300, 200, 120, 1]) {
    const a = buildAnswer(FULL_INPUTS, { budgetBytes: budget });
    seen.push(Object.keys(a.sections));
  }
  for (const kept of seen) {
    // Whatever survives is always a PREFIX of the priority order.
    assert.deepEqual(kept, ANSWER_PRIORITY.slice(0, kept.length), `not a priority prefix: ${kept}`);
  }
  // Monotonic: a smaller budget never keeps more sections than a bigger one.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].length <= seen[i - 1].length, 'section count must be monotonic in the budget');
  }
  assert.equal(Object.keys(full.sections).length, 5);
});

test('buildAnswer: truncation is announced when the marker fits, and never silently', () => {
  const a = buildAnswer(FULL_INPUTS, { budgetBytes: 260 });
  assert.equal(a.truncated, true);
  assert.ok(a.dropped.length > 0);
  if (a.bytes + bytes(TRUNCATION_MARKER) + 1 <= 260) {
    assert.ok(a.lines.includes(TRUNCATION_MARKER));
  }
});

test('buildAnswer: nothing to say → no lines, renderAnswer → empty string (inject nothing)', () => {
  const a = buildAnswer({ files: ['src/quiet.mjs'], now: NOW });
  assert.deepEqual(a.lines, []);
  assert.equal(a.truncated, false);
  assert.equal(renderAnswer(a), '');
});

test('buildAnswer: many foreign leases collapse into a bounded "+N more" line (never silently dropped)', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    target: `src/f${i}.mjs`, lockedBy: `agent-${i}`, until: '2026-09-01T00:00:00Z'
  }));
  const files = many.map((l) => l.target);
  const a = buildAnswer({ files, leases: many, actor: 'me', now: NOW }, { budgetBytes: 1 });
  const leaseLines = a.lines.filter((l) => l.startsWith('LEASE:'));
  assert.equal(leaseLines.length, 6, '5 leases + 1 summary line');
  assert.ok(leaseLines.at(-1).includes('+4 more'), leaseLines.at(-1));
});

test('buildAnswer is deterministic (same input ⇒ byte-identical output)', () => {
  assert.equal(renderAnswer(buildAnswer(FULL_INPUTS)), renderAnswer(buildAnswer(FULL_INPUTS)));
});

test('answerBudgetBytes: env override wins, junk falls back to BUDGETS.answerBytes', () => {
  assert.equal(answerBudgetBytes({}), BUDGETS.answerBytes);
  assert.equal(answerBudgetBytes({ BRAIN_ANSWER_BUDGET_BYTES: '250' }), 250);
  assert.equal(answerBudgetBytes({ BRAIN_ANSWER_BUDGET_BYTES: 'nope' }), BUDGETS.answerBytes);
  assert.equal(answerBudgetBytes({ BRAIN_ANSWER_BUDGET_BYTES: '-1' }), BUDGETS.answerBytes);
});

test('BUDGETS.answerBytes: the agreed hard budget for the per-EDIT ambient surface', () => {
  assert.equal(BUDGETS.answerBytes, 700);
  assert.equal(estimateTokens(BUDGETS.answerBytes), 175);
  assert.ok(BUDGETS.answerBytes < BUDGETS.stateDigestBytes,
    'the per-edit surface must be budgeted well below the once-per-session digest');
});

// ---------------------------------------------------------------------------
// (1c) hook pure cores
// ---------------------------------------------------------------------------

test('targetFiles: Edit/Write/MultiEdit yield the path; every other tool yields nothing', () => {
  assert.deepEqual(targetFiles({ tool_name: 'Edit', tool_input: { file_path: '/x/a.mjs' } }), ['/x/a.mjs']);
  assert.deepEqual(targetFiles({ tool_name: 'Write', tool_input: { file_path: 'a.mjs', content: 'x' } }), ['a.mjs']);
  assert.deepEqual(targetFiles({ tool_name: 'MultiEdit', tool_input: { file_path: 'a.mjs', edits: [] } }), ['a.mjs']);
  assert.deepEqual(targetFiles({ toolName: 'Edit', toolInput: { filePath: 'a.mjs' } }), ['a.mjs'], 'camelCase envelope');
  assert.deepEqual(targetFiles({ tool_name: 'Bash', tool_input: { command: 'ls' } }), []);
  assert.deepEqual(targetFiles({ tool_name: 'Edit', tool_input: {} }), []);
  assert.deepEqual(targetFiles({}), []);
  assert.deepEqual(targetFiles(), []);
});

test('shouldEmitAnswer: emit on cold state / new session / new file / TTL lapse / CHANGED answer', () => {
  const base = { sessionId: 's1', fileKey: 'a.mjs', hash: 'h1', now: NOW };
  assert.equal(shouldEmitAnswer(null, base), true, 'cold state');
  const st = { answerNudges: recordAnswer(null, base) };
  assert.equal(shouldEmitAnswer(st, base), false, 'identical repeat is suppressed');
  assert.equal(shouldEmitAnswer(st, { ...base, sessionId: 's2' }), true, 'new session');
  assert.equal(shouldEmitAnswer(st, { ...base, fileKey: 'b.mjs' }), true, 'new file');
  assert.equal(shouldEmitAnswer(st, { ...base, hash: 'h2' }), true, 'the answer changed → new information');
  assert.equal(shouldEmitAnswer(st, { ...base, now: NOW + ANSWER_TTL_MS + 1 }), true, 'TTL lapsed');
  assert.equal(shouldEmitAnswer(st, { ...base, fileKey: '' }), false, 'no file → never emit');
});

test('recordAnswer: namespaced, session-resetting, and bounded', () => {
  const first = recordAnswer(null, { sessionId: 's1', fileKey: 'a', hash: 'h', now: NOW });
  assert.deepEqual(Object.keys(first.files), ['a']);
  const second = recordAnswer(first, { sessionId: 's1', fileKey: 'b', hash: 'h', now: NOW });
  assert.deepEqual(Object.keys(second.files).sort(), ['a', 'b']);
  const reset = recordAnswer(second, { sessionId: 's2', fileKey: 'c', hash: 'h', now: NOW });
  assert.deepEqual(Object.keys(reset.files), ['c'], 'a new session starts fresh');

  let big = null;
  for (let i = 0; i < 60; i++) {
    big = recordAnswer(big, { sessionId: 's1', fileKey: `f${i}`, hash: 'h', now: NOW + i });
  }
  assert.ok(Object.keys(big.files).length <= 40, `state map must stay bounded, got ${Object.keys(big.files).length}`);
  assert.ok(big.files.f59, 'the newest entry survives pruning');
});

// ---------------------------------------------------------------------------
// (2)/(3) end-to-end on a scripted mkdtemp repo
// ---------------------------------------------------------------------------

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
};

function git(dir, args, extraEnv = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...extraEnv } });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A tiny real repo: history over src/a.mjs + src/partner.mjs (so co-change and
 * fileHealth have something to measure), a module record + an ADR that governs
 * it, and a FOREIGN lease on src/a.mjs.
 */
function makeRepo({ withLease = true, withBrain = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-answer-')));
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), `export const a = ${i};\n`);
    fs.writeFileSync(path.join(dir, 'src', 'partner.mjs'), `export const p = ${i};\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', i % 2 ? `fix: repair a (${i})` : `feat: change a (${i})`], {
      GIT_AUTHOR_DATE: `2026-08-${10 + i}T10:00:00Z`, GIT_COMMITTER_DATE: `2026-08-${10 + i}T10:00:00Z`
    });
  }
  if (!withBrain) return dir;

  const brain = path.join(dir, '.project-brain');
  fs.mkdirSync(path.join(brain, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(brain, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'context_index.md'), '# Context\n');
  fs.writeFileSync(path.join(brain, 'modules', 'core.md'),
    '---\ntitle: Core module\nmodule: core\nglobs: src/**\n---\n\n# Core module\n\nThe core.\n');
  fs.writeFileSync(path.join(brain, 'decisions', '0001-src-layout.md'),
    '---\ntitle: Source layout is owned by the core module\nmodule: core\n---\n\n# 0001\n\n## Decision\n\nKeep it flat.\n');
  const leaseRow = withLease
    ? '| src/a.mjs |  | agent-b | 2099-01-01T00:00:00Z | refactor in flight |'
    : '| _None_ | | | | |';
  fs.writeFileSync(path.join(brain, 'active_state.md'), [
    '# Active State', '', '## Workstreams', '',
    '| task_id | owner | tool | project | branch | scope / links | status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| _None_ | | | | | | |', '',
    '## File Leases', '',
    '| path glob or file | project | locked_by | until | notes |',
    '| --- | --- | --- | --- | --- |',
    leaseRow, '',
    '## Blockers', '', '- None recorded', ''
  ].join('\n'));
  return dir;
}

function runCli(dir, args, env = {}) {
  return spawnSync(process.execPath, [ANSWER_SCRIPT, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, BRAIN_ROOT: dir, BRAIN_USAGE_LOG: '0', BRAIN_ACTOR: '', ...env }
  });
}

function runHook(dir, stdin, env = {}) {
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: dir, encoding: 'utf8', input: stdin,
    env: { ...process.env, BRAIN_ROOT: dir, BRAIN_USAGE_LOG: '0', BRAIN_ACTOR: '', ...env }
  });
}

test('CLI: `answer --files` on a real repo exits 0 and stays inside the byte budget', () => {
  const dir = makeRepo();
  try {
    const r = runCli(dir, ['--files', 'src/a.mjs']);
    assert.equal(r.status, 0, r.stderr);
    const out = String(r.stdout || '');
    assert.ok(bytes(out) <= BUDGETS.answerBytes, `answer is ${bytes(out)} B — over the ${BUDGETS.answerBytes} B budget:\n${out}`);
    assert.match(out, /^LEASE: src\/a\.mjs held by agent-b/m, `lease warning missing:\n${out}`);
    assert.match(out, /danger: src\/a\.mjs \d/, `danger line missing:\n${out}`);
    assert.match(out, /governing: 0001-src-layout/, `governing ADR missing:\n${out}`);
    assert.match(out, /co-change: src\/partner\.mjs/, `co-change partner missing:\n${out}`);
    assert.match(out, /^next: brain:/m, `next action missing:\n${out}`);

    // The cache landed where .gitignore expects it and is keyed by HEAD.
    const cache = JSON.parse(fs.readFileSync(path.join(dir, '.project-brain', '.answer-cache.json'), 'utf8'));
    assert.equal(cache.head, git(dir, ['rev-parse', 'HEAD']).trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --json carries the structured sections + provenance, and --budget-bytes truncates', () => {
  const dir = makeRepo();
  try {
    const r = runCli(dir, ['--files', 'src/a.mjs', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.files, ['src/a.mjs']);
    assert.equal(j.leases[0].lockedBy, 'agent-b');
    assert.equal(j.danger.file, 'src/a.mjs');
    assert.equal(j.governing[0].id, '0001-src-layout');
    assert.equal(j.provenance.basis, 'measured');
    assert.ok(j.provenance.window.commits >= 6);

    const tight = JSON.parse(runCli(dir, ['--files', 'src/a.mjs', '--json', '--budget-bytes', '1']).stdout);
    assert.equal(tight.truncated, true);
    assert.ok(tight.leases.length >= 1, 'leases survive --budget-bytes 1');
    assert.equal(tight.danger, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: absolute paths resolve to repo-relative; a path outside the repo is ignored', () => {
  const dir = makeRepo();
  try {
    const r = runCli(dir, ['--files', `${path.join(dir, 'src/a.mjs')},/etc/hosts`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(String(r.stdout), /src\/a\.mjs/);
    assert.ok(!String(r.stdout).includes('/etc/hosts'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: no --files → usage on stderr, still exit 0', () => {
  const dir = makeRepo();
  try {
    const r = runCli(dir, []);
    assert.equal(r.status, 0);
    assert.equal(String(r.stdout || ''), '');
    assert.match(r.stderr, /Usage: project-brain x answer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: a real Edit payload emits a context-only PreToolUse payload carrying the lease warning', () => {
  const dir = makeRepo();
  try {
    const payload = JSON.stringify({
      session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src/a.mjs'), old_string: 'a', new_string: 'b' }
    });
    const r = runHook(dir, payload);
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(r.stdout);
    // The EXACT contract from decisions/0026 — context only, no decision.
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
    assert.equal(out.permissionDecision, undefined, 'an ambient hook must never carry a permission decision');
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(out.decision, undefined, 'an ambient hook must never block');

    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(ANSWER_HEADER), ctx);
    assert.match(ctx, /LEASE: src\/a\.mjs held by agent-b/, ctx);
    assert.ok(bytes(ctx) <= BUDGETS.answerBytes,
      `injected ${bytes(ctx)} B ≈ ${estimateTokens(bytes(ctx))} tok — over the ${BUDGETS.answerBytes} B budget`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: dedupe — the identical call twice in one session emits nothing the second time', () => {
  const dir = makeRepo();
  try {
    const payload = JSON.stringify({
      session_id: 'sess-dedupe', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src/a.mjs'), old_string: 'a', new_string: 'b' }
    });
    const first = runHook(dir, payload);
    assert.equal(first.status, 0);
    assert.ok(first.stdout.length > 0, 'first call must answer');

    const second = runHook(dir, payload);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '', 'second identical call in the same session must stay silent');

    // A different session re-surfaces it.
    const other = runHook(dir, payload.replace('sess-dedupe', 'sess-other'));
    assert.ok(other.stdout.length > 0, 'a new session re-surfaces the answer');

    // The dedupe state is namespaced — it must not clobber the other hooks' keys.
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.project-brain', '.route-hook-state.json'), 'utf8'));
    assert.ok(state.answerNudges, 'answerNudges namespace missing');
    assert.equal(state.answerNudges.sessionId, 'sess-other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: dedupe preserves a sibling hook namespace in the shared state file', () => {
  const dir = makeRepo();
  try {
    const statePath = path.join(dir, '.project-brain', '.route-hook-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ toolNudges: { sessionId: 'x', rawSearch: 123 }, lastHash: 'keep-me' }));
    runHook(dir, JSON.stringify({
      session_id: 's', tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src/a.mjs'), content: 'x' }
    }));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.lastHash, 'keep-me');
    assert.deepEqual(state.toolNudges, { sessionId: 'x', rawSearch: 123 });
    assert.ok(state.answerNudges);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: fails open — malformed stdin, empty stdin, a non-edit tool → exit 0, no output', () => {
  const dir = makeRepo();
  try {
    for (const stdin of ['', '   ', 'not json at all', '{"tool_name":', '[]', 'null']) {
      const r = runHook(dir, stdin, { BRAIN_ANSWER_DEDUPE: '0' });
      assert.equal(r.status, 0, `exit ${r.status} on stdin ${JSON.stringify(stdin)}`);
      assert.equal(r.stdout, '', `stdout leaked on stdin ${JSON.stringify(stdin)}`);
    }
    const bash = runHook(dir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), { BRAIN_ANSWER_DEDUPE: '0' });
    assert.equal(bash.status, 0);
    assert.equal(bash.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: no .project-brain/ → silent exit 0 and NO scaffolding', () => {
  const dir = makeRepo({ withBrain: false });
  try {
    const r = runHook(dir, JSON.stringify({
      session_id: 's', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src/a.mjs'), old_string: 'a', new_string: 'b' }
    }), { BRAIN_ANSWER_DEDUPE: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(dir, '.project-brain')), 'an ambient hook must never scaffold the brain');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: read-only — it never scaffolds or mutates active_state.md', () => {
  const dir = makeRepo();
  try {
    const state = path.join(dir, '.project-brain', 'active_state.md');
    const before = fs.readFileSync(state, 'utf8');
    runHook(dir, JSON.stringify({
      session_id: 's', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src/a.mjs'), old_string: 'a', new_string: 'b' }
    }), { BRAIN_ANSWER_DEDUPE: '0' });
    assert.equal(fs.readFileSync(state, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: BRAIN_ANSWER_HOOK=0 is a complete opt-out (no output, no state file)', () => {
  const dir = makeRepo();
  try {
    const r = runHook(dir, JSON.stringify({
      session_id: 's', tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src/a.mjs'), old_string: 'a', new_string: 'b' }
    }), { BRAIN_ANSWER_HOOK: '0' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(dir, '.project-brain', '.route-hook-state.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook: a repo with nothing notable stays completely silent (no empty banner)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-answer-quiet-')));
  try {
    fs.mkdirSync(path.join(dir, '.project-brain'), { recursive: true });
    const r = runHook(dir, JSON.stringify({
      session_id: 's', tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'brand-new.mjs'), content: 'x' }
    }), { BRAIN_ANSWER_DEDUPE: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'no git history, no records, no leases → inject nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (4) wiring
// ---------------------------------------------------------------------------

test('settings template: the answer hook is wired on Edit|Write|MultiEdit next to the convention lint', () => {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const group = (tpl.hooks?.PreToolUse || []).find((g) => g.matcher === 'Edit|Write|MultiEdit');
  assert.ok(group, 'Edit|Write|MultiEdit PreToolUse group missing');
  const cmds = (group.hooks || []).map((h) => String(h.command || ''));
  assert.ok(cmds.some((c) => c.includes('brain-lint-conventions.mjs')), 'the blocking convention lint must survive');
  const answer = cmds.find((c) => c.includes('brain-answer-hook.mjs'));
  assert.ok(answer, 'brain-answer-hook.mjs not wired');
  assert.match(answer, /\|\| true$/, 'the ambient hook must be fail-open in the shell too');
});
