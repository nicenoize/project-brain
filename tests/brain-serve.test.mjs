/**
 * Control-Room daemon tests (scripts/brain-serve.mjs, strategy §M2.75).
 *
 * The M2.75 security model is mandatory, so every point gets its own test:
 * token gating (401 on missing/wrong, constant-time compare), Origin/Host
 * validation (403, DNS-rebinding defense), no CORS headers, read-only API
 * (405 on non-GET), and the strict 127.0.0.1 bind.
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

fs.writeFileSync(path.join(BRAIN, 'decisions', '0001-test-decision.md'), `---
title: Bind the daemon to loopback only
status: canonical
layer: decision
---

# Bind the daemon to loopback only

Body.
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

/** Raw client so we can spoof Host/Origin headers freely. */
function request(pathname, { headers = {}, method = 'GET' } = {}) {
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
    req.end();
  });
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

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
