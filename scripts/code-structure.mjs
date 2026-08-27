/**
 * code-structure.mjs — cheap, language-agnostic SHAPE metrics from source text.
 *
 * WHY THIS EXISTS. Our danger score (git-intel.mjs `fileHealth`) is purely
 * history-based: churn, co-change scatter, bus factor, fix density. It has zero
 * awareness of what the code actually looks like, so a 2,600-line file that
 * nobody has touched in a year scores 0 and a 12-line file edited yesterday
 * scores high. Competitors ship dozens of structural detectors on top of real
 * parsers. We deliberately ship THREE cheap ones — size, nesting, coupling —
 * because those are the only shape signals that (a) survive without a parser in
 * any language, (b) are deterministic to the byte, and (c) we can CALIBRATE
 * against this repo's own fix history (git-intel `calibrateFileHealth`). If the
 * calibration says they add nothing, the numbers say so and they stay opt-in.
 *
 * >>> THESE ARE SHAPE METRICS, NOT SEMANTICS. <<<
 * There is no AST, no symbol table, no type information, no control-flow graph.
 * "Nesting depth" is brace counting or indentation counting. "Function count"
 * is a per-language keyword/pattern table applied line by line. Consequences
 * that are NOT bugs but the documented contract:
 *   - a deeply nested but trivial data literal reads as deep nesting;
 *   - JS arrow callbacks passed inline (`arr.map(x => …)`) are NOT counted as
 *     functions — only line-anchored declarations/assignments are, so the count
 *     is a floor, not a total;
 *   - languages with keyword blocks (Ruby `def…end`) are measured by
 *     INDENTATION, which is convention, not syntax;
 *   - the indent unit is inferred from the file itself (see detectIndentUnit),
 *     so a file with inconsistent indentation reports inconsistent depth;
 *   - `todoCount` is scanned on the RAW text, so a TODO inside a string counts;
 *   - multi-line string/template/docstring bodies are blanked before measuring,
 *     so they are not code lines and their braces never raise depth.
 * A metric this module cannot compute honestly is reported as 0, never guessed.
 *
 * Comment- and string-blanking REUSES import-graph.mjs's `scanSource` (one
 * scanner, one truth — the same lexical blind spots are documented there:
 * heredocs, Ruby %-literals, nested Rust block comments, JS regex literals).
 *
 * PURE library: importing this module has zero side effects (no argv parsing,
 * no fs access, no clocks, no network). `measure` is total — it never throws,
 * whatever the input — and deterministic: the same source always produces
 * byte-identical numbers. No new dependencies.
 *
 * API:
 *   measure(source, {file, lang})        → shape metrics for one file
 *   measureFiles({files, readFile})      → {files, skipped, provenance}
 *   refactorPlan(measure, graphFacts, healthFactors) → [{move, why, evidence}]
 *   familyOfFile(file) / NESTING_STYLE / LONG_LINE_CHARS / REFACTOR_THRESHOLDS
 */
import path from 'node:path';
import { scanSource } from './import-graph.mjs';

const P = path.posix;

/** The honest limitation sentence that travels with every structural result. */
export const STRUCTURE_NOTE =
  'shape metrics, not semantics: brace/indent counting plus a per-language keyword table, ' +
  'no parser and no AST. Function counts are a floor (inline callbacks are not counted), ' +
  'nesting is textual (a deep data literal reads as deep code), and Ruby/Python/YAML depth ' +
  'is indentation, i.e. convention rather than syntax. Comments and string bodies are blanked ' +
  'before measuring, so a brace inside a string never raises depth.';

// ---------------------------------------------------------------------------
// language table
// ---------------------------------------------------------------------------

/**
 * Extension → structural family. Wider than import-graph's LANG_BY_EXT because
 * shape metrics need no resolver: any brace language can be counted, so the
 * C-like family ('c') is included on a best-effort basis and marked as such.
 */
export const FAMILY_BY_EXT = Object.freeze({
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py',
  '.go': 'go',
  '.rb': 'rb',
  '.php': 'php',
  '.rs': 'rs',
  '.java': 'c', '.kt': 'c', '.kts': 'c', '.cs': 'c', '.scala': 'c', '.swift': 'c',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.hpp': 'c', '.cxx': 'c',
  '.m': 'c', '.mm': 'c',
  '.yml': 'yaml', '.yaml': 'yaml'
});

/**
 * Which lexical syntax (comment/string delimiters) scanSource should use for a
 * family. C-like languages borrow the JS lexer (`//`, `/* *\/`, quotes) and
 * YAML borrows Python's (`#`, quotes) — deliberate reuse, no second scanner.
 */
const LEX_FAMILY = Object.freeze({
  js: 'js', c: 'js', go: 'go', rs: 'rs', php: 'php', rb: 'rb', py: 'py', yaml: 'py'
});

/**
 * How nesting is counted per family. 'brace' = `{`/`}` depth; 'indent' =
 * leading whitespace over the file's own inferred indent unit. Ruby uses
 * indent because its blocks are keyword-delimited (`def…end`) and idiomatic
 * Ruby is consistently indented — that is a CONVENTION, stated here so nobody
 * reads a Ruby depth as syntax.
 */
export const NESTING_STYLE = Object.freeze({
  js: 'brace', c: 'brace', go: 'brace', rs: 'brace', php: 'brace',
  py: 'indent', rb: 'indent', yaml: 'indent'
});

/** A raw line longer than this counts toward longLineCount. */
export const LONG_LINE_CHARS = 120;
/** Tabs expand to this many columns when measuring indentation. */
export const TAB_WIDTH = 4;
/** How many lines after a function header we look for its opening brace. */
const BRACE_LOOKAHEAD = 4;
/** Attention markers counted by todoCount (raw text, strings included). */
const TODO_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/g;

/** PURE. Structural family for a path, or '' when the extension is not measurable. */
export function familyOfFile(file) {
  const ext = P.extname(String(file || '')).toLowerCase();
  return FAMILY_BY_EXT[ext] || '';
}

// ---------------------------------------------------------------------------
// function-start patterns (a keyword table, NOT a parser)
// ---------------------------------------------------------------------------

/**
 * Per-family line-anchored function-start patterns. Capture group 1 is the
 * name when the pattern can name it. Anchoring at line start is what keeps
 * inline callbacks (`arr.map((x) => …)`) out of the count: the count is
 * deliberately a FLOOR, so "28 functions" is never an overstatement.
 */
const FUNCTION_PATTERNS = Object.freeze({
  js: [
    /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)?/,
    /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function\b|\([^)]*\)[ \t]*(?::[^=]*)?=>|[A-Za-z_$][\w$]*[ \t]*=>)/,
    /^[ \t]*(?:static[ \t]+)?(?:async[ \t]+)?(?:get[ \t]+|set[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*\{[ \t]*$/
  ],
  c: [
    /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|synchronized|native|virtual|override|open|inline|suspend|operator|extern|unsafe|async|partial|const)[ \t]+)*(?:fun|func|def|sub)?[ \t]*(?:[\w<>\[\],.?$&:*]+[ \t]+)?([A-Za-z_]\w*)[ \t]*\([^;{]*\)[^;{]*\{[ \t]*$/
  ],
  py: [/^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/],
  go: [/^[ \t]*func[ \t]*(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)?/],
  rs: [/^[ \t]*(?:pub[ \t]*(?:\([^)]*\)[ \t]*)?)?(?:default[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:extern[ \t]+(?:\S+[ \t]+)?)?fn[ \t]+([A-Za-z_]\w*)/],
  rb: [/^[ \t]*def[ \t]+([A-Za-z_][\w.:?!=]*)/],
  php: [/^[ \t]*(?:(?:public|private|protected|static|final|abstract)[ \t]+)*function[ \t]*&?[ \t]*([A-Za-z_]\w*)/],
  yaml: []
});

/**
 * Identifiers a brace-and-parens pattern can capture that are control flow,
 * not functions. Without this list `if (x) {` would be a "function".
 */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'catch', 'do', 'else', 'try', 'finally',
  'return', 'with', 'function', 'class', 'struct', 'enum', 'interface', 'namespace',
  'new', 'typeof', 'delete', 'void', 'await', 'yield', 'case', 'default', 'in', 'of',
  'import', 'export', 'const', 'let', 'var', 'match', 'when', 'unless', 'until',
  'lock', 'using', 'fixed', 'select', 'go', 'defer', 'loop'
]);

// ---------------------------------------------------------------------------
// blanking + line geometry
// ---------------------------------------------------------------------------

function round(n, digits) {
  return Number(Number(n).toFixed(digits));
}

/** Blank a [start,end) span to spaces, keeping newlines so line numbers survive. */
function blankSpan(chars, start, end) {
  for (let k = start; k < end && k < chars.length; k++) {
    if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
  }
}

/**
 * Characters after which a `/` starts a regex literal rather than a division.
 * `=>` and the keyword list below cover the remaining real positions.
 */
const REGEX_PREV_CHARS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '{', '}', '\n', '\r', ''
]);
/** Keywords after which a `/` starts a regex literal. */
const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do', 'else', 'yield',
  'await', 'new', 'delete', 'void', 'throw'
]);

/** The identifier ending at index `k` of `chars`, or '' when there is none. */
function wordEndingAt(chars, k) {
  let end = k;
  while (end >= 0 && /[A-Za-z_$0-9]/.test(chars[end])) end -= 1;
  return chars.slice(end + 1, k + 1).join('');
}

/**
 * PURE. One forward pass that blanks JS/TS comments, string bodies, template
 * literals AND regex literals, newlines preserved.
 *
 * WHY THIS ONE FAMILY DOES NOT USE scanSource. Every other family here goes
 * through import-graph's scanner — one scanner, one truth. JavaScript cannot,
 * and the reason is measured, not stylistic: scanSource has no regex-literal
 * awareness (its own header lists that as a blind spot), so in
 * `s.replace(/^["']|["']$/g, '')` it reads the `"` inside the character class
 * as a string opener and blanks forward to the next quote — swallowing the
 * closing braces of the enclosing function and every comment in between. On
 * brain-serve.mjs that single line made the "longest function" measure 2,657
 * lines and put every later declaration at depth 5. The failure is not
 * repairable by a post-pass either, because comments and regex literals both
 * start with `/`: whichever you resolve first needs the other one resolved.
 * So JS/TS gets the one place where the three constructs are decided together,
 * and everything else keeps reusing scanSource.
 *
 * Known limits, stated rather than hidden: JSX text is treated as code, a
 * template literal whose `${…}` contains an unbalanced brace inside a nested
 * string can end early, and a `/` after `)` is always division (so
 * `f(x)/re/` — which is not valid JS anyway — is never a literal).
 */
export function blankJs(source, { regexLiterals = true } = {}) {
  const src = String(source == null ? '' : source);
  const chars = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      blankSpan(chars, i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end === -1 ? n : end + 2;
      blankSpan(chars, i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        // An unterminated quote must not eat the rest of the file: stop at EOL.
        if (src[j] === '\n') break;
        if (src[j] === ch) { j += 1; break; }
        j += 1;
      }
      blankSpan(chars, i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let braces = 0; // `${` … `}` depth, so an inner backtick is content
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (braces === 0 && src[j] === '`') { j += 1; break; }
        if (src[j] === '$' && src[j + 1] === '{') { braces += 1; j += 2; continue; }
        if (braces > 0) {
          if (src[j] === '{') braces += 1;
          else if (src[j] === '}') braces -= 1;
        }
        j += 1;
      }
      blankSpan(chars, i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }
    if (regexLiterals && ch === '/') {
      // Look back over the ALREADY-BLANKED buffer: comments and strings before
      // this point are spaces, so the previous non-blank char is real code.
      let k = i - 1;
      while (k >= 0 && (chars[k] === ' ' || chars[k] === '\t' || chars[k] === '\r')) k -= 1;
      const prev = k >= 0 ? chars[k] : '';
      const arrow = prev === '>' && k >= 1 && chars[k - 1] === '=';
      const opens = arrow || REGEX_PREV_CHARS.has(prev) || REGEX_PREV_WORDS.has(wordEndingAt(chars, k));
      if (opens) {
        let j = i + 1;
        let inClass = false;
        let closed = -1;
        while (j < n) {
          const c = src[j];
          if (c === '\n' || c === '\r') break; // a literal never spans lines
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { closed = j; break; }
          j += 1;
        }
        if (closed !== -1) {
          blankSpan(chars, i, closed + 1);
          i = closed + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return chars.join('');
}

/**
 * PURE. Comments AND string bodies blanked (newlines preserved), so no pattern
 * and no brace counter can ever see inside a comment or a literal. This is the
 * single guarantee behind "a brace inside a string must not raise depth".
 * JS/TS uses blankJs (see there for why); every other family reuses
 * import-graph's scanSource. C-like sources take blankJs with regex literals
 * turned OFF — same comment/string syntax, but a bare `/` is always division.
 */
export function blankSource(source, opts = {}) {
  const file = String(opts.file || '');
  const family = String(opts.lang || '') || familyOfFile(file);
  const src = String(source == null ? '' : source);
  if (family === 'js') return blankJs(src, { regexLiterals: true });
  if (family === 'c') return blankJs(src, { regexLiterals: false });
  const { scrubbed, stringSpans } = scanSource(src, LEX_FAMILY[family] || 'js');
  const chars = scrubbed.split('');
  for (const [start, end] of stringSpans) blankSpan(chars, start, end);
  return chars.join('');
}

/** Leading indentation width in columns (tabs expand to TAB_WIDTH). */
function leadingWidth(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

/**
 * PURE. Infer the file's own indent step: the smallest positive indentation
 * that occurs at least twice (so a one-off aligned continuation line cannot
 * set the unit to 1), falling back to the smallest positive indent, then to 4.
 * Clamped to 1…8. Documented heuristic, not a parser setting.
 */
export function detectIndentUnit(widths) {
  const counts = new Map();
  for (const w of widths) {
    if (w > 0) counts.set(w, (counts.get(w) || 0) + 1);
  }
  if (!counts.size) return 4;
  const values = [...counts.keys()].sort((a, b) => a - b);
  const repeated = values.find((v) => counts.get(v) >= 2);
  const unit = repeated !== undefined ? repeated : values[0];
  return Math.min(8, Math.max(1, unit));
}

/**
 * Per-line brace depth. A line's depth is the SHALLOWEST level it sits at:
 * closers apply before the line is measured, openers after — so `}` closing a
 * block reads at the block's outer depth, and `function f() {` reads at 0.
 */
function braceDepths(lines) {
  const depths = [];
  let depth = 0;
  for (const line of lines) {
    let min = depth;
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth = Math.max(0, depth - 1);
        if (depth < min) min = depth;
      }
    }
    depths.push(min);
  }
  return depths;
}

/** Per-line indentation depth over the file's inferred unit. */
function indentDepths(lines) {
  const widths = lines.map((l) => (/\S/.test(l) ? leadingWidth(l) : -1));
  const unit = detectIndentUnit(widths.filter((w) => w > 0));
  return widths.map((w) => (w < 0 ? 0 : Math.floor(w / unit)));
}

// ---------------------------------------------------------------------------
// function spans
// ---------------------------------------------------------------------------

/** First matching function pattern on a blanked line → name (may be ''), or null. */
function matchFunction(line, patterns) {
  for (const re of patterns) {
    const m = re.exec(line);
    if (!m) continue;
    const name = (m[1] || '').trim();
    if (name && NOT_A_FUNCTION.has(name)) continue;
    return name || '(anonymous)';
  }
  return null;
}

/** Last line of a brace-delimited body opened at/near `start`. */
function braceEnd(lines, start) {
  const limit = Math.min(lines.length, start + BRACE_LOOKAHEAD);
  let open = start;
  while (open < limit && !lines[open].includes('{')) open += 1;
  if (open >= limit) return start; // expression body / declaration only
  let depth = 0;
  let opened = false;
  for (let j = open; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth += 1; opened = true; }
      else if (ch === '}') {
        depth -= 1;
        if (opened && depth <= 0) return j;
      }
    }
  }
  return lines.length - 1;
}

/** Last line of an indentation-delimited body starting at `start`. */
function indentEnd(lines, depths, start) {
  const base = depths[start];
  let end = lines.length - 1;
  for (let j = start + 1; j < lines.length; j++) {
    if (!/\S/.test(lines[j])) continue;
    if (depths[j] <= base) { end = j - 1; break; }
  }
  while (end > start && !/\S/.test(lines[end])) end -= 1;
  return end;
}

/** All function spans in a blanked file, in source order. */
function functionSpans(lines, depths, family) {
  const patterns = FUNCTION_PATTERNS[family] || [];
  if (!patterns.length) return [];
  const style = NESTING_STYLE[family];
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const name = matchFunction(lines[i], patterns);
    if (name === null) continue;
    const end = style === 'brace' ? braceEnd(lines, i) : indentEnd(lines, depths, i);
    spans.push({ name, startLine: i + 1, lines: Math.max(1, end - i + 1) });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// measure
// ---------------------------------------------------------------------------

/** The zero result for unmeasurable input — explicit zeros, never guesses. */
function emptyMeasure(file, family) {
  return {
    file,
    family,
    nestingStyle: family ? NESTING_STYLE[family] : '',
    lines: 0,
    codeLines: 0,
    maxNestingDepth: 0,
    avgNestingDepth: 0,
    longestFunctionLines: 0,
    longestFunctionName: '',
    longestFunctionStartLine: 0,
    functionCount: 0,
    longLineCount: 0,
    todoCount: 0
  };
}

/**
 * PURE + TOTAL. Shape metrics for one source file. Never throws; an unknown
 * extension or empty source yields the explicit all-zero record with
 * `family: ''` so callers can tell "not measurable" from "measured as zero".
 *
 * @param {string} source raw file text
 * @param {{file?: string, lang?: string}} opts `lang` overrides extension inference
 * @returns {{file, family, nestingStyle, lines, codeLines, maxNestingDepth,
 *   avgNestingDepth, longestFunctionLines, longestFunctionName,
 *   longestFunctionStartLine, functionCount, longLineCount, todoCount}}
 *
 * Definitions (each one deliberately dull and checkable):
 *   lines        physical lines in the raw text (0 for empty input)
 *   codeLines    lines with non-whitespace AFTER comments and string bodies
 *                are blanked — a comment-only line or a docstring interior is
 *                not code
 *   maxNestingDepth / avgNestingDepth  over code lines only; braces for
 *                js/c/go/rs/php, indentation for py/rb/yaml
 *   longestFunctionLines  the largest function span; nested functions are
 *                measured too, so the outer one usually wins
 *   functionCount  line-anchored declarations only (a FLOOR — see header)
 *   longLineCount  raw lines over LONG_LINE_CHARS (trailing \r ignored)
 *   todoCount    TODO/FIXME/XXX/HACK in the RAW text (strings included)
 */
export function measure(source, opts = {}) {
  const file = String(opts.file || '');
  const family = String(opts.lang || '') || familyOfFile(file);
  if (!family || !NESTING_STYLE[family]) return emptyMeasure(file, '');
  const src = String(source == null ? '' : source);
  if (!src) return emptyMeasure(file, family);

  const rawLines = src.split('\n');
  const code = blankSource(src, { lang: family });
  const codeLinesArr = code.split('\n');
  const style = NESTING_STYLE[family];
  const depths = style === 'brace' ? braceDepths(codeLinesArr) : indentDepths(codeLinesArr);

  let codeLines = 0;
  let depthSum = 0;
  let maxDepth = 0;
  for (let i = 0; i < codeLinesArr.length; i++) {
    if (!/\S/.test(codeLinesArr[i])) continue;
    codeLines += 1;
    const d = depths[i];
    depthSum += d;
    if (d > maxDepth) maxDepth = d;
  }

  const spans = functionSpans(codeLinesArr, depths, family);
  let longest = { name: '', startLine: 0, lines: 0 };
  for (const s of spans) {
    // Deterministic tie-break: the earliest span of the maximum length wins.
    if (s.lines > longest.lines) longest = s;
  }

  let longLineCount = 0;
  for (const line of rawLines) {
    if (line.replace(/\r$/, '').length > LONG_LINE_CHARS) longLineCount += 1;
  }
  TODO_RE.lastIndex = 0;
  const todoCount = (src.match(TODO_RE) || []).length;

  return {
    file,
    family,
    nestingStyle: style,
    lines: rawLines.length,
    codeLines,
    maxNestingDepth: maxDepth,
    avgNestingDepth: codeLines ? round(depthSum / codeLines, 2) : 0,
    longestFunctionLines: longest.lines,
    longestFunctionName: longest.name,
    longestFunctionStartLine: longest.startLine,
    functionCount: spans.length,
    longLineCount,
    todoCount
  };
}

/**
 * PURE (given an injected `readFile`) + TOTAL. Measure a whole file list.
 * A file that fails to read, returns a non-string, or has an unmeasurable
 * extension lands in `skipped` with a reason — never thrown, never silently
 * dropped. Output ordering is byte-stable, so repeated runs are JSON-identical.
 *
 * @param {{files: string[], readFile: (file: string) => string}} input
 * @returns {{files: object[], skipped: Array<{file, reason}>, provenance}}
 */
export function measureFiles(input = {}) {
  const readFile = typeof input.readFile === 'function'
    ? input.readFile
    : () => { throw new Error('no readFile'); };
  const list = [...new Set((input.files || []).map((f) => String(f).replace(/^\.\//, '')))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files = [];
  const skipped = [];
  for (const file of list) {
    if (!familyOfFile(file)) { skipped.push({ file, reason: 'extension not measurable' }); continue; }
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
    files.push(measure(source, { file }));
  }
  return {
    files,
    skipped,
    provenance: { basis: 'measured', source: 'code-structure', note: STRUCTURE_NOTE }
  };
}

// ---------------------------------------------------------------------------
// refactorPlan — "kein Score ohne Aktion", made concrete
// ---------------------------------------------------------------------------

/**
 * REVIEWABLE DEFAULT thresholds — the point at which a shape stops being a
 * style preference and becomes a named refactoring move. Same discipline as
 * RISK_WEIGHTS/FILE_HEALTH_WEIGHTS in git-intel.mjs: starting priors, printed
 * with every plan, overridable per call.
 */
export const REFACTOR_THRESHOLDS = Object.freeze({
  splitCodeLines: 400,
  splitFunctions: 12,
  longFunctionLines: 60,
  deepNesting: 6,
  fanInHazard: 20,
  fanOutHazard: 15,
  fixDensity: 0.3,
  // Above this top-author share the repo is treated as effectively solo and
  // the add-owner move is suppressed (see rule 7).
  soloRepoShare: 0.8,
  // add-owner only speaks about files that already earned attention.
  ownerAdviceMinScore: 6.5,
  busFactorRaw: 1
});

/** Fixed emission order, so a plan is byte-stable regardless of rule order. */
export const REFACTOR_MOVES = Object.freeze([
  'break-cycle', 'split-file', 'extract-function', 'reduce-nesting',
  'reduce-fan-in', 'add-tests', 'add-owner'
]);

/** Deterministic thousands grouping (no Intl — locale must not enter output). */
function group(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Accept either a fileHealth entry or its bare `factors` array. */
function factorsOf(healthFactors) {
  if (!healthFactors) return [];
  if (Array.isArray(healthFactors)) return healthFactors;
  if (Array.isArray(healthFactors.factors)) return healthFactors.factors;
  return [];
}

/**
 * PURE + TOTAL. Turn measurements into NAMED refactoring moves. Every item
 * quotes the number that fired the rule — there is no generic advice in here,
 * and when nothing fires the answer is an empty list, not filler.
 *
 * @param {object|null} fileMeasure measure() output for the file
 * @param {{file?: string, fanIn?: number, fanOut?: number,
 *          cycles?: string[][]}|null} graphFacts import-graph facts for the file
 * @param {Array|object|null} healthFactors a fileHealth entry or its factors
 * @param {{thresholds?: object}} opts
 * @returns {Array<{move: string, why: string, evidence: string}>}
 *   move ∈ split-file | extract-function | reduce-nesting | break-cycle |
 *          reduce-fan-in | add-owner | add-tests
 */
export function refactorPlan(fileMeasure, graphFacts, healthFactors, opts = {}) {
  const t = { ...REFACTOR_THRESHOLDS, ...(opts.thresholds || {}) };
  const m = fileMeasure && typeof fileMeasure === 'object' ? fileMeasure : null;
  const g = graphFacts && typeof graphFacts === 'object' ? graphFacts : null;
  const factors = factorsOf(healthFactors);
  const rawOf = (name) => {
    const f = factors.find((x) => x && x.name === name);
    return f && Number.isFinite(f.raw) ? f.raw : null;
  };
  const evidenceOf = (name) => {
    const f = factors.find((x) => x && x.name === name);
    return (f && f.evidence) || '';
  };
  const items = [];
  const add = (move, why, evidence) => items.push({ move, why, evidence });

  // 1. break-cycle — a real cycle through this file, named end to end.
  const file = (g && g.file) || (m && m.file) || '';
  const cycleList = (g && Array.isArray(g.cycles)) ? g.cycles : [];
  const cycle = cycleList.find((c) => Array.isArray(c) && c.includes(file));
  if (cycle && cycle.length) {
    const rendered = `${cycle.join(' → ')} → ${cycle[0]}`;
    add('break-cycle',
      `import cycle of ${cycle.length} file(s) — invert one edge (extract the shared piece ` +
      'into a third module) so the graph becomes acyclic',
      `cycle: ${rendered}`);
  }

  // 2. split-file — big AND many responsibilities, not merely long.
  if (m && m.codeLines >= t.splitCodeLines && m.functionCount >= t.splitFunctions) {
    add('split-file',
      `${group(m.codeLines)} code lines across ${m.functionCount} functions — split by responsibility`,
      `codeLines ${m.codeLines} ≥ ${t.splitCodeLines}, functions ${m.functionCount} ≥ ${t.splitFunctions}`);
  }

  // 3. extract-function — one oversized body, named.
  if (m && m.longestFunctionLines >= t.longFunctionLines) {
    const named = m.longestFunctionName && m.longestFunctionName !== '(anonymous)'
      ? `\`${m.longestFunctionName}\``
      : 'the longest function';
    add('extract-function',
      `${named} spans ${m.longestFunctionLines} lines from line ${m.longestFunctionStartLine} — ` +
      'extract its steps into named helpers',
      `longestFunctionLines ${m.longestFunctionLines} ≥ ${t.longFunctionLines}`);
  }

  // 4. reduce-nesting — textual depth, stated as textual depth.
  if (m && m.maxNestingDepth >= t.deepNesting) {
    add('reduce-nesting',
      `nesting reaches depth ${m.maxNestingDepth} (average ${m.avgNestingDepth}) — ` +
      'invert the guards and lift the inner block out',
      `maxNestingDepth ${m.maxNestingDepth} ≥ ${t.deepNesting} (${m.nestingStyle} counting)`);
  }

  // 5. reduce-fan-in — everything imports it; worse when it also imports everything.
  const fanInCount = g && Number.isFinite(g.fanIn) ? g.fanIn : 0;
  const fanOutCount = g && Number.isFinite(g.fanOut) ? g.fanOut : 0;
  if (fanInCount >= t.fanInHazard) {
    const both = fanOutCount >= t.fanOutHazard;
    add('reduce-fan-in',
      `${fanInCount} file(s) import this` +
      (both
        ? ` while it imports ${fanOutCount} — a hub in both directions; extract the stable core ` +
          'so importers stop inheriting its dependencies'
        : ' — extract the stable core so a change here stops rippling'),
      `fanIn ${fanInCount} ≥ ${t.fanInHazard}` + (both ? `, fanOut ${fanOutCount} ≥ ${t.fanOutHazard}` : ''));
  }

  // 6. add-tests — it keeps getting repaired (history, not shape).
  const fixRaw = rawOf('fix-density');
  if (fixRaw !== null && fixRaw >= t.fixDensity) {
    add('add-tests',
      `${Math.round(fixRaw * 100)}% of its commits are repairs — pin the behaviour with tests ` +
      'before changing it again',
      evidenceOf('fix-density') || `fix-density raw ${fixRaw} ≥ ${t.fixDensity}`);
  }

  // 7. add-owner — one effective owner (history, not shape).
  //
  // Suppressed when the repo is EFFECTIVELY solo: there, every file has bus
  // factor 1, so the move fires on all of them and carries no information — a
  // recommendation that is always true is noise, not advice. The gate uses the
  // top author's share of all commits rather than a distinct-name count,
  // because one person routinely commits under several git identities
  // (`nicenoize` / `Sebastian Herrmann` / `sherrmann` in this very repo would
  // otherwise read as a three-person team). Pass `opts.topAuthorShare` (0..1).
  // The repo-level concentration gate was not enough: on a five-author repo
  // it passes, and then the rule fires on EVERY file with bus factor 1 —
  // which is most of them. Advice that is always true is noise. Gate it on
  // the file mattering too: "this dangerous file also has one owner" is worth
  // saying; the same sentence about a trivial file is not.
  const busRaw = rawOf('bus-factor');
  const share = Number.isFinite(opts.topAuthorShare) ? opts.topAuthorShare : null;
  const notSoloRepo = share === null ? true : share < t.soloRepoShare;
  const fileMatters = Number.isFinite(opts.fileScore)
    ? opts.fileScore >= t.ownerAdviceMinScore
    : items.length > 0; // fallback: something else already fired on this file
  const ownerRuleApplies = notSoloRepo && fileMatters;
  if (ownerRuleApplies && busRaw !== null && busRaw >= t.busFactorRaw) {
    add('add-owner',
      'bus factor 1 — one person is the only effective owner; pair on the next change or ' +
      'write down what only they know',
      evidenceOf('bus-factor') || 'bus-factor raw 1');
  }

  const order = new Map(REFACTOR_MOVES.map((mv, i) => [mv, i]));
  items.sort((a, b) => (order.get(a.move) ?? 99) - (order.get(b.move) ?? 99));
  return items;
}
