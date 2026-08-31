import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeFlag, takeOption, peekOption, splitEnv } from '../scripts/common.mjs';

test('takeFlag removes the flag and returns true when present', () => {
  const args = ['--a', '--b', 'val'];
  assert.equal(takeFlag(args, '--a'), true);
  assert.deepEqual(args, ['--b', 'val']);
});

test('takeFlag returns false and leaves argv untouched when absent', () => {
  const args = ['--b', 'val'];
  assert.equal(takeFlag(args, '--a'), false);
  assert.deepEqual(args, ['--b', 'val']);
});

test('takeOption removes name+value pair and returns value', () => {
  const args = ['--name', 'value', '--other'];
  assert.equal(takeOption(args, '--name'), 'value');
  assert.deepEqual(args, ['--other']);
});

test('takeOption returns empty string when missing', () => {
  const args = ['--other'];
  assert.equal(takeOption(args, '--name'), '');
  assert.deepEqual(args, ['--other']);
});

test('peekOption returns value without mutating argv', () => {
  const args = ['--name', 'value'];
  assert.equal(peekOption(args, '--name'), 'value');
  assert.deepEqual(args, ['--name', 'value']);
});

test('splitEnv splits comma/newline and trims, drops empties', () => {
  process.env.__BRAIN_TEST_SPLITENV = 'a, b\n c,,';
  assert.deepEqual(splitEnv('__BRAIN_TEST_SPLITENV'), ['a', 'b', 'c']);
  delete process.env.__BRAIN_TEST_SPLITENV;
});

test('splitEnv on missing env returns empty array', () => {
  delete process.env.__BRAIN_TEST_MISSING;
  assert.deepEqual(splitEnv('__BRAIN_TEST_MISSING'), []);
});

/* Registration drift.
   A consumer updates by pulling the skill checkout and the CODE arrives — but
   package.json only changes when the installer runs. Pull without
   `brain:update-skill` and the new commands exist on disk and are unreachable:
   npm answers "Missing script: brain:overview" and names no cause. That
   happened three times in one week, twice to me. The detector also caught that
   this repo's OWN package.json was missing three scripts it ships to others. */
test('missingBrainScripts: names what the host cannot reach', async () => {
  const { missingBrainScripts, mergePackageScripts } = await import('../scripts/common.mjs');

  // A host that has never been set up is missing everything.
  const bare = missingBrainScripts({});
  assert.ok(bare.length > 10, `expected a full list, got ${bare.length}`);
  assert.ok(bare.includes('brain:overview'), 'the newest command must be reported');
  assert.deepEqual(bare, [...bare].sort(), 'stable order — a diff of this must be readable');

  // A host the installer has just run is missing nothing.
  const installed = {};
  mergePackageScripts(installed);
  assert.deepEqual(missingBrainScripts(installed), []);

  // Remove one and it is named, alone.
  const drifted = { scripts: { ...installed.scripts } };
  delete drifted.scripts['brain:overview'];
  assert.deepEqual(missingBrainScripts(drifted), ['brain:overview']);

  // Unrelated host scripts are none of our business.
  assert.deepEqual(missingBrainScripts({ scripts: { ...installed.scripts, dev: 'vite' } }), []);
});
