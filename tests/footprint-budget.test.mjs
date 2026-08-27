/**
 * CI budget assertions (docs/strategy-agent-ops.md §2b „Budgets als CI-Test“,
 * decisions/0024). The session base cost the brain injects is a HARD budget,
 * not a vow: a breach here is a red build. The numbers live in ONE place —
 * BUDGETS in scripts/footprint.mjs — shared with brain:health's footprint
 * audit and cited by docs/eval-methodology.md.
 *
 * Asserted surfaces:
 *   (a) SKILL.md core ≤ BUDGETS.skillBytes (≈3k tok, len/4)
 *   (b) brain-state-digest output ≤ BUDGETS.stateDigestBytes (≈2k tok) even on
 *       a worst-case active_state.md (30 workstreams, 20 leases, long notes) —
 *       both through the pure core and end-to-end through the real CLI
 *   (c) the SessionStart hook in settings.recommended.json runs the digest
 *       script, not a raw `cat active_state.md`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BUDGETS, stateDigestBudgetBytes, estimateTokens } from '../scripts/footprint.mjs';
import {
  buildStateDigest,
  capBytes,
  recentSessionPointers,
  isFinishedWorkstream,
  isExpiredLease,
  TRUNCATION_MARKER
} from '../scripts/brain-state-digest.mjs';

const SKILL_MD = fileURLToPath(new URL('../SKILL.md', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/claude-code/settings.recommended.json', import.meta.url));
const DIGEST_SCRIPT = fileURLToPath(new URL('../scripts/brain-state-digest.mjs', import.meta.url));

const NOW = Date.parse('2026-08-27T12:00:00Z');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------------------
// Worst-case fixture: 30 workstreams, 20 leases, long scope/notes text.
// ---------------------------------------------------------------------------

const LONG = (i, n) => `long free-text cell number ${i} — ${'agents keep writing prose into table cells, '.repeat(n)}see also #21/#32`;

function worstCaseState() {
  const workstreams = [];
  for (let i = 0; i < 30; i++) {
    workstreams.push({
      taskId: `T-${String(i).padStart(3, '0')}-very-long-task-identifier`,
      owner: `agent-${i}@fleet.example`,
      tool: i % 2 ? 'claude-code' : 'cursor',
      project: `project-${i % 5}-with-a-long-name`,
      branch: `feature/${i}-extremely-long-branch-name-for-the-workstream-row`,
      scope: LONG(i, 6),
      status: i % 3 === 0 ? 'done' : 'active' // 10 finished, 20 active
    });
  }
  const leases = [];
  for (let i = 0; i < 20; i++) {
    leases.push({
      target: `src/deeply/nested/module-${i}/**/*.{ts,tsx,mjs}`,
      project: `project-${i % 5}-with-a-long-name`,
      lockedBy: `agent-${i}@fleet.example`,
      // 5 expired, 15 open
      until: i % 4 === 0 ? '2026-08-01T00:00:00Z' : '2026-09-30T00:00:00Z',
      notes: LONG(i, 4)
    });
  }
  return {
    workstreams,
    leases,
    blockers: Array.from({ length: 10 }, (_, i) => LONG(i, 3)),
    overlaps: Array.from({ length: 5 }, (_, i) => LONG(i, 3)),
    sessions: ['.project-brain/sessions/2026-08-27.md', '.project-brain/sessions/2026-08-26.md', '.project-brain/sessions/2026-08-25.md']
  };
}

/** The same worst case as raw active_state.md markdown (real parse path). */
function worstCaseMarkdown() {
  const s = worstCaseState();
  const esc = (v) => String(v).replace(/\|/g, '\\|');
  const ws = s.workstreams.map((w) => `| ${[w.taskId, w.owner, w.tool, w.project, w.branch, w.scope, w.status].map(esc).join(' | ')} |`);
  const ls = s.leases.map((l) => `| ${[l.target, l.project, l.lockedBy, l.until, l.notes].map(esc).join(' | ')} |`);
  return [
    '# Active State',
    '',
    '## Workstreams',
    '',
    '| task_id | owner | tool | project | branch | scope / links | status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...ws,
    '',
    '## File Leases',
    '',
    '| path glob or file | project | locked_by | until | notes |',
    '| --- | --- | --- | --- | --- |',
    ...ls,
    '',
    '## Blockers',
    '',
    ...s.blockers.map((b) => `- ${b}`),
    '',
    '## Overlaps',
    '',
    ...s.overlaps.map((o) => `- ${o}`),
    ''
  ].join('\n');
}

// ---------------------------------------------------------------------------
// (a) SKILL.md core stays under the hard byte budget
// ---------------------------------------------------------------------------

test('budget (a): SKILL.md core ≤ BUDGETS.skillBytes', () => {
  const size = fs.statSync(SKILL_MD).size;
  assert.ok(
    size <= BUDGETS.skillBytes,
    `SKILL.md is ${size} B ≈ ${estimateTokens(size)} tok — over the ${BUDGETS.skillBytes} B hard budget. ` +
    'Move detail into references/*.md and leave a one-line pointer.'
  );
});

// ---------------------------------------------------------------------------
// (b) digest output stays under budget on the worst-case fixture
// ---------------------------------------------------------------------------

test('budget (b): worst-case digest (pure core) ≤ BUDGETS.stateDigestBytes and truncates explicitly', () => {
  const digest = buildStateDigest(worstCaseState(), { now: NOW });
  assert.ok(
    bytes(digest) <= BUDGETS.stateDigestBytes,
    `digest is ${bytes(digest)} B — over the ${BUDGETS.stateDigestBytes} B hard budget`
  );
  // This fixture is far over budget pre-cap, so the marker must be visible.
  assert.ok(digest.includes(TRUNCATION_MARKER), 'over-budget digest must carry the truncation marker');
});

test('budget (b): worst-case digest end-to-end through the real script + real markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-budget-'));
  try {
    fs.mkdirSync(path.join(dir, '.project-brain', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.project-brain', 'active_state.md'), worstCaseMarkdown());
    for (const d of ['2026-08-25', '2026-08-26', '2026-08-27']) {
      fs.writeFileSync(path.join(dir, '.project-brain', 'sessions', `${d}-digest.md`), `# Session digests — ${d}\n`);
    }
    const raw = fs.statSync(path.join(dir, '.project-brain', 'active_state.md')).size;
    assert.ok(raw > 2 * BUDGETS.stateDigestBytes, `fixture too small to prove anything (${raw} B)`);

    const r = spawnSync(process.execPath, [DIGEST_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BRAIN_ROOT: dir, BRAIN_USAGE_LOG: '0' }
    });
    assert.equal(r.status, 0, `digest hook must exit 0: ${r.stderr}`);
    const out = String(r.stdout || '');
    assert.ok(bytes(out) <= BUDGETS.stateDigestBytes, `stdout is ${bytes(out)} B — over budget`);
    assert.ok(out.includes('Workstreams — 20 active (10 finished omitted)'), `finished rows not dropped first:\n${out.slice(0, 400)}`);
    assert.ok(out.includes('Active State (digest)'), 'digest header missing');
    // Read-only: the digest must not have touched the fixture.
    assert.equal(fs.statSync(path.join(dir, '.project-brain', 'active_state.md')).size, raw, 'digest mutated active_state.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('digest: missing active_state.md → silent success, no scaffolding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-budget-empty-'));
  try {
    const r = spawnSync(process.execPath, [DIGEST_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BRAIN_ROOT: dir, BRAIN_USAGE_LOG: '0' }
    });
    assert.equal(r.status, 0);
    assert.equal(String(r.stdout || ''), '');
    assert.ok(!fs.existsSync(path.join(dir, '.project-brain')), 'SessionStart hook must not scaffold .project-brain/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) the SessionStart hook actually runs the digest, not a raw cat
// ---------------------------------------------------------------------------

test('budget (c): settings.recommended.json SessionStart uses brain-state-digest.mjs, no raw cat', () => {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const cmds = (tpl.hooks?.SessionStart || [])
    .flatMap((g) => g.hooks || [])
    .map((h) => String(h.command || ''));
  assert.ok(cmds.length >= 2, 'expected the digest + route SessionStart hooks');
  assert.ok(cmds.some((c) => c.includes('brain-state-digest.mjs')), 'SessionStart must invoke the state digest');
  assert.ok(!cmds.some((c) => /cat\s+\S*active_state\.md/.test(c)), 'raw `cat active_state.md` must not come back');
  // The routing hook (ADR 0023) stays untouched.
  assert.ok(cmds.some((c) => c.includes('brain-route.mjs') && c.includes('sessionstart')), 'route hook lost');
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('buildStateDigest is deterministic (same input ⇒ byte-identical output)', () => {
  const a = buildStateDigest(worstCaseState(), { now: NOW });
  const b = buildStateDigest(worstCaseState(), { now: NOW });
  assert.equal(a, b);
});

test('buildStateDigest: small healthy state fits untruncated and keeps every row', () => {
  const state = {
    workstreams: [{ taskId: 'T-1', owner: 'seebo', tool: 'claude', project: '', branch: 'feature/x', scope: 'docs', status: 'active' }],
    leases: [{ target: 'src/a.ts', project: '', lockedBy: 'seebo', until: '2026-09-01T00:00:00Z', notes: '' }],
    blockers: ['None recorded'],
    overlaps: [],
    sessions: ['.project-brain/sessions/2026-08-27.md']
  };
  const digest = buildStateDigest(state, { now: NOW });
  assert.ok(!digest.includes(TRUNCATION_MARKER));
  assert.ok(digest.includes('T-1'));
  assert.ok(digest.includes('locked_by=seebo'));
  assert.ok(digest.includes('until=2026-09-01T00:00:00Z'));
  assert.ok(digest.includes('2026-08-27.md'));
  assert.ok(!digest.includes('Blockers:'), 'noise bullet "None recorded" must be dropped');
});

test('capBytes: passthrough under budget, marker + whole-line cuts over budget', () => {
  assert.equal(capBytes('abc\n', 100), 'abc\n');
  const long = Array.from({ length: 50 }, (_, i) => `line-${i}-xxxxxxxxxxxxxxxxxxxx`).join('\n');
  const capped = capBytes(long, 300);
  assert.ok(bytes(capped) <= 300);
  assert.ok(capped.endsWith(`${TRUNCATION_MARKER}\n`));
  assert.ok(capped.startsWith('line-0'));
});

test('isFinishedWorkstream / isExpiredLease classify and fail open', () => {
  assert.equal(isFinishedWorkstream({ status: 'done' }), true);
  assert.equal(isFinishedWorkstream({ status: 'Merged (PR #40)' }), true);
  assert.equal(isFinishedWorkstream({ status: 'active' }), false);
  assert.equal(isFinishedWorkstream({}), false); // unknown → keep
  assert.equal(isExpiredLease({ until: '2026-08-01T00:00:00Z' }, NOW), true);
  assert.equal(isExpiredLease({ until: '2026-09-01T00:00:00Z' }, NOW), false);
  assert.equal(isExpiredLease({ until: '' }, NOW), false); // no TTL → keep
  assert.equal(isExpiredLease({ until: 'next sprint' }, NOW), false); // unparseable → keep
});

test('stateDigestBudgetBytes: env override wins, junk falls back to BUDGETS', () => {
  assert.equal(stateDigestBudgetBytes({}), BUDGETS.stateDigestBytes);
  assert.equal(stateDigestBudgetBytes({ BRAIN_STATE_DIGEST_BUDGET_BYTES: '4000' }), 4000);
  assert.equal(stateDigestBudgetBytes({ BRAIN_STATE_DIGEST_BUDGET_BYTES: 'nope' }), BUDGETS.stateDigestBytes);
  assert.equal(stateDigestBudgetBytes({ BRAIN_STATE_DIGEST_BUDGET_BYTES: '-5' }), BUDGETS.stateDigestBytes);
});

test('recentSessionPointers: newest 3, lexical-chronological, missing dir → []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sessions-'));
  try {
    for (const d of ['2026-08-20', '2026-08-25', '2026-08-26', '2026-08-27']) {
      fs.writeFileSync(path.join(dir, `${d}-digest.md`), 'x');
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const got = recentSessionPointers(dir);
    assert.deepEqual(got, [
      '.project-brain/sessions/2026-08-27-digest.md',
      '.project-brain/sessions/2026-08-26-digest.md',
      '.project-brain/sessions/2026-08-25-digest.md'
    ]);
    assert.deepEqual(recentSessionPointers(path.join(dir, 'nope')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BUDGETS: documents the agreed hard budgets (docs cite these numbers)', () => {
  assert.equal(BUDGETS.skillBytes, 12000); // ≈3k tok
  assert.equal(BUDGETS.stateDigestBytes, 8000); // ≈2k tok
  assert.equal(estimateTokens(BUDGETS.skillBytes), 3000);
  assert.equal(estimateTokens(BUDGETS.stateDigestBytes), 2000);
});

/* The neighbours in the same context window.
   The footprint report answered "how many tokens does the brain inject"
   correctly and left the reader no way to judge the number: on a real machine
   the brain measured ≈2,890 tokens while the CLAUDE.md chain beside it measured
   ≈23,900 — eight times as much, invisible to the tool whose job is context
   discipline. A 427-byte digest took the blame for a 12,957-token problem
   because nobody had measured what sat next to it. */
test('measureInstructionChain: follows @imports and totals the chain', async () => {
  const { measureInstructionChain } = await import('../scripts/footprint.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-chain-'));
  try {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Entry\n\n@A.md\n@B.md\n@missing.md\n');
    fs.writeFileSync(path.join(dir, 'A.md'), 'a'.repeat(400));
    fs.writeFileSync(path.join(dir, 'B.md'), 'b'.repeat(800));

    const chain = measureInstructionChain(path.join(dir, 'CLAUDE.md'));
    assert.ok(chain.root.exists);
    // A missing import is skipped, not counted as zero and not thrown over.
    assert.deepEqual(chain.imports.map((f) => f.file), ['A.md', 'B.md']);
    const rootBytes = fs.statSync(path.join(dir, 'CLAUDE.md')).size;
    assert.equal(chain.totalBytes, rootBytes + 400 + 800);
    assert.equal(chain.totalTokens, Math.round((rootBytes + 1200) / 4));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('measureInstructionChain: a cycle is counted once, a missing entry is empty', async () => {
  const { measureInstructionChain } = await import('../scripts/footprint.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-chain-cycle-'));
  try {
    // Self-import: double-counting it would inflate every report that has one.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@CLAUDE.md\n@A.md\n');
    fs.writeFileSync(path.join(dir, 'A.md'), 'x'.repeat(100));
    const chain = measureInstructionChain(path.join(dir, 'CLAUDE.md'));
    assert.deepEqual(chain.imports.map((f) => f.file), ['A.md']);

    // No CLAUDE.md at all is the common case and must be silent, not an error.
    const none = measureInstructionChain(path.join(dir, 'nope', 'CLAUDE.md'));
    assert.equal(none.root, null);
    assert.equal(none.totalTokens, 0);
    assert.deepEqual(none.imports, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('measureInstructionChain: only a bare @file.md line is an import', async () => {
  const { measureInstructionChain } = await import('../scripts/footprint.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-chain-prose-'));
  try {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), [
      'Mail me at a@B.md if this breaks.',      // prose, not an import
      'See `@A.md` for detail.',                 // quoted, not an import
      '@A.md'                                    // the real one
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'A.md'), 'a'.repeat(40));
    const chain = measureInstructionChain(path.join(dir, 'CLAUDE.md'));
    assert.deepEqual(chain.imports.map((f) => f.file), ['A.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
