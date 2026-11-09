import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERBS, usage, parseTokens, withCompactionMark, listScripts } from '../bin/leanlamp.mjs';

const BIN = fileURLToPath(new URL('../bin/leanlamp.mjs', import.meta.url));
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0', ...(opts.env || {}) }, cwd: opts.cwd });

test('nine verbs, the rest under x', () => {
  assert.deepEqual(VERBS.map(([v]) => v), ['init', 'open', 'status', 'recall', 'steer', 'hold', 'compact', 'receipt', 'sessions']);
  assert.match(usage(), /less context, same agent/);
  assert.ok(listScripts().includes('companion'));
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /receipt/);
  assert.equal(run(['nope']).status, 2);
  assert.equal(run(['x', 'no-such-thing']).status, 2);
});

test('token counts and the compaction mark', () => {
  assert.equal(parseTokens('300k'), 300_000);
  assert.equal(parseTokens('1M'), 1_000_000);
  assert.equal(parseTokens('250000'), 250_000);
  assert.throws(() => parseTokens('lots'), /not a token count/);
  const r = withCompactionMark({ env: { FOO: '1' }, model: 'x' }, 300_000);
  assert.deepEqual(r.settings, { env: { FOO: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, model: 'x' });
  assert.equal(r.before, null);
});

test('compact writes the personal mark by default, reports what wins, keeps shared settings untouched', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  const env = { CLAUDE_CONFIG_DIR: path.join(repo, 'no-user-config'), BRAIN_HOME: path.join(repo, 'brain-home') }; // backups and the ledger stay in the test
  assert.match(run(['compact'], { cwd: repo, env }).stdout, /model's default/);
  assert.match(run(['compact', '--at', '300k', '--dry-run'], { cwd: repo, env }).stdout, /would set CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 in .*settings\.local\.json/);
  const r = run(['compact', '--at', '300k'], { cwd: repo, env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')), { permissions: { allow: ['Bash(npm test)'] } }, 'the team file is untouched');
  assert.ok(!fs.readdirSync(path.join(repo, '.claude')).some((f) => f.includes('.bak')), 'no backups in the repo');
  assert.match(run(['compact'], { cwd: repo, env }).stdout, /compacts at 300k \(settings\.local\)/);
  // a shared mark under a personal one does not win, and says so
  const s = run(['compact', '--at', '400k', '--shared'], { cwd: repo, env });
  assert.equal(s.status, 1);
  assert.match(s.stdout, /300k \(settings\.local\) wins/);
  assert.equal(run(['compact', '--at', '10k'], { cwd: repo, env }).status, 2);
});

test('steer and hold go through the companion with its state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-bus-'));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ v: 1, atMs: Date.now(), sessions: [{ id: 'abcd1234-0000', title: 'billing refactor', state: 'tool', control: true }] }));
  const r = run(['steer', '--state', state, 'billing', 'keep it --no-verify --all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /billing refactor/);
  const inbox = fs.readdirSync(path.join(dir, 'inbox'))[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'inbox', inbox), 'utf8').trim()).text, 'keep it --no-verify --all');
  const h = run(['hold', '--all', '--for', '10m', '--state', state]);
  assert.equal(h.status, 0, h.stderr);
  assert.equal(run(['hold', 'release', '--all', '--state', state]).status, 0);
});

import { needsBuild, appHome } from '../bin/leanlamp.mjs';

test('open: the built app is reused until the version or the engine changes', () => {
  const want = { version: '1.2.0', engine: '/x/scripts/brain-companion.mjs' };
  assert.equal(needsBuild(null, want), true, 'never built');
  assert.equal(needsBuild({ ...want, builtAt: 'yesterday' }, want), false);
  assert.equal(needsBuild({ ...want, version: '1.1.0' }, want), true, 'upgraded');
  assert.equal(needsBuild({ ...want, engine: '/old/scripts/brain-companion.mjs' }, want), true, 'moved');
  assert.equal(appHome({ BRAIN_HOME: '/tmp/bh' }), '/tmp/bh/app');
});

test('init --undo puts back exactly what leanlamp changed, and leaves what others changed since', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-undo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const home = path.join(repo, 'brain-home');
  const userSettings = path.join(repo, 'user-settings.json');
  const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  fs.writeFileSync(userSettings, JSON.stringify(original));
  const env = { CLAUDE_CONFIG_DIR: path.join(repo, 'no-user-config'), BRAIN_HOME: home };
  const companion = fileURLToPath(new URL('../scripts/brain-companion.mjs', import.meta.url));
  const hooked = spawnSync(process.execPath, [companion, 'install-hooks', '--settings', userSettings], { encoding: 'utf8', env: { ...process.env, ...env, BRAIN_USAGE_LOG: '0' } });
  assert.equal(hooked.status, 0, hooked.stderr);
  assert.equal(run(['compact', '--at', '300k'], { cwd: repo, env }).status, 0);
  const local = path.join(repo, '.claude', 'settings.local.json');
  assert.ok(fs.existsSync(local), 'compact created the personal file');

  const dry = run(['init', '--undo', '--dry-run'], { cwd: repo, env });
  assert.match(dry.stdout, /would remove the companion hook/);
  assert.match(fs.readFileSync(userSettings, 'utf8'), /brain-companion-hook/, 'a dry run changes nothing');

  const r = run(['init', '--undo'], { cwd: repo, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(userSettings, 'utf8')), original, 'the user settings are as they were');
  assert.equal(fs.existsSync(local), false, 'the file leanlamp created is gone');
  assert.match(run(['init', '--undo'], { cwd: repo, env }).stdout, /nothing to put back/);

  // a mark someone changed after leanlamp set it stays
  assert.equal(run(['compact', '--at', '300k'], { cwd: repo, env }).status, 0);
  fs.writeFileSync(local, JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } }));
  const kept = run(['init', '--undo'], { cwd: repo, env });
  assert.equal(kept.status, 1);
  assert.match(kept.stdout, /changed since \(now 250000\) — left as is/);
  assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000');
});

import { planUndo } from '../bin/leanlamp.mjs';
import { removeHook } from '../scripts/brain-companion.mjs';

const K = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const hookGroup = (event) => (event === 'PreToolUse' ? [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/x/scripts/brain-companion-hook.mjs"' }] }] : [{ hooks: [{ type: 'command', command: 'node "/x/scripts/brain-companion-hook.mjs"' }] }]);
const plan1 = (changes, files) => planUndo(changes, (f) => files[f], removeHook);

test('undo walks marks back newest first and keeps a value the user set in between', () => {
  const changes = [
    { kind: 'mark', file: 'F', key: K, before: null, after: '300000', created: true },
    { kind: 'mark', file: 'F', key: K, before: '250000', after: '400000' }
  ];
  const [p] = plan1(changes, { F: { env: { [K]: '400000' }, model: 'opus' } });
  assert.deepEqual(p.next, { env: { [K]: '250000' }, model: 'opus' }, "the user's 250k comes back, not nothing");
  assert.equal(p.write, true);
  assert.equal(p.kept, false);
});

test('undo: a half-done earlier undo, an unreadable file, a mark removed by hand', () => {
  const half = plan1([{ kind: 'mark', file: 'F', key: K, before: '200000', after: '300000' }], { F: { env: { [K]: '200000' } } })[0];
  assert.equal(half.kept, false, 'already back: not "changed since"');
  assert.equal(half.write, false);
  const bad = plan1([{ kind: 'hook', file: 'F', action: 'added' }], { F: null })[0];
  assert.equal(bad.kept, true);
  assert.equal(bad.keep.length, 1, 'stays in the ledger for the next run');
  const gone = plan1([{ kind: 'mark', file: 'F', key: K, before: null, after: '300000' }], { F: { model: 'x' } })[0];
  assert.equal(gone.kept, false);
  assert.match(gone.done[0][0], /gone already/);
});

test('undo: hook and mark in one file leanlamp created leave no empty file behind; a re-added hook comes out', () => {
  const settings = { hooks: { PreToolUse: hookGroup('PreToolUse'), UserPromptSubmit: hookGroup('UserPromptSubmit') }, env: { [K]: '300000' } };
  const both = plan1([
    { kind: 'hook', file: 'F', action: 'added', created: true },
    { kind: 'mark', file: 'F', key: K, before: null, after: '300000' }
  ], { F: settings })[0];
  assert.equal(both.remove, true);
  const again = plan1([
    { kind: 'hook', file: 'G', action: 'added' }, { kind: 'hook', file: 'G', action: 'removed' }, { kind: 'hook', file: 'G', action: 'added' }
  ], { G: { model: 'opus', hooks: { PreToolUse: hookGroup('PreToolUse') } } })[0];
  assert.deepEqual(again.next, { model: 'opus' });
  assert.equal(again.remove, false, 'not created by leanlamp: kept, even if it were empty');
});

test('compact refuses outside a repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-norepo-'));
  const r = run(['compact', '--at', '300k'], { cwd: dir, env: { BRAIN_HOME: path.join(dir, 'bh'), GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not in a git repository/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

import { fromNpxCache } from '../bin/leanlamp.mjs';

test('init and open refuse to run from the npx cache', () => {
  assert.equal(fromNpxCache('/Users/a/.npm/_npx/3f2a1b/node_modules/leanlamp'), true);
  assert.equal(fromNpxCache('/opt/homebrew/lib/node_modules/leanlamp'), false);
  assert.equal(fromNpxCache('/Users/a/Coding/project-brain'), false);
});

import { HELP } from '../bin/leanlamp.mjs';

test('every verb has help, and --help never acts', () => {
  for (const [v] of VERBS) assert.ok(HELP[v], `help for ${v}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-help-'));
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, '{}');
  const env = { CLAUDE_CONFIG_DIR: home, BRAIN_HOME: path.join(home, 'bh') };
  for (const v of ['init', 'open', 'compact', 'hold', 'steer', 'receipt', 'status']) {
    const r = run([v, '--help'], { cwd: home, env });
    assert.equal(r.status, 0, `${v} --help`);
    assert.match(r.stdout, new RegExp(`^leanlamp ${v}`), `${v} --help prints its own help`);
  }
  assert.equal(fs.readFileSync(settings, 'utf8'), '{}', 'init --help wrote nothing');
  assert.equal(fs.existsSync(path.join(home, 'bh')), false, 'nothing was built or recorded');
});

test('a steer note may say --help', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-steerhelp-'));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ v: 1, atMs: Date.now(), sessions: [{ id: 'abcd1234-0000', title: 'billing refactor', state: 'tool', control: true }] }));
  const r = run(['steer', '--state', state, 'billing', 'please', 'run', '--help', 'first'], { env: { BRAIN_HOME: path.join(dir, 'bh') } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /steer → billing refactor/);
  const inbox = fs.readdirSync(path.join(dir, 'inbox'));
  assert.match(fs.readFileSync(path.join(dir, 'inbox', inbox[0]), 'utf8'), /please run --help first/);
});

test('mistakes get a leanlamp message, a way forward and a non-zero exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leanlamp-errors-'));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ v: 1, atMs: Date.now(), sessions: [{ id: 'abcd1234-0000', title: 'billing refactor', state: 'tool', control: true }] }));
  const env = { BRAIN_HOME: path.join(dir, 'bh') };
  const miss = run(['steer', '--state', state, 'nosuch', 'hi'], { env });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /^leanlamp: no session matches "nosuch" — there are: abcd1234 billing refactor/);
  const days = run(['receipt', '--days', 'x', '--state', state], { env });
  assert.equal(days.status, 1);
  assert.match(days.stderr, /--days takes a whole number/);
  assert.equal(run(['recall'], { env }).status, 2);
  assert.match(run(['hold', 'approve', '--state', state], { env }).stderr, /WAITING line of leanlamp status/);
});
