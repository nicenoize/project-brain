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

export function chunkCode(text, filePath, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const symbols = findSymbols(text);
  if (!symbols.length) {
    return chunkText(text, maxChars, opts.overlap || 250).map(part => ({
      text: part,
      heading: path.basename(filePath),
      embeddingText: `${filePath}\n${part}`
    }));
  }

  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (let i = 0; i < symbols.length; i++) {
    const start = symbols[i].index;
    const end = symbols[i + 1]?.index || text.length;
    const body = text.slice(start, end).trim();
    if (currentLen && currentLen + body.length > maxChars) {
      chunks.push(codeChunk(filePath, current));
      current = [];
      currentLen = 0;
    }
    current.push({ name: symbols[i].name, body });
    currentLen += body.length;
  }
  if (current.length) chunks.push(codeChunk(filePath, current));
  return chunks;
}

export function chunkSummary(text, filePath, docData = {}) {
  const ext = path.extname(filePath);
  const title = docData.title || path.basename(filePath);
  if (isCodeExt(ext)) {
    const symbols = findSymbols(text).map(symbol => symbol.name).slice(0, 40);
    const comment = (text.match(/\/\*\*([\s\S]*?)\*\//) || [])[1]?.replace(/^\s*\*\s?/gm, '').trim() || '';
    return {
      text: [`# ${title}`, `File: ${filePath}`, comment, symbols.length ? `Exports/symbols: ${symbols.join(', ')}` : 'No exported symbols detected.'].filter(Boolean).join('\n'),
      heading: title,
      isSummary: true
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

export function dispatchChunker(filePath, text, docData = {}, opts = {}) {
  const summary = chunkSummary(text, filePath, docData);
  const chunks = isCodeExt(path.extname(filePath))
    ? chunkCode(text, filePath, opts)
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

function findSymbols(text) {
  const pattern = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  return [...text.matchAll(pattern)].map(match => ({ name: match[1], index: match.index || 0 }));
}

function codeChunk(filePath, parts) {
  const heading = parts.map(part => part.name).join(', ');
  const text = parts.map(part => part.body).join('\n\n');
  return {
    text,
    heading,
    embeddingText: `${filePath}\n${heading}\n${text}`
  };
}

function isCodeExt(ext) {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext);
}
