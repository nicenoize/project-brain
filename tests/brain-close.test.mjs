import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure exports — importing the script must NOT run its CLI (isMain guard) and
// must NOT touch git or the filesystem.
import {
  parseGitStatusShort,
  suggestCommitType,
  suggestScope,
  suggestCommitMessage,
  adrCandidatesFromFindings,
  collectCloseChecklist,
  renderChecklist,
  renderSessionLog
} from '../scripts/brain-close.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOSE_SCRIPT = path.resolve(here, '..', 'scripts', 'brain-close.mjs');

// ---------------------------------------------------------------------------
// parseGitStatusShort
// ---------------------------------------------------------------------------

test('parseGitStatusShort: classifies staged / untracked / deleted / rename', () => {
  const text = [
    ' M scripts/foo.mjs',
    'A  scripts/bar.mjs',
    '?? new/file.mjs',
    ' D scripts/gone.mjs',
    'R  old.mjs -> renamed.mjs',
    '',
    'MM scripts/both.mjs'
  ].join('\n');
  const e = parseGitStatusShort(text);
  assert.equal(e.length, 6);

  const foo = e.find((x) => x.path === 'scripts/foo.mjs');
  assert.equal(foo.staged, false); // ' M' = worktree-modified, not staged
  assert.equal(foo.untracked, false);

  const bar = e.find((x) => x.path === 'scripts/bar.mjs');
  assert.equal(bar.staged, true);

  const untracked = e.find((x) => x.path === 'new/file.mjs');
  assert.equal(untracked.untracked, true);
  assert.equal(untracked.staged, false);

  const gone = e.find((x) => x.path === 'scripts/gone.mjs');
  assert.equal(gone.deleted, true);

  // rename keeps the new path
  assert.ok(e.some((x) => x.path === 'renamed.mjs'));

  const both = e.find((x) => x.path === 'scripts/both.mjs');
  assert.equal(both.staged, true); // 'M' in index column
});

test('parseGitStatusShort: empty / whitespace → no entries', () => {
  assert.deepEqual(parseGitStatusShort(''), []);
  assert.deepEqual(parseGitStatusShort('\n  \n'), []);
  assert.deepEqual(parseGitStatusShort(null), []);
});

// ---------------------------------------------------------------------------
// suggestCommitType / suggestScope
// ---------------------------------------------------------------------------

test('suggestCommitType: docs-only, tests-only, mixed', () => {
  assert.equal(suggestCommitType(['README.md', 'docs/guide.md']), 'docs');
  assert.equal(suggestCommitType(['tests/a.test.mjs', 'tests/edges/b.test.mjs']), 'test');
  assert.equal(suggestCommitType(['scripts/foo.mjs', 'README.md']), 'feat');
  assert.equal(suggestCommitType([]), 'chore');
});

test('suggestScope: brain plumbing collapses to brain; else top dir by frequency', () => {
  assert.equal(suggestScope(['scripts/brain-close.mjs', 'lib/x.ts']), 'brain');
  assert.equal(suggestScope(['SKILL.md']), 'brain');
  assert.equal(suggestScope(['references/commands.md']), 'brain');
  assert.equal(suggestScope(['lib/a.ts', 'lib/b.ts', 'app/c.ts']), 'lib');
  assert.equal(suggestScope(['top.mjs']), ''); // no directory segment
});

// ---------------------------------------------------------------------------
// suggestCommitMessage
// ---------------------------------------------------------------------------

test('suggestCommitMessage: builds a skeleton subject + counts; null when clean', () => {
  assert.equal(suggestCommitMessage({ entries: [] }), null);

  const msg = suggestCommitMessage({
    entries: [
      { path: 'scripts/brain-close.mjs', staged: true, untracked: false },
      { path: 'tests/brain-close.test.mjs', staged: false, untracked: true }
    ],
    diffStat: ' 2 files changed'
  });
  assert.equal(msg.subject, 'feat(brain): <summarize this change>');
  assert.equal(msg.changedCount, 2);
  assert.equal(msg.stagedCount, 1);
  assert.equal(msg.untrackedCount, 1);
  assert.equal(msg.diffStat, '2 files changed');
});

// ---------------------------------------------------------------------------
// adrCandidatesFromFindings
// ---------------------------------------------------------------------------

test('adrCandidatesFromFindings: only open/planned, sorted by impact desc', () => {
  const findings = [
    { slug: 'a', title: 'A', status: 'resolved', impact: 9, category: 'security' },
    { slug: 'b', title: 'B', status: 'open', impact: 3, category: 'tech-debt' },
    { slug: 'c', title: 'C', status: 'planned', impact: 8, category: 'performance' },
    { slug: 'd', title: 'D', status: 'wontfix', impact: 5, category: 'dx' }
  ];
  const out = adrCandidatesFromFindings(findings);
  assert.deepEqual(out.map((f) => f.slug), ['c', 'b']);
  assert.equal(out[0].impact, 8);
});

test('adrCandidatesFromFindings: empty / null safe', () => {
  assert.deepEqual(adrCandidatesFromFindings([]), []);
  assert.deepEqual(adrCandidatesFromFindings(null), []);
});

// ---------------------------------------------------------------------------
// collectCloseChecklist — the core
// ---------------------------------------------------------------------------

test('collectCloseChecklist: quiet when everything empty', () => {
  const cl = collectCloseChecklist({});
  assert.equal(cl.quiet, true);
  assert.equal(cl.commit, null);
  assert.deepEqual(cl.digest, []);
  assert.equal(cl.counts.changed, 0);
});

test('collectCloseChecklist: dedupes digest, filters _None_ leases, populates counts', () => {
  const cl = collectCloseChecklist({
    branch: 'feature/p2-wave',
    actor: 'codex',
    digestLines: ['- **Decided:** X', '- **Decided:** X', '- **Memory:** Y'],
    leases: [
      { target: '_None_', lockedBy: '' },
      { target: 'lib/auth.ts', lockedBy: 'codex', until: '2026-07-18' }
    ],
    findings: [{ slug: 'f1', title: 'Leaky', status: 'open', impact: 4, category: 'security' }],
    learnCandidates: [
      { query: 'how does auth work', used: ['lib/auth.ts'], uses: 2 },
      { query: '   ', used: [] } // dropped: blank query
    ],
    status: { entries: [{ path: 'lib/auth.ts', staged: true, untracked: false }], diffStat: '1 file' }
  });
  assert.equal(cl.quiet, false);
  assert.deepEqual(cl.digest, ['- **Decided:** X', '- **Memory:** Y']); // deduped
  assert.equal(cl.openLeases.length, 1); // _None_ filtered
  assert.equal(cl.adrCandidates.length, 1);
  assert.equal(cl.learnCandidates.length, 1); // blank dropped
  assert.ok(cl.commit);
  assert.equal(cl.counts.digest, 2);
  assert.equal(cl.counts.leases, 1);
  assert.equal(cl.counts.adrCandidates, 1);
  assert.equal(cl.counts.learnCandidates, 1);
  assert.equal(cl.counts.changed, 1);
  assert.equal(cl.counts.staged, 1);
});

test('collectCloseChecklist: dirty tree alone is enough to be non-quiet', () => {
  const cl = collectCloseChecklist({
    status: { entries: [{ path: 'x.mjs', staged: false, untracked: true }] }
  });
  assert.equal(cl.quiet, false);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('renderChecklist: quiet → minimal note; populated → all sections', () => {
  const quiet = renderChecklist(collectCloseChecklist({}));
  assert.match(quiet, /Nothing to close out/);

  const full = renderChecklist(collectCloseChecklist({
    digestLines: ['- **Decided:** ship it'],
    leases: [{ target: 'lib/a.ts', lockedBy: 'me' }],
    findings: [{ slug: 'f', title: 'T', status: 'open', impact: 1, category: 'dx' }],
    learnCandidates: [{ query: 'q', used: ['a.ts'], uses: 1 }],
    status: { entries: [{ path: 'lib/a.ts', staged: true }], diffStat: '' }
  }));
  assert.match(full, /## Session digest/);
  assert.match(full, /## Open leases \(1\)/);
  assert.match(full, /ADR candidates/);
  assert.match(full, /brain:learn candidates \(1\)/);
  assert.match(full, /Commit suggestion \(SUGGESTION only/);
  assert.match(full, /never stages or commits/);
});

test('renderSessionLog: has a dated close header + suggestion marked suggestion-only', () => {
  const log = renderSessionLog(
    collectCloseChecklist({ status: { entries: [{ path: 'a.mjs', staged: true }] } }),
    { timestamp: '2026-07-17T10:00:00.000Z' }
  );
  assert.match(log, /^## close 2026-07-17T10:00:00\.000Z/);
  assert.match(log, /suggestion only/i);
});

// ---------------------------------------------------------------------------
// CLI sanity (spawn) — cheap, no heavy eval
// ---------------------------------------------------------------------------

test('CLI: --json --dry-run emits parseable JSON, writes nothing', () => {
  const r = spawnSync('node', [CLOSE_SCRIPT, '--json', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim()[0], '{');
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.sessionLog, null);
  assert.ok('quiet' in parsed);
  assert.ok(parsed.counts);
});

test('CLI: --help exits 0 and prints usage', () => {
  const r = spawnSync('node', [CLOSE_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});
