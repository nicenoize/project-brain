/**
 * import-graph.mjs — deterministic, dependency-free, multi-language import /
 * reference graph (the language-agnostic sibling of ts-graph.mjs).
 *
 * WHY THIS EXISTS. The compiler-backed path (ts-graph.mjs) gives exact,
 * checker-resolved import edges — but ONLY for TypeScript, and only when the
 * optional `typescript` package is installed. On a plain `.mjs` repo (this one)
 * or on Python/Go/Ruby/PHP/Rust repos, "what breaks if I change this?" had no
 * structural answer at all and fell back to git history alone. This module
 * closes that gap: one regex/line-scanner pass over the file list produces a
 * file→file edge set that the same consumers can read.
 *
 * >>> THIS IS NOT A PARSER. <<<
 * It is a line/character state-scanner plus per-language regular expressions.
 * It has no AST, no symbol table, no module resolver. It CANNOT know about:
 *   - computed/dynamic specifiers (`require(base + name)`, `importlib`,
 *     `__import__`, Ruby's `Dir[…].each { require _1 }`) — invisible;
 *   - conditional/platform re-exports, package.json "exports" maps, monorepo
 *     workspace links, Go build tags, Rust `#[path]`, PHP autoloader maps;
 *   - macro/codegen-produced imports;
 *   - re-export chains (`export * from`) as *symbol* provenance — only the
 *     file edge is recorded.
 * Heredocs, Ruby `%w[]`/`%q{}` literals, nested Rust block comments and JS
 * regex literals containing quote characters are known scanner blind spots.
 * Every edge therefore carries an explicit `confidence` (1.0 exact / 0.8
 * inferred / 0.6 alias-or-search) and every unresolved specifier is REPORTED
 * in `external` rather than silently dropped — the coverage numbers are the
 * honest part of the output, not a footnote.
 *
 * PURE library: importing this module has zero side effects (no argv parsing,
 * no fs access, no clocks, no network). All I/O is injected (`readFile`), so
 * the same inputs always produce byte-identical output. Ordering is byte-stable
 * everywhere (never localeCompare). Total: a file that fails to read is
 * collected into `skipped`, never thrown.
 *
 * API:
 *   parseImports(source, {file, lang})        → [{spec, kind, line}]
 *   resolveSpec(spec, {fromFile, files, roots}) → repo-relative path | null
 *   resolveSpecWithConfidence(...)            → {targets, confidence, how} | null
 *   buildImportGraph({files, readFile, roots}) → {nodes, edges, external,
 *                                                coverage, skipped, provenance}
 *   dependents(graph, file, {depth})          → reverse reachability (blast radius)
 *   cycles(graph, {maxLen, maxCycles})        → bounded simple import cycles
 *   fanIn(graph) / fanOut(graph)              → ranked in/out degree
 *   orphans(graph, {entryPoints})             → dead-code CANDIDATES (never claims)
 *   defaultEntryPoints({pkg, files})          → package.json bin/main/scripts + test globs
 *   parseTsconfigPaths(text, {configPath})    → trivially-derivable path aliases
 *
 * The thin CLI lives in brain-graph-scan.mjs (`project-brain x graph-scan`).
 */
import path from 'node:path';

const P = path.posix;

/** The honest limitation sentence stamped onto every graph's provenance. */
export const SCAN_NOTE =
  'regex/line-scanner, not a parser: static import/require/use statements only. ' +
  'Computed specifiers, package "exports" maps, autoloaders, build tags and codegen are invisible; ' +
  'unresolved specifiers are reported in `external` rather than dropped. ' +
  'Edge confidence: 1.0 exact relative resolve, 0.8 extension/index inference, 0.6 alias or path-search resolve.';

// ---------------------------------------------------------------------------
// language table
// ---------------------------------------------------------------------------

/**
 * Extension → language id. Deliberately overlaps the extension conventions in
 * lang-symbols.mjs (.py/.go) and common.mjs's indexable globs; this table is
 * wider because the graph resolves languages lang-symbols does not extract
 * symbols for yet.
 */
export const LANG_BY_EXT = Object.freeze({
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.rb': 'rb',
  '.php': 'php',
  '.rs': 'rs'
});

/** Languages that share one scanner + one regex set ("family"). */
const FAMILY_BY_LANG = Object.freeze({
  js: 'js', ts: 'js', py: 'py', go: 'go', rb: 'rb', php: 'php', rs: 'rs'
});

/** Candidate file extensions per family — resolution NEVER crosses families. */
const EXTS_BY_FAMILY = Object.freeze({
  js: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json'],
  py: ['.py'],
  go: ['.go'],
  rb: ['.rb'],
  php: ['.php'],
  rs: ['.rs']
});

/** PURE. Language id for a path, or '' when the extension is not code we scan. */
export function langOf(file) {
  const ext = P.extname(String(file || '')).toLowerCase();
  return LANG_BY_EXT[ext] || '';
}

/** PURE. Family (shared scanner/regex set) for a language id, or ''. */
export function familyOf(lang) {
  return FAMILY_BY_LANG[String(lang || '')] || '';
}

// ---------------------------------------------------------------------------
// comment / string state scanner
// ---------------------------------------------------------------------------

/**
 * Per-family lexical syntax for the state scan. `strings` entries are
 * [open, close, escapesEnabled]; longest delimiters MUST come first so `"""`
 * wins over `"`. `blockAtLineStart` models Ruby's =begin/=end rule.
 */
const SYNTAX = Object.freeze({
  js: { line: ['//'], block: [['/*', '*/']], strings: [['`', '`', true], ['"', '"', true], ["'", "'", true]] },
  py: {
    line: ['#'], block: [],
    strings: [['"""', '"""', false], ["'''", "'''", false], ['"', '"', true], ["'", "'", true]]
  },
  go: { line: ['//'], block: [['/*', '*/']], strings: [['`', '`', false], ['"', '"', true], ["'", "'", true]] },
  rb: { line: ['#'], block: [['=begin', '=end']], blockAtLineStart: true, strings: [['"', '"', true], ["'", "'", true]] },
  php: { line: ['//', '#'], block: [['/*', '*/']], strings: [['"', '"', true], ["'", "'", true]] },
  rs: { line: ['//'], block: [['/*', '*/']], strings: [['"', '"', true]] }
});

/** Replace [start,end) with spaces but keep newlines so line numbers survive. */
function blank(chars, start, end) {
  for (let k = start; k < end && k < chars.length; k++) {
    if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
  }
}

/**
 * PURE. Single forward state scan producing:
 *   - `scrubbed`: source with comment bodies blanked (newlines preserved), so
 *     regexes can never match inside a comment;
 *   - `stringSpans`: [start,end) ranges of string literals, so a regex whose
 *     *guard* position (the keyword, not the specifier) falls inside a string
 *     can be rejected — that is what kills `const s = "require('x')"`.
 *
 * Honest limits: no regex-literal awareness in JS, no heredocs, no Ruby %-literals,
 * no nested Rust block comments, no PHP `#[Attribute]` distinction from `#` comments.
 */
export function scanSource(source, family) {
  const syn = SYNTAX[family] || SYNTAX.js;
  const src = String(source || '');
  const n = src.length;
  const chars = src.split('');
  const stringSpans = [];
  let i = 0;
  while (i < n) {
    let matched = false;

    for (const [open, close] of syn.block) {
      if (syn.blockAtLineStart && i !== 0 && src[i - 1] !== '\n') continue;
      if (!src.startsWith(open, i)) continue;
      let end = src.indexOf(close, i + open.length);
      end = end === -1 ? n : end + close.length;
      blank(chars, i, end);
      i = end;
      matched = true;
      break;
    }
    if (matched) continue;

    for (const open of syn.line) {
      if (!src.startsWith(open, i)) continue;
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      blank(chars, i, end);
      i = end;
      matched = true;
      break;
    }
    if (matched) continue;

    for (const [open, close, escapes] of syn.strings) {
      if (!src.startsWith(open, i)) continue;
      const start = i;
      let j = i + open.length;
      while (j < n) {
        if (escapes && src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(close, j)) { j += close.length; break; }
        j++;
      }
      if (j > n) j = n;
      stringSpans.push([start, j]);
      i = j;
      matched = true;
      break;
    }
    if (matched) continue;

    i++;
  }
  return { scrubbed: chars.join(''), stringSpans };
}

/** Binary-search membership tester over sorted, non-overlapping [start,end) spans. */
function makeSpanTester(spans) {
  return (index) => {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = spans[mid];
      if (index < s) hi = mid - 1;
      else if (index >= e) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

/** 1-based line number lookup for a character index. */
function makeLineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Deterministic byte-order compare (NOT localeCompare, which is locale-dependent). */
function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// parseImports
// ---------------------------------------------------------------------------

const RE = {
  jsFrom: /\bfrom\s*(['"])([^'"\n]+)\1/g,
  jsSide: /\bimport\s*(['"])([^'"\n]+)\1/g,
  jsDynamic: /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g,
  jsRequire: /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g,
  pyFrom: /^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm,
  pyImport: /^[ \t]*import[ \t]+([^\n#]+)/gm,
  goSingle: /^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm,
  goGroup: /^[ \t]*import[ \t]*\(/gm,
  goQuoted: /"([^"\n]+)"/,
  rbRequire: /\brequire(?:_relative)?\s*\(?\s*(['"])([^'"\n]+)\1/g,
  phpUse: /^[ \t]*use[ \t]+(\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*)[ \t]*(?:as[ \t]+\w+[ \t]*)?;/gm,
  phpInclude: /\b(?:require_once|require|include_once|include)\s*\(?\s*(?:__DIR__\s*\.\s*)?(['"])([^'"\n]+)\1/g,
  rsMod: /^[ \t]*(?:pub(?:\s*\([^)\n]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm,
  rsUse: /^[ \t]*(?:pub(?:\s*\([^)\n]*\))?[ \t]+)?use[ \t]+([^;\n]+);/gm
};

/**
 * PURE. Extract static import/reference statements from one source file.
 *
 * @param {string} source raw file text
 * @param {{file?: string, lang?: string}} opts `lang` overrides extension inference
 * @returns {Array<{spec: string, kind: 'import'|'require'|'dynamic'|'from'|'include'|'use', line: number}>}
 *   deterministic order (line, kind, spec); duplicates on the same line collapse.
 *
 * Kind mapping (documented, not guessed):
 *   js   `import 'x'`→import · `import…from 'x'` / `export…from 'x'`→from ·
 *        `require('x')`→require · `import('x')`→dynamic
 *   py   `import a.b`→import · `from a.b import c`→from
 *   go   single + grouped `import ( … )`→import
 *   rb   `require` / `require_relative`→require
 *   php  `use A\B;`→use · `require`/`include` string literal→include
 *   rs   `mod x;`→include (it names a FILE) · `use crate::a::b;`→use
 */
export function parseImports(source, opts = {}) {
  const file = String(opts.file || '');
  const lang = opts.lang || langOf(file);
  const family = familyOf(lang);
  if (!family) return [];

  const src = String(source || '');
  if (!src) return [];
  const { scrubbed, stringSpans } = scanSource(src, family);
  const inString = makeSpanTester(stringSpans);
  const lineAt = makeLineIndex(src);

  const out = [];
  /** Record a specifier whose position is already known to be real code. */
  const pushRaw = (spec, kind, at) => {
    const s = String(spec || '').trim();
    if (!s) return;
    out.push({ spec: s, kind, line: lineAt(at) });
  };
  /** Record one specifier. `guard` is the KEYWORD index — never the quote. */
  const push = (spec, kind, guard) => {
    if (inString(guard)) return;
    pushRaw(spec, kind, guard);
  };
  const scan = (re, fn) => {
    re.lastIndex = 0;
    for (let m = re.exec(scrubbed); m; m = re.exec(scrubbed)) fn(m);
  };

  if (family === 'js') {
    scan(RE.jsDynamic, (m) => push(m[2], 'dynamic', m.index));
    scan(RE.jsRequire, (m) => push(m[2], 'require', m.index));
    scan(RE.jsSide, (m) => push(m[2], 'import', m.index));
    scan(RE.jsFrom, (m) => push(m[2], 'from', m.index));
  } else if (family === 'py') {
    scan(RE.pyFrom, (m) => push(m[1], 'from', m.index));
    scan(RE.pyImport, (m) => {
      // `import a.b as c, d` → two specs. Bare `import(` is not Python, and a
      // line that is really `from … import …` never matches this anchor.
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[ \t]+as[ \t]+/)[0].trim();
        if (/^[.\w]+$/.test(name)) push(name, 'import', m.index);
      }
    });
  } else if (family === 'go') {
    scan(RE.goSingle, (m) => push(m[1], 'import', m.index));
    scan(RE.goGroup, (m) => {
      // The block OPENER is guarded against being inside a string; inside the
      // block every line is `[alias] "path"`, and those quotes are legitimate
      // string spans — so the per-line pushes deliberately bypass the guard.
      if (inString(m.index)) return;
      const close = scrubbed.indexOf(')', m.index);
      const end = close === -1 ? scrubbed.length : close;
      const blockStart = scrubbed.indexOf('(', m.index) + 1;
      let cursor = blockStart;
      for (const line of scrubbed.slice(blockStart, end).split('\n')) {
        const q = RE.goQuoted.exec(line);
        if (q) pushRaw(q[1], 'import', cursor + line.indexOf(q[0]));
        cursor += line.length + 1;
      }
    });
  } else if (family === 'rb') {
    scan(RE.rbRequire, (m) => push(m[2], 'require', m.index));
  } else if (family === 'php') {
    scan(RE.phpUse, (m) => push(m[1].replace(/^\\/, ''), 'use', m.index));
    scan(RE.phpInclude, (m) => push(m[2], 'include', m.index));
  } else if (family === 'rs') {
    scan(RE.rsMod, (m) => push(m[1], 'include', m.index));
    scan(RE.rsUse, (m) => push(m[1].trim(), 'use', m.index));
  }

  out.sort((a, b) => a.line - b.line || byString(a.kind, b.kind) || byString(a.spec, b.spec));
  const seen = new Set();
  return out.filter((e) => {
    const key = `${e.line}\0${e.kind}\0${e.spec}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Common Go stdlib top-level package roots — never searched inside the repo. */
const GO_STDLIB_ROOTS = new Set([
  'archive', 'bufio', 'builtin', 'bytes', 'cmp', 'compress', 'container', 'context', 'crypto',
  'database', 'debug', 'embed', 'encoding', 'errors', 'expvar', 'flag', 'fmt', 'go', 'hash',
  'html', 'image', 'index', 'io', 'log', 'maps', 'math', 'mime', 'net', 'os', 'path', 'plugin',
  'reflect', 'regexp', 'runtime', 'slices', 'sort', 'strconv', 'strings', 'sync', 'syscall',
  'testing', 'text', 'time', 'unicode', 'unsafe'
]);

/** Directory prefixes searched for non-relative specifiers, in this order. */
const ROOT_CANDIDATES = ['src', 'lib', 'app', 'pkg', 'internal', 'source', 'test', 'tests'];

/**
 * PURE. Deterministic default search roots for a file list: '' (repo root)
 * first, then any conventional source root that actually exists as a directory
 * prefix in `files`. Nothing is invented.
 */
export function defaultRoots(files) {
  const list = files instanceof Set ? [...files] : (files || []);
  const dirs = new Set();
  for (const f of list) {
    const first = String(f).split('/')[0];
    if (first) dirs.add(first);
  }
  return ['', ...ROOT_CANDIDATES.filter((r) => dirs.has(r))];
}

function normalizeRel(p) {
  if (!p) return '';
  const norm = P.normalize(p).replace(/^\.\//, '');
  if (norm === '.' || norm.startsWith('../') || norm.startsWith('/')) return '';
  return norm;
}

function hit(targets, confidence, how) {
  return { targets, confidence, how };
}

function isRelativeSpec(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

// --- JS / TS ---------------------------------------------------------------

function resolveJsBase(base, fileSet, ownExt, cap, how) {
  const norm = normalizeRel(base);
  if (!norm) return null;
  const exts = EXTS_BY_FAMILY.js;
  if (fileSet.has(norm) && P.extname(norm)) {
    return hit([norm], Math.min(1.0, cap), how === 'alias' ? 'alias-exact' : 'exact-relative');
  }
  const ordered = exts.includes(ownExt) ? [ownExt, ...exts.filter((e) => e !== ownExt)] : exts;
  const candidates = [];
  for (const e of ordered) candidates.push(norm + e);
  // TS ESM convention: `import './foo.js'` names the SOURCE file foo.ts.
  const jsExt = norm.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExt) {
    const stem = norm.slice(0, -jsExt[0].length);
    for (const e of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(stem + e);
  }
  for (const e of ordered) candidates.push(P.join(norm, 'index' + e));
  for (const c of candidates) {
    if (fileSet.has(c)) return hit([c], Math.min(0.8, cap), how === 'alias' ? 'alias-inferred' : 'inferred');
  }
  return null;
}

function resolveJs(spec, ctx) {
  const { fromFile, fileSet, aliases } = ctx;
  const ownExt = P.extname(fromFile).toLowerCase();
  if (isRelativeSpec(spec)) {
    return resolveJsBase(P.join(P.dirname(fromFile), spec), fileSet, ownExt, 1.0, 'relative');
  }
  if (spec.startsWith('/') || spec.startsWith('#') || spec.startsWith('node:')) return null;
  for (const alias of aliases || []) {
    for (const target of aliasTargets(alias, spec)) {
      const found = resolveJsBase(target, fileSet, ownExt, 0.6, 'alias');
      if (found) return found;
    }
  }
  return null; // bare npm specifier → external
}

/** Substitute a spec into a tsconfig-style `paths` mapping. */
function aliasTargets(alias, spec) {
  const { pattern, targets } = alias;
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === spec ? targets.slice() : [];
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  if (!spec.startsWith(head) || !spec.endsWith(tail)) return [];
  if (spec.length < head.length + tail.length) return [];
  const mid = spec.slice(head.length, spec.length - tail.length);
  return targets.map((t) => t.replace('*', mid));
}

/**
 * PURE. Extract trivially-derivable path aliases from a tsconfig/jsconfig body.
 * Only `compilerOptions.baseUrl` + `compilerOptions.paths` are honored — no
 * `extends` chasing, no project references, no solution-style configs. When the
 * text is unparseable, returns [] (never throws).
 *
 * @returns {Array<{pattern: string, targets: string[]}>} repo-relative targets
 */
export function parseTsconfigPaths(text, opts = {}) {
  const configPath = String(opts.configPath || 'tsconfig.json');
  let cfg;
  try {
    cfg = JSON.parse(stripJsonc(String(text || '')));
  } catch {
    return [];
  }
  const co = (cfg && cfg.compilerOptions) || {};
  const paths = co.paths;
  if (!paths || typeof paths !== 'object') return [];
  const dir = P.dirname(configPath) === '.' ? '' : P.dirname(configPath);
  const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : '.';
  const base = normalizeRel(P.join(dir, baseUrl)) || '';
  const out = [];
  for (const pattern of Object.keys(paths).sort(byString)) {
    const raw = paths[pattern];
    if (!Array.isArray(raw)) continue;
    const targets = raw
      .filter((t) => typeof t === 'string')
      .map((t) => normalizeRel(base ? P.join(base, t) : t))
      .filter(Boolean);
    if (targets.length) out.push({ pattern, targets });
  }
  // Longest literal prefix first so '@app/ui/*' beats '@app/*' deterministically.
  out.sort((a, b) => b.pattern.length - a.pattern.length || byString(a.pattern, b.pattern));
  return out;
}

/** Strip // and /* *\/ comments plus trailing commas so JSONC parses as JSON. */
function stripJsonc(text) {
  const { scrubbed } = scanSource(text, 'js');
  return scrubbed.replace(/,(\s*[}\]])/g, '$1');
}

// --- Python ----------------------------------------------------------------

function resolvePy(spec, ctx) {
  const { fromFile, fileSet, roots } = ctx;
  const dots = spec.match(/^\.+/);
  if (dots) {
    const level = dots[0].length;
    let dir = P.dirname(fromFile);
    for (let k = 1; k < level; k++) dir = P.dirname(dir);
    if (dir === '.') dir = '';
    const rest = spec.slice(level).split('.').filter(Boolean).join('/');
    const base = normalizeRel(rest ? P.join(dir, rest) : dir || '.');
    if (!base && rest) return null;
    return pickPy(base || rest, fileSet, 0.8);
  }
  const rel = spec.split('.').filter(Boolean).join('/');
  if (!rel) return null;
  for (const root of roots) {
    const found = pickPy(normalizeRel(root ? P.join(root, rel) : rel), fileSet, 0.6);
    if (found) return found;
  }
  return null; // stdlib / site-packages → external
}

function pickPy(base, fileSet, confidence) {
  if (!base) return null;
  if (fileSet.has(base) && base.endsWith('.py')) return hit([base], Math.min(1.0, confidence), 'exact-relative');
  for (const c of [`${base}.py`, P.join(base, '__init__.py')]) {
    if (fileSet.has(c)) return hit([c], confidence, confidence >= 0.8 ? 'inferred' : 'root-search');
  }
  return null;
}

// --- Go --------------------------------------------------------------------

/**
 * Go imports name a PACKAGE (a directory), not a file — so a resolved Go edge
 * fans out to every .go file in that package. Resolution is a longest-suffix
 * directory search: the module prefix from go.mod is not read (that would be a
 * guess about which prefix belongs to this module), so only specifiers with at
 * least two segments are attempted, common stdlib roots are excluded, and the
 * match must be unique. Confidence is therefore always 0.6.
 */
/**
 * PURE. The `module` path declared by a go.mod body, or ''.
 *
 * Go's intra-repo imports are ABSOLUTE, not relative: a file in a module
 * declared `module acme/operator` imports its sibling package as
 * `"acme/operator/factory"`, and nothing in that string resembles a path on
 * disk. Without go.mod the suffix ladder below has nothing to match, so a
 * properly package-structured Go repo resolves ZERO internal edges while a
 * flat one resolves some — the tidier the codebase, the worse we did. Found on
 * a 31-file Kubernetes operator: 190 specs, 190 unresolved.
 *
 * Deliberately not a go.mod parser: only the `module` line, ignoring `replace`
 * directives, vendor/ trees and build tags — hence 0.8, never 1.0.
 */
export function parseGoModule(text) {
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*module\s+("?)([^\s"]+)\1\s*(?:\/\/.*)?$/);
    if (m) return m[2];
  }
  return '';
}

/**
 * PURE-ish (calls the injected readFile). Every go.mod in the file list mapped
 * to the directory it governs, longest module path first so that a nested
 * module wins over its parent.
 * @returns {Array<{prefix: string, dir: string}>}
 */
function discoverGoModules(readFile, files) {
  const mods = [];
  for (const f of files) {
    if (P.basename(f) !== 'go.mod') continue;
    let text;
    try { text = readFile(f); } catch { continue; }
    if (typeof text !== 'string') continue;
    const prefix = parseGoModule(text);
    if (!prefix) continue;
    const dir = P.dirname(f) === '.' ? '' : P.dirname(f);
    mods.push({ prefix, dir });
  }
  mods.sort((a, b) => b.prefix.length - a.prefix.length || byString(a.prefix, b.prefix));
  return mods;
}

function resolveGo(spec, ctx) {
  const { fileSet, roots } = ctx;
  const segments = spec.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  if (GO_STDLIB_ROOTS.has(segments[0])) return null;
  const dirs = ctx.dirIndex || goDirIndex(fileSet);
  // Declared module path first: exact, and it beats the heuristic ladder.
  for (const mod of ctx.goModules || []) {
    if (spec !== mod.prefix && !spec.startsWith(mod.prefix + '/')) continue;
    const rest = spec.slice(mod.prefix.length).replace(/^\//, '');
    const cand = normalizeRel(mod.dir ? P.join(mod.dir, rest) : rest);
    if (cand !== '' || !rest) {
      const key = rest ? cand : mod.dir;
      if (dirs.has(key)) return hit([...dirs.get(key)].sort(byString), 0.8, 'go-module');
    }
    // The prefix matched but the package is absent — a module-internal import
    // we genuinely cannot place. Fall through to the ladder rather than lie.
  }
  for (let k = segments.length; k >= 2; k--) {
    const suffix = segments.slice(-k).join('/');
    const matches = [];
    for (const root of roots) {
      const cand = normalizeRel(root ? P.join(root, suffix) : suffix);
      if (cand && dirs.has(cand) && !matches.includes(cand)) matches.push(cand);
    }
    if (matches.length === 1) {
      return hit([...dirs.get(matches[0])].sort(byString), 0.6, 'go-package');
    }
  }
  return null;
}

function goDirIndex(fileSet) {
  const dirs = new Map();
  for (const f of fileSet) {
    if (!f.endsWith('.go')) continue;
    const dir = P.dirname(f) === '.' ? '' : P.dirname(f);
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    dirs.get(dir).add(f);
  }
  return dirs;
}

// --- Ruby ------------------------------------------------------------------

/**
 * `require_relative 'x'` and `require 'x'` are indistinguishable in our
 * {spec, kind} shape, so both go through the same ladder: relative-to-file
 * first (covers require_relative), then the load-path roots (covers require).
 * Honest false-positive risk: `require 'json'` next to a local json.rb resolves
 * locally — hence 0.8/0.6, never 1.0 unless the spec names the file exactly.
 */
function resolveRb(spec, ctx) {
  const { fromFile, fileSet, roots } = ctx;
  const relBase = normalizeRel(P.join(P.dirname(fromFile), spec));
  if (relBase) {
    if (fileSet.has(relBase) && relBase.endsWith('.rb')) return hit([relBase], 1.0, 'exact-relative');
    if (fileSet.has(`${relBase}.rb`)) return hit([`${relBase}.rb`], 0.8, 'inferred');
  }
  if (isRelativeSpec(spec)) return null;
  for (const root of roots) {
    const base = normalizeRel(root ? P.join(root, spec) : spec);
    if (!base) continue;
    if (fileSet.has(`${base}.rb`)) return hit([`${base}.rb`], 0.6, 'root-search');
    if (fileSet.has(base) && base.endsWith('.rb')) return hit([base], 0.6, 'root-search');
  }
  return null;
}

// --- PHP -------------------------------------------------------------------

function resolvePhp(spec, ctx) {
  const { fromFile, fileSet, roots } = ctx;
  if (spec.includes('\\')) {
    // `use A\B\C;` — PSR-4 without reading composer.json autoload maps, so:
    // full path under a root first, then progressively drop leading namespace
    // segments, and only accept a UNIQUE match.
    const parts = spec.split('\\').filter(Boolean);
    for (let drop = 0; drop < parts.length; drop++) {
      const rel = `${parts.slice(drop).join('/')}.php`;
      const matches = [];
      for (const root of roots) {
        const cand = normalizeRel(root ? P.join(root, rel) : rel);
        if (cand && fileSet.has(cand) && !matches.includes(cand)) matches.push(cand);
      }
      if (matches.length === 1) return hit([matches[0]], 0.6, 'namespace-search');
    }
    return null;
  }
  // include/require with a literal path. `__DIR__ . '/x.php'` leaves '/x.php',
  // which is relative to the including file, not the filesystem root.
  const cleaned = spec.replace(/^\//, '');
  const base = normalizeRel(P.join(P.dirname(fromFile), cleaned));
  if (base) {
    if (fileSet.has(base) && base.endsWith('.php')) return hit([base], 1.0, 'exact-relative');
    if (fileSet.has(`${base}.php`)) return hit([`${base}.php`], 0.8, 'inferred');
  }
  for (const root of roots) {
    const cand = normalizeRel(root ? P.join(root, cleaned) : cleaned);
    if (cand && fileSet.has(cand) && cand.endsWith('.php')) return hit([cand], 0.6, 'root-search');
  }
  return null;
}

// --- Rust ------------------------------------------------------------------

/** Directory a Rust file's inline submodules live in (mod.rs/lib.rs/main.rs vs foo.rs). */
function rustModuleDir(fromFile) {
  const dir = P.dirname(fromFile) === '.' ? '' : P.dirname(fromFile);
  const stem = P.basename(fromFile, '.rs');
  if (stem === 'mod' || stem === 'lib' || stem === 'main') return dir;
  return dir ? P.join(dir, stem) : stem;
}

function rustCrateRoot(fromFile, fileSet) {
  let dir = P.dirname(fromFile) === '.' ? '' : P.dirname(fromFile);
  for (;;) {
    for (const name of ['lib.rs', 'main.rs']) {
      const cand = dir ? P.join(dir, name) : name;
      if (fileSet.has(cand)) return dir;
    }
    if (!dir) return null;
    dir = P.dirname(dir) === '.' ? '' : P.dirname(dir);
  }
}

function resolveRs(spec, ctx) {
  const { fromFile, fileSet } = ctx;
  if (/^[A-Za-z_]\w*$/.test(spec)) {
    // `mod x;` — names a file next to the current module.
    const dir = rustModuleDir(fromFile);
    for (const c of [dir ? P.join(dir, `${spec}.rs`) : `${spec}.rs`, dir ? P.join(dir, spec, 'mod.rs') : `${spec}/mod.rs`]) {
      const norm = normalizeRel(c);
      if (norm && fileSet.has(norm)) return hit([norm], 0.8, 'inferred');
    }
    return null;
  }
  // `use crate::a::b;` / `use self::x;` / `use super::y::{A, B};`
  const head = spec.split('{')[0].split(/\s+as\s+/)[0];
  const segments = head.split('::').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  let baseDir;
  if (segments[0] === 'crate') baseDir = rustCrateRoot(fromFile, fileSet);
  else if (segments[0] === 'self') baseDir = rustModuleDir(fromFile);
  else if (segments[0] === 'super') baseDir = P.dirname(rustModuleDir(fromFile)) === '.' ? '' : P.dirname(rustModuleDir(fromFile));
  else return null; // external crate
  if (baseDir === null || baseDir === undefined) return null;
  const rest = segments.slice(1);
  // The trailing segment is usually an ITEM (fn/struct), so try the full path
  // and then the path minus its last segment. Longest match wins.
  for (let take = rest.length; take >= 1; take--) {
    const relPath = rest.slice(0, take).join('/');
    for (const c of [
      baseDir ? P.join(baseDir, `${relPath}.rs`) : `${relPath}.rs`,
      baseDir ? P.join(baseDir, relPath, 'mod.rs') : `${relPath}/mod.rs`
    ]) {
      const norm = normalizeRel(c);
      if (norm && fileSet.has(norm)) return hit([norm], 0.6, 'crate-path');
    }
  }
  return null;
}

// --- dispatcher ------------------------------------------------------------

/**
 * PURE. Resolve one specifier to concrete repo files.
 *
 * Resolution NEVER crosses languages: a Python specifier can only land on .py,
 * a Go one only on .go, and so on. Anything not resolvable inside the repo
 * (bare npm packages, stdlib modules, vendored/site-packages code) yields null
 * — that is the honest "external" signal, not a failure.
 *
 * Confidence contract:
 *   1.0  the spec, joined relative to the importing file, IS a file in `files`
 *   0.8  extension / index.* / __init__.py / mod.rs inference on a relative spec
 *   0.6  tsconfig alias substitution, or a root/suffix path search
 *
 * @param {string} spec
 * @param {{fromFile: string, files: string[]|Set<string>, roots?: string[],
 *          aliases?: Array<{pattern: string, targets: string[]}>, lang?: string,
 *          kind?: string, dirIndex?: Map,
 *          goModules?: Array<{prefix: string, dir: string}>}} ctx
 * @returns {{targets: string[], confidence: number, how: string} | null}
 */
export function resolveSpecWithConfidence(spec, ctx = {}) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const fromFile = String(ctx.fromFile || '');
  const lang = ctx.lang || langOf(fromFile);
  const family = familyOf(lang);
  if (!family) return null;
  const fileSet = ctx.files instanceof Set ? ctx.files : new Set(ctx.files || []);
  const roots = Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots : defaultRoots(fileSet);
  const inner = {
    fromFile, fileSet, roots, aliases: ctx.aliases || [],
    dirIndex: ctx.dirIndex, goModules: ctx.goModules
  };
  let found = null;
  if (family === 'js') found = resolveJs(raw, inner);
  else if (family === 'py') found = resolvePy(raw, inner);
  else if (family === 'go') found = resolveGo(raw, inner);
  else if (family === 'rb') found = resolveRb(raw, inner);
  else if (family === 'php') found = resolvePhp(raw, inner);
  else if (family === 'rs') found = resolveRs(raw, inner);
  if (!found || !found.targets.length) return null;
  // Never guess across languages — enforce the family's extension set.
  const allowed = EXTS_BY_FAMILY[family];
  const targets = found.targets.filter((t) => allowed.includes(P.extname(t)));
  if (!targets.length) return null;
  return { targets, confidence: found.confidence, how: found.how };
}

/**
 * PURE. Contract-shaped wrapper: the resolved repo-relative file path, or null.
 * (Go package imports fan out to several files; this returns the first —
 * buildImportGraph uses resolveSpecWithConfidence to keep all of them.)
 */
export function resolveSpec(spec, ctx = {}) {
  const found = resolveSpecWithConfidence(spec, ctx);
  return found ? found.targets[0] : null;
}

// ---------------------------------------------------------------------------
// buildImportGraph
// ---------------------------------------------------------------------------

/**
 * PURE (given an injected `readFile`). Build the whole-repo import graph.
 *
 * TOTAL: a file whose read throws, returns non-string, or is not a scannable
 * language is collected into `skipped` with a reason — never thrown.
 * DETERMINISTIC: input order is irrelevant (files are sorted first), all output
 * arrays are byte-stably ordered, so repeated builds are JSON-identical.
 *
 * @param {{files: string[], readFile: (file: string) => string,
 *          roots?: string[], aliases?: Array<{pattern, targets}>}} input
 * @returns {{nodes, edges, external, coverage, skipped, provenance}}
 */
export function buildImportGraph(input = {}) {
  const readFile = typeof input.readFile === 'function' ? input.readFile : () => { throw new Error('no readFile'); };
  const allFiles = [...new Set((input.files || []).map((f) => String(f).replace(/^\.\//, '')))].sort(byString);
  const fileSet = new Set(allFiles);
  const roots = Array.isArray(input.roots) && input.roots.length ? input.roots : defaultRoots(allFiles);
  const aliases = input.aliases !== undefined ? (input.aliases || []) : discoverAliases(readFile);
  const dirIndex = goDirIndex(fileSet);
  const goModules = Array.isArray(input.goModules) ? input.goModules : discoverGoModules(readFile, allFiles);

  const codeFiles = allFiles.filter((f) => familyOf(langOf(f)));
  const skipped = [];
  const edgeMap = new Map(); // 'from\0to\0kind' → edge
  const externalCounts = new Map();
  const byLang = new Map();
  let filesScanned = 0;
  let filesWithImports = 0;
  let totalSpecs = 0;
  let unresolvedSpecs = 0;

  for (const file of codeFiles) {
    const lang = langOf(file);
    let source;
    try {
      source = readFile(file);
    } catch (error) {
      skipped.push({ file, reason: String((error && error.message) || error) });
      continue;
    }
    if (typeof source !== 'string') {
      skipped.push({ file, reason: 'unreadable: readFile did not return a string' });
      continue;
    }
    filesScanned += 1;
    byLang.set(lang, (byLang.get(lang) || 0) + 1);

    let imports;
    try {
      imports = parseImports(source, { file, lang });
    } catch (error) {
      skipped.push({ file, reason: `parse failed: ${String((error && error.message) || error)}` });
      continue;
    }
    if (imports.length) filesWithImports += 1;

    for (const imp of imports) {
      totalSpecs += 1;
      const found = resolveSpecWithConfidence(imp.spec, {
        fromFile: file, files: fileSet, roots, aliases, lang, kind: imp.kind, dirIndex, goModules
      });
      if (!found) {
        unresolvedSpecs += 1;
        externalCounts.set(imp.spec, (externalCounts.get(imp.spec) || 0) + 1);
        continue;
      }
      for (const to of found.targets) {
        if (to === file) continue; // self-import (Go package siblings) is not an edge
        const key = `${file}\0${to}\0${imp.kind}`;
        const prev = edgeMap.get(key);
        if (!prev || found.confidence > prev.confidence) {
          edgeMap.set(key, { from: file, to, kind: imp.kind, confidence: found.confidence });
        }
      }
    }
  }

  const edges = [...edgeMap.values()].sort((a, b) =>
    byString(a.from, b.from) || byString(a.to, b.to) || byString(a.kind, b.kind));

  const outDeg = new Map();
  const inDeg = new Map();
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }
  const skippedSet = new Set(skipped.map((s) => s.file));
  const scannedSet = new Set(codeFiles.filter((f) => !skippedSet.has(f)));
  const nodes = [...scannedSet].sort(byString).map((file) => ({
    file,
    lang: langOf(file),
    imports: outDeg.get(file) || 0,
    importedBy: inDeg.get(file) || 0
  }));

  const external = [...externalCounts.entries()]
    .map(([spec, count]) => ({ spec, count }))
    .sort((a, b) => b.count - a.count || byString(a.spec, b.spec));

  const byLangObj = {};
  for (const key of [...byLang.keys()].sort(byString)) byLangObj[key] = byLang.get(key);

  return {
    nodes,
    edges,
    external,
    coverage: {
      filesScanned,
      filesWithImports,
      resolvedEdges: edges.length,
      totalSpecs,
      unresolvedSpecs,
      externalSpecs: external.length,
      skippedFiles: skipped.length,
      byLang: byLangObj
    },
    skipped: skipped.sort((a, b) => byString(a.file, b.file)),
    provenance: { basis: 'measured', source: 'import-scan', note: SCAN_NOTE }
  };
}

/** Read tsconfig/jsconfig aliases through the injected readFile. Never throws. */
function discoverAliases(readFile) {
  for (const configPath of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const text = readFile(configPath);
      if (typeof text !== 'string' || !text.trim()) continue;
      const aliases = parseTsconfigPaths(text, { configPath });
      if (aliases.length) return aliases;
    } catch {
      // Missing/unreadable config is the normal case — skip aliases entirely.
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// derived views (all pure)
// ---------------------------------------------------------------------------

function reverseAdjacency(graph) {
  const rev = new Map();
  for (const e of graph.edges || []) {
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
  }
  for (const list of rev.values()) list.sort(byString);
  return rev;
}

function forwardAdjacency(graph) {
  const fwd = new Map();
  for (const e of graph.edges || []) {
    if (!fwd.has(e.from)) fwd.set(e.from, []);
    if (!fwd.get(e.from).includes(e.to)) fwd.get(e.from).push(e.to);
  }
  for (const list of fwd.values()) list.sort(byString);
  return fwd;
}

/**
 * PURE. Reverse reachability = blast radius: every file that transitively
 * imports `file`, with the shortest hop distance. BFS, so `depth` is exact.
 *
 * @param {object} graph buildImportGraph() output
 * @param {string} file repo-relative path
 * @param {{depth?: number}} opts max hops (default: unbounded)
 * @returns {{file, maxDepth, dependents: Array<{file, depth}>}}
 */
export function dependents(graph, file, opts = {}) {
  const maxDepth = Number.isFinite(opts.depth) && opts.depth > 0 ? Math.floor(opts.depth) : Infinity;
  const rev = reverseAdjacency(graph);
  const seen = new Map();
  let frontier = [String(file || '')];
  seen.set(frontier[0], 0);
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const parent of rev.get(node) || []) {
        if (seen.has(parent)) continue;
        seen.set(parent, depth);
        next.push(parent);
      }
    }
    frontier = next.sort(byString);
  }
  seen.delete(String(file || ''));
  const list = [...seen.entries()]
    .map(([f, depth]) => ({ file: f, depth }))
    .sort((a, b) => a.depth - b.depth || byString(a.file, b.file));
  return {
    file: String(file || ''),
    maxDepth: maxDepth === Infinity ? null : maxDepth,
    dependents: list
  };
}

/**
 * PURE. Bounded enumeration of simple import cycles. Each cycle is canonicalized
 * (rotated so its byte-smallest member leads) and deduped. Both caps are hard:
 * `maxLen` bounds cycle length, `maxCycles` bounds the count — `truncated` says
 * so honestly instead of pretending the list is complete.
 *
 * @returns {{cycles: string[][], truncated: boolean, params: {maxLen, maxCycles}}}
 */
export function cycles(graph, opts = {}) {
  const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen >= 2 ? Math.floor(opts.maxLen) : 8;
  const maxCycles = Number.isFinite(opts.maxCycles) && opts.maxCycles > 0 ? Math.floor(opts.maxCycles) : 50;
  const fwd = forwardAdjacency(graph);
  const starts = [...new Set([...fwd.keys(), ...(graph.edges || []).map((e) => e.to)])].sort(byString);
  const rank = new Map(starts.map((f, i) => [f, i]));
  const found = [];
  const seenKeys = new Set();
  let truncated = false;

  for (const start of starts) {
    if (found.length >= maxCycles) { truncated = true; break; }
    const startRank = rank.get(start);
    const path = [start];
    const onPath = new Set([start]);
    const walk = (node) => {
      if (found.length >= maxCycles) { truncated = true; return; }
      for (const next of fwd.get(node) || []) {
        if (next === start && path.length >= 2) {
          const key = path.join('\x1f');
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            found.push([...path]);
            if (found.length >= maxCycles) { truncated = true; return; }
          }
          continue;
        }
        // Only explore nodes ranked after the start: each cycle is then
        // enumerated exactly once, from its smallest member.
        if (rank.get(next) <= startRank) continue;
        if (onPath.has(next)) continue;
        if (path.length >= maxLen) { truncated = true; continue; }
        path.push(next);
        onPath.add(next);
        walk(next);
        onPath.delete(next);
        path.pop();
        if (found.length >= maxCycles) return;
      }
    };
    walk(start);
  }

  found.sort((a, b) => a.length - b.length || byString(a.join('\x1f'), b.join('\x1f')));
  return { cycles: found, truncated, params: { maxLen, maxCycles } };
}

/** PURE. Files ranked by how many other files import them (in-degree). */
export function fanIn(graph) {
  return rankDegree(graph, 'importedBy');
}

/** PURE. Files ranked by how many files they import (out-degree). */
export function fanOut(graph) {
  return rankDegree(graph, 'imports');
}

function rankDegree(graph, key) {
  return (graph.nodes || [])
    .map((n) => ({ file: n.file, count: n[key] || 0 }))
    .sort((a, b) => b.count - a.count || byString(a.file, b.file));
}

/** The honest caveat that must travel with every orphan list. */
export const ORPHAN_CAVEAT =
  'CANDIDATES ONLY, not dead code: a file with no static importer may still be a CLI/bin entry point, ' +
  'a test, a hook script, a dynamically loaded plugin, or reached through a specifier this scanner ' +
  'cannot see (computed require, autoloader, build tag). Confirm before deleting anything.';

/**
 * PURE. Files nothing in the graph imports, minus known entry points.
 *
 * @param {object} graph
 * @param {{entryPoints?: string[]}} opts exact paths and/or simple globs
 * @returns {{candidates: Array<{file, lang}>, entryPoints: string[], caveat: string}}
 */
export function orphans(graph, opts = {}) {
  const entryPoints = [...new Set((opts.entryPoints || []).map(String))].sort(byString);
  const matchers = entryPoints.map(globToRegExp);
  const candidates = (graph.nodes || [])
    .filter((n) => !n.importedBy)
    .filter((n) => !matchers.some((re) => re.test(n.file)))
    .map((n) => ({ file: n.file, lang: n.lang }))
    .sort((a, b) => byString(a.file, b.file));
  return { candidates, entryPoints, caveat: ORPHAN_CAVEAT };
}

/** Minimal deterministic glob → RegExp (`**`, `*`, `?`). No brace expansion. */
export function globToRegExp(pattern) {
  const GLOBSTAR_SLASH = '\u0000';
  const GLOBSTAR = '\u0001';
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(GLOBSTAR_SLASH).join('(?:[^/]*\\/)*')
    .split(GLOBSTAR).join('.*');
  return new RegExp(`^${body}$`);
}

/** Conventional test/spec locations — never reported as dead-code candidates. */
export const TEST_ENTRY_GLOBS = Object.freeze([
  '**/*.spec.*', '**/*.test.*', '**/*_test.go', '**/conftest.py', '**/test_*.py',
  '__tests__/**', 'e2e/**', 'spec/**', 'test/**', 'tests/**'
]);

/**
 * PURE. Default entry points: package.json `bin` / `main` / `module` / `exports`
 * plus any script file named in `scripts`, plus bin/ and the conventional test
 * globs. Concrete paths are kept only when they exist in `files`; globs pass
 * through unfiltered.
 *
 * @param {{pkg?: object, files?: string[]}} input
 * @returns {string[]} sorted, deduped
 */
export function defaultEntryPoints(input = {}) {
  const pkg = input.pkg || {};
  const fileSet = new Set((input.files || []).map((f) => String(f).replace(/^\.\//, '')));
  const out = new Set(TEST_ENTRY_GLOBS);
  out.add('bin/**');

  const addPath = (value) => {
    const rel = normalizeRel(String(value || '').replace(/^\.\//, ''));
    if (rel && fileSet.has(rel)) out.add(rel);
  };
  const walkExports = (value, depth = 0) => {
    if (depth > 4) return;
    if (typeof value === 'string') addPath(value);
    else if (Array.isArray(value)) for (const v of value) walkExports(v, depth + 1);
    else if (value && typeof value === 'object') for (const k of Object.keys(value).sort(byString)) walkExports(value[k], depth + 1);
  };

  walkExports(pkg.main);
  walkExports(pkg.module);
  walkExports(pkg.bin);
  walkExports(pkg.exports);
  for (const command of Object.values(pkg.scripts || {})) {
    // Pull every path-looking token that names a script file out of the command.
    for (const m of String(command).matchAll(/[\w./@-]+\.(?:mjs|cjs|js|ts|tsx|py|rb|php|sh)\b/g)) addPath(m[0]);
  }
  return [...out].sort(byString);
}
