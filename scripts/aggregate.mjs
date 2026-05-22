import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MINILM_EMBED_CAP = 1100;
const MINILM_EMBED_TRIM = 1080;

/**
 * Build human-readable + embed-ready text for a module/feature/project/decision-cluster
 * summary. See brain-index.mjs for usage. Pure: no FS, no I/O.
 *
 * - `text`         : full child concat — shown to humans via brain:pack.
 * - `embeddingText`: intent-dense, capped near MiniLM's ~256 token context so
 *                    the tail of a big group doesn't silently drop out.
 */
export function buildAggregateSummaryTexts({ title, key, readmeLeadParagraph = '', children }) {
  const verbose = children.map(record => `## ${record.heading || record.file}\n${record.text}`).join('\n\n');
  const childLines = [];
  const symbolUnion = new Set();
  const sliceCap = 20;
  const sorted = [...children].sort((a, b) => String(a.file).localeCompare(String(b.file)));
  for (const record of sorted.slice(0, sliceCap)) {
    const intent = firstSentenceOfChild(record);
    const childTitle = record.heading || path.basename(record.file || '');
    if (intent) childLines.push(`- ${childTitle}: ${intent}`);
    else if (childTitle) childLines.push(`- ${childTitle}`);
    for (const sym of (record.symbols || []).slice(0, 8)) symbolUnion.add(sym);
  }
  const remainder = children.length - sliceCap;
  if (remainder > 0) childLines.push(`- … +${remainder} more`);

  const embedSections = [
    `# ${title}`,
    `Key: ${key}`,
    readmeLeadParagraph ? `Readme: ${readmeLeadParagraph}` : '',
    childLines.length ? `Children:\n${childLines.join('\n')}` : '',
    symbolUnion.size ? `Exports: ${[...symbolUnion].slice(0, 60).join(', ')}` : ''
  ].filter(Boolean);

  let embeddingText = embedSections.join('\n');
  if (embeddingText.length > MINILM_EMBED_CAP) embeddingText = embeddingText.slice(0, MINILM_EMBED_TRIM) + ' …';
  return { text: verbose, embeddingText };
}

/** First non-boilerplate sentence from a child summary's text. */
export function firstSentenceOfChild(record) {
  const lines = String(record.text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('# ')) continue;
    if (line.startsWith('File: ')) continue;
    if (line.startsWith('Exports') || line.startsWith('Imports') || line.startsWith('Resolved ') || line.startsWith('Cross-file')) continue;
    if (line.startsWith('Headings:')) continue;
    if (line.startsWith('No exported') || line.startsWith('No headings')) continue;
    const match = line.match(/^[^.?!]+[.?!]?/);
    return (match ? match[0] : line).slice(0, 180);
  }
  return '';
}

/** Frontmatter-derived cluster keys for an ADR file-summary record. */
export function decisionGroupKeys(record) {
  const out = [];
  if (record.module) out.push({ kind: 'module', key: record.module });
  if (record.feature) out.push({ kind: 'feature', key: record.feature });
  return out;
}

/** Discover monorepo packages under packages/* and apps/* (configurable). */
export function discoverPackages(root, globs = ['packages/*', 'apps/*']) {
  const found = new Set();
  for (const pattern of globs) {
    const base = pattern.replace(/\/\*$/, '');
    const baseDir = path.join(root, base);
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pkgDir = `${base}/${entry.name}`;
      if (fs.existsSync(path.join(root, pkgDir, 'package.json'))) found.add(pkgDir);
    }
  }
  return [...found].sort();
}

/** Bucket file-summary records by which package directory they belong to. */
export function groupSummariesByPackage(records, packageDirs) {
  const sorted = [...packageDirs].sort((a, b) => b.length - a.length); // longest-prefix match
  const byPkg = new Map();
  for (const record of records) {
    if (!record.isSummary) continue;
    if (record.isModuleSummary || record.isProjectSummary || record.type === 'package-summary') continue;
    if (record.type === 'session' || record.type === 'auto-compact' || record.type === 'feature-summary') continue;
    const pkg = sorted.find(p => record.file === p || (record.file && record.file.startsWith(`${p}/`)));
    if (!pkg) continue;
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(record);
  }
  return byPkg;
}

/** First paragraph of `<root>/<dir>/README.md` (case-insensitive). */
export function readDirReadmeLead(root, dir) {
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
  for (const name of candidates) {
    const full = path.join(root, dir, name);
    if (!fs.existsSync(full)) continue;
    try {
      const text = fs.readFileSync(full, 'utf8');
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
      const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      for (const p of paragraphs) {
        if (p.startsWith('#')) continue;
        return p.slice(0, 280).replace(/\s+/g, ' ');
      }
    } catch {}
  }
  return '';
}

/** Parse top-level exports from `<root>/<pkgDir>/src/index.ts` or fallbacks. */
export function readTopLevelExports(root, pkgDir) {
  const candidates = ['src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'src/index.mjs'];
  for (const rel of candidates) {
    const full = path.join(root, pkgDir, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const text = fs.readFileSync(full, 'utf8');
      const names = new Set();
      for (const m of text.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
          const local = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (local && /^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
        }
      }
      for (const m of text.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.add(m[1]);
      }
      for (const m of text.matchAll(/^\s*export\s*\*\s*from\s+['"]([^'"]+)['"]/gm)) {
        names.add(`*from:${path.basename(m[1])}`);
      }
      if (names.size) return [...names].slice(0, 32);
    } catch {}
  }
  return [];
}

/**
 * Build the synthesized package-summary record for one package directory.
 * Returns null if package.json is missing or unparseable.
 */
export function buildPackageSummary({ root, pkgDir, childSummaries }) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(root, pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const name = pkgJson.name || pkgDir;
  const description = pkgJson.description || '';
  const keywords = Array.isArray(pkgJson.keywords) ? pkgJson.keywords.filter(Boolean).slice(0, 12) : [];
  const deps = [...Object.keys(pkgJson.dependencies || {}), ...Object.keys(pkgJson.peerDependencies || {})].slice(0, 24);
  const readmeLead = readDirReadmeLead(root, pkgDir);
  const topExports = readTopLevelExports(root, pkgDir);

  const childTitles = childSummaries
    .map(record => record.heading || path.basename(record.file || ''))
    .filter(Boolean)
    .slice(0, 24);
  const childIntents = childSummaries
    .slice(0, 12)
    .map(record => {
      const intent = firstSentenceOfChild(record);
      const t = record.heading || path.basename(record.file || '');
      return intent ? `- ${t}: ${intent}` : (t ? `- ${t}` : '');
    })
    .filter(Boolean);

  const embedSections = [
    `# ${name} package`,
    `Path: ${pkgDir}`,
    description ? `Description: ${description}` : '',
    keywords.length ? `Keywords: ${keywords.join(', ')}` : '',
    readmeLead ? `Readme: ${readmeLead}` : '',
    topExports.length ? `Exports: ${topExports.join(', ')}` : '',
    childIntents.length ? `Files:\n${childIntents.join('\n')}` : '',
    deps.length ? `Deps: ${deps.join(', ')}` : ''
  ].filter(Boolean);
  let embeddingText = embedSections.join('\n');
  if (embeddingText.length > MINILM_EMBED_CAP) embeddingText = embeddingText.slice(0, MINILM_EMBED_TRIM) + ' …';

  const text = [
    `# ${name}`,
    `Path: ${pkgDir}`,
    description && `> ${description}`,
    keywords.length && `**Keywords:** ${keywords.join(', ')}`,
    readmeLead && `**Readme:** ${readmeLead}`,
    topExports.length && `**Top-level exports:** ${topExports.join(', ')}`,
    childTitles.length && `**Files (${childSummaries.length}):** ${childTitles.join(', ')}`,
    deps.length && `**Dependencies:** ${deps.join(', ')}`
  ].filter(Boolean).join('\n\n');

  const signature = crypto
    .createHash('sha256')
    .update([name, description, keywords.join(','), readmeLead, topExports.join(','), deps.join(','), childTitles.join(',')].join('|'))
    .digest('hex');
  return { name, text, embeddingText, signature };
}
