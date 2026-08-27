/**
 * MCP stdio server tests (scripts/brain-mcp.mjs).
 *
 * These drive the REAL protocol against a REAL child process — a unit test of
 * the handler table would prove nothing about the thing that actually breaks
 * (framing, stdout hygiene, staying alive on garbage). One long-lived server is
 * shared by the protocol tests; the crash/exit tests each get their own child
 * and kill it in a finally block, so no subprocess outlives the suite.
 *
 * Fixture: a mkdtemp git repo with a seeded .project-brain (active_state.md
 * with a workstream + a lease, one module record, one ADR governing it) and two
 * commits, passed to the child via BRAIN_ROOT — the same override
 * tests/brain-serve.test.mjs uses.
 *
 * The stdout-hygiene assertion is the load-bearing one: EVERY stdout line must
 * parse as JSON. A single stray console.log anywhere in the imported graph
 * corrupts an MCP transport, and the failure mode in a real host is a silent
 * "server disconnected".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/brain-mcp.mjs', import.meta.url));

// --- fixture ---------------------------------------------------------------

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-'));
const BRAIN = path.join(FIXTURE, '.project-brain');
fs.mkdirSync(path.join(BRAIN, 'decisions'), { recursive: true });
fs.mkdirSync(path.join(BRAIN, 'modules'), { recursive: true });

fs.writeFileSync(path.join(BRAIN, 'active_state.md'), `# Active State

## Workstreams

| task_id | owner | tool | project | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- | --- |
| T-77 | seebo | claude | demo | feature/77-mcp | scripts/** | active |

## File Leases

| path glob or file | project | locked_by | until | notes |
| --- | --- | --- | --- | --- |
| app.mjs | demo | claude-a | 2099-01-01T00:00 | mcp work |

## Blockers

- none

## Overlaps

- none
`);

fs.writeFileSync(path.join(BRAIN, 'modules', 'demo.md'), `---
title: Demo module
module: demo
---

# Demo module

The demo module owns \`app.mjs\` and \`lib.mjs\`.
`);

fs.writeFileSync(path.join(BRAIN, 'decisions', '0001-loopback-only.md'), `---
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

const CHILD_ENV = {
  ...process.env,
  BRAIN_ROOT: FIXTURE,
  // Determinism + speed: no embedder probe, no TS program load, no ambient
  // actor turning a foreign lease into a self-held warning.
  BRAIN_INDEX_PROVIDER: 'none',
  BRAIN_TS_GRAPH: '0',
  BRAIN_FLEET_MODE: '0',
  BRAIN_ACTOR: ''
};

// --- minimal MCP client over the child's stdio ------------------------------

/** Spawn the server; returns { child, send, next, stdoutLines, stderr, kill }. */
function startServer() {
  const child = spawn(process.execPath, [SCRIPT], { cwd: FIXTURE, env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutLines = [];
  const pending = new Map(); // id → resolve
  const waiters = [];        // resolvers waiting for any frame
  let stderr = '';
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.length) continue;
      stdoutLines.push(line);
      let frame;
      try { frame = JSON.parse(line); } catch { frame = { __unparseable: line }; }
      const id = frame && frame.id;
      if (pending.has(id)) { pending.get(id)(frame); pending.delete(id); }
      else if (waiters.length) waiters.shift()(frame);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

  /** Send a request and resolve with its response frame (matched by id). */
  const call = (id, method, params) => {
    const p = new Promise((resolve) => pending.set(id, resolve));
    write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return p;
  };
  /** Write a raw line (used for the malformed-JSON case) and await one frame. */
  const raw = (line) => {
    const p = new Promise((resolve) => waiters.push(resolve));
    child.stdin.write(`${line}\n`);
    return p;
  };
  const notify = (method, params) => write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });

  return {
    child, call, raw, notify, stdoutLines,
    stderrText: () => stderr,
    kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  };
}

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    if (typeof t.unref === 'function') t.unref();
  })
]);

let server;

before(async () => {
  server = startServer();
  const init = await withTimeout(server.call(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-harness', version: '1.0.0' }
  }), 15_000, 'initialize');
  server.initResult = init.result;
  server.notify('notifications/initialized');
});

after(() => {
  if (server) server.kill();
  fs.rmSync(FIXTURE, { recursive: true, force: true });
});

// --- protocol ---------------------------------------------------------------

test('initialize returns protocolVersion, tools capability and serverInfo', () => {
  const r = server.initResult;
  assert.equal(r.protocolVersion, '2025-06-18', 'echoes the client protocol when supported');
  assert.ok(r.capabilities && r.capabilities.tools, 'advertises the tools capability');
  assert.equal(r.serverInfo.name, 'project-brain');
  assert.match(r.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.match(r.instructions, /brain_status/, 'instructions tell the agent where to start');
});

test('initialize falls back to a supported version for an unknown one', async () => {
  const other = startServer();
  try {
    const r = await withTimeout(other.call(1, 'initialize', {
      protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '0' }
    }), 15_000, 'initialize');
    assert.equal(r.result.protocolVersion, '2025-06-18');
  } finally {
    other.kill();
  }
});

test('notifications get no response at all', async () => {
  // A notification MUST NOT be answered — not even with an error. Counting
  // frames (rather than just checking the ping came back) is what actually
  // proves the notification produced nothing.
  const before = server.stdoutLines.length;
  server.notify('notifications/cancelled', { requestId: 999 });
  server.notify('notifications/definitely-not-a-real-one');
  const pong = await withTimeout(server.call(2, 'ping'), 10_000, 'ping');
  assert.equal(pong.id, 2);
  assert.deepEqual(pong.result, {});
  assert.equal(server.stdoutLines.length - before, 1, 'exactly one frame: the ping response');
});

test('tools/list returns all 8 tools with valid JSON schemas', async () => {
  const r = await withTimeout(server.call(3, 'tools/list'), 10_000, 'tools/list');
  const tools = r.result.tools;
  assert.equal(tools.length, 8);
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'brain_blast', 'brain_danger', 'brain_leases', 'brain_next',
    'brain_risk', 'brain_search', 'brain_status', 'brain_why'
  ]);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object schema`);
    assert.equal(typeof t.inputSchema.properties, 'object');
    if (t.inputSchema.required) {
      assert.ok(Array.isArray(t.inputSchema.required));
      for (const key of t.inputSchema.required) {
        assert.ok(t.inputSchema.properties[key], `${t.name}: required "${key}" must be declared`);
      }
    }
    // The schema must survive a JSON round-trip unchanged (no undefined/NaN).
    assert.deepEqual(JSON.parse(JSON.stringify(t.inputSchema)), t.inputSchema);
  }
  // Required args are declared where the tool cannot work without them.
  assert.deepEqual(tools.find((t) => t.name === 'brain_why').inputSchema.required, ['file']);
  assert.deepEqual(tools.find((t) => t.name === 'brain_search').inputSchema.required, ['query']);
});

test('unknown method → -32601, server stays alive', async () => {
  const r = await withTimeout(server.call(4, 'no/such/method'), 10_000, 'unknown method');
  assert.equal(r.error.code, -32601);
  assert.match(r.error.message, /Method not found/);
  const pong = await withTimeout(server.call(5, 'ping'), 10_000, 'ping after unknown method');
  assert.deepEqual(pong.result, {});
});

test('malformed JSON → -32700 error frame, server stays alive', async () => {
  const frame = await withTimeout(server.raw('{ this is not json'), 10_000, 'parse error');
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.id, null, 'a parse error cannot know the id');
  assert.equal(frame.error.code, -32700);
  const pong = await withTimeout(server.call(6, 'ping'), 10_000, 'ping after garbage');
  assert.deepEqual(pong.result, {}, 'the transport survived the garbage');
});

test('unknown tool name → -32602', async () => {
  const r = await withTimeout(server.call(7, 'tools/call', { name: 'brain_nope', arguments: {} }), 10_000, 'unknown tool');
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /unknown tool/);
});

// --- answers ----------------------------------------------------------------

/** The provenance line is a product rule: every answer must carry it. */
function assertProvenance(text) {
  const line = text.split('\n').find((l) => l.startsWith('provenance: '));
  assert.ok(line, `answer is missing the provenance line:\n${text}`);
  assert.match(line, /basis /, 'provenance names its basis');
  assert.match(line, /active_state\.md /, 'provenance names the coordination-state freshness');
}

test('tools/call brain_status answers with repo state and provenance', async () => {
  const r = await withTimeout(server.call(10, 'tools/call', { name: 'brain_status', arguments: {} }), 30_000, 'brain_status');
  assert.ok(!r.result.isError, `brain_status failed: ${JSON.stringify(r.result)}`);
  const text = r.result.content[0].text;
  assert.equal(r.result.content[0].type, 'text');
  assert.match(text, /fleet: degraded/, 'single-repo fixture reports the honest degraded flag');
  assert.match(text, /T-77/, 'the open workstream is named');
  assert.match(text, /app\.mjs — claude-a/, 'the active lease names its holder');
  assert.match(text, /^next: /m, 'a top next action is offered');
  assertProvenance(text);
  assert.ok(Buffer.byteLength(text) < 4000, `status answer must stay token-lean, got ${Buffer.byteLength(text)} bytes`);
});

test('tools/call brain_why answers with module, governing ADR and history', async () => {
  const r = await withTimeout(server.call(11, 'tools/call', { name: 'brain_why', arguments: { file: 'app.mjs' } }), 30_000, 'brain_why');
  assert.ok(!r.result.isError, `brain_why failed: ${JSON.stringify(r.result)}`);
  const text = r.result.content[0].text;
  assert.match(text, /^why app\.mjs$/m);
  assert.match(text, /module: demo/, 'the module record claiming app.mjs wins over the path heuristic');
  assert.match(text, /0001-loopback-only/, 'the governing ADR is cited');
  assert.match(text, /Bind strictly to 127\.0\.0\.1/, 'the Decision excerpt IS the answer');
  assert.match(text, /fix: touch app/, 'recent history is included');
  assertProvenance(text);
  assert.ok(Buffer.byteLength(text) < 4000, `why answer must stay token-lean, got ${Buffer.byteLength(text)} bytes`);
});

test('brain_why without a file returns an in-band tool error, not a crash', async () => {
  const r = await withTimeout(server.call(12, 'tools/call', { name: 'brain_why', arguments: {} }), 10_000, 'brain_why empty');
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /needs `file`/);
});

test('brain_leases reports the holder, the TTL and the conflict', async () => {
  const r = await withTimeout(server.call(13, 'tools/call', {
    name: 'brain_leases', arguments: { files: ['app.mjs'], actor: 'seebo' }
  }), 20_000, 'brain_leases');
  const text = r.result.content[0].text;
  assert.match(text, /claude-a/, 'names the holder');
  assert.match(text, /until 2099-01-01T00:00/, 'names the TTL');
  assert.match(text, /conflicts for 1 file\(s\) against actor "seebo": 1/);
  assertProvenance(text);
});

// --- transport hygiene + lifecycle -----------------------------------------

test('stdout carries protocol frames ONLY (every line parses as JSON-RPC)', () => {
  assert.ok(server.stdoutLines.length >= 8, 'the suite exercised the transport');
  for (const line of server.stdoutLines) {
    let frame;
    assert.doesNotThrow(() => { frame = JSON.parse(line); },
      `non-protocol output on stdout would break an MCP host: ${line.slice(0, 200)}`);
    assert.equal(frame.jsonrpc, '2.0', `frame is not JSON-RPC: ${line.slice(0, 200)}`);
    assert.ok('result' in frame || 'error' in frame, `frame is neither a result nor an error: ${line.slice(0, 200)}`);
  }
});

test('server exits cleanly (code 0) when stdin closes', async () => {
  const other = startServer();
  try {
    await withTimeout(other.call(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' }
    }), 15_000, 'initialize');
    const exited = new Promise((resolve) => other.child.on('exit', (code, signal) => resolve({ code, signal })));
    other.child.stdin.end();
    const { code } = await withTimeout(exited, 15_000, 'clean exit');
    assert.equal(code, 0, 'stdin close is a normal shutdown, not a crash');
  } finally {
    other.kill();
  }
});

test('a request still in flight when stdin closes is answered before exit', async () => {
  const other = startServer();
  try {
    const initP = other.call(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' }
    });
    const callP = other.call(2, 'tools/call', { name: 'brain_status', arguments: {} });
    other.child.stdin.end(); // host hangs up immediately after writing
    await withTimeout(initP, 15_000, 'initialize');
    const r = await withTimeout(callP, 30_000, 'in-flight brain_status');
    assert.ok(r.result.content[0].text.length > 0, 'the answer survived the hang-up');
  } finally {
    other.kill();
  }
});

test('--print-config prints a paste-ready MCP host snippet on stdout', async () => {
  const child = spawn(process.execPath, [SCRIPT, '--print-config'], { cwd: FIXTURE, env: CHILD_ENV });
  try {
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const code = await withTimeout(new Promise((resolve) => child.on('exit', resolve)), 15_000, '--print-config');
    assert.equal(code, 0);
    const cfg = JSON.parse(out); // stdout must be pure JSON (hints go to stderr)
    const entry = cfg.mcpServers['project-brain'];
    assert.equal(entry.command, 'node');
    assert.equal(entry.args.length, 1);
    assert.ok(entry.args[0].endsWith('brain-mcp.mjs'));
    assert.ok(path.isAbsolute(entry.args[0]), 'the config must carry an absolute script path');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
});
