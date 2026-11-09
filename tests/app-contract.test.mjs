// The companion app drives the engine through its CLI (Actions.swift:
// `node brain-companion.mjs --state <file> --json <verb> …`). These tests make
// the app's own calls against a scratch bus, so a change to the CLI cannot
// silently break a button. Calls that would change this machine (installing
// the hook into real settings, stopping real processes) run as dry runs; their
// writing paths are covered elsewhere with explicit target files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'scripts', 'brain-companion.mjs');
const ACTIONS = path.join(ROOT, 'companion', 'Sources', 'Leanlamp', 'Actions.swift');
const SID = '1b2c3d4e-0000-4000-8000-000000000001';

/** The verbs the app sends, read from its source. */
function appVerbs() {
  const src = fs.readFileSync(ACTIONS, 'utf8');
  const verbs = new Set();
  for (const m of src.matchAll(/run\(\[\s*"([a-z-]+)"/g)) verbs.add(m[1]);
  for (const m of src.matchAll(/answer\(id, "([a-z]+)"\)/g)) verbs.add(m[1]);
  return verbs;
}

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'app-contract-'));
  const bus = path.join(home, 'bus');
  fs.mkdirSync(path.join(bus, 'pending'), { recursive: true });
  const state = path.join(bus, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ v: 1, atMs: Date.now(), sessions: [{ id: SID, title: 'billing refactor', project: 'acme', state: 'tool', control: true }] }));
  const roots = path.join(home, 'transcripts');
  fs.mkdirSync(roots);
  const env = { ...process.env, BRAIN_HOME: path.join(home, 'brain-home'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), BRAIN_COMPANION_FROM: 'app', BRAIN_USAGE_LOG: '0', BRAIN_SCRATCH_ROOT: home, BRAIN_LEFTOVER_MIN_AGE_SEC: '0' }; // clean must never reach this machine's real leftovers
  delete env.LEANLAMP_CLI;
  // exactly as Actions.run builds it: flags first, then the verb and its words
  const app = (...args) => spawnSync(process.execPath, [ENGINE, '--state', state, '--json', ...args], { encoding: 'utf8', env, cwd: home });
  return { home, bus, state, roots, app };
}

const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

// verb → a call the way the app makes it (dry where the real one would change this machine)
const CONTRACT = {
  steer: (s) => {
    const r = s.app('steer', SID.slice(0, 8), '--', 'keep --no-verify off');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(json(r).ok, true);
    const [note] = fs.readdirSync(path.join(s.bus, 'inbox'));
    assert.match(fs.readFileSync(path.join(s.bus, 'inbox', note), 'utf8'), /keep --no-verify off/);
  },
  hold: (s) => {
    const r = s.app('hold', '--all', '--for', '30m');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(json(r).hold.glob, '**');
  },
  release: (s) => {
    s.app('hold', '--all', '--for', '30m');
    const r = s.app('release', '--all');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(json(r).released, 1);
  },
  approve: (s) => answer(s, 'approve', 'allow'),
  deny: (s) => answer(s, 'deny', 'deny'),
  receipt: (s) => {
    const r = spawnSync(process.execPath, [ENGINE, '--state', s.state, '--json', 'receipt', '--write', '--roots', s.roots], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0', BRAIN_HOME: path.join(s.home, 'bh') } });
    assert.equal(r.status, 0, `the app's Recompute (no --days) failed: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(s.bus, 'receipt.json')));
  },
  park: (s) => {
    // a stand-in session: a process, its registry entry, a transcript, quiet for a day
    // orphaned on purpose: launchd reaps it, as a terminal reaps a real session (our own child would stay a zombie)
    const child = { pid: Number(spawnSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim()) };
    child.kill = () => process.kill(child.pid, 'SIGKILL');
    try {
      const cfg = path.join(s.home, 'claude'), cwd = path.join(s.home, 'work');
      fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
      const sid = 'park-contract-' + process.pid;
      fs.writeFileSync(path.join(cfg, 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: sid, cwd, name: 'export', status: 'idle', kind: 'interactive', startedAt: Date.now() - 1000 }));
      const tdir = path.join(cfg, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(tdir, { recursive: true });
      fs.writeFileSync(path.join(tdir, `${sid}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 86_400_000).toISOString(), message: { content: 'build the export' } }) + '\n');
      const r = s.app('park', sid);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.equal(json(r).ok, true);
      const card = JSON.parse(fs.readFileSync(path.join(s.home, 'brain-home', 'companion', 'parked', `${sid}.json`), 'utf8'));
      assert.equal(card.goal, 'build the export');
    } finally { try { child.kill(); } catch { /* ended by park */ } }
  },
  resume: (s) => {
    const dir = path.join(s.home, 'brain-home', 'companion', 'parked');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc.json'), JSON.stringify({ sessionId: 'abc', name: 'export', project: 'w', cwd: '/w', configDir: path.join(os.homedir(), '.claude'), parkedAt: 1 }));
    const r = s.app('resume', 'abc', '--dry-run'); // the app runs it without --dry-run: that opens Terminal
    assert.equal(r.status, 0, r.stderr);
    assert.match(json(r).command, /claude --resume abc/);
  },
  clean: (s) => {
    // a server a closed session left in its scratchpad (the owner id is no open session)
    const pad = path.join(s.home, 'claude-501', 'proj', '00000000-0000-4000-8000-00000000c1ea', 'scratchpad');
    fs.mkdirSync(pad, { recursive: true });
    const pid = Number(spawnSync('sh', ['-c', `cd '${pad}' && exec sleep 60 >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim());
    try {
      const r = s.app('clean');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(json(r).stopped >= 1, r.stdout);
      let up = true; try { process.kill(pid, 0); } catch { up = false; }
      assert.equal(up, false, 'the leftover is gone');
    } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* stopped */ } }
  },
  reclaim: (s) => {
    const r = s.app('reclaim', '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(json(r), 'JSON for the app');
  },
  'install-hooks': (s) => {
    const r = s.app('install-hooks', '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    const out = json(r);
    assert.ok(Array.isArray(out.targets) && typeof out.installed === 'boolean', 'Connect reads targets and installed');
  },
  'uninstall-hooks': (s) => {
    const r = s.app('uninstall-hooks', '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(json(r));
  },
  check: (s) => {
    const r = s.app('check');
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const out = json(r);
    assert.ok(out && Array.isArray(out.checks) && out.checks.every((c) => c.id && c.status && c.text), 'SetupReport decodes these fields');
  }
};

function answer(s, verb, decision) {
  const id = 'p-app-contract';
  fs.writeFileSync(path.join(s.bus, 'pending', `${id}.json`), JSON.stringify({ id, session: SID, tool: 'Edit', file: '/x/a.ts', at: Date.now(), deadline: Date.now() + 45_000 }));
  const r = s.app(verb, id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).decision, decision);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.bus, 'answers', `${id}.json`), 'utf8')).decision, decision);
}

test('every verb the app sends is in the contract', () => {
  const missing = [...appVerbs()].filter((v) => !CONTRACT[v]);
  assert.deepEqual(missing, [], `Actions.swift calls verbs this test does not cover: ${missing.join(', ')}`);
  assert.ok(appVerbs().size >= 10, 'the source was read');
});

for (const [verb, call] of Object.entries(CONTRACT)) {
  test(`the app's ${verb} call works`, () => call(scratch()));
}
