import path from 'node:path';
import { chunkText } from './common.mjs';

const DEFAULT_MAX_CHARS = 1800;

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
  const symbols = await findSymbols(text, filePath);
  const imports = findImports(text);
  const importedNames = findImportedNames(text);
  if (!symbols.length) {
    return chunkText(text, maxChars, opts.overlap || 250).map(part => ({
      text: part,
      heading: path.basename(filePath),
      embeddingText: `${filePath}\n${part}`,
      symbols: [],
      imports,
      references: findReferences(part, importedNames)
    }));
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
      chunks.push(codeChunk(filePath, current, imports, importedNames));
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
  if (current.length) chunks.push(codeChunk(filePath, current, imports, importedNames));
  return chunks;
}

export function chunkSummary(text, filePath, docData = {}) {
  const ext = path.extname(filePath);
  const title = docData.title || path.basename(filePath);
  if (isCodeExt(ext)) {
    const symbols = findSymbolsRegex(text).map(symbol => symbol.name).slice(0, 40);
    const imports = findImports(text).slice(0, 40);
    const comment = (text.match(/\/\*\*([\s\S]*?)\*\//) || [])[1]?.replace(/^\s*\*\s?/gm, '').trim() || '';
    return {
      text: [`# ${title}`, `File: ${filePath}`, comment, symbols.length ? `Exports/symbols: ${symbols.join(', ')}` : 'No exported symbols detected.', imports.length ? `Imports: ${imports.join(', ')}` : ''].filter(Boolean).join('\n'),
      heading: title,
      isSummary: true,
      symbols,
      imports,
      references: []
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
  const summary = chunkSummary(text, filePath, docData);
  const chunks = isCodeExt(path.extname(filePath))
    ? await chunkCode(text, filePath, opts)
    : chunkMarkdown(text, opts);
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

async function findSymbols(text, filePath) {
  const ast = await findSymbolsAst(text, filePath);
  return ast.length ? ast : findSymbolsRegex(text);
}

async function findSymbolsAst(text, filePath) {
  let ts;
  try {
    ts = await import('typescript');
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

function codeChunk(filePath, parts, imports = [], importedNames = []) {
  const heading = parts.map(part => part.name).join(', ');
  const text = parts.map(part => part.body).join('\n\n');
  const symbols = parts.map(part => part.name);
  const symbolKinds = parts.map(part => part.kind || '').filter(Boolean);
  const exportedSymbols = parts.filter(part => part.exported).map(part => part.name);
  return {
    text,
    heading,
    embeddingText: `${filePath}\n${heading}\n${text}`,
    symbols,
    symbolKinds,
    exportedSymbols,
    lineStart: Math.min(...parts.map(part => part.lineStart || 1)),
    lineEnd: Math.max(...parts.map(part => part.lineEnd || 1)),
    imports,
    references: findReferences(text, [...importedNames, ...symbols])
  };
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
