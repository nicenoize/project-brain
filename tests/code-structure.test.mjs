import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  measure,
  measureFiles,
  refactorPlan,
  blankSource,
  detectIndentUnit,
  familyOfFile,
  NESTING_STYLE,
  LONG_LINE_CHARS,
  REFACTOR_THRESHOLDS,
  REFACTOR_MOVES,
  STRUCTURE_NOTE
} from '../scripts/code-structure.mjs';

/** Source fixtures are built line-by-line: no escaping games, exact line counts. */
const src = (...lines) => lines.join('\n');

// ---------------------------------------------------------------------------
// language families
// ---------------------------------------------------------------------------

test('familyOfFile: extension table covers brace and indent families, rejects the rest', () => {
  assert.equal(familyOfFile('scripts/a.mjs'), 'js');
  assert.equal(familyOfFile('src/App.tsx'), 'js');
  assert.equal(familyOfFile('main.go'), 'go');
  assert.equal(familyOfFile('lib.rs'), 'rs');
  assert.equal(familyOfFile('index.php'), 'php');
  assert.equal(familyOfFile('app.rb'), 'rb');
  assert.equal(familyOfFile('m.py'), 'py');
  assert.equal(familyOfFile('Main.java'), 'c');
  assert.equal(familyOfFile('ci.yml'), 'yaml');
  assert.equal(familyOfFile('README.md'), '');
  assert.equal(familyOfFile(''), '');
  // the nesting style per family is a declared contract, not an accident
  assert.equal(NESTING_STYLE.js, 'brace');
  assert.equal(NESTING_STYLE.py, 'indent');
  assert.equal(NESTING_STYLE.rb, 'indent');
});

test('measure: unmeasurable extension → explicit zero record with family "" (never a guess)', () => {
  const m = measure('# hello\n\nsome prose\n', { file: 'README.md' });
  assert.equal(m.family, '');
  assert.equal(m.lines, 0);
  assert.equal(m.codeLines, 0);
  assert.equal(m.maxNestingDepth, 0);
  assert.equal(m.functionCount, 0);
  // total function: null/undefined/empty never throw
  assert.equal(measure(null, { file: 'a.mjs' }).codeLines, 0);
  assert.equal(measure('', { file: 'a.mjs' }).lines, 0);
  assert.equal(measure(undefined, {}).family, '');
});

// ---------------------------------------------------------------------------
// brace family — JS/TS, Go, Rust, PHP, C-like
// ---------------------------------------------------------------------------

test('measure (brace/js): lines, codeLines, depth, function spans', () => {
  const m = measure(src(
    '// a comment line',                    // 1  comment → not code
    'export function outer(a) {',           // 2  depth 0, function #1
    '  if (a) {',                           // 3  depth 1
    '    for (const x of a) {',             // 4  depth 2
    '      use(x);',                        // 5  depth 3
    '    }',                                // 6  depth 2
    '  }',                                  // 7  depth 1
    '  return a;',                          // 8  depth 1
    '}',                                    // 9  depth 0
    '',                                     // 10 blank
    'const arrow = (x) => {',               // 11 function #2
    '  return x;',                          // 12
    '};',                                   // 13
    'const inline = list.map((x) => x + 1);' // 14 NOT a function (not line-anchored)
  ), { file: 'a.mjs' });

  assert.equal(m.family, 'js');
  assert.equal(m.nestingStyle, 'brace');
  assert.equal(m.lines, 14);
  assert.equal(m.codeLines, 12); // 14 minus the comment line and the blank line
  assert.equal(m.maxNestingDepth, 3);
  assert.equal(m.functionCount, 2); // the inline callback is deliberately not counted
  assert.equal(m.longestFunctionName, 'outer');
  assert.equal(m.longestFunctionStartLine, 2);
  assert.equal(m.longestFunctionLines, 8); // lines 2..9
  assert.equal(m.longLineCount, 0);
  assert.equal(m.todoCount, 0);
  // avg depth is over CODE lines only
  assert.ok(m.avgNestingDepth > 0 && m.avgNestingDepth < 3);
});

test('measure (brace/js): control-flow keywords are never counted as functions', () => {
  const m = measure(src(
    'function real() {',
    '  if (x) {',
    '  }',
    '  while (y) {',
    '  }',
    '  switch (z) {',
    '  }',
    '  try {',
    '  } catch (e) {',
    '  }',
    '}'
  ), { file: 'a.js' });
  assert.equal(m.functionCount, 1);
  assert.equal(m.longestFunctionName, 'real');
});

test('measure (brace/go, rust, php, java): per-language function keywords', () => {
  const go = measure(src(
    'package main',
    '',
    'func main() {',
    '\tif true {',
    '\t\tprintln("}")',
    '\t}',
    '}',
    '',
    'func (s *Server) Handle(w int) {',
    '\treturn',
    '}'
  ), { file: 'main.go' });
  assert.equal(go.family, 'go');
  assert.equal(go.functionCount, 2);
  assert.equal(go.maxNestingDepth, 2); // the "}" inside the string does NOT count

  const rs = measure(src(
    'pub fn alpha() {',
    '    if true {',
    '        println!("{}", 1);',
    '    }',
    '}',
    'fn beta() -> u32 { 1 }',
    'pub(crate) async unsafe fn gamma() {}'
  ), { file: 'lib.rs' });
  assert.equal(rs.functionCount, 3);
  assert.equal(rs.maxNestingDepth, 2);

  const php = measure(src(
    '<?php',
    'class A {',
    '    public function run() {',
    '        return "{";',
    '    }',
    '}'
  ), { file: 'a.php' });
  assert.equal(php.functionCount, 1);
  assert.equal(php.maxNestingDepth, 2);

  const java = measure(src(
    'public class A {',
    '    public void run(int x) {',
    '        if (x > 0) { y(); }',
    '    }',
    '}'
  ), { file: 'A.java' });
  assert.equal(java.family, 'c');
  assert.equal(java.functionCount, 1); // `class A {` has no parens, `if (x) {` is filtered
});

// ---------------------------------------------------------------------------
// indent family — Python, Ruby, YAML
// ---------------------------------------------------------------------------

test('detectIndentUnit: smallest indent occurring twice, so a one-off alignment cannot win', () => {
  assert.equal(detectIndentUnit([4, 8, 12, 4]), 4);
  assert.equal(detectIndentUnit([2, 4, 6, 2]), 2);
  assert.equal(detectIndentUnit([7, 4, 8, 4]), 4); // the lone 7 (aligned continuation) loses
  assert.equal(detectIndentUnit([]), 4); // no indentation at all → documented default
  assert.equal(detectIndentUnit([3]), 3); // single sample → the only evidence there is
  assert.equal(detectIndentUnit([40]), 8); // clamped
});

test('measure (indent/py): depth from indentation, docstrings are not code', () => {
  const m = measure(src(
    'def outer(a):',            // 1 depth 0, function #1
    '    """Doc line one',      // 2 docstring → blanked
    '    doc line two"""',      // 3 docstring → blanked
    '    if a:',                // 4 depth 1
    '        for x in a:',      // 5 depth 2
    '            use(x)',       // 6 depth 3
    '',                         // 7 blank
    'async def other():',       // 8 depth 0, function #2
    '    return 1'              // 9 depth 1
  ), { file: 'm.py' });

  assert.equal(m.family, 'py');
  assert.equal(m.nestingStyle, 'indent');
  assert.equal(m.lines, 9);
  assert.equal(m.codeLines, 6); // 9 minus 2 docstring lines minus 1 blank
  assert.equal(m.maxNestingDepth, 3);
  assert.equal(m.functionCount, 2);
  assert.equal(m.longestFunctionName, 'outer');
  // outer's body ends before the next line at or above its own depth (line 8)
  assert.equal(m.longestFunctionLines, 6);
});

test('measure (indent/rb, yaml): Ruby by convention, YAML has no functions', () => {
  const rb = measure(src(
    'def alpha',
    '  if true',
    '    puts "{"',
    '  end',
    'end',
    '',
    'def beta',
    '  1',
    'end'
  ), { file: 'a.rb' });
  assert.equal(rb.nestingStyle, 'indent');
  assert.equal(rb.functionCount, 2);
  assert.equal(rb.maxNestingDepth, 2);

  const yaml = measure(src(
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: echo hi',
    'name: ci'
  ), { file: 'ci.yml' });
  assert.equal(yaml.family, 'yaml');
  assert.equal(yaml.functionCount, 0);
  assert.equal(yaml.maxNestingDepth, 3);
});

// ---------------------------------------------------------------------------
// blanking correctness — the whole contract rests on this
// ---------------------------------------------------------------------------

test('blanking: a brace inside a string never raises depth (js, py, go, rb)', () => {
  const js = measure(src(
    'function f() {',
    '  const a = "{{{{";',
    "  const b = '}}}}';",
    '  const c = `{{${x}}}`;',
    '  return a + b + c;',
    '}'
  ), { file: 'a.mjs' });
  assert.equal(js.maxNestingDepth, 1);
  assert.equal(js.codeLines, 6); // the string LINES are still code, only their bodies are blanked

  const go = measure(src('func f() {', '\ts := "{{{"', '}'), { file: 'a.go' });
  assert.equal(go.maxNestingDepth, 1);

  // Python: a brace in a string is irrelevant to indent depth, but the string
  // must still not be mistaken for structure.
  const py = measure(src('def f():', '    s = "{{{"', '    return s'), { file: 'a.py' });
  assert.equal(py.maxNestingDepth, 1);

  const rb = measure(src('def f', '  s = "{{{"', '  s', 'end'), { file: 'a.rb' });
  assert.equal(rb.maxNestingDepth, 1);
});

test('blanking: comments never contribute code lines, depth or function starts', () => {
  const m = measure(src(
    '/* function ghost() {',
    '   still a comment {{{ */',
    'function real() {',
    '  // function alsoGhost() {',
    '  return 1;',
    '}'
  ), { file: 'a.mjs' });
  assert.equal(m.functionCount, 1);
  assert.equal(m.maxNestingDepth, 1);
  assert.equal(m.codeLines, 3); // lines 3, 5, 6
});

test('blanking: a JS regex literal with unbalanced braces and quotes cannot corrupt the file', () => {
  // This is the exact shape that broke the naive scanner: the `"` inside the
  // character class opens a phantom string, and `\{` is an unbalanced brace.
  const m = measure(src(
    'function outer() {',
    '  const t = s.replace(/^["\']|["\']$/g, \'\');',
    '  const u = /[^;{]*\\{[ \\t]*$/.test(t);',
    '  return u;',
    '}',
    'function next() {',
    '  return 1;',
    '}'
  ), { file: 'a.mjs' });
  assert.equal(m.maxNestingDepth, 1, 'a regex brace must not raise depth');
  assert.equal(m.functionCount, 2);
  assert.equal(m.longestFunctionName, 'outer');
  assert.equal(m.longestFunctionLines, 5, 'outer must end at its own closing brace, not at EOF');
});

test('blanking: a division is not a regex, and a glob in a template keeps its delimiters', () => {
  const m = measure(src(
    'function f(a, b) {',
    '  const ratio = a / b;',
    '  const rest = (a + b) / 2;',
    '  const globs = [`**/${a}`, `**/${b}/**`];',
    '  return { ratio, rest, globs };',
    '}',
    'function g() {',
    '  return 2;',
    '}'
  ), { file: 'a.mjs' });
  assert.equal(m.functionCount, 2);
  assert.equal(m.maxNestingDepth, 1);
  assert.equal(m.codeLines, 9);
});

test('blankSource: exposes the blanked text so blanking is checkable, not just inferred', () => {
  const blanked = blankSource('const a = "x{y}z"; // c{d}\n', { file: 'a.mjs' });
  assert.equal(blanked.includes('x{y}z'), false);
  assert.equal(blanked.includes('c{d}'), false);
  assert.equal(blanked.includes('const a ='), true);
  assert.equal(blanked.length, 'const a = "x{y}z"; // c{d}\n'.length); // length preserved
  // non-JS families go through import-graph's scanner and behave the same way
  const py = blankSource('s = "a{b}"  # note{}\n', { file: 'a.py' });
  assert.equal(py.includes('a{b}'), false);
  assert.equal(py.includes('note{}'), false);
});

// ---------------------------------------------------------------------------
// the remaining reported metrics
// ---------------------------------------------------------------------------

test('measure: longLineCount and todoCount read the RAW text (documented, not hidden)', () => {
  const long = 'const x = "' + 'y'.repeat(LONG_LINE_CHARS) + '";';
  const m = measure(src(
    'function f() {',
    long,
    '  // TODO: fix this',
    '  /* FIXME and XXX and HACK */',
    '  return "TODO in a string counts too";',
    '}'
  ), { file: 'a.mjs' });
  assert.equal(m.longLineCount, 1);
  assert.equal(m.todoCount, 5); // TODO, FIXME, XXX, HACK, TODO-in-string
});

test('measure: deterministic — the same source produces byte-identical JSON', () => {
  const source = src('function f() {', '  return { a: 1 };', '}');
  const a = JSON.stringify(measure(source, { file: 'a.mjs' }));
  const b = JSON.stringify(measure(source, { file: 'a.mjs' }));
  assert.equal(a, b);
  // `lang` overrides extension inference (same text, told it is Python)
  assert.equal(measure(source, { file: 'a.mjs', lang: 'py' }).nestingStyle, 'indent');
});

// ---------------------------------------------------------------------------
// measureFiles — total, deterministic, honest about what it could not read
// ---------------------------------------------------------------------------

test('measureFiles: unreadable and unmeasurable files land in `skipped`, never thrown', () => {
  const files = ['b.mjs', 'a.mjs', 'README.md', 'boom.mjs', 'weird.mjs'];
  const readFile = (f) => {
    if (f === 'boom.mjs') throw new Error('EACCES: nope');
    if (f === 'weird.mjs') return 42; // not a string
    return 'function f() {\n  return 1;\n}\n';
  };
  const result = measureFiles({ files, readFile });
  assert.deepEqual(result.files.map((m) => m.file), ['a.mjs', 'b.mjs']); // sorted, byte order
  assert.deepEqual(result.skipped.map((s) => s.file), ['README.md', 'boom.mjs', 'weird.mjs']);
  assert.match(result.skipped[0].reason, /extension not measurable/);
  assert.match(result.skipped[1].reason, /EACCES/);
  assert.match(result.skipped[2].reason, /did not return a string/);
  assert.equal(result.provenance.basis, 'measured');
  assert.equal(result.provenance.source, 'code-structure');
  assert.equal(result.provenance.note, STRUCTURE_NOTE);

  // determinism: input order is irrelevant
  const shuffled = measureFiles({ files: [...files].reverse(), readFile });
  assert.equal(JSON.stringify(result), JSON.stringify(shuffled));
  // total: no readFile at all is an error per file, not a throw
  assert.equal(measureFiles({ files: ['a.mjs'] }).skipped.length, 1);
  assert.deepEqual(measureFiles({}).files, []);
});

// ---------------------------------------------------------------------------
// refactorPlan — every item names the number that fired it
// ---------------------------------------------------------------------------

/** A measure-shaped object below every threshold: the "nothing fires" baseline. */
function calmMeasure(overrides = {}) {
  return {
    file: 'scripts/calm.mjs',
    family: 'js',
    nestingStyle: 'brace',
    lines: 90,
    codeLines: 70,
    maxNestingDepth: 2,
    avgNestingDepth: 1.1,
    longestFunctionLines: 12,
    longestFunctionName: 'small',
    longestFunctionStartLine: 4,
    functionCount: 5,
    longLineCount: 0,
    todoCount: 0,
    ...overrides
  };
}

const calmGraph = { file: 'scripts/calm.mjs', fanIn: 2, fanOut: 3, cycles: [] };
const calmFactors = [
  { name: 'churn-percentile', weight: 0.35, raw: 0.4, contribution: 0.14, evidence: 'churn rank #10 of 20' },
  { name: 'bus-factor', weight: 0.2, raw: 0.5, contribution: 0.1, evidence: 'bus factor 2 — Ann owns 50%' },
  { name: 'fix-density', weight: 0.25, raw: 0.1, contribution: 0.025, evidence: '1 of 10 commits are fix/revert commits (10%)' }
];

test('refactorPlan: nothing fires → empty list, never filler advice', () => {
  assert.deepEqual(refactorPlan(calmMeasure(), calmGraph, calmFactors), []);
  assert.deepEqual(refactorPlan(null, null, null), []);
  assert.deepEqual(refactorPlan(undefined, undefined, []), []);
  assert.deepEqual(refactorPlan({}, {}, {}), []);
});

test('refactorPlan: split-file names the line and function counts that fired it', () => {
  const plan = refactorPlan(
    calmMeasure({ codeLines: 2632, functionCount: 28 }), calmGraph, calmFactors);
  const item = plan.find((p) => p.move === 'split-file');
  assert.ok(item, 'split-file must fire');
  assert.match(item.why, /2,632 code lines across 28 functions/);
  assert.match(item.why, /split by responsibility/);
  assert.match(item.evidence, /codeLines 2632 ≥ 400/);
  assert.match(item.evidence, /functions 28 ≥ 12/);
  // long but simple (few functions) is NOT a split candidate
  assert.equal(
    refactorPlan(calmMeasure({ codeLines: 2632, functionCount: 3 }), calmGraph, calmFactors)
      .some((p) => p.move === 'split-file'),
    false);
});

test('refactorPlan: extract-function names the function and its span', () => {
  const plan = refactorPlan(
    calmMeasure({ longestFunctionLines: 147, longestFunctionName: 'parseDoc', longestFunctionStartLine: 459 }),
    calmGraph, calmFactors);
  const item = plan.find((p) => p.move === 'extract-function');
  assert.match(item.why, /`parseDoc` spans 147 lines from line 459/);
  assert.match(item.evidence, /longestFunctionLines 147 ≥ 60/);
  // exactly at the threshold fires; one below stays silent
  const edge = REFACTOR_THRESHOLDS.longFunctionLines;
  assert.ok(refactorPlan(calmMeasure({ longestFunctionLines: edge }), calmGraph, calmFactors)
    .some((p) => p.move === 'extract-function'));
  assert.equal(refactorPlan(calmMeasure({ longestFunctionLines: edge - 1 }), calmGraph, calmFactors)
    .some((p) => p.move === 'extract-function'), false);
});

test('refactorPlan: reduce-nesting quotes the depth and the counting style', () => {
  const plan = refactorPlan(
    calmMeasure({ maxNestingDepth: 8, avgNestingDepth: 3.4 }), calmGraph, calmFactors);
  const item = plan.find((p) => p.move === 'reduce-nesting');
  assert.match(item.why, /nesting reaches depth 8 \(average 3\.4\)/);
  assert.match(item.evidence, /maxNestingDepth 8 ≥ 6 \(brace counting\)/);
});

test('refactorPlan: break-cycle renders the actual cycle, and only for a member file', () => {
  const graph = {
    file: 'scripts/common.mjs',
    fanIn: 3,
    fanOut: 2,
    cycles: [['scripts/common.mjs', 'scripts/friction.mjs'], ['x.mjs', 'y.mjs']]
  };
  const item = refactorPlan(calmMeasure({ file: 'scripts/common.mjs' }), graph, calmFactors)
    .find((p) => p.move === 'break-cycle');
  assert.equal(item.evidence,
    'cycle: scripts/common.mjs → scripts/friction.mjs → scripts/common.mjs');
  assert.match(item.why, /invert one edge/);
  // a file not in any cycle gets no cycle advice
  assert.equal(
    refactorPlan(calmMeasure({ file: 'scripts/other.mjs' }), { ...graph, file: 'scripts/other.mjs' }, calmFactors)
      .some((p) => p.move === 'break-cycle'),
    false);
});

test('refactorPlan: reduce-fan-in fires on importers, and sharpens when it is a hub both ways', () => {
  const oneWay = refactorPlan(calmMeasure(), { ...calmGraph, fanIn: 76, fanOut: 2 }, calmFactors)
    .find((p) => p.move === 'reduce-fan-in');
  assert.match(oneWay.why, /^76 file\(s\) import this — extract the stable core/);
  assert.equal(oneWay.evidence, 'fanIn 76 ≥ 20');

  const bothWays = refactorPlan(calmMeasure(), { ...calmGraph, fanIn: 76, fanOut: 30 }, calmFactors)
    .find((p) => p.move === 'reduce-fan-in');
  assert.match(bothWays.why, /while it imports 30 — a hub in both directions/);
  assert.match(bothWays.evidence, /fanOut 30 ≥ 15/);

  // a widely-imported leaf below the threshold stays silent
  assert.equal(
    refactorPlan(calmMeasure(), { ...calmGraph, fanIn: 19, fanOut: 40 }, calmFactors)
      .some((p) => p.move === 'reduce-fan-in'),
    false);
});

test('refactorPlan: add-tests and add-owner reuse the health factor evidence verbatim', () => {
  const factors = [
    { name: 'fix-density', weight: 0.25, raw: 0.42, contribution: 0.105, evidence: '5 of 12 commits are fix/revert commits (42%)' },
    { name: 'bus-factor', weight: 0.2, raw: 1, contribution: 0.2, evidence: 'bus factor 1 — Ann owns 100% of 12 commits' }
  ];
  const plan = refactorPlan(calmMeasure(), calmGraph, factors);
  const tests = plan.find((p) => p.move === 'add-tests');
  assert.match(tests.why, /42% of its commits are repairs/);
  assert.equal(tests.evidence, '5 of 12 commits are fix/revert commits (42%)');
  const owner = plan.find((p) => p.move === 'add-owner');
  assert.match(owner.why, /bus factor 1/);
  assert.equal(owner.evidence, 'bus factor 1 — Ann owns 100% of 12 commits');

  // a fileHealth ENTRY works as well as a bare factor array
  assert.deepEqual(refactorPlan(calmMeasure(), calmGraph, { file: 'x', factors }), plan);
  // healthy history stays silent
  assert.equal(refactorPlan(calmMeasure(), calmGraph, calmFactors).length, 0);
});

test('refactorPlan: emission order is fixed and thresholds are overridable', () => {
  const plan = refactorPlan(
    calmMeasure({ codeLines: 900, functionCount: 30, longestFunctionLines: 200, maxNestingDepth: 9 }),
    { file: 'scripts/calm.mjs', fanIn: 40, fanOut: 40, cycles: [['scripts/calm.mjs', 'z.mjs']] },
    [{ name: 'fix-density', weight: 0.25, raw: 0.9, contribution: 0.2, evidence: '9 of 10 are fixes' },
      { name: 'bus-factor', weight: 0.2, raw: 1, contribution: 0.2, evidence: 'bus factor 1' }]
  );
  assert.deepEqual(plan.map((p) => p.move), REFACTOR_MOVES);
  // every item is fully populated — no move without a why and an evidence number
  for (const item of plan) {
    assert.ok(item.why.length > 10, item.move);
    assert.ok(item.evidence.length > 0, item.move);
  }
  // deterministic
  assert.equal(JSON.stringify(plan), JSON.stringify(refactorPlan(
    calmMeasure({ codeLines: 900, functionCount: 30, longestFunctionLines: 200, maxNestingDepth: 9 }),
    { file: 'scripts/calm.mjs', fanIn: 40, fanOut: 40, cycles: [['scripts/calm.mjs', 'z.mjs']] },
    [{ name: 'fix-density', weight: 0.25, raw: 0.9, contribution: 0.2, evidence: '9 of 10 are fixes' },
      { name: 'bus-factor', weight: 0.2, raw: 1, contribution: 0.2, evidence: 'bus factor 1' }]
  )));

  // thresholds are reviewable defaults, not constants baked into the rules
  const strict = refactorPlan(calmMeasure(), calmGraph, calmFactors,
    { thresholds: { splitCodeLines: 10, splitFunctions: 1 } });
  assert.deepEqual(strict.map((p) => p.move), ['split-file']);
});
