/**
 * Lightweight, language-agnostic symbol/reference extraction for languages
 * the TypeScript-compiler path in chunk.mjs does NOT cover (today: Python
 * and Go). This is the first, pure-JS increment that establishes the
 * extractor interface so polyglot code files can feed the EXISTING impact +
 * graph machinery (which only consumes record.symbols / exportedSymbols /
 * references). Precision via tree-sitter is the documented follow-up.
 *
 * Pure + exported for unit testing. No dependencies, no native modules.
 *
 * extractLiteSymbols(filePath, text) -> { symbols, exportedSymbols, references }
 *   - Unknown / unsupported extensions return empty arrays (safe no-op).
 */
import path from 'node:path';

const MAX_SYMBOLS = 200;
const MAX_REFERENCES = 256;

/**
 * Dispatch by file extension to a per-language lite extractor.
 * Returns empty arrays for anything we don't recognize so callers can treat
 * this as a safe fallback.
 */
export function extractLiteSymbols(filePath, text) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const source = String(text || '');
  switch (ext) {
    case '.py':
      return finalize(extractPython(source));
    case '.go':
      return finalize(extractGo(source));
    default:
      return { symbols: [], exportedSymbols: [], references: [] };
  }
}

/** Extensions this module can extract lite symbols for. */
export function isLiteCodeExt(ext) {
  return ext === '.py' || ext === '.go';
}

function finalize({ symbols, exportedSymbols, references }) {
  const sym = uniqueStrings(symbols).slice(0, MAX_SYMBOLS);
  const exp = uniqueStrings(exportedSymbols).slice(0, MAX_SYMBOLS);
  const symSet = new Set(sym);
  // References are "things this file uses that it doesn't itself define" — keep
  // them disjoint from local definitions so the impact graph's caller/callee
  // resolution doesn't treat a file as calling its own definitions.
  const refs = uniqueStrings(references).filter(r => !symSet.has(r)).slice(0, MAX_REFERENCES);
  return { symbols: sym, exportedSymbols: exp, references: refs };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/**
 * Python heuristics:
 *   - `def name(...)`      → symbol (exported unless _private)
 *   - `class Name(...)`    → symbol (exported unless _private)
 *   - module-level `NAME = ...` / `NAME: T = ...` → symbol (exported unless _private)
 *   - called identifiers `name(...)` and attribute roots `pkg.fn(...)` → references
 * "Exported" is heuristic: Python has no export keyword, so a top-level name is
 * treated as exported unless it starts with `_` (the de-facto private convention).
 */
export function extractPython(text) {
  const code = stripPythonStringsAndComments(text);
  const lines = code.split('\n');
  const symbols = [];
  const exportedSymbols = [];

  for (const line of lines) {
    const defMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (defMatch) {
      pushSymbol(symbols, exportedSymbols, defMatch[1], isPythonExported(defMatch[1]));
      continue;
    }
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/);
    if (classMatch) {
      pushSymbol(symbols, exportedSymbols, classMatch[1], isPythonExported(classMatch[1]));
      continue;
    }
    // Module-level assignment (no leading indentation): NAME = / NAME: T = .
    // Skip augmented assignments (+=, etc.) and comparisons (==).
    const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=(?!=)/);
    if (assignMatch && !/^\s/.test(line)) {
      pushSymbol(symbols, exportedSymbols, assignMatch[1], isPythonExported(assignMatch[1]));
    }
  }

  const references = collectReferences(code, new Set([...PY_KEYWORDS, ...PY_BUILTINS]));
  return { symbols, exportedSymbols, references };
}

function isPythonExported(name) {
  return !name.startsWith('_');
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/**
 * Go heuristics:
 *   - `func Name(...)`            → symbol
 *   - `func (r T) Name(...)`      → symbol (method; name only)
 *   - `type Name ...`             → symbol
 *   - top-level `var Name` / `const Name` (incl. grouped blocks)  → symbol
 * Exported in Go == identifier starts with an uppercase letter.
 */
export function extractGo(text) {
  const code = stripGoStringsAndComments(text);
  const lines = code.split('\n');
  const symbols = [];
  const exportedSymbols = [];
  let groupKind = null; // 'var' | 'const' inside a `var (` / `const (` block

  for (const line of lines) {
    // func Name(...) or func (recv T) Name(...)
    const funcMatch = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(\[]/);
    if (funcMatch) {
      pushSymbol(symbols, exportedSymbols, funcMatch[1], isGoExported(funcMatch[1]));
      continue;
    }
    // type Name ... (including `type Name struct {` / `type Name interface {`)
    const typeMatch = line.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (typeMatch) {
      pushSymbol(symbols, exportedSymbols, typeMatch[1], isGoExported(typeMatch[1]));
      continue;
    }

    // Grouped var/const blocks: `var (` ... `)`.
    if (/^\s*var\s*\($/.test(line)) { groupKind = 'var'; continue; }
    if (/^\s*const\s*\($/.test(line)) { groupKind = 'const'; continue; }
    if (groupKind && /^\s*\)\s*$/.test(line)) { groupKind = null; continue; }
    if (groupKind) {
      const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (entry) pushSymbol(symbols, exportedSymbols, entry[1], isGoExported(entry[1]));
      continue;
    }

    // Single-line top-level var/const NAME ...
    const single = line.match(/^\s*(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (single) pushSymbol(symbols, exportedSymbols, single[1], isGoExported(single[1]));
  }

  const references = collectReferences(code, GO_KEYWORDS);
  return { symbols, exportedSymbols, references };
}

function isGoExported(name) {
  return /^[A-Z]/.test(name);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pushSymbol(symbols, exportedSymbols, name, exported) {
  if (!name) return;
  symbols.push(name);
  if (exported) exportedSymbols.push(name);
}

/**
 * Collect called/used identifiers as references:
 *   - `name(...)` call sites
 *   - attribute / selector roots: `pkg.fn(...)` → `pkg` and `fn`
 * Filters out the language's keywords/builtins and very short names.
 */
function collectReferences(code, stopWords) {
  const refs = new Set();
  // Calls: identifier (or selector chain) immediately followed by `(`.
  for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g)) {
    for (const part of match[1].split('.')) addRef(refs, part, stopWords);
  }
  // Selector roots that aren't calls: `obj.attr` → obj (the package/receiver root).
  for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_]/g)) {
    addRef(refs, match[1], stopWords);
  }
  return [...refs];
}

function addRef(set, name, stopWords) {
  if (!name || name.length < 2) return;
  if (stopWords.has(name)) return;
  set.add(name);
}

function uniqueStrings(list) {
  return [...new Set((list || []).map(String).filter(Boolean))];
}

/** Strip Python comments and string literals (incl. triple-quoted) to avoid false refs. */
function stripPythonStringsAndComments(text) {
  return String(text)
    .replace(/'''[\s\S]*?'''/g, ' ')
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/#.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

/** Strip Go comments and string/rune literals (incl. raw backtick strings). */
function stripGoStringsAndComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ');
}

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'self', 'cls'
]);

const PY_BUILTINS = new Set([
  'print', 'len', 'range', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'type', 'isinstance', 'issubclass', 'super', 'object', 'open', 'enumerate', 'zip', 'map',
  'filter', 'sorted', 'reversed', 'sum', 'min', 'max', 'abs', 'round', 'any', 'all',
  'getattr', 'setattr', 'hasattr', 'repr', 'format', 'input', 'iter', 'next', 'bytes',
  'frozenset', 'property', 'staticmethod', 'classmethod', 'callable', 'hash', 'id', 'vars'
]);

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
  'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
  'return', 'select', 'struct', 'switch', 'type', 'var',
  // common builtins
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover', 'print',
  'println', 'close', 'complex', 'real', 'imag', 'nil', 'true', 'false', 'iota',
  // predeclared types
  'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'byte', 'rune', 'float32', 'float64', 'bool', 'error', 'any', 'uintptr'
]);
