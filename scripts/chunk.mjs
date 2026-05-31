import path from 'node:path';
import { chunkText } from './common.mjs';
import { extractLiteSymbols, isLiteCodeExt } from './lang-symbols.mjs';

const DEFAULT_MAX_CHARS = 1800;

/**
 * Polyglot (Python/Go) lite symbol extraction is gated OFF by default behind
 * BRAIN_POLYGLOT_SYMBOLS=1. When unset, indexing is byte-for-byte unchanged —
 * .py/.go files fall through to the markdown chunker exactly as before. The
 * intent is to flip this default-on after validation; tree-sitter precision is
 * the documented follow-up.
 */
export function polyglotSymbolsEnabled() {
  return process.env.BRAIN_POLYGLOT_SYMBOLS === '1';
}

/** Is this an extension we'll handle as a code file (TS/JS precise OR polyglot lite)? */
function isHandledCodeExt(ext) {
  return isCodeExt(ext) || (polyglotSymbolsEnabled() && isLiteCodeExt(ext));
}

export function chunkMarkdown(text, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const sections = splitMarkdownSections(text);
  const chunks = [];
  for (const section of sections) {
    if (section.text.length <= maxChars) {
      chunks.push(section);
      continue;
    }
    for (const part of chunkText(section.text, maxChars, opts.overlap || 250)) {
      chunks.push({ text: part, heading: section.heading });
    }
  }
  return chunks.filter(chunk => chunk.text.trim());
}

export async function chunkCode(text, filePath, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const tsSemantics = opts.tsSemantics || null;
  const symbols = await findSymbols(text, filePath, tsSemantics);
  const imports = findImports(text);
  const importedNames = findImportedNames(text);
  if (!symbols.length) {
    return chunkText(text, maxChars, opts.overlap || 250).map((part) => {
      const chunk = {
        text: part,
        heading: path.basename(filePath),
        embeddingText: `${filePath}\n${part}`,
        symbols: [],
        symbolKinds: [],
        exportedSymbols: [],
        lineStart: 1,
        lineEnd: lineNumberAt(part, part.length),
        imports,
        references: findReferences(part, importedNames)
      };
      if (!tsSemantics?.resolvedImports?.length) return chunk;
      return {
        ...chunk,
        imports: uniqueStrings([...(chunk.imports || []), ...tsSemantics.resolvedImports]).slice(0, 48)
      };
    });
  }

  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (let i = 0; i < symbols.length; i++) {
    const start = symbols[i].index;
    const end = symbols[i + 1]?.index || text.length;
    const rawBody = text.slice(start, end);
    const body = rawBody.trim();
    const lineStart = lineNumberAt(text, start);
    const lineEnd = lineStart + body.split('\n').length - 1;
    if (currentLen && currentLen + body.length > maxChars) {
      chunks.push(codeChunk(filePath, current, imports, importedNames, text, tsSemantics));
      current = [];
      currentLen = 0;
    }
    current.push({
      name: symbols[i].name,
      kind: symbols[i].kind,
      exported: symbols[i].exported,
      lineStart,
      lineEnd,
      body
    });
    currentLen += body.length;
  }
  if (current.length) chunks.push(codeChunk(filePath, current, imports, importedNames, text, tsSemantics));
  return chunks;
}

/**
 * Polyglot-lite code chunker for languages outside the TS/JS AST path
 * (Python/Go today). Splits on size only (no per-symbol windowing — that's a
 * tree-sitter follow-up) but carries the regex-extracted symbols /
 * exportedSymbols / references on EVERY chunk so the existing impact + graph
 * machinery sees them. Only reached when BRAIN_POLYGLOT_SYMBOLS=1.
 */
export function chunkLiteCode(text, filePath, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const { symbols, exportedSymbols, references } = extractLiteSymbols(filePath, text);
  const imports = findImports(text);
  // Size-only splitting with bounded overlap. Small files (the common case)
  // stay a single chunk. Per-symbol windowing is the tree-sitter follow-up.
  const parts = splitBySize(text, maxChars, Math.min(opts.overlap || 250, Math.floor(maxChars / 4)));
  return parts.filter(Boolean).map((part) => ({
    text: part,
    heading: symbols.length ? symbols.slice(0, 12).join(', ') : path.basename(filePath),
    embeddingText: `${filePath}\n${part}`,
    symbols,
    symbolKinds: [],
    exportedSymbols,
    lineStart: 1,
    lineEnd: lineNumberAt(part, part.length),
    imports,
    references
  }));
}

export function chunkSummary(text, filePath, docData = {}, tsSemantics = null) {
  const ext = path.extname(filePath);
  const title = docData.title || path.basename(filePath);
  if (!isCodeExt(ext) && polyglotSymbolsEnabled() && isLiteCodeExt(ext)) {
    const { symbols, exportedSymbols } = extractLiteSymbols(filePath, text);
    const names = uniqueStrings([...exportedSymbols, ...symbols]).slice(0, 40);
    const imports = findImports(text).slice(0, 40);
    const intent = extractCodeIntent(text);
    return {
      text: [`# ${title}`, `File: ${filePath}`, intent, names.length ? `Exports/symbols: ${names.join(', ')}` : 'No exported symbols detected.', imports.length ? `Imports: ${imports.join(', ')}` : ''].filter(Boolean).join('\n'),
      heading: title,
      isSummary: true,
      symbols: names,
      imports: uniqueStrings(imports).slice(0, 48),
      references: []
    };
  }
  if (isCodeExt(ext)) {
    const symbols = findSymbolsRegex(text).map(symbol => symbol.name).slice(0, 40);
    const imports = findImports(text).slice(0, 40);
    // Intent sentence: prefer the file's leading JSDoc, then the first exported
    // symbol's JSDoc, then the first non-empty // line at the top of the file.
    // Embedding a real sentence beats embedding a bag of identifiers — most of
    // the dense-recall benefit on code files lives in this one line.
    const intent = extractCodeIntent(text);
    const resolved = tsSemantics?.resolvedImports?.length
      ? `Resolved modules: ${tsSemantics.resolvedImports.slice(0, 32).join(', ')}`
      : '';
    const cross = tsSemantics?.crossFileRefs?.size
      ? `Cross-file refs: ${[...tsSemantics.crossFileRefs].slice(0, 40).join(', ')}`
      : '';
    return {
      text: [`# ${title}`, `File: ${filePath}`, intent, symbols.length ? `Exports/symbols: ${symbols.join(', ')}` : 'No exported symbols detected.', imports.length ? `Imports: ${imports.join(', ')}` : '', resolved, cross].filter(Boolean).join('\n'),
      heading: title,
      isSummary: true,
      symbols,
      imports: uniqueStrings([...imports, ...(tsSemantics?.resolvedImports || [])]).slice(0, 48),
      references: tsSemantics?.crossFileRefs?.size ? [...tsSemantics.crossFileRefs].slice(0, 48) : []
    };
  }
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map(match => match[1].trim()).slice(0, 40);
  const frontmatter = Object.entries(docData).map(([key, value]) => `${key}: ${value}`).join('\n');
  return {
    text: [`# ${title}`, `File: ${filePath}`, frontmatter, headings.length ? `Headings: ${headings.join(' | ')}` : 'No headings detected.'].filter(Boolean).join('\n'),
    heading: title,
    isSummary: true
  };
}

export async function dispatchChunker(filePath, text, docData = {}, opts = {}) {
  const tsSemantics = opts.tsContext?.get?.(filePath) || null;
  const summary = chunkSummary(text, filePath, docData, tsSemantics);
  const ext = path.extname(filePath);
  let chunks;
  if (isCodeExt(ext)) {
    // Precise TS/JS AST path — unchanged.
    chunks = await chunkCode(text, filePath, { ...opts, tsSemantics });
  } else if (polyglotSymbolsEnabled() && isLiteCodeExt(ext)) {
    // Polyglot fallback (Python/Go), env-gated. Leaves the TS/JS path untouched.
    chunks = chunkLiteCode(text, filePath, opts);
  } else {
    chunks = chunkMarkdown(text, opts);
  }
  return [
    { ...summary, chunk: -1, embeddingText: `${filePath}\n${summary.text}` },
    ...chunks.map((chunk, index) => ({
      ...chunk,
      chunk: index,
      embeddingText: chunk.embeddingText || `${filePath}\n${chunk.heading || ''}\n${chunk.text}`
    }))
  ];
}

function splitMarkdownSections(text) {
  const matches = [...text.matchAll(/^#{2,3}\s+(.+)$/gm)];
  if (!matches.length) return chunkText(text).map(part => ({ text: part, heading: '' }));
  const sections = [];
  if (matches[0].index > 0) sections.push({ heading: '', text: text.slice(0, matches[0].index).trim() });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index || text.length;
    sections.push({ heading: matches[i][1].trim(), text: text.slice(start, end).trim() });
  }
  return sections.filter(section => section.text);
}

async function findSymbols(text, filePath, tsSemantics = null) {
  // Reuse declared symbols from the ts-graph pass when available — avoids
  // a second `import('typescript')` and a duplicate AST walk per file.
  if (tsSemantics?.declaredSymbols?.length) return tsSemantics.declaredSymbols;
  const ast = await findSymbolsAst(text, filePath);
  return ast.length ? ast : findSymbolsRegex(text);
}

async function findSymbolsAst(text, filePath) {
  let ts;
  try {
    const mod = await import('typescript');
    ts = mod.default ?? mod;
  } catch {
    return [];
  }
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX
    : filePath.endsWith('.jsx') ? ts.ScriptKind.JSX
      : filePath.endsWith('.js') || filePath.endsWith('.mjs') ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols = [];
  visit(source);
  return symbols.sort((a, b) => a.index - b.index);

  function visit(node) {
    const name = node.parent === source ? symbolName(node) : '';
    if (name) {
      symbols.push({ name, kind: ts.SyntaxKind[node.kind], exported: hasExport(node), index: node.getStart(source) });
    }
    ts.forEachChild(node, visit);
  }

  function symbolName(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      return node.name.text;
    }
    if (ts.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations[0];
      if (declaration?.name && ts.isIdentifier(declaration.name)) return declaration.name.text;
    }
    return '';
  }

  function hasExport(node) {
    return Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
  }
}

/** Pull a one-sentence intent description out of a code file. */
export function extractCodeIntent(text) {
  // 1. File-level JSDoc: the first /** */ block at the very top of the file
  //    (before any non-whitespace content other than `'use strict';` etc).
  const fileJsDoc = text.match(/^\s*(?:['"]use strict['"];?\s*)?(\/\*\*([\s\S]*?)\*\/)/);
  if (fileJsDoc) {
    const cleaned = stripJsDocStars(fileJsDoc[2]);
    if (cleaned) return cleaned;
  }
  // 2. JSDoc immediately preceding the first `export` declaration.
  const exportJsDoc = text.match(/\/\*\*([\s\S]*?)\*\/\s*export\s+(?:async\s+)?(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\b/);
  if (exportJsDoc) {
    const cleaned = stripJsDocStars(exportJsDoc[1]);
    if (cleaned) return cleaned;
  }
  // 3. Leading line comments (//) at the top of the file.
  const lines = text.split('\n');
  const commentBuf = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (commentBuf.length) break;
      continue;
    }
    if (trimmed.startsWith('//')) {
      commentBuf.push(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }
    break;
  }
  if (commentBuf.length) return commentBuf.join(' ').trim();
  return '';
}

function stripJsDocStars(raw) {
  return String(raw)
    .replace(/^\s*\*\s?/gm, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('@')) // drop @param/@returns/@throws/etc.
    .join(' ')
    .trim();
}

function findSymbolsRegex(text) {
  const pattern = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  return [...text.matchAll(pattern)].map(match => ({ name: match[1], kind: 'regex', exported: match[0].trim().startsWith('export'), index: match.index || 0 }));
}

function findImports(text) {
  const imports = new Set();
  for (const match of text.matchAll(/^\s*import(?:\s+type)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)) imports.add(match[1]);
  for (const match of text.matchAll(/^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm)) imports.add(match[1]);
  for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gm)) imports.add(match[1]);
  return [...imports];
}

function findImportedNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/^\s*import(?:\s+type)?\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm)) {
    const clause = match[1].trim();
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const local = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (local) names.add(local);
      }
    }
    const defaultName = clause.replace(/\{[\s\S]*?\}/, '').split(',')[0].trim();
    if (defaultName && /^[A-Za-z_$][\w$]*$/.test(defaultName)) names.add(defaultName);
  }
  return [...names];
}

function findReferences(text, candidateSymbols = []) {
  const code = stripStringsAndComments(text);
  const refs = new Set();
  for (const symbol of candidateSymbols) {
    const name = typeof symbol === 'string' ? symbol : symbol.name;
    if (!name) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
    if (pattern.test(code)) refs.add(name);
  }
  for (const match of code.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g)) {
    if (!JS_WORDS.has(match[1])) refs.add(match[1]);
  }
  return [...refs];
}

function codeChunk(filePath, parts, imports = [], importedNames = [], fullFileText = '', tsSemantics = null) {
  const heading = parts.map(part => part.name).join(', ');
  const text = parts.map(part => part.body).join('\n\n');
  const symbols = parts.map(part => part.name);
  const symbolKinds = parts.map(part => part.kind || '').filter(Boolean);
  const exportedSymbols = parts.filter(part => part.exported).map(part => part.name);
  const lineStart = Math.min(...parts.map(part => part.lineStart || 1));
  const lineEnd = Math.max(...parts.map(part => part.lineEnd || 1));
  const base = {
    text,
    heading,
    embeddingText: `${filePath}\n${heading}\n${text}`,
    symbols,
    symbolKinds,
    exportedSymbols,
    lineStart,
    lineEnd,
    imports,
    references: findReferences(text, [...importedNames, ...symbols])
  };
  return mergeSemanticsChunk(base, fullFileText, tsSemantics);
}

function mergeSemanticsChunk(chunk, fullFileText, tsSemantics) {
  if (!tsSemantics || !fullFileText) return chunk;
  const { start, end } = lineRangeToOffsets(fullFileText, chunk.lineStart || 1, chunk.lineEnd || 1);
  const fromTs = [];
  for (const span of tsSemantics.spans || []) {
    if (span.end < start || span.start > end) continue;
    fromTs.push(span.name);
  }
  const mergedImports = uniqueStrings([...(chunk.imports || []), ...(tsSemantics.resolvedImports || [])]).slice(0, 48);
  const mergedRefs = uniqueStrings([...(chunk.references || []), ...fromTs]).slice(0, 64);
  return { ...chunk, imports: mergedImports, references: mergedRefs };
}

function uniqueStrings(list) {
  return [...new Set(list.map(String).filter(Boolean))];
}

/**
 * Fixed-window split with a bounded overlap that always makes forward progress
 * (avoids the overlap-underflow looping that bites the shared chunkText on
 * inputs <= overlap). Used by the polyglot-lite code chunker.
 */
function splitBySize(text, maxChars, overlap) {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const step = Math.max(1, maxChars - Math.max(0, overlap));
  const chunks = [];
  for (let i = 0; i < clean.length; i += step) {
    chunks.push(clean.slice(i, Math.min(i + maxChars, clean.length)).trim());
    if (i + maxChars >= clean.length) break;
  }
  return chunks.filter(Boolean);
}

function lineRangeToOffsets(text, lineStart, lineEnd) {
  const lines = text.split('\n');
  if (!lines.length) return { start: 0, end: 0 };
  const startIdx = Math.min(Math.max(lineStart, 1), lines.length);
  const endIdx = Math.min(Math.max(lineEnd, startIdx), lines.length);
  let start = 0;
  for (let ln = 1; ln < startIdx; ln++) start += lines[ln - 1].length + 1;
  let end = start;
  for (let ln = startIdx; ln <= endIdx; ln++) {
    end += lines[ln - 1].length;
    if (ln < endIdx) end += 1;
  }
  return { start: Math.min(start, text.length), end: Math.min(Math.max(end, start), text.length) };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripStringsAndComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

const JS_WORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'extends', 'return', 'import', 'export', 'from',
  'async', 'await', 'for', 'while', 'if', 'else', 'switch', 'case', 'break', 'continue',
  'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'true', 'false', 'null',
  'undefined', 'typeof', 'instanceof', 'delete', 'void', 'yield', 'default'
]);

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function isCodeExt(ext) {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext);
}
