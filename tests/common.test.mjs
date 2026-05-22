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
