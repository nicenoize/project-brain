/**
 * brain:outline — read ONE function instead of a whole file.
 *
 * An agent that needs `calibrateFileHealth` reads all 1,300 lines of
 * git-intel.mjs to get 90 of them, on every file it touches. The measurement
 * already existed: code-structure.mjs walked every function span to report the
 * longest one and never handed the list over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlineOf } from '../scripts/brain-outline.mjs';
import { measure } from '../scripts/code-structure.mjs';

const SRC = [
  'export function plain(a, b) {',            // 1
  '  return a + b;',
  '}',
  '',
  'export function destructured(root, { budget }) {',   // 5
  '  const x = { a: 1 };',
  '  return x;',
  '}',
  '',
  'export function defaulted(m = {}) {',       // 10
  '  if (m) {',
  '    return 1;',
  '  }',
  '  return 0;',
  '}'
].join('\n');

test('outlineOf: braces in a parameter list are not the body closing', () => {
  // `function f(m = {}) {` opened AND closed a brace before the body started,
  // so the scan ended the function on its own signature line and reported it as
  // 1 line. That also under-reported longestFunctionLines, which is a
  // structural factor in the danger score — the bug was never only cosmetic.
  const o = outlineOf(SRC, 'x.mjs');
  const by = new Map(o.symbols.map((s) => [s.name, s]));

  assert.equal(by.get('plain').startLine, 1);
  assert.equal(by.get('plain').lines, 3);

  assert.equal(by.get('destructured').startLine, 5);
  assert.equal(by.get('destructured').lines, 4, 'a destructured parameter must not end the function');

  assert.equal(by.get('defaulted').startLine, 10);
  assert.equal(by.get('defaulted').lines, 6, 'a defaulted `= {}` must not end the function');

  // Every span must lie inside the file.
  const total = SRC.split('\n').length;
  for (const s of o.symbols) {
    assert.ok(s.endLine <= total, `${s.name} ends past EOF`);
    assert.ok(s.startLine <= s.endLine, `${s.name} ends before it starts`);
  }
});

test('outlineOf: the outline cannot disagree with the metrics beside it', () => {
  const o = outlineOf(SRC, 'x.mjs');
  const m = measure(SRC, { file: 'x.mjs' });
  assert.equal(o.functionCount, m.functionCount);
  assert.equal(o.lines, m.lines);
  // The longest span in the outline IS the one measure reports.
  const longest = o.symbols.reduce((a, b) => (b.lines > a.lines ? b : a));
  assert.equal(longest.lines, m.longestFunctionLines);
  assert.equal(longest.name, m.longestFunctionName);
});

test('outlineOf: degenerate input yields an empty outline, never a throw', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const o = outlineOf(bad, 'x.mjs');
    assert.deepEqual(o.symbols, []);
    assert.equal(o.functionCount, 0);
  }
  // A language with no declaration patterns is empty, not wrong.
  assert.deepEqual(outlineOf('hello world', 'notes.txt').symbols, []);
});
