import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Pure exports — importing the script must NOT run its CLI (isMain guard).
import { summarizeGate, needsEvalGate, evalVerdictOk } from '../scripts/brain-improve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', 'scripts');
const AUDIT_SCRIPT = path.join(scriptsDir, 'brain-audit.mjs');
const IMPROVE_SCRIPT = path.join(scriptsDir, 'brain-improve.mjs');

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-improve-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 1;\n');
  return cwd;
}

function runAudit(cwd, args) {
  return spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}
function runImprove(cwd, args) {
  return spawnSync(process.execPath, [IMPROVE_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}
function readFinding(cwd, slug) {
  return fs.readFileSync(path.join(cwd, '.project-brain', 'findings', `${slug}.md`), 'utf8');
}

function addFinding(cwd, title, extra = []) {
  const r = runAudit(cwd, ['add', '--title', title, '--category', 'correctness', '--sources', 'src.mjs', '--body', 'desc', ...extra]);
  assert.equal(r.status, 0, r.stderr);
}

// ---------------------------------------------------------------------------
// reconcile: staleness lifecycle (reuses brain-explain evaluateExplainers/hashSource)
// ---------------------------------------------------------------------------

test('reconcile: fresh when cited sources are unchanged', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug A');
  const r = runImprove(cwd, ['reconcile', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.resolved.length, 0);
  assert.equal(out.stale.length, 0);
});

test('reconcile: resolves a finding when its only cited source is deleted', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug B');
  fs.rmSync(path.join(cwd, 'src.mjs'));
  const r = runImprove(cwd, ['reconcile', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].slug, 'bug-b');
  assert.match(readFinding(cwd, 'bug-b'), /status: resolved/);
});

test('reconcile: changed (not deleted) source is surfaced as stale, not auto-resolved', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug C');
  fs.writeFileSync(path.join(cwd, 'src.mjs'), 'export const x = 999;\n');
  const r = runImprove(cwd, ['reconcile', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.resolved.length, 0);
  assert.equal(out.stale.length, 1);
  assert.equal(out.stale[0].slug, 'bug-c');
  assert.match(readFinding(cwd, 'bug-c'), /status: open/); // unchanged
});

test('reconcile --dry-run does not mutate the finding', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug D');
  fs.rmSync(path.join(cwd, 'src.mjs'));
  const r = runImprove(cwd, ['reconcile', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).resolved.length, 1); // would resolve
  assert.match(readFinding(cwd, 'bug-d'), /status: open/); // but file untouched
});

// ---------------------------------------------------------------------------
// plan (offline path — no --enrich, so no embedder/store needed)
// ---------------------------------------------------------------------------

test('plan without --enrich writes an improve-plan record from the finding', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug E', ['--symbols', 'foo', '--module', 'lib/x']);
  const r = runImprove(cwd, ['plan', 'bug-e']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.project-brain\/plans\/improve-bug-e\.md/);

  const text = fs.readFileSync(path.join(cwd, '.project-brain', 'plans', 'improve-bug-e.md'), 'utf8');
  assert.match(text, /^type: improve-plan$/m);
  assert.match(text, /finding: bug-e/);
  assert.match(text, /# Improvement plan: Bug E/);
  assert.match(text, /## Work packages/);
  assert.match(text, /Not enriched/); // hint when --enrich is omitted
});

test('plan errors clearly for an unknown finding slug', () => {
  const cwd = makeRepo();
  const r = runImprove(cwd, ['plan', 'does-not-exist']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /finding not found/);
});

test('plan --json reports the planned files and package count', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug F');
  const r = runImprove(cwd, ['plan', 'bug-f', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.finding, 'bug-f');
  assert.equal(out.slug, 'improve-bug-f');
  assert.equal(out.enriched, false);
  assert.ok(out.files.includes('src.mjs'));
});

test('plan flips the source finding open → planned', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug G');
  assert.match(readFinding(cwd, 'bug-g'), /status: open/);
  runImprove(cwd, ['plan', 'bug-g']);
  assert.match(readFinding(cwd, 'bug-g'), /status: planned/);
});

// ---------------------------------------------------------------------------
// status / next — the loop primitive
// ---------------------------------------------------------------------------

test('status reports an empty backlog', () => {
  const cwd = makeRepo();
  const r = runImprove(cwd, ['status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.findings, 0);
  assert.match(s.next, /audit run|find more/);
});

test('next plans the highest-impact open finding and flips it to planned', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Low bug', ['--impact', '2']);
  addFinding(cwd, 'High bug', ['--impact', '5']);
  const r = runImprove(cwd, ['next', '--no-enrich', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.step, 'planned');
  assert.equal(out.finding, 'high-bug');       // highest impact picked first
  assert.equal(out.remainingOpen, 1);
  assert.match(readFinding(cwd, 'high-bug'), /status: planned/);
  assert.match(readFinding(cwd, 'low-bug'), /status: open/);
});

test('next reports the execute step once everything open is planned', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Only bug');
  runImprove(cwd, ['next', '--no-enrich']);    // plans it → planned
  const r = runImprove(cwd, ['next', '--no-enrich', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).step, 'execute');
});

test('next reports the audit step on an empty backlog', () => {
  const cwd = makeRepo();
  const r = runImprove(cwd, ['next', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).step, 'audit');
});

test('status counts planned findings and plans after next', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Bug Z');
  runImprove(cwd, ['next', '--no-enrich']);
  const s = JSON.parse(runImprove(cwd, ['status', '--json']).stdout);
  assert.equal(s.planned, 1);
  assert.equal(s.plans, 1);
});

// ---------------------------------------------------------------------------
// summarizeGate — the review aggregation logic, as a PURE function (fixtures,
// no real guard/verify/eval needed). This is where the gate verdict lives.
// ---------------------------------------------------------------------------

test('summarizeGate passes when guard + verify pass and no eval gate is required', () => {
  const r = summarizeGate({
    guard: { ran: true, ok: true },
    verify: { ran: true, ok: true },
    evalCompare: { required: false }
  });
  assert.equal(r.pass, true);
  // eval gate is reported as skipped when not required
  assert.equal(r.reasons.find(x => x.gate === 'eval:compare').status, 'skipped');
});

test('summarizeGate fails when guard fails', () => {
  const r = summarizeGate({
    guard: { ran: true, ok: false, detail: 'boom' },
    verify: { ran: true, ok: true },
    evalCompare: { required: false }
  });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.find(x => x.gate === 'guard').status, 'fail');
});

test('summarizeGate fails when verify (drift) fails', () => {
  const r = summarizeGate({
    guard: { ran: true, ok: true },
    verify: { ran: true, ok: false },
    evalCompare: { required: false }
  });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.find(x => x.gate === 'verify').status, 'fail');
});

test('summarizeGate fails a required eval gate that could not run (no reports = no proof)', () => {
  const r = summarizeGate({
    guard: { ran: true, ok: true },
    verify: { ran: true, ok: true },
    evalCompare: { required: true, ran: false }
  });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.find(x => x.gate === 'eval:compare').status, 'fail');
});

test('summarizeGate passes when a required eval gate ran and cleared', () => {
  const r = summarizeGate({
    guard: { ran: true, ok: true },
    verify: { ran: true, ok: true },
    evalCompare: { required: true, ran: true, ok: true, detail: 'no regression' }
  });
  assert.equal(r.pass, true);
  assert.equal(r.reasons.find(x => x.gate === 'eval:compare').status, 'pass');
});

test('summarizeGate fails when a required eval gate ran and detected a regression', () => {
  const r = summarizeGate({
    guard: { ran: true, ok: true },
    verify: { ran: true, ok: true },
    evalCompare: { required: true, ran: true, ok: false, detail: 'hit@K regressed' }
  });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.find(x => x.gate === 'eval:compare').status, 'fail');
});

// ---------------------------------------------------------------------------
// needsEvalGate — eval gate routing (category + retrieval-core touch)
// ---------------------------------------------------------------------------

test('needsEvalGate: performance plan touching scripts/retrieval.mjs requires the eval gate', () => {
  assert.equal(needsEvalGate({ category: 'performance', body: 'fix in `scripts/retrieval.mjs`' }), true);
});

test('needsEvalGate: correctness plan touching scripts/retrieval.mjs requires the eval gate', () => {
  assert.equal(needsEvalGate({ category: 'correctness', module: 'scripts/retrieval.mjs', body: '' }), true);
});

test('needsEvalGate: performance plan NOT touching retrieval is exempt', () => {
  assert.equal(needsEvalGate({ category: 'performance', body: 'fix in scripts/other.mjs' }), false);
});

test('needsEvalGate: non-retrieval category touching retrieval is exempt', () => {
  assert.equal(needsEvalGate({ category: 'documentation', body: 'scripts/retrieval.mjs' }), false);
});

// ---------------------------------------------------------------------------
// evalVerdictOk — paired-bootstrap verdict → gate pass/fail (refuses regressions)
// ---------------------------------------------------------------------------

test('evalVerdictOk: significant negative delta is a regression (fails the gate)', () => {
  const v = evalVerdictOk({ hit: { delta: -0.4, significant: true, ci95: [-0.7, -0.1] }, mrr: { delta: 0, significant: false }, verdict: 'X' });
  assert.equal(v.ok, false);
  assert.equal(v.regressed, true);
});

test('evalVerdictOk: significant improvement clears the gate', () => {
  const v = evalVerdictOk({ hit: { delta: 0.4, significant: true, ci95: [0.1, 0.7] }, mrr: { delta: 0, significant: false }, verdict: 'Y' });
  assert.equal(v.ok, true);
  assert.equal(v.regressed, false);
});

test('evalVerdictOk: within-noise result clears the gate (no demand for a win)', () => {
  const v = evalVerdictOk({ hit: { delta: -0.1, significant: false }, mrr: { delta: 0.1, significant: false }, verdict: 'Z' });
  assert.equal(v.ok, true);
});

test('evalVerdictOk: missing report fails the gate', () => {
  assert.equal(evalVerdictOk(null).ok, false);
});

// ---------------------------------------------------------------------------
// execute — DEFAULT is a dry preview: it materializes packages and prints what
// it WOULD spawn, but spawns NOTHING (no worktrees, no orchestration).
// ---------------------------------------------------------------------------

function planNoEnrich(cwd, findingSlug) {
  const r = runImprove(cwd, ['plan', findingSlug]);
  assert.equal(r.status, 0, r.stderr);
}

test('execute without --run is a dry preview: prints the plan, spawns nothing, exits 0', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Exec bug');
  planNoEnrich(cwd, 'exec-bug');
  const r = runImprove(cwd, ['execute', 'improve-exec-bug']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY PREVIEW/);
  assert.match(r.stdout, /Materialized \d+ work-package/);
  assert.match(r.stdout, /brain-worktree\.mjs spawn/); // shows what it WOULD spawn
  // The materialized work-package file exists...
  assert.ok(fs.existsSync(path.join(cwd, '.project-brain', 'work-packages', 'improve-exec-bug.md')));
  // ...but NOTHING was spawned: no worktrees, no orchestration plans on disk.
  assert.ok(!fs.existsSync(path.join(cwd, '.worktrees')), 'dry preview must not create worktrees');
  assert.ok(!fs.existsSync(path.join(cwd, '.project-brain', 'orchestration')), 'dry preview must not run the orchestrator');
});

test('execute --json (dry) reports mode=dry with wouldSpawn and no spawned flag', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Exec json');
  planNoEnrich(cwd, 'exec-json');
  const r = runImprove(cwd, ['execute', 'improve-exec-json', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'dry');
  assert.equal(out.plan, 'improve-exec-json');
  assert.match(out.wouldSpawn, /brain-worktree\.mjs spawn/);
  assert.ok(!('spawned' in out), 'dry preview must not claim anything was spawned');
  assert.ok(!fs.existsSync(path.join(cwd, '.worktrees')));
});

test('execute accepts the bare finding slug (resolves to improve-<slug>)', () => {
  const cwd = makeRepo();
  addFinding(cwd, 'Exec bare');
  planNoEnrich(cwd, 'exec-bare');
  const r = runImprove(cwd, ['execute', 'exec-bare']); // no improve- prefix
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /improve-exec-bare/);
});

test('execute errors clearly for an unknown plan slug', () => {
  const cwd = makeRepo();
  const r = runImprove(cwd, ['execute', 'no-such-plan']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /plan not found/);
});
