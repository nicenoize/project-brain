/**
 * Control-Room daemon tests (scripts/brain-serve.mjs, strategy §M2.75).
 *
 * The M2.75 security model is mandatory, so every point gets its own test:
 * token gating (401 on missing/wrong, constant-time compare), Origin/Host
 * validation (403, DNS-rebinding defense), no CORS headers, the method
 * matrix (writes confined to POST /api/runners/start|stop, 405 elsewhere),
 * and the strict 127.0.0.1 bind. The runner write API block additionally
 * proves: runner command resolution is config-only (body injection inert),
 * the brief gate blocks unacknowledged starts over foreign leases without
 * spawning, every start/stop leaves an audit line in events.jsonl, stop
 * really kills the process, and no zombie children survive the run.
 *
 * Fixture: a mkdtemp git repo with a seeded .project-brain (active_state.md
 * with one workstream + one lease, events.jsonl, one decision record).
 * BRAIN_ROOT is set BEFORE the dynamic import of brain-serve.mjs so that
 * common.mjs/active-state.mjs resolve into the fixture, and the handler is
 * mounted on an ephemeral 127.0.0.1 port via the exported startServer().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';

// --- fixture repo, created before brain-serve (→ common.mjs) is imported ---

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-serve-'));
process.env.BRAIN_ROOT = FIXTURE;
// The runner tests manage BRAIN_RUNNER_CMD themselves — an ambient value from
// the invoking shell must not leak into the "unconfigured" assertions.
delete process.env.BRAIN_RUNNER_CMD;
// Answer-endpoint determinism: /api/brief's lease advisory must not become a
// self-held warn because of an ambient actor, and the pack preview must take
// the deterministic degraded path (provider 'none' → packPreview null +
// packWarning) instead of probing/loading an embedding stack mid-test.
delete process.env.BRAIN_ACTOR;
process.env.BRAIN_INDEX_PROVIDER = 'none';

const BRAIN = path.join(FIXTURE, '.project-brain');
fs.mkdirSync(path.join(BRAIN, 'decisions'), { recursive: true });

fs.writeFileSync(path.join(BRAIN, 'active_state.md'), `# Active State

## Workstreams

| task_id | owner | tool | project | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- | --- |
| T-42 | seebo | claude | demo | feature/42-serve | scripts/** | active |

## File Leases

| path glob or file | project | locked_by | until | notes |
| --- | --- | --- | --- | --- |
| scripts/** | demo | claude-a | 2099-01-01T00:00 | serve work |

## Blockers

- none

## Overlaps

- none
`);

fs.writeFileSync(path.join(BRAIN, 'events.jsonl'),
  '{"type":"lease-acquired","task":"T-42"}\n' +
  '{"type":"workstream-started","task":"T-42"}\n' +
  'not-json-should-be-skipped\n');

// `module: demo` links this ADR to the modules/demo.md record below — that is
// exactly how the real records carry the relation (/api/map, /api/why).
fs.writeFileSync(path.join(BRAIN, 'decisions', '0001-test-decision.md'), `---
title: Bind the daemon to loopback only
status: canonical
layer: decision
module: demo
---

# Bind the daemon to loopback only

## Context

A daemon on 0.0.0.0 is reachable from the LAN.

## Decision

Bind strictly to 127.0.0.1 and gate every API call on a per-session token.
`);

// Tiny git repo so the intel endpoints have history.
execSync('git init --quiet', { cwd: FIXTURE });
execSync('git config user.email t@example.com', { cwd: FIXTURE });
execSync('git config user.name Tester', { cwd: FIXTURE });
fs.writeFileSync(path.join(FIXTURE, 'app.mjs'), 'export const x = 1;\n');
fs.writeFileSync(path.join(FIXTURE, 'lib.mjs'), 'export const y = 2;\n');
execSync('git add .', { cwd: FIXTURE });
execSync('git -c commit.gpgsign=false commit -q -m "feat: seed"', { cwd: FIXTURE });
fs.appendFileSync(path.join(FIXTURE, 'app.mjs'), 'export const z = 3;\n');
execSync('git add .', { cwd: FIXTURE });
execSync('git -c commit.gpgsign=false commit -q -m "fix: touch app"', { cwd: FIXTURE });

// --- Doc-Navigator fixture (additive: no existing assertion depends on it) ---
// One COMMITTED module record that claims app.mjs/lib.mjs, plus a later commit
// touching app.mjs → the record provably lags the code (the /api/map staleness
// signal). Explicit commit dates because git's ISO dates have 1s resolution and
// same-second commits would tie. Two UNCOMMITTED records isolate the age path:
// with no commit of their own, the record's date falls back to its mtime.
fs.mkdirSync(path.join(BRAIN, 'modules'), { recursive: true });
fs.mkdirSync(path.join(FIXTURE, 'ui'), { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'ui', 'panel.jsx'), 'export const Panel = () => null;\n');
fs.writeFileSync(path.join(BRAIN, 'modules', 'demo.md'), `---
title: Demo module
status: canonical
layer: architecture
module: demo
date: 2026-01-01
---

# Demo module

The demo module owns \`app.mjs\` and \`lib.mjs\`; see [[0001-test-decision]].

Prose mentioning brain-work must not be mistaken for a path.
`);
const commitAt = (iso, msg) => execSync(`git -c commit.gpgsign=false commit -q -m "${msg}"`, {
  cwd: FIXTURE,
  env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }
});
execSync('git add .project-brain/modules ui', { cwd: FIXTURE });
commitAt('2026-01-01T00:00:00+00:00', 'docs: seed the demo module record');
fs.appendFileSync(path.join(FIXTURE, 'app.mjs'), 'export const drift = 4;\n');
execSync('git add app.mjs', { cwd: FIXTURE });
commitAt('2026-06-01T00:00:00+00:00', 'feat: drift app.mjs after the doc was written');

// Uncommitted: mtime IS the record date. `globs:` frontmatter wins over the
// body-derived paths and points at nothing in this repo → no code signal, so
// only the age threshold can flip these.
fs.writeFileSync(path.join(BRAIN, 'modules', 'fresh.md'), `---
title: Fresh module
module: fresh
globs: docs/**
---

# Fresh module

Written just now.
`);
fs.writeFileSync(path.join(BRAIN, 'modules', 'aged.md'), `---
title: Aged module
module: aged
globs: vendor/**
---

# Aged module

Nobody has touched this in a long time.
`);
const AGED_DAYS = 200;
const agedAt = new Date(Date.now() - AGED_DAYS * 86_400_000);
fs.utimesSync(path.join(BRAIN, 'modules', 'aged.md'), agedAt, agedAt);

// Import AFTER the env override so ROOT/ACTIVE_STATE resolve into the fixture.
const serve = await import('../scripts/brain-serve.mjs');

const TOKEN = 'f'.repeat(64);
let daemon; // { server, port, token, close }
let base;

before(async () => {
  daemon = await serve.startServer({ root: FIXTURE, port: 0, token: TOKEN });
  base = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  await daemon.close();
  fs.rmSync(FIXTURE, { recursive: true, force: true });
});

/** Raw client so we can spoof Host/Origin headers and send raw bodies. */
function request(pathname, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: daemon.port,
      path: pathname,
      method,
      headers
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

/** JSON POST with the session token (headers can override/extend). */
function post(pathname, obj, headers = {}) {
  return request(pathname, {
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json', ...headers },
    body: typeof obj === 'string' ? obj : JSON.stringify(obj)
  });
}

// ---------------------------------------------------------------------------
// security model — (a) loopback bind
// ---------------------------------------------------------------------------

test('security (a): server binds only 127.0.0.1', () => {
  const addr = daemon.server.address();
  assert.equal(addr.address, '127.0.0.1');
  assert.equal(addr.port, daemon.port);
});

// ---------------------------------------------------------------------------
// security model — (b) session token, constant-time compare
// ---------------------------------------------------------------------------

test('security (b): missing token → 401', async () => {
  const r = await request('/api/state');
  assert.equal(r.status, 401);
  assert.match(r.body, /unauthorized/);
});

test('security (b): wrong token → 401', async () => {
  const r = await request('/api/state', { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
  assert.equal(r.status, 401);
  // Same-length wrong token also rejected via ?token=
  const q = await request(`/api/state?token=${'1'.repeat(64)}`);
  assert.equal(q.status, 401);
});

test('security (b): tokenEquals is length-safe and exact', () => {
  assert.equal(serve.tokenEquals(TOKEN, TOKEN), true);
  assert.equal(serve.tokenEquals(TOKEN.slice(0, 10), TOKEN), false);
  assert.equal(serve.tokenEquals('', TOKEN), false);
  assert.equal(serve.tokenEquals(undefined, TOKEN), false);
});

test('security (b): ?token= query param is accepted', async () => {
  const r = await request(`/api/state?token=${TOKEN}`);
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// security model — (c) Origin / Host validation (DNS-rebinding defense)
// ---------------------------------------------------------------------------

test('security (c): evil Origin → 403 even with a valid token', async () => {
  const r = await request('/api/state', { headers: { ...bearer, Origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /cross-origin/);
});

test('security (c): local Origin on the bound port is accepted', async () => {
  const r = await request('/api/state', { headers: { ...bearer, Origin: base } });
  assert.equal(r.status, 200);
  const localhost = await request('/api/state', { headers: { ...bearer, Origin: `http://localhost:${daemon.port}` } });
  assert.equal(localhost.status, 200);
});

test('security (c): evil Host header → 403 (DNS rebinding)', async () => {
  const r = await request('/api/state', { headers: { ...bearer, Host: 'evil.example' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /Host/);
  // https-style host with port, still non-local → 403
  const r2 = await request('/', { headers: { Host: 'evil.example:80' } });
  assert.equal(r2.status, 403);
});

test('security (c): checkOrigin/checkHost helpers', () => {
  assert.equal(serve.checkOrigin(undefined), true, 'absent Origin allowed (curl)');
  assert.equal(serve.checkOrigin('http://evil.example'), false);
  assert.equal(serve.checkOrigin('https://127.0.0.1:4100', 4100), false, 'https origin is not the served page');
  assert.equal(serve.checkOrigin('http://127.0.0.1:4100', 4100), true);
  assert.equal(serve.checkOrigin('http://localhost:4100', 4100), true);
  assert.equal(serve.checkOrigin('http://127.0.0.1:9999', 4100), false, 'other local port rejected when port pinned');
  assert.equal(serve.checkHost('127.0.0.1:4100'), true);
  assert.equal(serve.checkHost('localhost:4100'), true);
  assert.equal(serve.checkHost('evil.example'), false);
  assert.equal(serve.checkHost(''), false, 'missing Host fails closed');
});

// ---------------------------------------------------------------------------
// security model — (d) read-only API, (e) no CORS
// ---------------------------------------------------------------------------

test('security (d): non-GET to the API → 405 (no execute/command endpoints)', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await request('/api/state', { method, headers: bearer });
    assert.equal(r.status, 405, `${method} must be rejected`);
  }
});

test('security (e): no CORS headers on any response', async () => {
  const ok = await request('/api/state', { headers: bearer });
  const denied = await request('/api/state');
  const page = await request('/');
  for (const r of [ok, denied, page]) {
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-methods'], undefined);
    assert.equal(r.headers['access-control-allow-headers'], undefined);
  }
});

// ---------------------------------------------------------------------------
// API happy paths
// ---------------------------------------------------------------------------

test('/api/state returns the seeded workstream + lease with freshness metadata', async () => {
  const r = await request('/api/state', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.workstreams.length, 1);
  assert.equal(body.workstreams[0].taskId, 'T-42');
  assert.equal(body.workstreams[0].status, 'active');
  assert.equal(body.leases.length, 1);
  assert.equal(body.leases[0].target, 'scripts/**');
  assert.equal(typeof body.state_age, 'number');
  assert.ok(body.state_age >= 0);
  assert.equal(body.stale_warning, null, 'freshly seeded state is not stale');
});

test('/api/events tails events.jsonl, skips malformed lines, honors limit', async () => {
  const all = await request('/api/events', { headers: bearer });
  assert.equal(all.status, 200);
  const body = JSON.parse(all.body);
  assert.equal(body.events.length, 2, 'malformed line skipped');
  assert.equal(body.events[0].type, 'lease-acquired');
  assert.equal(typeof body.state_age, 'number');

  const limited = await request('/api/events?limit=1', { headers: bearer });
  const lb = JSON.parse(limited.body);
  assert.equal(lb.events.length, 1);
  assert.equal(lb.events[0].type, 'workstream-started', 'limit takes the tail');
});

test('/api/intel/* compute from the fixture git history', async () => {
  const hs = JSON.parse((await request('/api/intel/hotspots', { headers: bearer })).body);
  assert.ok(hs.files.some((f) => f.file === 'app.mjs'), 'hotspots include committed file');
  assert.equal(hs.state_age, 0, 'live-computed intel reports age 0');

  const cc = await request('/api/intel/co-change', { headers: bearer });
  assert.equal(cc.status, 200);
  assert.ok(Array.isArray(JSON.parse(cc.body).pairs));

  const own = JSON.parse((await request('/api/intel/ownership', { headers: bearer })).body);
  assert.ok(own.files.some((f) => f.path === 'app.mjs'));
  assert.equal(own.files[0].topAuthors[0].author, 'Tester');
});

test('/api/records lists the seeded decision with its frontmatter title', async () => {
  const r = await request('/api/records?type=decision', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].title, 'Bind the daemon to loopback only');
  assert.match(body.records[0].file, /decisions\/0001-test-decision\.md$/);
  assert.equal(typeof body.state_age, 'number');

  const empty = JSON.parse((await request('/api/records?type=grill', { headers: bearer })).body);
  assert.deepEqual(empty.records, [], 'absent record dir → empty list, not an error');

  const bad = await request('/api/records?type=shell-command', { headers: bearer });
  assert.equal(bad.status, 400, 'unknown type is rejected, never treated as a path');
});

test('/api/meta carries version, root, provider availability and state_age', async () => {
  const r = await request('/api/meta', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  assert.equal(body.root, FIXTURE);
  assert.equal(body.port, daemon.port);
  assert.equal(typeof body.provider.name, 'string');
  assert.equal(typeof body.provider.available, 'boolean');
  assert.equal(typeof body.state_age, 'number', '/api/meta carries state_age');
});

test('/api/state does not create active_state.md when it is absent (read-only)', async () => {
  const stateFile = path.join(BRAIN, 'active_state.md');
  const saved = fs.readFileSync(stateFile, 'utf8');
  fs.rmSync(stateFile);
  try {
    const r = await request('/api/state', { headers: bearer });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.deepEqual(body.workstreams, []);
    assert.equal(body.state_age, null);
    assert.match(body.stale_warning, /not found/);
    assert.equal(fs.existsSync(stateFile), false, 'the API must never create brain state');
  } finally {
    fs.writeFileSync(stateFile, saved);
  }
});

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

test('/api/stream requires the token', async () => {
  const denied = await request('/api/stream');
  assert.equal(denied.status, 401);
});

test('/api/stream with token opens an event-stream', async () => {
  await new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: daemon.port,
      path: `/api/stream?token=${TOKEN}`
    }, (res) => {
      try {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS on SSE either');
      } catch (error) { req.destroy(); return reject(error); }
      res.once('data', (chunk) => {
        try { assert.match(String(chunk), /: connected/); } catch (error) { req.destroy(); return reject(error); }
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => {}); // destroy() races the socket teardown
  });
});

// ---------------------------------------------------------------------------
// static status page
// ---------------------------------------------------------------------------

test('status page is served at / without a token and leaks no secrets', async () => {
  const r = await request('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  // Either the built Control Room (ui/dist present in the package checkout)
  // or the built-in fallback status page — both are valid; neither may leak.
  assert.match(r.body, /Control Room|project-brain/);
  assert.ok(!r.body.includes(TOKEN), 'the public page must not embed the session token');
});

test('unknown /api endpoint → 404 (with token), never falls through to static', async () => {
  const r = await request('/api/does-not-exist', { headers: bearer });
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /<html/i);
});

// ---------------------------------------------------------------------------
// freshness + frontmatter helpers
// ---------------------------------------------------------------------------

test('freshness: mtime-based age and stale warning past the threshold', () => {
  const f = path.join(FIXTURE, 'fresh.txt');
  fs.writeFileSync(f, 'x');
  const fresh = serve.freshness(f, Date.now(), 3600);
  assert.equal(fresh.stale_warning, null);
  assert.ok(fresh.state_age <= 5);

  const stale = serve.freshness(f, Date.now() + 100 * 3600 * 1000, 3600);
  assert.match(stale.stale_warning, /stale/);

  const missing = serve.freshness(path.join(FIXTURE, 'nope.txt'));
  assert.equal(missing.state_age, null);
  assert.match(missing.stale_warning, /not found/);
});

test('frontmatterTitle: frontmatter wins, heading fallback, quotes stripped', () => {
  assert.equal(serve.frontmatterTitle('---\ntitle: "Quoted Title"\n---\n# Other'), 'Quoted Title');
  assert.equal(serve.frontmatterTitle('# Heading Only\n\nbody'), 'Heading Only');
  assert.equal(serve.frontmatterTitle(''), '');
});

// ---------------------------------------------------------------------------
// answer endpoints (/api/changed, /api/risk, /api/next, /api/brief) — these
// run BEFORE the runner section because they assert against the ORIGINAL
// seeded active_state.md (scripts/** leased by claude-a), which the runner
// tests reseed.
// ---------------------------------------------------------------------------

test('answer endpoints: all five are token-gated (401 without)', async () => {
  for (const p of ['/api/changed', '/api/risk', '/api/next', '/api/brief', '/api/blast']) {
    const r = await request(p);
    assert.equal(r.status, 401, `${p} must require the session token`);
  }
});

test('/api/changed reflects staged + unstaged files and the branch', async () => {
  fs.writeFileSync(path.join(FIXTURE, 'staged.mjs'), 'export const s = 1;\n');
  execSync('git add staged.mjs', { cwd: FIXTURE });
  fs.appendFileSync(path.join(FIXTURE, 'lib.mjs'), '// dirty\n');
  try {
    const r = await request('/api/changed', { headers: bearer });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.staged) && body.staged.includes('staged.mjs'), 'staged file listed');
    assert.ok(Array.isArray(body.unstaged) && body.unstaged.includes('lib.mjs'), 'unstaged file listed');
    assert.equal(typeof body.branch, 'string');
    assert.ok(body.branch.length > 0, 'current branch resolved');
    assert.equal(body.state_age, 0, 'live-computed → age 0');
    assert.equal(body.stale_warning, null);
  } finally {
    execSync('git reset -q -- staged.mjs', { cwd: FIXTURE });
    fs.rmSync(path.join(FIXTURE, 'staged.mjs'), { force: true });
    execSync('git checkout -q -- lib.mjs', { cwd: FIXTURE });
  }
});

test('/api/risk with explicit files returns score + factors + calibration shape', async () => {
  const r = await request('/api/risk?files=app.mjs,lib.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.files, ['app.mjs', 'lib.mjs']);
  assert.equal(typeof body.score, 'number');
  assert.ok(body.score >= 0 && body.score <= 10);
  assert.ok(Array.isArray(body.factors) && body.factors.length >= 2, 'weighted factors present');
  for (const f of body.factors) {
    assert.equal(typeof f.name, 'string');
    assert.equal(typeof f.weight, 'number');
    assert.equal(typeof f.raw, 'number');
    assert.equal(typeof f.contribution, 'number');
    assert.equal(typeof f.evidence, 'string');
  }
  // Leases exist in the fixture → the lease-conflicts factor must be wired.
  assert.ok(body.factors.some((f) => f.name === 'lease-conflicts'), 'lease factor wired from active-state');
  assert.equal(body.provenance.basis, 'measured');
  assert.equal(body.provenance.source, 'git-log');
  assert.equal(typeof body.provenance.window.commits, 'number');
  // Calibration: the fixture has 2 young commits → likely all censored, so
  // assert the SHAPE and the honesty note, never a value (per the plan).
  assert.ok(body.calibration, 'calibration block present');
  assert.ok(body.calibration.auc === null || typeof body.calibration.auc === 'number');
  assert.equal(typeof body.calibration.commits, 'number');
  assert.ok(Array.isArray(body.calibration.quartiles));
  for (const q of body.calibration.quartiles) {
    assert.equal(typeof q.q, 'string');
    assert.equal(typeof q.defectRate, 'number');
  }
  assert.equal(typeof body.calibration.verdictLine, 'string');
  assert.equal(body.calibration.note, 'in-repo self-calibration, not a cross-repo benchmark');
  assert.equal(body.state_age, 0);
});

test('/api/risk caches calibration per HEAD (second call never re-runs calibrateRisk)', async () => {
  await request('/api/risk?files=app.mjs', { headers: bearer });
  const first = serve.riskCalibrationStats();
  assert.ok(first.computes >= 1, 'calibration ran at least once');
  await request('/api/risk?files=lib.mjs', { headers: bearer });
  const second = serve.riskCalibrationStats();
  assert.equal(second.computes, first.computes, 'same HEAD → cached, not recomputed');
  assert.equal(second.key, first.key);
});

test('/api/risk with no changes and no files → degraded 200, never an error', async () => {
  const r = await request('/api/risk', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.score, null);
  assert.equal(body.reason, 'no-changes');
  assert.deepEqual(body.files, []);
});

test('/api/next returns ≤5 ranked actions, each with an auto|human boundary', async () => {
  const r = await request('/api/next', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.actions));
  assert.ok(body.actions.length >= 1 && body.actions.length <= 5, `1..5 actions, got ${body.actions.length}`);
  for (const a of body.actions) {
    assert.equal(typeof a.command, 'string');
    assert.match(a.command, /^brain:/);
    assert.equal(typeof a.reason, 'string');
    assert.ok(['auto', 'human'].includes(a.boundary), `boundary auto|human, got ${a.boundary}`);
  }
  assert.ok(body.provenance, 'provenance present');
  assert.equal(typeof body.provenance.signals, 'object', 'sensed signals exposed for transparency');
  assert.equal(body.state_age, 0);
});

test('/api/brief surfaces the fixture lease advisory and a safe pack preview', async () => {
  const r = await request('/api/brief?files=scripts/serve-work.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.files, ['scripts/serve-work.mjs']);
  assert.ok(Array.isArray(body.advisories));
  const lease = body.advisories.find((a) => a.kind === 'lease');
  assert.ok(lease, 'the scripts/** lease covers the target file');
  assert.equal(lease.severity, 'conflict', 'foreign lease → conflict severity');
  assert.match(lease.message, /leased by claude-a/);
  assert.equal(lease.target, 'scripts/serve-work.mjs');
  // packPreview: null-or-string, NEVER a 500. With BRAIN_INDEX_PROVIDER=none
  // the deterministic degraded path is null + a warning.
  assert.ok(body.packPreview === null || typeof body.packPreview === 'string');
  if (body.packPreview === null) {
    assert.equal(typeof body.packWarning, 'string', 'a null preview always explains itself');
  }
  assert.equal(body.state_age, 0);
});

test('/api/brief with no target files → empty advisories, still 200', async () => {
  const r = await request('/api/brief', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.files, []);
  assert.deepEqual(body.advisories, []);
});

// ---------------------------------------------------------------------------
// /api/blast — "what breaks if I change this?" (measured ⊕ inferred)
//
// The measured half is import-graph.mjs (JS/TS/MJS/Python/Go/Ruby/PHP/Rust),
// NOT ts-graph — which is why a .mjs fixture can prove a measured edge at all.
// The fixture starts with two .mjs files that import nothing, so the first test
// still exercises the degradation (graphAvailable:false + reason, co-change
// edges still answering); the block further down adds a REAL relative import
// and proves the measured edge appears. The co-change block appends three
// commits — deliberately AFTER every test that asserts on the two seed commits,
// and before the runner section (which does not read git history).
// ---------------------------------------------------------------------------

test('/api/blast on the fixture: 200 with nodes/edges arrays + graphAvailable boolean', async () => {
  const r = await request('/api/blast?files=app.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.files, ['app.mjs']);
  assert.ok(Array.isArray(body.nodes) && Array.isArray(body.edges));
  assert.equal(typeof body.truncated, 'boolean');
  assert.equal(typeof body.graphAvailable, 'boolean');
  // Nothing in the fixture imports anything yet → the scan resolved no edge, so
  // the graph honestly reports itself unavailable and explains why (it no longer
  // means "no TypeScript" — the scan covers every language it supports).
  assert.equal(body.graphAvailable, false);
  assert.equal(typeof body.reason, 'string');
  assert.match(body.reason, /no static import edge resolved/);
  // Coverage is the scan's own numbers, not a TS-file count: files really read,
  // edges really resolved, specifiers that pointed outside the repo, per language.
  assert.equal(body.coverage.resolvedEdges, 0);
  assert.ok(body.coverage.filesScanned >= 2, 'the .mjs sources were scanned, not skipped');
  assert.equal(typeof body.coverage.unresolvedSpecs, 'number');
  assert.equal(typeof body.coverage.byLang, 'object');
  assert.ok(body.coverage.byLang.js >= 2, 'byLang counts the .mjs files as js');
  assert.equal(body.coverage.totalSeeds, 1);
  // Seeds are always node depth 0 with kind 'seed'.
  const seed = body.nodes.find((n) => n.file === 'app.mjs');
  assert.ok(seed, 'the seed file is always a node');
  assert.equal(seed.kind, 'seed');
  assert.equal(seed.depth, 0);
  assert.equal(typeof seed.score, 'number');
  for (const e of body.edges) {
    assert.ok(['imports', 'co-change'].includes(e.kind));
    assert.equal(e.basis, e.kind === 'imports' ? 'measured' : 'inferred');
    assert.equal(typeof e.confidence, 'number');
  }
  assert.equal(body.provenance.basis, 'mixed');
  assert.equal(body.provenance.edgeKinds.imports.startsWith('measured'), true);
  assert.equal(body.provenance.edgeKinds['co-change'].startsWith('inferred'), true);
  assert.equal(body.state_age, 0);
});

test('/api/blast honors explicit ?files= (multi-seed) and caps depth at 3', async () => {
  const multi = await request('/api/blast?files=app.mjs,lib.mjs', { headers: bearer });
  assert.equal(multi.status, 200);
  const body = JSON.parse(multi.body);
  assert.deepEqual(body.files, ['app.mjs', 'lib.mjs']);
  assert.equal(body.coverage.totalSeeds, 2);
  assert.equal(body.nodes.filter((n) => n.kind === 'seed').length, 2);
  assert.equal(body.depth, 2, 'default depth is 2');

  const deep = JSON.parse((await request('/api/blast?files=app.mjs&depth=9', { headers: bearer })).body);
  assert.equal(deep.depth, 3, 'depth is capped at 3');
  const shallow = JSON.parse((await request('/api/blast?files=app.mjs&depth=1', { headers: bearer })).body);
  assert.equal(shallow.depth, 1);
  const garbage = JSON.parse((await request('/api/blast?files=app.mjs&depth=abc', { headers: bearer })).body);
  assert.equal(garbage.depth, 2, 'unparseable depth falls back to the default');
  const zero = JSON.parse((await request('/api/blast?files=app.mjs&depth=0', { headers: bearer })).body);
  assert.equal(zero.depth, 1, 'depth is clamped to at least 1');
});

test('/api/blast rejects an oversized ?files= list (>500) with 400', async () => {
  const many = Array.from({ length: 501 }, (_, i) => `f${i}.mjs`).join(',');
  const r = await request(`/api/blast?files=${many}`, { headers: bearer });
  assert.equal(r.status, 400);
  assert.match(r.body, /too many files/);
});

test('/api/blast with no changes and no files → degraded 200, never an error', async () => {
  const r = await request('/api/blast', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.files, []);
  assert.deepEqual(body.nodes, []);
  assert.deepEqual(body.edges, []);
  assert.equal(body.truncated, false);
  assert.equal(body.reason, 'no-changes');
});

test('/api/blast returns INFERRED co-change edges even without a static graph', async () => {
  // Three commits touching both files → support 3, confidence 1.0, which is
  // exactly the git-intel co-change threshold. This is the every-language
  // fallback: no TS program, but the history still answers the question.
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(FIXTURE, 'feature.mjs'), `export const a${i} = ${i};\n`);
    fs.appendFileSync(path.join(FIXTURE, 'feature.test.mjs'), `// case ${i}\n`);
    execSync('git add feature.mjs feature.test.mjs', { cwd: FIXTURE });
    execSync(`git -c commit.gpgsign=false commit -q -m "feat: pair ${i}"`, { cwd: FIXTURE });
  }
  const r = await request('/api/blast?files=feature.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.graphAvailable, false, 'still no TS graph — this is the fallback path');
  const edge = body.edges.find((e) => e.from === 'feature.mjs' && e.to === 'feature.test.mjs');
  assert.ok(edge, 'co-change partner surfaced from history');
  assert.equal(edge.kind, 'co-change');
  assert.equal(edge.basis, 'inferred', 'history edges are marked inferred, never measured');
  assert.ok(edge.confidence > 0 && edge.confidence <= 1);
  const node = body.nodes.find((n) => n.file === 'feature.test.mjs');
  assert.ok(node, 'the partner is a ranked node');
  assert.equal(node.kind, 'co-change');
  assert.equal(node.depth, 1);
  assert.ok(node.score > 0 && node.score < 1, 'reached nodes score below the seed');
});

test('/api/blast caches adjacency per HEAD (a second query never rebuilds it)', async () => {
  await request('/api/blast?files=feature.mjs', { headers: bearer });
  const first = serve.blastStats();
  assert.ok(first.computes >= 1, 'adjacency built at least once');
  assert.equal(typeof first.key, 'string');
  // Different question, same HEAD → the graph + co-change adjacency is reused.
  await request('/api/blast?files=app.mjs,lib.mjs&depth=3', { headers: bearer });
  const second = serve.blastStats();
  assert.equal(second.computes, first.computes, 'same HEAD → cached, not recomputed');
  assert.equal(second.key, first.key);
});

// ---------------------------------------------------------------------------
// The language-coverage regression: MEASURED edges in a .mjs repo.
//
// This is the whole point of swapping ts-graph for the multi-language import
// scan. Before, this fixture could NEVER produce a measured edge (no .ts/.tsx,
// no `typescript` dep) and /api/blast was history-only. The block below adds a
// REAL relative import between two .mjs files, an import cycle, and enough
// unimported files to bite the /api/graph list caps — then proves each answer.
//
// Everything lands in graphfix/ and is COMMITTED: the per-HEAD graph cache only
// re-scans when HEAD moves, and a clean tree keeps the later fleet assertions
// (dirty counts) exactly as they were.
// ---------------------------------------------------------------------------

const GRAPHFIX_ORPHANS = 25;

/**
 * Seeded from inside the first test of this block, NOT from a before() hook —
 * a hook would run before the whole file and retroactively give the earlier
 * "no measured edges yet" assertions an import graph.
 */
function seedGraphFixture() {
  const dir = path.join(FIXTURE, 'graphfix');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'helper.mjs'), 'export const help = () => 1;\n');
  // The measured edge under test: a plain relative import, resolved exactly.
  fs.writeFileSync(path.join(dir, 'consumer.mjs'),
    "import { help } from './helper.mjs';\nexport const use = () => help();\n");
  // A two-file cycle so /api/graph has a real cycle to report.
  fs.writeFileSync(path.join(dir, 'cycle-a.mjs'), "import './cycle-b.mjs';\nexport const a = 1;\n");
  fs.writeFileSync(path.join(dir, 'cycle-b.mjs'), "import './cycle-a.mjs';\nexport const b = 2;\n");
  // Unimported filler: pushes the orphan list past its cap so `truncated` and
  // `total` can be asserted against a known number instead of a guess.
  for (let i = 0; i < GRAPHFIX_ORPHANS; i++) {
    fs.writeFileSync(path.join(dir, `orphan${String(i).padStart(2, '0')}.mjs`), `export const o${i} = ${i};\n`);
  }
  execSync('git add graphfix', { cwd: FIXTURE });
  execSync('git -c commit.gpgsign=false commit -q -m "feat: graph fixture"', { cwd: FIXTURE });
}

test('/api/blast now returns a MEASURED edge for a real .mjs relative import', async () => {
  seedGraphFixture();
  const r = await request('/api/blast?files=graphfix/helper.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.graphAvailable, true, 'the scan produced edges — this repo has no TypeScript at all');
  assert.equal(body.reason, undefined, 'an available graph explains nothing away');

  const edge = body.edges.find((e) => e.from === 'graphfix/helper.mjs' && e.to === 'graphfix/consumer.mjs');
  assert.ok(edge, 'the importer surfaced through a measured import edge');
  assert.equal(edge.kind, 'imports');
  assert.equal(edge.basis, 'measured', 'a resolved import is measured, never inferred');
  assert.equal(edge.confidence, 1, 'an exact relative resolve is full confidence');

  const node = body.nodes.find((n) => n.file === 'graphfix/consumer.mjs');
  assert.ok(node, 'the importer is a ranked node');
  assert.equal(node.kind, 'dependent');
  assert.equal(node.basis, 'measured');
  assert.equal(node.depth, 1);

  assert.ok(body.coverage.resolvedEdges >= 3, 'coverage counts the real edges (import + cycle pair)');
  assert.ok(body.coverage.filesScanned >= GRAPHFIX_ORPHANS + 4);
  assert.equal(typeof body.coverage.unresolvedSpecs, 'number');
  assert.ok(body.coverage.byLang.js > 0);
  assert.match(body.provenance.source, /import-scan/);
});

test('/api/risk blast-radius factor now fires in a non-TS repo', async () => {
  const r = await request('/api/risk?files=graphfix/helper.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  const factor = body.factors.find((f) => f.name === 'blast-radius');
  assert.ok(factor, 'the measured dependency factor is wired for .mjs sources');
  assert.match(factor.evidence, /1 downstream dependent file\(s\): graphfix\/consumer\.mjs/);
  assert.ok(factor.contribution > 0, 'it actually moves the score');
  assert.match(body.provenance.source, /import-scan static imports/,
    'the answer names the second source it used, not just git-log');

  // A file nothing imports still gets the factor — with an honest zero, which
  // is different from the factor being absent (= "we have no graph").
  const lone = JSON.parse((await request('/api/risk?files=graphfix/orphan00.mjs', { headers: bearer })).body);
  const loneFactor = lone.factors.find((f) => f.name === 'blast-radius');
  assert.ok(loneFactor);
  assert.equal(loneFactor.raw, 0);
  assert.equal(loneFactor.contribution, 0);
});

test('/api/graph is token-gated', async () => {
  const r = await request('/api/graph');
  assert.equal(r.status, 401);
});

test('/api/graph answers the graph\'s own questions: cycles, orphans, fan-in/out', async () => {
  const r = await request('/api/graph', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);

  // Cycles: the seeded pair, reported as {files, length}.
  const cycle = body.cycles.find((c) => c.files.includes('graphfix/cycle-a.mjs'));
  assert.ok(cycle, 'the real import cycle is reported');
  assert.deepEqual(cycle.files, ['graphfix/cycle-a.mjs', 'graphfix/cycle-b.mjs']);
  assert.equal(cycle.length, 2);

  // Fan-in / fan-out: only files with edges, each {file, count}.
  const inbound = body.fanIn.find((e) => e.file === 'graphfix/helper.mjs');
  assert.ok(inbound, 'the imported file ranks in fan-in');
  assert.equal(inbound.count, 1);
  const outbound = body.fanOut.find((e) => e.file === 'graphfix/consumer.mjs');
  assert.ok(outbound, 'the importing file ranks in fan-out');
  assert.equal(outbound.count, 1);
  for (const row of [...body.fanIn, ...body.fanOut]) assert.ok(row.count > 0, 'zero-degree rows are never padding');

  // Orphans are CANDIDATES and say so, with the entry-point patterns excluded.
  assert.ok(body.orphans.candidates.some((c) => c.file === 'graphfix/consumer.mjs'),
    'nothing imports the consumer → it is a candidate');
  assert.ok(!body.orphans.candidates.some((c) => c.file === 'graphfix/helper.mjs'),
    'an imported file is never an orphan candidate');
  assert.ok(!body.orphans.candidates.some((c) => c.file === 'feature.test.mjs'),
    'test files are entry points, not dead code');
  assert.match(body.orphans.caveat, /CANDIDATES ONLY/);
  assert.ok(body.orphans.entryPoints.includes('**/*.test.*'), 'the exclusions travel with the answer');
  assert.ok(body.orphans.entryPoints.length <= 25 && body.orphans.entryPointsTotal >= body.orphans.entryPoints.length);

  assert.equal(body.degraded, false);
  assert.ok(body.coverage.resolvedEdges >= 3);
  assert.ok(body.coverage.filesScanned >= GRAPHFIX_ORPHANS + 4);
  assert.ok(body.coverage.byLang.js > 0);
  assert.equal(body.provenance.basis, 'measured');
  assert.equal(body.provenance.source, 'import-scan');
  assert.match(body.provenance.note, /not a parser/);
  assert.deepEqual(body.provenance.caps, { cycles: 20, cycleLength: 8, lists: 25 });
  assert.equal(body.state_age, 0, 'freshness on every answer');
  assert.equal(body.stale_warning, null);
});

test('/api/graph caps every list and says so with truncated:true', async () => {
  const body = JSON.parse((await request('/api/graph', { headers: bearer })).body);
  assert.ok(body.cycles.length <= 20, 'cycles capped at 20');
  assert.ok(body.fanIn.length <= 25 && body.fanOut.length <= 25, 'rankings capped at 25');
  assert.equal(body.orphans.candidates.length, 25, 'the orphan list is capped at 25');
  assert.ok(body.orphans.total > 25, 'the honest total is still reported');
  assert.equal(body.truncated, true, 'a cap that bit is never silent');
});

test('/api/graph caches the scan per HEAD (a second request never re-scans)', async () => {
  await request('/api/graph', { headers: bearer });
  const first = serve.graphStats();
  assert.ok(first.computes >= 1, 'the graph was scanned at least once');
  assert.equal(typeof first.key, 'string');
  // Different endpoint, same HEAD → the same scan answers both.
  await request('/api/blast?files=graphfix/helper.mjs', { headers: bearer });
  await request('/api/graph', { headers: bearer });
  const second = serve.graphStats();
  assert.equal(second.computes, first.computes, 'same HEAD → cached, not re-scanned');
  assert.equal(second.key, first.key);
});

// ---------------------------------------------------------------------------
// Doc-Navigator (/api/map, /api/doc, /api/why) — the intent-first answer to
// auto-generated wikis: nothing here invents documentation from code. These
// assertions therefore check three things: that authored records become
// navigable, that the ONE derived signal (staleness) is measured from git, and
// that the doc reader can never be walked outside .project-brain.
// ---------------------------------------------------------------------------

test('doc-navigator: /api/map, /api/doc and /api/why are all token-gated', async () => {
  for (const p of ['/api/map', '/api/doc?file=.project-brain/modules/demo.md', '/api/why?file=app.mjs']) {
    const r = await request(p);
    assert.equal(r.status, 401, `${p} must require the session token`);
  }
});

test('/api/map returns modules with derived globs, link counts, counts and orphans', async () => {
  const r = await request('/api/map', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);

  const demo = body.modules.find((m) => m.name === 'demo');
  assert.ok(demo, 'the seeded module record is on the map');
  assert.equal(demo.file, '.project-brain/modules/demo.md');
  assert.equal(demo.module, 'demo');
  assert.equal(demo.title, 'Demo module');
  assert.match(demo.summary, /demo module owns/);
  // fileGlobs come from what the AUTHOR wrote, not from scanning the code.
  assert.ok(demo.fileGlobs.includes('app.mjs'), 'backticked path becomes a glob');
  assert.ok(demo.fileGlobs.includes('lib.mjs'));
  assert.ok(!demo.fileGlobs.includes('brain-work'), 'prose identifiers are not paths');
  // The ADR carries `module: demo` — that is the whole linking mechanism.
  assert.equal(demo.decisionCount, 1);
  assert.equal(demo.featureCount, 0);
  assert.equal(demo.findingCount, 0);
  assert.equal(typeof demo.ageDays, 'number');

  assert.deepEqual(body.counts, {
    decisions: 1, modules: 3, features: 0, findings: 0, insights: 0
  });

  // The honest gap: ui/ holds code and no module record names it.
  assert.ok(Array.isArray(body.orphans.codeDirs));
  assert.ok(body.orphans.codeDirs.includes('ui'), 'unclaimed code area is reported, not papered over');
  assert.equal(typeof body.orphans.reason, 'string');

  assert.equal(body.provenance.basis, 'measured');
  assert.match(body.provenance.source, /git log/);
  assert.equal(body.provenance.staleDocDays, 60);
  assert.equal(typeof body.provenance.window.commits, 'number');
  assert.ok('state_age' in body && 'stale_warning' in body, 'freshness on every answer');
});

test('/api/map staleness is MEASURED: code newer than the doc, and the age threshold flips', async () => {
  const body = JSON.parse((await request('/api/map', { headers: bearer })).body);
  const byName = Object.fromEntries(body.modules.map((m) => [m.name, m]));

  // demo.md was committed 2026-01-01; app.mjs was committed after it.
  assert.equal(byName.demo.stale, true);
  assert.equal(byName.demo.staleReason, 'code-newer-than-doc');
  assert.ok(Date.parse(byName.demo.lastCodeChange) > Date.parse(byName.demo.lastDocChange),
    'the drift is proven from commit dates, not guessed');

  // fresh.md was written seconds ago and its globs match no commit.
  assert.equal(byName.fresh.stale, false);
  assert.equal(byName.fresh.staleReason, null);
  assert.equal(byName.fresh.lastCodeChange, null, 'no commit touches docs/** → no code signal');
  assert.deepEqual(byName.fresh.fileGlobs, ['docs/**'], 'frontmatter globs win over the body');

  // aged.md is 200 days old with no code signal → only the threshold applies.
  assert.equal(byName.aged.stale, true);
  assert.equal(byName.aged.staleReason, 'older-than-60d');
  assert.ok(byName.aged.ageDays > 60);

  // Flip BRAIN_STALE_DOC_DAYS and the age-only record stops being stale, while
  // the measured code-drift record stays stale — two different signals.
  process.env.BRAIN_STALE_DOC_DAYS = '365';
  try {
    const relaxed = JSON.parse((await request('/api/map', { headers: bearer })).body);
    const byName2 = Object.fromEntries(relaxed.modules.map((m) => [m.name, m]));
    assert.equal(relaxed.provenance.staleDocDays, 365);
    assert.equal(byName2.aged.stale, false, 'age threshold is configurable per process');
    assert.equal(byName2.demo.stale, true, 'code-drift does not depend on the threshold');
  } finally {
    delete process.env.BRAIN_STALE_DOC_DAYS;
  }
});

test('/api/doc returns frontmatter, body and outgoing links for a seeded record', async () => {
  const r = await request('/api/doc?file=.project-brain/modules/demo.md', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.file, '.project-brain/modules/demo.md');
  assert.equal(body.title, 'Demo module');
  assert.equal(body.frontmatter.module, 'demo');
  assert.equal(body.frontmatter.status, 'canonical');
  assert.match(body.body, /# Demo module/);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.links.decisions.map((d) => d.id), ['0001-test-decision'],
    'the [[wiki-link]] resolves to the real ADR record');
  assert.equal(body.links.decisions[0].file, '.project-brain/decisions/0001-test-decision.md');
  assert.equal(body.links.decisions[0].title, 'Bind the daemon to loopback only');
  assert.deepEqual(body.links.modules.map((m) => m.name), ['demo'], 'frontmatter module: links back');
  assert.ok(body.links.files.includes('app.mjs'), 'files the record names are navigable');
  assert.ok('state_age' in body);

  // The `.project-brain/` prefix is optional — records are addressed both ways.
  const short = await request('/api/doc?file=modules/demo.md', { headers: bearer });
  assert.equal(short.status, 200);
  assert.equal(JSON.parse(short.body).file, '.project-brain/modules/demo.md');

  const missing = await request('/api/doc?file=modules/nope.md', { headers: bearer });
  assert.equal(missing.status, 404, 'absent record is a 404, never a traversal hint');
});

test('/api/doc rejects traversal, absolute paths and non-.md — and never reads outside', async () => {
  const outside = path.join(FIXTURE, 'secret.md');
  fs.writeFileSync(outside, 'TOP_SECRET_FIXTURE_STRING\n');
  try {
    const attempts = [
      '../../etc/passwd',
      '../secret.md',
      '../../../../etc/hosts.md',
      '.project-brain/../secret.md',
      'modules/../../secret.md',
      '/etc/passwd',
      '/etc/hosts.md',
      'C:\\Windows\\system.md',
      'modules/demo.txt',
      'modules/demo',
      ''
    ];
    for (const attempt of attempts) {
      const r = await request(`/api/doc?file=${encodeURIComponent(attempt)}`, { headers: bearer });
      assert.equal(r.status, 400, `"${attempt}" must be rejected with 400`);
      assert.equal(JSON.parse(r.body).error, 'bad-request');
      assert.ok(!r.body.includes('TOP_SECRET_FIXTURE_STRING'), 'nothing outside .project-brain is ever read');
      assert.ok(!r.body.includes('root:'), 'no /etc/passwd content leaks');
    }
    // Missing param behaves the same as an empty one.
    const bare = await request('/api/doc', { headers: bearer });
    assert.equal(bare.status, 400);

    // The pure resolver is the single choke point — assert it directly too.
    assert.equal(serve.resolveBrainDoc(FIXTURE, '../secret.md'), null);
    assert.equal(serve.resolveBrainDoc(FIXTURE, '/etc/passwd.md'), null);
    assert.equal(serve.resolveBrainDoc(FIXTURE, 'modules/demo.txt'), null);
    assert.equal(serve.resolveBrainDoc(FIXTURE, 'modules/de\0mo.md'), null);
    assert.equal(
      serve.resolveBrainDoc(FIXTURE, 'modules/demo.md'),
      path.join(BRAIN, 'modules', 'demo.md'),
      'a legitimate record still resolves'
    );
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('/api/why answers "why is this file like this": module, ADRs, findings, history', async () => {
  const r = await request('/api/why?file=app.mjs', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.file, 'app.mjs');
  // The module record claims app.mjs through its authored glob.
  assert.equal(body.module, 'demo');
  assert.equal(body.moduleRecord, '.project-brain/modules/demo.md');
  assert.equal(body.provenance.matchedBy, 'module-record-glob');

  assert.equal(body.decisions.length, 1, 'the governing ADR is found via module:');
  const [adr] = body.decisions;
  assert.equal(adr.file, '.project-brain/decisions/0001-test-decision.md');
  assert.equal(adr.title, 'Bind the daemon to loopback only');
  assert.match(adr.excerpt, /127\.0\.0\.1/, 'the excerpt is the Decision section, i.e. the answer');

  assert.deepEqual(body.findings, [], 'no findings in the fixture');

  assert.ok(body.history.length >= 2, `last commits touching the file, got ${body.history.length}`);
  assert.ok(body.history.length <= 5, 'history is capped at 5');
  for (const h of body.history) {
    assert.match(h.hash, /^[0-9a-f]{7,40}$/);
    assert.equal(typeof h.subject, 'string');
    assert.ok(h.subject.length > 0);
    assert.ok(!Number.isNaN(Date.parse(h.dateIso)), 'each commit carries a parseable date');
  }
  assert.ok(body.history.some((h) => h.subject.includes('drift app.mjs')), 'the drift commit is in the history');
  assert.equal(body.state_age, 0, 'live-computed → age 0');
});

test('/api/why is honest when no record covers the file', async () => {
  const r = await request('/api/why?file=ui/panel.jsx', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.moduleRecord, null);
  assert.deepEqual(body.decisions, []);
  assert.equal(body.provenance.matchedBy, 'path-heuristic');
  assert.match(body.reason, /no module record|no authored intent/i);

  const bad = await request('/api/why', { headers: bearer });
  assert.equal(bad.status, 400, 'a missing ?file= is a 400, not an empty answer');
});

test('doc-navigator pure helpers: path extraction, globs and module inference', () => {
  const paths = serve.extractPaths('owns `app.mjs`, `scripts/**` and `scripts/x.mjs`; not `record.symbols`, `topK` or `scripts/`');
  assert.deepEqual(paths, ['app.mjs', 'scripts/**', 'scripts/x.mjs']);

  assert.deepEqual(serve.moduleGlobs({ globs: 'a/**, b.mjs' }, 'ignored `c.mjs`'), ['a/**', 'b.mjs'],
    'explicit frontmatter wins over the body');
  assert.deepEqual(serve.moduleGlobs({}, 'derives `c.mjs`'), ['c.mjs']);

  assert.equal(serve.globMatchesFile('scripts/**', 'scripts/deep/x.mjs'), true);
  assert.equal(serve.globMatchesFile('scripts/**', 'lib/x.mjs'), false);
  assert.equal(serve.globMatchesFile('app.mjs', 'app.mjs'), true);

  assert.equal(serve.inferModuleFromPath('src/api/handler.ts'), 'src/api');
  assert.equal(serve.inferModuleFromPath('scripts/common.mjs'), 'scripts');
  assert.equal(serve.inferModuleFromPath('README.md'), '');

  assert.equal(serve.decisionExcerpt('# T\n\n## Context\n\nc\n\n## Decision\n\nUse loopback.\n\n## Consequences\n\nx'),
    'Use loopback.', 'the Decision section is preferred over Context');
  assert.equal(serve.decisionExcerpt('# T\n\nJust a body.\n'), 'Just a body.');

  assert.deepEqual(serve.wikiLinks('see [[0001-x]] and [[mod|alias]] and [[0001-x]]'), ['0001-x', 'mod']);
});

// ---------------------------------------------------------------------------
// runner write API (M2.75) — tests run in registration order, and this whole
// section deliberately comes AFTER the read-only assertions above (it appends
// audit events and reseeds active_state.md).
// ---------------------------------------------------------------------------

const RUNNERS_DIR = path.join(BRAIN, 'runners');
const EVENTS_FILE = path.join(BRAIN, 'events.jsonl');
const MARKER = 'MARKER_OK_31337';
const MARKER_CMD = `'${process.execPath}' -e 'console.log("${MARKER}"); setInterval(() => console.log("tick"), 100)'`;

/** Every PID the API ever spawns lands here; the final sweep asserts all dead. */
const spawnedPids = [];

function killQuietly(pid) {
  for (const target of [-pid, pid]) {
    try { process.kill(target, 'SIGKILL'); } catch { /* already dead */ }
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

function readEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

test('runners: GET /api/runners is token-gated and reports runnerCmdConfigured=false when unset', async () => {
  assert.equal(process.env.BRAIN_RUNNER_CMD, undefined);
  const denied = await request('/api/runners');
  assert.equal(denied.status, 401, 'runner listing requires the session token');

  const r = await request('/api/runners', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.runners, []);
  assert.equal(body.runnerCmdConfigured, false);
  assert.ok('state_age' in body, 'freshness metadata is present');
});

test('runners: resolveRunnerCmd — env wins over config.json, absent config → "", never the request', () => {
  assert.equal(serve.resolveRunnerCmd(FIXTURE, {}), '', 'nothing configured → empty');
  const cfg = path.join(BRAIN, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ runnerCmd: 'from-config --wp {id}' }));
  try {
    assert.equal(serve.resolveRunnerCmd(FIXTURE, {}), 'from-config --wp {id}');
    assert.equal(serve.resolveRunnerCmd(FIXTURE, { BRAIN_RUNNER_CMD: 'from-env' }), 'from-env', 'env overrides config');
    fs.writeFileSync(cfg, 'not json {{{');
    assert.equal(serve.resolveRunnerCmd(FIXTURE, {}), '', 'malformed config → unconfigured, not a throw');
  } finally {
    fs.rmSync(cfg, { force: true });
  }
});

test('runners: start without a configured runner command → 400 no-runner-cmd, nothing spawned', async () => {
  const r = await post('/api/runners/start', { task: 'T-42' });
  assert.equal(r.status, 400);
  const body = JSON.parse(r.body);
  assert.equal(body.error, 'no-runner-cmd');
  assert.match(body.hint, /BRAIN_RUNNER_CMD|config\.json/);
  assert.equal(fs.existsSync(RUNNERS_DIR), false, 'no supervision record may appear');
});

test('runners: unknown task → 400 (the API references workstream rows, never commands)', async () => {
  process.env.BRAIN_RUNNER_CMD = MARKER_CMD;
  try {
    const r = await post('/api/runners/start', { task: 'no-such-task' });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, 'unknown-task');
    const missing = await post('/api/runners/start', {});
    assert.equal(missing.status, 400, 'missing task field matches no workstream');
  } finally {
    delete process.env.BRAIN_RUNNER_CMD;
  }
});

test('runners: leaseAdvisories — foreign active leases only, expired excluded, unparseable kept', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const leases = [
    { target: 'src/**', lockedBy: 'bob', until: '2099-01-01T00:00', notes: 'active foreign' },
    { target: 'docs/**', lockedBy: 'bob', until: '2000-01-01T00:00', notes: 'expired' },
    { target: 'src/api/**', lockedBy: 'alice', until: '2099-01-01T00:00', notes: 'own lease' },
    { target: 'undated/**', lockedBy: 'carol', until: 'soonish', notes: 'unparseable ttl' }
  ];
  const advisories = serve.leaseAdvisories(leases, 'alice', now);
  assert.deepEqual(advisories.map((a) => a.target), ['src/**', 'undated/**']);
  assert.equal(advisories[0].lockedBy, 'bob');
  assert.match(advisories[0].message, /leased by bob/);
  assert.match(advisories[0].message, /until 2099/);
});

test('runners: brief gate → 409 with advisories, NO spawn, NO record, NO audit event', async () => {
  // Reseed per the spec: workstream owner=alice, foreign lease lockedBy=bob
  // (plus an expired bob lease and alice's own lease — both must not gate).
  fs.writeFileSync(path.join(BRAIN, 'active_state.md'), `# Active State

## Workstreams

| task_id | owner | tool | project | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- | --- |
| WP-7 | alice | claude | demo | feature/wp7 | src/** | active |

## File Leases

| path glob or file | project | locked_by | until | notes |
| --- | --- | --- | --- | --- |
| src/** | demo | bob | 2099-01-01T00:00 | refactor in flight |
| docs/** | demo | bob | 2000-01-01T00:00 | long expired |
| src/api/** | demo | alice | 2099-01-01T00:00 | own lease |
`);
  process.env.BRAIN_RUNNER_CMD = MARKER_CMD;
  try {
    const r = await post('/api/runners/start', { task: 'WP-7' });
    assert.equal(r.status, 409);
    const body = JSON.parse(r.body);
    assert.equal(body.briefGate, true);
    assert.equal(body.advisories.length, 1, 'expired + own leases are excluded');
    assert.equal(body.advisories[0].target, 'src/**');
    assert.equal(body.advisories[0].lockedBy, 'bob');
    assert.equal(body.advisories[0].until, '2099-01-01T00:00');
    assert.match(body.advisories[0].message, /leased by bob/);
    assert.equal(fs.existsSync(path.join(RUNNERS_DIR, 'WP-7.json')), false, 'gate must not spawn or record');
    assert.ok(!readEvents().some((e) => e.verb === 'runner.started'), 'gate must not audit a start');
  } finally {
    delete process.env.BRAIN_RUNNER_CMD;
  }
});

test('runners: acknowledged start spawns the CONFIGURED command (body injection ignored) + audit', async () => {
  process.env.BRAIN_RUNNER_CMD = MARKER_CMD;
  try {
    // Injection attempt: runnerCmd/command in the body must be dead weight.
    const r = await post('/api/runners/start', {
      task: 'WP-7',
      acknowledged: true,
      runnerCmd: 'echo INJECTED_EVIL && rm -rf /',
      command: 'echo INJECTED_EVIL'
    });
    assert.equal(r.status, 200);
    const { runner } = JSON.parse(r.body);
    assert.equal(runner.task, 'WP-7');
    assert.equal(runner.status, 'running');
    assert.ok(Number.isInteger(runner.pid) && runner.pid > 0);
    assert.ok(runner.startedAt);
    assert.ok(runner.logFile.endsWith('WP-7.log'));
    spawnedPids.push(runner.pid);
    assert.equal(pidAlive(runner.pid), true, 'the runner process is really alive');

    const record = JSON.parse(fs.readFileSync(path.join(RUNNERS_DIR, 'WP-7.json'), 'utf8'));
    assert.equal(record.runnerCmd, MARKER_CMD, 'spawned command is the configured one');
    assert.ok(!record.runnerCmd.includes('INJECTED_EVIL'), 'body-supplied command never reaches the record');

    const gotMarker = await waitFor(() => {
      try { return fs.readFileSync(record.logFile, 'utf8').includes(MARKER); } catch { return false; }
    });
    assert.equal(gotMarker, true, 'log proves the configured command ran');
    assert.ok(!fs.readFileSync(record.logFile, 'utf8').includes('INJECTED_EVIL'), 'injected command never ran');

    const started = readEvents().filter((e) => e.verb === 'runner.started');
    assert.equal(started.length, 1, 'exactly one audit line for the one start');
    assert.equal(started[0].task, 'WP-7');
    assert.equal(started[0].actor, 'control-room');
    assert.equal(started[0].acknowledgedBriefGate, true);
    assert.equal(started[0].advisoryCount, 1);
    assert.ok(started[0].ts);
  } finally {
    delete process.env.BRAIN_RUNNER_CMD;
  }
});

test('runners: GET /api/runners maps workPackageId→task and never leaks the runner command', async () => {
  process.env.BRAIN_RUNNER_CMD = MARKER_CMD;
  try {
    const r = await request('/api/runners', { headers: bearer });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.runnerCmdConfigured, true);
    const entry = body.runners.find((x) => x.id === 'WP-7');
    assert.ok(entry, 'the started runner is listed');
    assert.equal(entry.task, 'WP-7');
    assert.equal(entry.status, 'running');
    assert.ok(!('runnerCmd' in entry), 'the command never appears in API responses');
    assert.ok(!r.body.includes(MARKER), 'not even inside other fields');
  } finally {
    delete process.env.BRAIN_RUNNER_CMD;
  }
});

test('runners: starting the same task again → 409 already-running, no second process', async () => {
  process.env.BRAIN_RUNNER_CMD = MARKER_CMD;
  try {
    const before = JSON.parse(fs.readFileSync(path.join(RUNNERS_DIR, 'WP-7.json'), 'utf8')).pid;
    const r = await post('/api/runners/start', { task: 'WP-7', acknowledged: true });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).error, 'already-running');
    const after = JSON.parse(fs.readFileSync(path.join(RUNNERS_DIR, 'WP-7.json'), 'utf8')).pid;
    assert.equal(after, before, 'the record still points at the original process');
  } finally {
    delete process.env.BRAIN_RUNNER_CMD;
  }
});

test('runners: log tail is token-gated and bounded', async () => {
  const denied = await request('/api/runners/log?id=WP-7');
  assert.equal(denied.status, 401);

  await waitFor(() => {
    const t = fs.readFileSync(path.join(RUNNERS_DIR, 'WP-7.json'), 'utf8');
    try { return fs.readFileSync(JSON.parse(t).logFile, 'utf8').split('\n').length > 6; } catch { return false; }
  });
  const r = await request('/api/runners/log?id=WP-7&lines=5', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.lines));
  assert.ok(body.lines.length >= 1 && body.lines.length <= 5, `lines param bounds output, got ${body.lines.length}`);
  assert.equal(typeof body.truncated, 'boolean');
  assert.ok(body.lines.some((l) => l === MARKER || l === 'tick'), 'tail shows real runner output');

  const missing = await request('/api/runners/log?id=no-such-runner', { headers: bearer });
  assert.equal(missing.status, 404);
});

test('runners: stop really kills the process, audits runner.stopped, is idempotent', async () => {
  const record = JSON.parse(fs.readFileSync(path.join(RUNNERS_DIR, 'WP-7.json'), 'utf8'));
  const r = await post('/api/runners/stop', { id: 'WP-7' });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'stopped');
  assert.throws(() => process.kill(record.pid, 0), (error) => error.code === 'ESRCH', 'process must be really dead');
  assert.equal(JSON.parse(fs.readFileSync(path.join(RUNNERS_DIR, 'WP-7.json'), 'utf8')).status, 'exited');

  const stoppedEvents = readEvents().filter((e) => e.verb === 'runner.stopped');
  assert.equal(stoppedEvents.length, 1);
  assert.equal(stoppedEvents[0].id, 'WP-7');
  assert.equal(stoppedEvents[0].actor, 'control-room');

  const again = await post('/api/runners/stop', { id: 'WP-7' });
  assert.equal(again.status, 200, 'stop is idempotent per the supervisor lib');
  assert.equal(JSON.parse(again.body).status, 'already-exited');

  const unknown = await post('/api/runners/stop', { id: 'never-existed' });
  assert.equal(unknown.status, 404);
});

test('runners security: POSTs pass through Origin/token gates; GET on a POST path → 405', async () => {
  const evilOrigin = await post('/api/runners/start', { task: 'WP-7', acknowledged: true }, { Origin: 'http://evil.example' });
  assert.equal(evilOrigin.status, 403, 'cross-origin POST rejected even with a valid token');

  const noToken = await request('/api/runners/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'WP-7' })
  });
  assert.equal(noToken.status, 401);

  const evilHost = await post('/api/runners/stop', { id: 'WP-7' }, { Host: 'evil.example' });
  assert.equal(evilHost.status, 403, 'DNS-rebinding Host rejected on POSTs too');

  const wrongMethod = await request('/api/runners/start', { headers: bearer });
  assert.equal(wrongMethod.status, 405, 'GET on a POST endpoint is rejected');
  assert.equal(wrongMethod.headers.allow, 'POST');
});

test('runners security: content-type, malformed JSON, and oversized bodies are rejected', async () => {
  process.env.BRAIN_RUNNER_CMD = MARKER_CMD;
  try {
    const wrongType = await request('/api/runners/start', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ task: 'WP-7' })
    });
    assert.equal(wrongType.status, 415, 'non-JSON content type rejected');

    const malformed = await post('/api/runners/start', '{"task": nope');
    assert.equal(malformed.status, 400);
    assert.match(JSON.parse(malformed.body).error, /malformed JSON/);

    const notObject = await post('/api/runners/start', '[1,2,3]');
    assert.equal(notObject.status, 400, 'non-object JSON body rejected');

    const huge = await post('/api/runners/start', `{"task":"${'x'.repeat(20 * 1024)}"}`);
    assert.equal(huge.status, 413, 'bodies over the 16KB cap are rejected');
  } finally {
    delete process.env.BRAIN_RUNNER_CMD;
  }
});

test('SSE: runner record changes under .project-brain/runners/ emit state-changed', async () => {
  fs.mkdirSync(RUNNERS_DIR, { recursive: true });
  await new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: daemon.port,
      path: `/api/stream?token=${TOKEN}`
    }, (res) => {
      let buf = '';
      let touched = false;
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('no state-changed event for a runner record change'));
      }, 5000);
      res.on('data', (chunk) => {
        buf += chunk;
        if (!touched && buf.includes(': connected')) {
          touched = true;
          // A dead-PID record touch — exactly what start/stop/reconcile write.
          fs.writeFileSync(path.join(RUNNERS_DIR, 'sse-touch.json'),
            JSON.stringify({ pid: 99999999, workPackageId: 'sse-touch', status: 'exited', logFile: '' }));
        }
        if (buf.includes('state-changed') && buf.includes('runners')) {
          clearTimeout(timer);
          req.destroy();
          resolve();
        }
      });
    });
    req.on('error', () => {}); // destroy() races the socket teardown
  });
});

test('runners: no zombie children survive the test run', async () => {
  for (const pid of spawnedPids) killQuietly(pid);
  const allDead = await waitFor(() => spawnedPids.every((pid) => !pidAlive(pid)), 3000);
  assert.equal(allDead, true, `zombie runner pids still alive: ${spawnedPids.filter((pid) => pidAlive(pid)).join(', ')}`);
});

// ---------------------------------------------------------------------------
// fleet view (/api/fleet) — "which of my repos needs attention right now?"
//
// Two fixtures, deliberately separate:
//   1. the single-repo FIXTURE above (0 sibling projects) proves the DEGRADED
//      path on the shared daemon — no mutation, so it stays order-independent;
//   2. a synthetic fleet root (2 git repos + 1 project that is NOT a git repo)
//      served by a SECOND daemon rooted at it, proving the non-degraded path,
//      the ranking, and the per-project error containment.
//
// The second daemon's brain state still resolves to the fixture's
// active_state.md (BRAIN_ROOT is process-wide and fixed before the import). In
// production root === BRAIN_ROOT, so this only means the fleet fixture reuses
// the fixture's state file — which is exactly what exercises the piece under
// test: the join from a state row's `project` column to a discovered project
// name. Those rows are added INSIDE the test below (never at module scope) so
// the /api/state assertions further up keep their exact counts.
// ---------------------------------------------------------------------------

// TTL off by default here: each fleet test wants to observe the live state it
// just wrote. The TTL test flips it back on explicitly.
process.env.BRAIN_FLEET_TTL_MS = '0';

const FLEET = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fleet-'));
const FLEET_A = path.join(FLEET, 'svc-a');
const FLEET_B = path.join(FLEET, 'svc-b');
const FLEET_BROKEN = path.join(FLEET, 'svc-broken');

function initFleetRepo(dir, commitIso) {
  fs.mkdirSync(dir, { recursive: true });
  // package.json is the discovery marker projects.mjs looks for.
  fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"${path.basename(dir)}"}\n`);
  execSync('git init --quiet', { cwd: dir });
  execSync('git config user.email t@example.com', { cwd: dir });
  execSync('git config user.name Tester', { cwd: dir });
  execSync('git add .', { cwd: dir });
  execSync('git -c commit.gpgsign=false commit -q -m "feat: seed"', {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: commitIso, GIT_COMMITTER_DATE: commitIso }
  });
}

const FLEET_A_STALE_DAYS = 10;
initFleetRepo(FLEET_A, new Date(Date.now() - FLEET_A_STALE_DAYS * 86_400_000).toISOString());
// svc-a: uncommitted work (1 staged + 1 untracked) sitting on a 10-day-old commit.
fs.writeFileSync(path.join(FLEET_A, 'src.mjs'), 'export const a = 1;\n');
execSync('git add src.mjs', { cwd: FLEET_A });
fs.writeFileSync(path.join(FLEET_A, 'notes.txt'), 'wip\n');

// svc-b: committed just now, clean tree, no workstream, no lease → nothing to report.
initFleetRepo(FLEET_B, new Date().toISOString());

// svc-broken: a discovered project (package.json) that is NOT a git repo — and
// the fleet root is outside any repo, so git really refuses to answer here.
fs.mkdirSync(FLEET_BROKEN, { recursive: true });
fs.writeFileSync(path.join(FLEET_BROKEN, 'package.json'), '{"name":"svc-broken"}\n');

let fleetDaemon;

before(async () => {
  // cwd = svc-a → that project is the one "the daemon was started in".
  fleetDaemon = await serve.startServer({ root: FLEET, port: 0, token: TOKEN, cwd: FLEET_A });
});

after(async () => {
  if (fleetDaemon) await fleetDaemon.close();
  fs.rmSync(FLEET, { recursive: true, force: true });
});

/** GET a JSON endpoint on an arbitrary local daemon port, with the token. */
function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: bearer }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const fleetGet = () => getJson(fleetDaemon.port, '/api/fleet');

/** Every contributing reason must be human-readable AND carry its number. */
function assertReasonsCarryNumbers(project) {
  for (const reason of project.reasons) {
    assert.equal(typeof reason.kind, 'string');
    assert.equal(typeof reason.weight, 'number');
    assert.match(reason.message, /\d/, `reason "${reason.kind}" must name its number: ${reason.message}`);
    assert.ok(reason.message.length > 10, `reason "${reason.kind}" must be a sentence, not a label`);
  }
}

test('/api/fleet is token-gated (401 without)', async () => {
  const r = await request('/api/fleet');
  assert.equal(r.status, 401);
  const ok = await request('/api/fleet', { headers: bearer });
  assert.equal(ok.status, 200);
});

test('/api/fleet on a single repo → degraded:true with a reason and the active repo present', async () => {
  const r = await request('/api/fleet', { headers: bearer });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.degraded, true, 'one repo is not a fleet');
  assert.equal(body.fleetRoot, null);
  assert.match(body.reason, /fleet mode off/);
  assert.match(body.reason, /solo-multi-repo-setup/);
  assert.equal(body.truncated, false);
  assert.equal(body.projects.length, 1, 'the active repo is still reported');

  const p = body.projects[0];
  assert.equal(p.name, path.basename(FIXTURE));
  assert.equal(p.path, FIXTURE);
  assert.equal(p.isActive, true);
  assert.equal(body.active, p.name);
  assert.equal(typeof p.attention, 'number');
  assert.ok(Array.isArray(p.reasons));
  assert.equal(typeof p.dirty.staged, 'number');
  assert.equal(typeof p.dirty.unstaged, 'number');
  assert.ok(p.lastCommit && typeof p.lastCommit.hash === 'string', 'last commit is reported');
  assert.equal(typeof p.staleDays, 'number');
  assert.equal(p.error, undefined);
  assertReasonsCarryNumbers(p);

  // Provenance names the weights so the ranking stays reviewable, not magic.
  assert.equal(body.provenance.basis, 'measured');
  assert.deepEqual(body.provenance.weights, serve.FLEET_ATTENTION_WEIGHTS);
  assert.deepEqual(body.provenance.thresholds, serve.FLEET_ATTENTION_THRESHOLDS);
  assert.equal(body.provenance.maxProjects, 25);
  assert.equal(typeof body.generated_at, 'string');
});

test('/api/fleet on a synthetic 2-repo fleet: every repo listed, sorted by attention, reasons carry numbers', async () => {
  // Tag state rows to svc-a (per-project tagging is the fleet contract) —
  // written here, after every single-repo /api/state assertion has run.
  fs.writeFileSync(path.join(BRAIN, 'active_state.md'), `# Active State

## Workstreams

| task_id | owner | tool | project | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- | --- |
| T-42 | seebo | claude | demo | feature/42-serve | scripts/** | active |
| T-77 | seebo | claude | svc-a | feature/77 | src/** | active |

## File Leases

| path glob or file | project | locked_by | until | notes |
| --- | --- | --- | --- | --- |
| scripts/** | demo | claude-a | 2099-01-01T00:00 | serve work |
| src/** | svc-a | claude-b | 2099-01-01T00:00 | agent editing svc-a |

## Blockers

- none

## Overlaps

- none
`);

  const { status, body } = await fleetGet();
  assert.equal(status, 200);
  assert.equal(body.degraded, false, 'two sibling projects auto-activate fleet mode');
  assert.equal(body.fleetRoot, FLEET);
  assert.equal(body.truncated, false);
  assert.equal(body.active, 'svc-a', 'the repo the daemon was started in');

  const names = body.projects.map((p) => p.name);
  assert.deepEqual([...names].sort(), ['svc-a', 'svc-b', 'svc-broken']);

  // Sorted by attention, descending — the ranking IS the answer.
  const scores = body.projects.map((p) => p.attention);
  assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
  assert.equal(names[0], 'svc-a', 'the repo with stuck work ranks first');

  const a = body.projects.find((p) => p.name === 'svc-a');
  assert.equal(a.isActive, true);
  assert.equal(a.path, FLEET_A);
  assert.deepEqual(a.dirty, { staged: 1, unstaged: 1 }, 'porcelain=v2 splits staged from worktree');
  assert.equal(typeof a.branch, 'string');
  assert.equal(a.ahead, null, 'no upstream configured → ahead/behind are unknown, not 0');
  assert.equal(a.behind, null);
  assert.equal(a.workstreams, 1);
  assert.equal(a.leases, 1);
  assert.equal(a.conflicts, 1, 'seebo owns the workstream, claude-b holds the lease');
  assert.ok(a.staleDays >= FLEET_A_STALE_DAYS - 1 && a.staleDays <= FLEET_A_STALE_DAYS + 1);
  assert.equal(a.lastCommit.subject, 'feat: seed');
  assertReasonsCarryNumbers(a);

  const kinds = a.reasons.map((r) => r.kind);
  assert.ok(kinds.includes('lease-conflict'), kinds.join(','));
  assert.ok(kinds.includes('dirty-stale'), kinds.join(','));
  assert.ok(kinds.includes('abandoned-workstream'), kinds.join(','));
  assert.ok(kinds.includes('stale'), kinds.join(','));
  assert.match(a.reasons.find((r) => r.kind === 'dirty-stale').message, /1 file staged and 1 file unstaged/);
  assert.match(a.reasons.find((r) => r.kind === 'lease-conflict').message, /claude-b/);
  assert.ok(a.attention > 0 && a.attention <= 100);

  // A quiet repo reports nothing — no invented urgency to fill a dashboard.
  const b = body.projects.find((p) => p.name === 'svc-b');
  assert.equal(b.isActive, false);
  assert.equal(b.attention, 0);
  assert.deepEqual(b.reasons, []);
  assert.deepEqual(b.dirty, { staged: 0, unstaged: 0 });
  assert.equal(b.conflicts, 0);
  assert.equal(b.error, undefined);

  assert.ok(a.attention > b.attention, 'the repo with a lease conflict outranks the clean one');
});

test('/api/fleet: a project that is not a git repo yields error and never breaks the fleet', async () => {
  const { status, body } = await fleetGet();
  assert.equal(status, 200, 'one broken sibling must not fail the whole answer');
  const broken = body.projects.find((p) => p.name === 'svc-broken');
  assert.ok(broken, 'a broken project is still listed');
  assert.match(broken.error, /not a git repository/i);
  assert.equal(broken.attention, 0, 'unknown state is never ranked as urgent');
  assert.deepEqual(broken.reasons, []);
  assert.equal(broken.lastCommit, null);
  assert.equal(broken.branch, null);
  // The healthy siblings are unaffected.
  assert.ok(body.projects.find((p) => p.name === 'svc-a').lastCommit);
});

test('/api/fleet memoizes per (root, cwd) for a TTL — a dashboard poll cannot spawn 2N git processes', async () => {
  const previous = process.env.BRAIN_FLEET_TTL_MS;
  try {
    process.env.BRAIN_FLEET_TTL_MS = '0';
    const before0 = serve.fleetStats().computes;
    await fleetGet();
    await fleetGet();
    assert.equal(serve.fleetStats().computes, before0 + 2, 'TTL 0 → every request recomputes');

    process.env.BRAIN_FLEET_TTL_MS = '60000';
    assert.equal(serve.fleetStats().ttlMs, 60_000, 'the TTL is read at call time');
    await fleetGet(); // primes the cache under the new TTL
    const primed = serve.fleetStats();
    assert.equal(primed.key, `${FLEET}|${FLEET_A}`, 'cache key is (root, cwd), never a HEAD');
    await fleetGet();
    await fleetGet();
    assert.equal(serve.fleetStats().computes, primed.computes, 'two more requests, zero recomputes');
  } finally {
    process.env.BRAIN_FLEET_TTL_MS = previous;
  }
});

test('fleet pure core: parseGitStatusV2 splits staged/worktree and reads branch + ahead/behind', () => {
  const sample = [
    '# branch.oid abc123',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -3',
    '1 M. N... 100644 100644 100644 aaa bbb staged.mjs',
    '1 .M N... 100644 100644 100644 aaa bbb worktree.mjs',
    '1 MM N... 100644 100644 100644 aaa bbb both.mjs',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.mjs\told.mjs',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.mjs',
    '? untracked.mjs',
    ''
  ].join('\n');
  assert.deepEqual(serve.parseGitStatusV2(sample), {
    branch: 'feature/x',
    ahead: 2,
    behind: 3,
    staged: 3,      // M., MM, R.
    unstaged: 4     // .M, MM, u, ?
  });

  const detached = serve.parseGitStatusV2('# branch.head (detached)\n');
  assert.equal(detached.branch, null);
  assert.equal(detached.ahead, null, 'no branch.ab line → unknown, not 0');
  assert.equal(detached.behind, null);
  assert.deepEqual(serve.parseGitStatusV2(''), { branch: null, ahead: null, behind: null, staged: 0, unstaged: 0 });
});

test('fleet pure core: fleetAttention weights, message numbers, and the quiet case', () => {
  const W = serve.FLEET_ATTENTION_WEIGHTS;

  const quiet = serve.fleetAttention({
    dirty: { staged: 0, unstaged: 0 }, staleDays: 0, workstreams: 0, conflicts: 0, ahead: 0, behind: 0
  });
  assert.equal(quiet.attention, 0);
  assert.deepEqual(quiet.reasons, [], 'nothing to report → no invented urgency');

  // Dirty but freshly committed is NOT attention — the work is still moving.
  const busy = serve.fleetAttention({
    dirty: { staged: 4, unstaged: 1 }, staleDays: 0, workstreams: 1, conflicts: 0, ahead: 0, behind: 0
  });
  assert.deepEqual(busy.reasons, []);
  assert.equal(busy.attention, 0);

  const conflicted = serve.fleetAttention({
    dirty: { staged: 0, unstaged: 0 }, staleDays: 0, workstreams: 0, conflicts: 3,
    conflictActors: ['claude-b'], ahead: 0, behind: 0
  });
  assert.equal(conflicted.attention, W.leaseConflict);
  assert.equal(conflicted.reasons[0].kind, 'lease-conflict');
  assert.match(conflicted.reasons[0].message, /3 active leases held by a different actor \(claude-b\)/);
  assert.ok(conflicted.attention > quiet.attention, 'a lease conflict outranks a clean repo');

  const pushed = serve.fleetAttention({
    dirty: { staged: 0, unstaged: 0 }, staleDays: 0, workstreams: 0, conflicts: 0,
    ahead: 2, behind: 5, branch: 'feature/x'
  });
  assert.equal(pushed.attention, W.unpushed + W.behind);
  assert.match(pushed.reasons.find((r) => r.kind === 'unpushed').message, /2 commits unpushed on feature\/x/);
  assert.match(pushed.reasons.find((r) => r.kind === 'behind').message, /5 commits behind upstream on feature\/x/);

  const stuck = serve.fleetAttention({
    dirty: { staged: 3, unstaged: 0 }, staleDays: 6, workstreams: 1, conflicts: 0, ahead: 0, behind: 0
  });
  assert.match(stuck.reasons.find((r) => r.kind === 'dirty-stale').message, /3 files staged and 0 files unstaged, 6 days/);
  // Reasons come back heaviest-first so a UI can render the headline directly.
  assert.deepEqual(stuck.reasons.map((r) => r.weight), [...stuck.reasons.map((r) => r.weight)].sort((x, y) => y - x));

  // 6 days: abandoned fires, the 7-day escalation does not. Clamped at 100.
  assert.deepEqual(stuck.reasons.map((r) => r.kind), ['dirty-stale', 'abandoned-workstream']);
  const everything = serve.fleetAttention({
    dirty: { staged: 9, unstaged: 9 }, staleDays: 90, workstreams: 2, conflicts: 2, ahead: 4, behind: 4
  });
  assert.equal(everything.attention, 100, 'score is clamped to 100');
});
