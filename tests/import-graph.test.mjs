import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LANG_BY_EXT,
  langOf,
  familyOf,
  scanSource,
  parseImports,
  resolveSpec,
  resolveSpecWithConfidence,
  parseTsconfigPaths,
  defaultRoots,
  buildImportGraph,
  dependents,
  cycles,
  fanIn,
  fanOut,
  orphans,
  defaultEntryPoints,
  globToRegExp,
  SCAN_NOTE,
  ORPHAN_CAVEAT
} from '../scripts/import-graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = path.join(here, '..', 'scripts', 'brain-graph-scan.mjs');

/** Compact assertion helper: does the parse contain this exact {spec, kind}? */
function has(list, spec, kind) {
  return list.some((e) => e.spec === spec && e.kind === kind);
}

// ---------------------------------------------------------------------------
// language table
// ---------------------------------------------------------------------------

test('langOf / familyOf: extension table covers the six supported families', () => {
  assert.equal(langOf('scripts/a.mjs'), 'js');
  assert.equal(langOf('src/A.TSX'), 'ts');
  assert.equal(langOf('a/b.py'), 'py');
  assert.equal(langOf('a/b.go'), 'go');
  assert.equal(langOf('a/b.rb'), 'rb');
  assert.equal(langOf('a/b.php'), 'php');
  assert.equal(langOf('a/b.rs'), 'rs');
  assert.equal(langOf('README.md'), '');
  assert.equal(langOf(''), '');
  assert.equal(familyOf('ts'), 'js');
  assert.equal(familyOf('md'), '');
  // The table is frozen so a caller cannot silently widen language support.
  assert.throws(() => { LANG_BY_EXT['.foo'] = 'foo'; }, TypeError);
});

// ---------------------------------------------------------------------------
// parseImports — JS / TS
// ---------------------------------------------------------------------------

test('parseImports js: import/from/export-from/require/dynamic all recognised with kinds', () => {
  const src = [
    "import fs from 'node:fs';",
    "import { a, b } from './a.mjs';",
    "import './side-effect.mjs';",
    "export { c } from './c.mjs';",
    "export * from './star.mjs';",
    "const dep = require('./legacy.cjs');",
    "const lazy = await import('./lazy.mjs');",
    "import type { T } from './types.ts';"
  ].join('\n');
  const imports = parseImports(src, { file: 'scripts/x.mjs' });

  assert.ok(has(imports, 'node:fs', 'from'));
  assert.ok(has(imports, './a.mjs', 'from'));
  assert.ok(has(imports, './side-effect.mjs', 'import'));
  assert.ok(has(imports, './c.mjs', 'from'));
  assert.ok(has(imports, './star.mjs', 'from'));
  assert.ok(has(imports, './legacy.cjs', 'require'));
  assert.ok(has(imports, './lazy.mjs', 'dynamic'));
  assert.ok(has(imports, './types.ts', 'from'));
  // Line numbers are 1-based and track the source, not the scrubbed copy.
  assert.equal(imports.find((e) => e.spec === './side-effect.mjs').line, 3);
  assert.equal(imports.find((e) => e.spec === './lazy.mjs').line, 7);
});

test('parseImports js: multi-line import lists and `import x, {y} from` resolve to one from-edge', () => {
  const src = [
    'import defaultExport, {',
    '  alpha,',
    '  beta',
    "} from './wide.mjs';"
  ].join('\n');
  const imports = parseImports(src, { file: 'scripts/x.mjs' });
  assert.equal(imports.length, 1);
  assert.equal(imports[0].spec, './wide.mjs');
  assert.equal(imports[0].kind, 'from');
});

test('parseImports js: comments and strings never produce false positives', () => {
  const src = [
    "// import ghost from './ghost.mjs';",
    '/*',
    " * require('./block-ghost.mjs')",
    ' */',
    "const snippet = \"require('./string-ghost.mjs')\";",
    "const tpl = `import './tpl-ghost.mjs'`;",
    "const notAnImport = { from: './object-key.mjs' };",
    "const arr = Array.from('abc');",
    "import real from './real.mjs';"
  ].join('\n');
  const imports = parseImports(src, { file: 'scripts/x.mjs' });
  assert.deepEqual(imports, [{ spec: './real.mjs', kind: 'from', line: 9 }]);
});

test('parseImports js: require.resolve and computed require are not mistaken for edges', () => {
  const src = [
    "const p = require.resolve('./a.mjs');",
    'const mod = require(base + name);'
  ].join('\n');
  assert.deepEqual(parseImports(src, { file: 'scripts/x.cjs' }), []);
});

// ---------------------------------------------------------------------------
// parseImports — Python
// ---------------------------------------------------------------------------

test('parseImports py: plain, dotted, aliased, comma-listed and relative forms', () => {
  const src = [
    'import os',
    'import a.b',
    'import x.y as xy, z',
    'from a.b import c',
    'from . import sibling',
    'from .mod import thing',
    'from ..pkg.deep import other',
    '    import indented_conditional  # inside a function',
    '# import commented',
    '"""',
    'import docstring_ghost',
    '"""'
  ].join('\n');
  const imports = parseImports(src, { file: 'src/app.py' });

  assert.ok(has(imports, 'os', 'import'));
  assert.ok(has(imports, 'a.b', 'import'));
  assert.ok(has(imports, 'x.y', 'import'));
  assert.ok(has(imports, 'z', 'import'));
  assert.ok(has(imports, 'a.b', 'from'));
  assert.ok(has(imports, '.', 'from'));
  assert.ok(has(imports, '.mod', 'from'));
  assert.ok(has(imports, '..pkg.deep', 'from'));
  assert.ok(has(imports, 'indented_conditional', 'import'));
  assert.ok(!has(imports, 'commented', 'import'));
  assert.ok(!imports.some((e) => e.spec.includes('docstring_ghost')));
});

// ---------------------------------------------------------------------------
// parseImports — Go
// ---------------------------------------------------------------------------

test('parseImports go: single and grouped import blocks, aliases, string guard', () => {
  const src = [
    'package main',
    '',
    'import "fmt"',
    'import alias "example.com/m/pkg/one"',
    '',
    'import (',
    '\t"os"',
    '\tutil "example.com/m/pkg/util"',
    '\t// "example.com/m/pkg/commented"',
    ')',
    '',
    'const s = "example.com/m/pkg/instring"',
    'const raw = `import "example.com/m/pkg/raw"`'
  ].join('\n');
  const imports = parseImports(src, { file: 'pkg/svc/svc.go' });

  assert.ok(has(imports, 'fmt', 'import'));
  assert.ok(has(imports, 'example.com/m/pkg/one', 'import'));
  assert.ok(has(imports, 'os', 'import'));
  assert.ok(has(imports, 'example.com/m/pkg/util', 'import'));
  assert.ok(!imports.some((e) => e.spec.includes('commented')));
  assert.ok(!imports.some((e) => e.spec.includes('instring')));
  assert.ok(!imports.some((e) => e.spec.includes('raw')));
  assert.equal(imports.find((e) => e.spec === 'example.com/m/pkg/util').line, 8);
});

// ---------------------------------------------------------------------------
// parseImports — Ruby / PHP / Rust
// ---------------------------------------------------------------------------

test('parseImports rb: require and require_relative, =begin block comment guard', () => {
  const src = [
    "require 'json'",
    "require_relative 'helper'",
    'require("net/http")',
    '=begin',
    "require 'ghost'",
    '=end',
    "# require 'commented'",
    'puts "require \'in-string\'"'
  ].join('\n');
  const imports = parseImports(src, { file: 'lib/main.rb' });

  assert.ok(has(imports, 'json', 'require'));
  assert.ok(has(imports, 'helper', 'require'));
  assert.ok(has(imports, 'net/http', 'require'));
  assert.ok(!imports.some((e) => e.spec === 'ghost'));
  assert.ok(!imports.some((e) => e.spec === 'commented'));
  assert.ok(!imports.some((e) => e.spec === 'in-string'));
});

test('parseImports php: use statements and require/include literals', () => {
  const src = [
    '<?php',
    'use App\\Service\\Mailer;',
    'use App\\Model\\User as U;',
    "require_once 'bootstrap.php';",
    "include __DIR__ . '/partials/header.php';",
    '// use App\\Ghost;',
    "$s = \"include 'ghost.php'\";"
  ].join('\n');
  const imports = parseImports(src, { file: 'src/Foo.php' });

  assert.ok(has(imports, 'App\\Service\\Mailer', 'use'));
  assert.ok(has(imports, 'App\\Model\\User', 'use'));
  assert.ok(has(imports, 'bootstrap.php', 'include'));
  assert.ok(has(imports, '/partials/header.php', 'include'));
  assert.ok(!imports.some((e) => e.spec.includes('Ghost')));
  assert.ok(!imports.some((e) => e.spec === 'ghost.php'));
});

test('parseImports rs: mod declarations and use paths', () => {
  const src = [
    'mod helper;',
    'pub mod exported;',
    'use crate::helper::run;',
    'use super::sibling::Thing;',
    'use self::inner::Other;',
    'use serde::Serialize;',
    '// mod ghost;',
    '/* use crate::block_ghost::X; */'
  ].join('\n');
  const imports = parseImports(src, { file: 'src/lib.rs' });

  assert.ok(has(imports, 'helper', 'include'));
  assert.ok(has(imports, 'exported', 'include'));
  assert.ok(has(imports, 'crate::helper::run', 'use'));
  assert.ok(has(imports, 'super::sibling::Thing', 'use'));
  assert.ok(has(imports, 'self::inner::Other', 'use'));
  assert.ok(has(imports, 'serde::Serialize', 'use'));
  assert.ok(!imports.some((e) => e.spec === 'ghost'));
  assert.ok(!imports.some((e) => e.spec.includes('block_ghost')));
});

test('parseImports: unknown language and empty source are total (return [])', () => {
  assert.deepEqual(parseImports('# whatever', { file: 'README.md' }), []);
  assert.deepEqual(parseImports('', { file: 'a.mjs' }), []);
  assert.deepEqual(parseImports(null, { file: 'a.mjs' }), []);
});

test('scanSource: comments are blanked but line count is preserved exactly', () => {
  const src = "a\n// comment here\n/* two\nlines */\nb\n";
  const { scrubbed } = scanSource(src, 'js');
  assert.equal(scrubbed.split('\n').length, src.split('\n').length);
  assert.ok(!scrubbed.includes('comment here'));
  assert.equal(scrubbed.length, src.length);
});

// ---------------------------------------------------------------------------
// resolveSpec — the resolution table
// ---------------------------------------------------------------------------

const FILES = [
  'scripts/a.mjs',
  'scripts/b.mjs',
  'scripts/nested/index.mjs',
  'src/comp.ts',
  'src/comp.tsx',
  'src/deep/index.ts',
  'src/pkg/__init__.py',
  'src/pkg/mod.py',
  'src/app.py',
  'pkg/util/one.go',
  'pkg/util/two.go',
  'pkg/svc/svc.go',
  'lib/main.rb',
  'lib/helper.rb',
  'src/App/Bar.php',
  'src/Foo.php',
  'src/lib.rs',
  'src/helper.rs',
  'src/deepmod/mod.rs'
];

test('resolveSpec js: exact relative resolve is confidence 1.0', () => {
  const r = resolveSpecWithConfidence('./b.mjs', { fromFile: 'scripts/a.mjs', files: FILES });
  assert.deepEqual(r.targets, ['scripts/b.mjs']);
  assert.equal(r.confidence, 1.0);
  assert.equal(resolveSpec('./b.mjs', { fromFile: 'scripts/a.mjs', files: FILES }), 'scripts/b.mjs');
});

test('resolveSpec js: extension inference and index.* inference are confidence 0.8', () => {
  const ext = resolveSpecWithConfidence('./comp', { fromFile: 'src/other.ts', files: FILES });
  assert.deepEqual(ext.targets, ['src/comp.ts']);
  assert.equal(ext.confidence, 0.8);

  const idx = resolveSpecWithConfidence('./deep', { fromFile: 'src/other.ts', files: FILES });
  assert.deepEqual(idx.targets, ['src/deep/index.ts']);
  assert.equal(idx.confidence, 0.8);

  const nested = resolveSpecWithConfidence('./nested', { fromFile: 'scripts/a.mjs', files: FILES });
  assert.deepEqual(nested.targets, ['scripts/nested/index.mjs']);
});

test('resolveSpec js: TS ESM convention — ./comp.js names the source file comp.ts', () => {
  const r = resolveSpecWithConfidence('./comp.js', { fromFile: 'src/other.ts', files: FILES });
  assert.deepEqual(r.targets, ['src/comp.ts']);
  assert.equal(r.confidence, 0.8);
});

test('resolveSpec: bare npm and node: specifiers are external → null', () => {
  for (const spec of ['fast-glob', 'node:fs', '@scope/pkg', '#internal']) {
    assert.equal(resolveSpec(spec, { fromFile: 'scripts/a.mjs', files: FILES }), null, spec);
  }
});

test('resolveSpec js: escaping the repo root never resolves', () => {
  assert.equal(resolveSpec('../../outside.mjs', { fromFile: 'scripts/a.mjs', files: FILES }), null);
  assert.equal(resolveSpec('/etc/passwd', { fromFile: 'scripts/a.mjs', files: FILES }), null);
});

test('parseTsconfigPaths + alias resolve is confidence 0.6', () => {
  const tsconfig = `{
    // a JSONC comment
    "compilerOptions": {
      "baseUrl": ".",
      "paths": {
        "@/*": ["./src/*"],
        "@app": ["./src/app.py"],
      },
    },
  }`;
  const aliases = parseTsconfigPaths(tsconfig, { configPath: 'tsconfig.json' });
  assert.deepEqual(aliases.map((a) => a.pattern), ['@app', '@/*']);
  assert.deepEqual(aliases[1].targets, ['src/*']);

  const r = resolveSpecWithConfidence('@/comp', { fromFile: 'scripts/a.mjs', files: FILES, aliases });
  assert.deepEqual(r.targets, ['src/comp.ts']);
  assert.equal(r.confidence, 0.6);

  // Unparseable / alias-free configs degrade to "no aliases", never throw.
  assert.deepEqual(parseTsconfigPaths('{ not json'), []);
  assert.deepEqual(parseTsconfigPaths('{"compilerOptions":{}}'), []);
});

test('resolveSpec py: relative module, relative package __init__, and root-search', () => {
  const rel = resolveSpecWithConfidence('.pkg.mod', { fromFile: 'src/app.py', files: FILES });
  assert.deepEqual(rel.targets, ['src/pkg/mod.py']);
  assert.equal(rel.confidence, 0.8);

  const pkgInit = resolveSpecWithConfidence('.pkg', { fromFile: 'src/app.py', files: FILES });
  assert.deepEqual(pkgInit.targets, ['src/pkg/__init__.py']);

  const abs = resolveSpecWithConfidence('pkg.mod', { fromFile: 'src/app.py', files: FILES });
  assert.deepEqual(abs.targets, ['src/pkg/mod.py']);
  assert.equal(abs.confidence, 0.6);

  // stdlib stays external
  assert.equal(resolveSpec('os.path', { fromFile: 'src/app.py', files: FILES }), null);
});

test('resolveSpec go: package import fans out to every file in the package dir', () => {
  const r = resolveSpecWithConfidence('example.com/m/pkg/util', { fromFile: 'pkg/svc/svc.go', files: FILES });
  assert.deepEqual(r.targets, ['pkg/util/one.go', 'pkg/util/two.go']);
  assert.equal(r.confidence, 0.6);
  // Single-segment and stdlib specifiers are never searched inside the repo.
  assert.equal(resolveSpec('fmt', { fromFile: 'pkg/svc/svc.go', files: FILES }), null);
  assert.equal(resolveSpec('net/http', { fromFile: 'pkg/svc/svc.go', files: FILES }), null);
});

test('resolveSpec rb: require_relative-style and load-path-style both land on .rb', () => {
  const r = resolveSpecWithConfidence('helper', { fromFile: 'lib/main.rb', files: FILES });
  assert.deepEqual(r.targets, ['lib/helper.rb']);
  assert.equal(r.confidence, 0.8);
  assert.equal(resolveSpec('json', { fromFile: 'lib/main.rb', files: FILES }), null);
});

test('resolveSpec php: namespace search and __DIR__-relative include', () => {
  const ns = resolveSpecWithConfidence('App\\Bar', { fromFile: 'src/Foo.php', files: FILES });
  assert.deepEqual(ns.targets, ['src/App/Bar.php']);
  assert.equal(ns.confidence, 0.6);

  const inc = resolveSpecWithConfidence('/App/Bar.php', { fromFile: 'src/Foo.php', files: FILES, kind: 'include' });
  assert.deepEqual(inc.targets, ['src/App/Bar.php']);
  assert.equal(inc.confidence, 1.0);

  assert.equal(resolveSpec('Vendor\\Absent', { fromFile: 'src/Foo.php', files: FILES }), null);
});

test('resolveSpec rs: mod files, crate:: paths, and external crates', () => {
  const mod = resolveSpecWithConfidence('helper', { fromFile: 'src/lib.rs', files: FILES });
  assert.deepEqual(mod.targets, ['src/helper.rs']);
  assert.equal(mod.confidence, 0.8);

  const modDir = resolveSpecWithConfidence('deepmod', { fromFile: 'src/lib.rs', files: FILES });
  assert.deepEqual(modDir.targets, ['src/deepmod/mod.rs']);

  const cratePath = resolveSpecWithConfidence('crate::helper::run', { fromFile: 'src/deepmod/mod.rs', files: FILES });
  assert.deepEqual(cratePath.targets, ['src/helper.rs']);
  assert.equal(cratePath.confidence, 0.6);

  assert.equal(resolveSpec('serde::Serialize', { fromFile: 'src/lib.rs', files: FILES }), null);
});

test('resolveSpec: never guesses across languages', () => {
  // A python-looking spec from a .py file must not land on scripts/a.mjs.
  assert.equal(resolveSpec('scripts.a', { fromFile: 'src/app.py', files: FILES }), null);
  // A JS relative spec must not land on a .py file.
  assert.equal(resolveSpec('./app', { fromFile: 'src/x.mjs', files: FILES }), null);
});

test('defaultRoots: repo root first, then only conventional dirs that actually exist', () => {
  assert.deepEqual(defaultRoots(FILES), ['', 'src', 'lib', 'pkg']);
  assert.deepEqual(defaultRoots([]), ['']);
});

// ---------------------------------------------------------------------------
// buildImportGraph — shape, determinism, totality
// ---------------------------------------------------------------------------

const SOURCES = {
  'scripts/a.mjs': "import { b } from './b.mjs';\nimport fg from 'fast-glob';\n",
  'scripts/b.mjs': "import { c } from './nested/index.mjs';\n",
  'scripts/nested/index.mjs': "import 'node:fs';\n",
  'scripts/orphan.mjs': "import { a } from './a.mjs';\n",
  'src/app.py': 'from .pkg.mod import thing\nimport os\n',
  'src/pkg/mod.py': 'import json\n',
  'src/pkg/__init__.py': '',
  'README.md': '# not code'
};

function fixtureGraph(overrides = {}) {
  const sources = { ...SOURCES, ...overrides };
  return buildImportGraph({
    files: Object.keys(sources),
    readFile: (f) => {
      if (!(f in sources)) throw new Error(`ENOENT: ${f}`);
      return sources[f];
    },
    aliases: []
  });
}

test('buildImportGraph: nodes/edges/external/coverage/provenance shape', () => {
  const g = fixtureGraph();

  // Non-code files are not nodes.
  assert.ok(!g.nodes.some((n) => n.file === 'README.md'));
  assert.equal(g.coverage.filesScanned, 7);
  assert.equal(g.coverage.byLang.js, 4);
  assert.equal(g.coverage.byLang.py, 3);

  assert.deepEqual(
    g.edges.map((e) => `${e.from} -${e.kind}-> ${e.to} @${e.confidence}`),
    [
      'scripts/a.mjs -from-> scripts/b.mjs @1',
      'scripts/b.mjs -from-> scripts/nested/index.mjs @1',
      'scripts/orphan.mjs -from-> scripts/a.mjs @1',
      'src/app.py -from-> src/pkg/mod.py @0.8'
    ]
  );

  const a = g.nodes.find((n) => n.file === 'scripts/a.mjs');
  assert.deepEqual(a, { file: 'scripts/a.mjs', lang: 'js', imports: 1, importedBy: 1 });

  // Unresolved specifiers are REPORTED, never dropped.
  // Ranked by use count, then byte order — equal counts fall back to the spec.
  assert.deepEqual(g.external, [
    { spec: 'fast-glob', count: 1 },
    { spec: 'json', count: 1 },
    { spec: 'node:fs', count: 1 },
    { spec: 'os', count: 1 }
  ]);
  assert.equal(g.coverage.unresolvedSpecs, 4);
  assert.equal(g.coverage.resolvedEdges, 4);
  assert.equal(g.coverage.totalSpecs, 8);
  assert.equal(g.coverage.filesWithImports, 6); // every scanned file but the empty __init__.py

  assert.equal(g.provenance.basis, 'measured');
  assert.equal(g.provenance.source, 'import-scan');
  assert.equal(g.provenance.note, SCAN_NOTE);
  assert.match(g.provenance.note, /not a parser/);
});

test('buildImportGraph: byte-identical JSON on repeated builds, regardless of input order', () => {
  const first = JSON.stringify(fixtureGraph());
  const second = JSON.stringify(fixtureGraph());
  assert.equal(first, second);

  const shuffled = buildImportGraph({
    files: Object.keys(SOURCES).reverse(),
    readFile: (f) => SOURCES[f],
    aliases: []
  });
  assert.equal(JSON.stringify(shuffled), first);
});

test('buildImportGraph: a file that fails to read is skipped, never thrown', () => {
  const g = buildImportGraph({
    files: ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/boom.mjs'],
    readFile: (f) => {
      if (f === 'scripts/boom.mjs') throw new Error('EACCES: permission denied');
      return SOURCES[f] ?? '';
    },
    aliases: []
  });
  assert.deepEqual(g.skipped, [{ file: 'scripts/boom.mjs', reason: 'EACCES: permission denied' }]);
  assert.equal(g.coverage.skippedFiles, 1);
  assert.equal(g.coverage.filesScanned, 2);
  assert.ok(!g.nodes.some((n) => n.file === 'scripts/boom.mjs'));
});

test('buildImportGraph: empty input is total and still carries provenance', () => {
  const g = buildImportGraph({});
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.external, []);
  assert.equal(g.coverage.filesScanned, 0);
  assert.equal(g.provenance.source, 'import-scan');
});

test('buildImportGraph: tsconfig aliases are discovered through the injected readFile', () => {
  const sources = {
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    'src/a.ts': "import { u } from '@/util';\n",
    'src/util.ts': 'export const u = 1;\n'
  };
  const g = buildImportGraph({ files: ['src/a.ts', 'src/util.ts'], readFile: (f) => sources[f] });
  assert.deepEqual(g.edges, [{ from: 'src/a.ts', to: 'src/util.ts', kind: 'from', confidence: 0.6 }]);
});

// ---------------------------------------------------------------------------
// derived views on hand-built graphs with known structure
// ---------------------------------------------------------------------------

/** Hand-build a graph from `from -> to` pairs; nodes/degrees derived. */
function mkGraph(pairs) {
  const edges = pairs.map(([from, to]) => ({ from, to, kind: 'from', confidence: 1 }));
  const files = [...new Set(pairs.flat())].sort();
  return {
    nodes: files.map((file) => ({
      file,
      lang: langOf(file) || 'js',
      imports: edges.filter((e) => e.from === file).length,
      importedBy: edges.filter((e) => e.to === file).length
    })),
    edges
  };
}

// a.mjs → b.mjs → core.mjs ; c.mjs → core.mjs ; loose.mjs imports nothing
const DIAMOND = mkGraph([
  ['a.mjs', 'b.mjs'],
  ['b.mjs', 'core.mjs'],
  ['c.mjs', 'core.mjs'],
  ['a.mjs', 'c.mjs']
]);

test('dependents: reverse reachability reports exact hop distance', () => {
  const r = dependents(DIAMOND, 'core.mjs');
  assert.equal(r.file, 'core.mjs');
  assert.equal(r.maxDepth, null);
  assert.deepEqual(r.dependents, [
    { file: 'b.mjs', depth: 1 },
    { file: 'c.mjs', depth: 1 },
    { file: 'a.mjs', depth: 2 }
  ]);
});

test('dependents: --depth truncates, and a leaf has no dependents', () => {
  assert.deepEqual(dependents(DIAMOND, 'core.mjs', { depth: 1 }).dependents, [
    { file: 'b.mjs', depth: 1 },
    { file: 'c.mjs', depth: 1 }
  ]);
  assert.deepEqual(dependents(DIAMOND, 'a.mjs').dependents, []);
  assert.deepEqual(dependents(DIAMOND, 'does/not/exist.mjs').dependents, []);
});

test('dependents: cyclic graphs terminate and never report the seed file', () => {
  const cyclic = mkGraph([['x.mjs', 'y.mjs'], ['y.mjs', 'x.mjs']]);
  const r = dependents(cyclic, 'x.mjs');
  assert.deepEqual(r.dependents, [{ file: 'y.mjs', depth: 1 }]);
});

test('cycles: finds each simple cycle exactly once, canonicalised', () => {
  const g = mkGraph([
    ['a.mjs', 'b.mjs'],
    ['b.mjs', 'a.mjs'],
    ['c.mjs', 'd.mjs'],
    ['d.mjs', 'e.mjs'],
    ['e.mjs', 'c.mjs'],
    ['f.mjs', 'g.mjs']
  ]);
  const r = cycles(g);
  assert.deepEqual(r.cycles, [
    ['a.mjs', 'b.mjs'],
    ['c.mjs', 'd.mjs', 'e.mjs']
  ]);
  assert.equal(r.truncated, false);
});

test('cycles: acyclic graph → none; caps are honoured and reported as truncated', () => {
  assert.deepEqual(cycles(DIAMOND).cycles, []);

  const g = mkGraph([
    ['a.mjs', 'b.mjs'],
    ['b.mjs', 'c.mjs'],
    ['c.mjs', 'a.mjs']
  ]);
  const short = cycles(g, { maxLen: 2 });
  assert.deepEqual(short.cycles, []);
  assert.equal(short.truncated, true);
  assert.deepEqual(short.params, { maxLen: 2, maxCycles: 50 });

  const capped = cycles(mkGraph([
    ['a.mjs', 'b.mjs'], ['b.mjs', 'a.mjs'],
    ['c.mjs', 'd.mjs'], ['d.mjs', 'c.mjs']
  ]), { maxCycles: 1 });
  assert.equal(capped.cycles.length, 1);
  assert.equal(capped.truncated, true);
});

test('fanIn / fanOut: ranked by degree then byte order', () => {
  assert.deepEqual(fanIn(DIAMOND), [
    { file: 'core.mjs', count: 2 },
    { file: 'b.mjs', count: 1 },
    { file: 'c.mjs', count: 1 },
    { file: 'a.mjs', count: 0 }
  ]);
  assert.deepEqual(fanOut(DIAMOND)[0], { file: 'a.mjs', count: 2 });
});

test('orphans: unimported files are CANDIDATES, entry points are excluded, caveat travels along', () => {
  const g = mkGraph([
    ['bin/cli.mjs', 'lib/core.mjs'],
    ['tests/core.test.mjs', 'lib/core.mjs'],
    ['scripts/unused.mjs', 'lib/core.mjs']
  ]);
  const bare = orphans(g);
  assert.deepEqual(bare.candidates.map((c) => c.file), [
    'bin/cli.mjs', 'scripts/unused.mjs', 'tests/core.test.mjs'
  ]);
  assert.equal(bare.caveat, ORPHAN_CAVEAT);
  assert.match(bare.caveat, /CANDIDATES ONLY, not dead code/);

  const guarded = orphans(g, { entryPoints: ['bin/**', 'tests/**'] });
  assert.deepEqual(guarded.candidates, [{ file: 'scripts/unused.mjs', lang: 'js' }]);
  assert.deepEqual(guarded.entryPoints, ['bin/**', 'tests/**']);
});

test('defaultEntryPoints: package.json bin/main/scripts plus test globs, existing paths only', () => {
  const files = ['bin/cli.mjs', 'index.mjs', 'scripts/brain-guard.mjs', 'scripts/unused.mjs', 'ghost.mjs'];
  const eps = defaultEntryPoints({
    pkg: {
      main: './index.mjs',
      bin: { 'project-brain': 'bin/cli.mjs' },
      scripts: {
        guard: 'node scripts/brain-guard.mjs --strict',
        missing: 'node scripts/absent.mjs',
        test: 'node --test tests/*.test.mjs'
      }
    },
    files
  });
  assert.ok(eps.includes('index.mjs'));
  assert.ok(eps.includes('bin/cli.mjs'));
  assert.ok(eps.includes('scripts/brain-guard.mjs'));
  assert.ok(eps.includes('tests/**'));
  assert.ok(!eps.includes('scripts/absent.mjs'), 'non-existent script paths are not invented');
  assert.ok(!eps.includes('scripts/unused.mjs'));
  assert.deepEqual(eps, [...eps].sort(), 'entry points are deterministically sorted');
  // Empty package.json still yields the conventional globs.
  assert.ok(defaultEntryPoints({}).includes('bin/**'));
});

test('globToRegExp: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('tests/**').test('tests/a/b.mjs'));
  assert.ok(globToRegExp('**/*.test.*').test('tests/x.test.mjs'));
  assert.ok(globToRegExp('**/*.test.*').test('x.test.mjs'));
  assert.ok(globToRegExp('scripts/*.mjs').test('scripts/a.mjs'));
  assert.ok(!globToRegExp('scripts/*.mjs').test('scripts/nested/a.mjs'));
});

// ---------------------------------------------------------------------------
// CLI — subprocess run on a scripted polyglot repo
// ---------------------------------------------------------------------------

/** Build a throwaway polyglot repo and return its root. */
function makePolyglotRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-graph-scan-'));
  const put = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  put('package.json', JSON.stringify({
    name: 'polyglot-fixture',
    bin: { fixture: 'scripts/entry.mjs' },
    scripts: { start: 'node scripts/entry.mjs' }
  }, null, 2));

  // JS: entry → helper, plus an external specifier and a 2-cycle.
  put('scripts/entry.mjs', "import { help } from './helper.mjs';\nimport fg from 'fast-glob';\nexport const run = () => help();\n");
  put('scripts/helper.mjs', "import { back } from './loop-a.mjs';\nexport const help = () => back();\n");
  put('scripts/loop-a.mjs', "import './loop-b.mjs';\nexport const back = 1;\n");
  put('scripts/loop-b.mjs', "import './loop-a.mjs';\n");
  put('scripts/nobody-imports-me.mjs', "import os from 'node:os';\nexport const x = os.platform();\n");

  // Python package with a relative import.
  put('src/app.py', 'from .util import helper\nimport os\n');
  put('src/util.py', 'def helper():\n    return 1\n');

  // Go: svc imports the util package (two files → two edges).
  put('pkg/svc/svc.go', 'package svc\n\nimport (\n\t"fmt"\n\t"example.com/m/pkg/util"\n)\n\nfunc Run() { fmt.Println(util.One()) }\n');
  put('pkg/util/one.go', 'package util\n\nfunc One() int { return 1 }\n');
  put('pkg/util/two.go', 'package util\n\nfunc Two() int { return 2 }\n');

  // Ruby, PHP, Rust.
  put('lib/main.rb', "require_relative 'helper'\nrequire 'json'\n");
  put('lib/helper.rb', 'def helper; 1; end\n');
  put('src/Foo.php', "<?php\nuse App\\Bar;\nrequire_once 'boot.php';\n");
  put('src/App/Bar.php', "<?php\nclass Bar {}\n");
  put('src/lib.rs', 'mod helper;\nuse crate::helper::run;\n');
  put('src/helper.rs', 'pub fn run() {}\n');

  return root;
}

function runScan(root, args) {
  return spawnSync(process.execPath, [SCAN_SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_ROOT: root, BRAIN_QUIET: '1' }
  });
}

test('graph-scan CLI: --json over a scripted polyglot repo resolves every language', () => {
  const root = makePolyglotRepo();
  try {
    const r = runScan(root, ['--json', '--cycles', '--orphans']);
    assert.equal(r.status, 0, r.stderr);
    const g = JSON.parse(r.stdout);

    const edge = (from, to) => g.edges.some((e) => e.from === from && e.to === to);
    assert.ok(edge('scripts/entry.mjs', 'scripts/helper.mjs'), 'js relative edge');
    assert.ok(edge('src/app.py', 'src/util.py'), 'python relative edge');
    assert.ok(edge('pkg/svc/svc.go', 'pkg/util/one.go'), 'go package edge (file 1)');
    assert.ok(edge('pkg/svc/svc.go', 'pkg/util/two.go'), 'go package edge (file 2)');
    assert.ok(edge('lib/main.rb', 'lib/helper.rb'), 'ruby require_relative edge');
    assert.ok(edge('src/Foo.php', 'src/App/Bar.php'), 'php namespace edge');
    assert.ok(edge('src/lib.rs', 'src/helper.rs'), 'rust mod edge');

    for (const lang of ['js', 'py', 'go', 'rb', 'php', 'rs']) {
      assert.ok(g.coverage.byLang[lang] > 0, `byLang.${lang}`);
    }
    assert.ok(g.coverage.resolvedEdges >= 7);
    assert.ok(g.coverage.unresolvedSpecs > 0, 'external specifiers are counted, not hidden');
    assert.ok(g.external.some((e) => e.spec === 'fast-glob'));
    assert.equal(g.provenance.source, 'import-scan');

    // The 2-cycle is found; the package.json bin entry is NOT an orphan candidate.
    assert.deepEqual(g.cycles.cycles, [['scripts/loop-a.mjs', 'scripts/loop-b.mjs']]);
    const orphanFiles = g.orphans.candidates.map((c) => c.file);
    assert.ok(orphanFiles.includes('scripts/nobody-imports-me.mjs'));
    assert.ok(!orphanFiles.includes('scripts/entry.mjs'), 'package.json bin is an entry point');
    assert.match(g.orphans.caveat, /CANDIDATES ONLY/);
    assert.ok(g.nextAction.startsWith('→'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('graph-scan CLI: human output states real coverage, provenance, the limitation and an action', () => {
  const root = makePolyglotRepo();
  try {
    const r = runScan(root, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Import graph — scanned \d+ files, resolved \d+ edges, \d+ specifier\(s\) unresolved \(external\/stdlib\)/m);
    assert.match(r.stdout, /by language: /);
    assert.match(r.stdout, /Top fan-in/);
    assert.match(r.stdout, /— basis: measured · source: import-scan · \d+\/\d+ specifiers resolved/);
    assert.match(r.stdout, /NOTE: regex\/line-scanner, not a parser/);
    assert.match(r.stdout, /^→ /m, 'human output must end in a concrete next action');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('graph-scan CLI: --file X --dependents prints the blast radius', () => {
  const root = makePolyglotRepo();
  try {
    const r = runScan(root, ['--json', '--file', 'scripts/helper.mjs', '--dependents']);
    assert.equal(r.status, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.deepEqual(g.dependents.dependents, [{ file: 'scripts/entry.mjs', depth: 1 }]);

    const human = runScan(root, ['--file', 'scripts/helper.mjs', '--dependents']);
    assert.match(human.stdout, /Blast radius — files that transitively import scripts\/helper\.mjs/);
    assert.match(human.stdout, /scripts\/entry\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('graph-scan CLI: --dependents without --file fails loudly on stderr', () => {
  const root = makePolyglotRepo();
  try {
    const r = runScan(root, ['--dependents']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--dependents needs --file/);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('graph-scan CLI: --help exits 0 and documents the scanner honestly', () => {
  const r = spawnSync(process.execPath, [SCAN_SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOT a parser/);
});
