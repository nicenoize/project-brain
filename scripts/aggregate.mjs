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
/**
 * Synthesize one repo-summary record per fleet project (chunk: -7).
 * Returns { name, text, embeddingText, signature } or null when no
 * contracts can be extracted.
 *
 * Repo summaries differ from package summaries: they cover any language
 * (Node / Go / Python / Helm / kustomize / Docker), not just JS packages.
 * They aggregate the project's high-signal anchors (package.json name +
 * description, go.mod module path, Chart.yaml metadata, README first
 * paragraph, top-level exports, k8s service names, Dockerfile-built
 * image refs) into a single intent-dense vector per project.
 */
export function buildRepoSummary({ root, project, childSummaries = [] }) {
  const contracts = extractProjectContracts(root, project);
  const readmeLead = readDirReadmeLead(root, project.dir);
  const name = contracts.name || project.name;
  const description = contracts.description || '';
  const kinds = project.kinds || [];

  const childTitles = childSummaries
    .map(r => r.heading || path.basename(r.file || ''))
    .filter(Boolean)
    .slice(0, 18);
  const childIntents = childSummaries
    .slice(0, 10)
    .map(r => {
      const intent = firstSentenceOfChild(r);
      const t = r.heading || path.basename(r.file || '');
      return intent ? `- ${t}: ${intent}` : (t ? `- ${t}` : '');
    })
    .filter(Boolean);

  const embedSections = [
    `# ${name} project`,
    `Path: ${project.dir}`,
    kinds.length ? `Kinds: ${kinds.join(', ')}` : '',
    description ? `Description: ${description}` : '',
    readmeLead ? `Readme: ${readmeLead}` : '',
    contracts.routes?.length ? `Routes: ${contracts.routes.slice(0, 12).join(', ')}` : '',
    contracts.services?.length ? `Services: ${contracts.services.slice(0, 12).join(', ')}` : '',
    contracts.images?.length ? `Images: ${contracts.images.slice(0, 8).join(', ')}` : '',
    contracts.topExports?.length ? `Exports: ${contracts.topExports.slice(0, 24).join(', ')}` : '',
    contracts.binaries?.length ? `Binaries: ${contracts.binaries.slice(0, 8).join(', ')}` : '',
    childIntents.length ? `Files:\n${childIntents.join('\n')}` : '',
    contracts.deps?.length ? `Deps: ${contracts.deps.slice(0, 18).join(', ')}` : ''
  ].filter(Boolean);
  let embeddingText = embedSections.join('\n');
  if (embeddingText.length > 1100) embeddingText = embeddingText.slice(0, 1080) + ' …';

  const text = [
    `# ${name}`,
    `Path: ${project.dir}`,
    kinds.length && `**Kinds:** ${kinds.join(', ')}`,
    description && `> ${description}`,
    readmeLead && `**Readme:** ${readmeLead}`,
    contracts.routes?.length && `**Routes:** ${contracts.routes.join(', ')}`,
    contracts.services?.length && `**Services:** ${contracts.services.join(', ')}`,
    contracts.images?.length && `**Images:** ${contracts.images.join(', ')}`,
    contracts.topExports?.length && `**Exports:** ${contracts.topExports.join(', ')}`,
    contracts.binaries?.length && `**Binaries:** ${contracts.binaries.join(', ')}`,
    childTitles.length && `**Files (${childSummaries.length}):** ${childTitles.join(', ')}`,
    contracts.deps?.length && `**Deps:** ${contracts.deps.join(', ')}`
  ].filter(Boolean).join('\n\n');

  const sig = crypto.createHash('sha256').update([
    name, description, kinds.join(','), readmeLead,
    (contracts.routes || []).join(','), (contracts.services || []).join(','),
    (contracts.images || []).join(','), (contracts.topExports || []).join(','),
    (contracts.binaries || []).join(','), (contracts.deps || []).join(','),
    childTitles.join(',')
  ].join('|')).digest('hex');

  return { name, text, embeddingText, signature: sig };
}

/** Pulls contracts (routes, services, images, etc.) from a project dir. */
export function extractProjectContracts(root, project) {
  const projAbs = path.join(root, project.dir);
  const out = {
    name: project.name, description: '',
    routes: [], services: [], images: [], topExports: [],
    binaries: [], deps: []
  };

  if (project.kinds?.includes('node')) {
    Object.assign(out, mergeContracts(out, extractNodeContracts(projAbs)));
  }
  if (project.kinds?.includes('go')) {
    Object.assign(out, mergeContracts(out, extractGoContracts(projAbs)));
  }
  if (project.kinds?.includes('python')) {
    Object.assign(out, mergeContracts(out, extractPythonContracts(projAbs)));
  }
  if (project.kinds?.includes('helm') || project.kinds?.includes('kustomize')) {
    Object.assign(out, mergeContracts(out, extractK8sContracts(projAbs)));
  }
  if (project.kinds?.includes('docker')) {
    Object.assign(out, mergeContracts(out, extractDockerContracts(projAbs, project)));
  }
  if (project.kinds?.includes('proto')) {
    Object.assign(out, mergeContracts(out, extractProtoContracts(projAbs)));
  }
  return out;
}

function mergeContracts(prev, next) {
  return {
    name: next.name || prev.name,
    description: next.description || prev.description,
    routes: [...(prev.routes || []), ...(next.routes || [])],
    services: [...(prev.services || []), ...(next.services || [])],
    images: [...(prev.images || []), ...(next.images || [])],
    topExports: [...(prev.topExports || []), ...(next.topExports || [])],
    binaries: [...(prev.binaries || []), ...(next.binaries || [])],
    deps: [...(prev.deps || []), ...(next.deps || [])]
  };
}

function extractNodeContracts(projAbs) {
  const out = { topExports: [], routes: [], deps: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projAbs, 'package.json'), 'utf8'));
    out.name = pkg.name;
    out.description = pkg.description || '';
    out.deps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})];
    out.topExports = readTopLevelExports(projAbs, '');
  } catch {}
  // Route discovery: app/api/**/route.ts (Next.js) + src/routes/*.ts (express-ish).
  for (const pattern of [['app', 'api'], ['src', 'routes'], ['pages', 'api']]) {
    const dir = path.join(projAbs, ...pattern);
    if (!fs.existsSync(dir)) continue;
    walkShallow(dir, projAbs, 4, (rel) => {
      if (/\.(t|j)sx?$/.test(rel)) out.routes.push(rel.replace(/\\/g, '/'));
    });
  }
  return out;
}

function extractGoContracts(projAbs) {
  const out = { binaries: [], deps: [] };
  try {
    const mod = fs.readFileSync(path.join(projAbs, 'go.mod'), 'utf8');
    const m = mod.match(/^module\s+(\S+)/m);
    if (m) out.name = m[1];
    out.deps = [...mod.matchAll(/^\s*([^\s/]+\.[^\s/]+\/\S+)\s+v/gm)].map(x => x[1]).slice(0, 24);
  } catch {}
  const cmdDir = path.join(projAbs, 'cmd');
  if (fs.existsSync(cmdDir)) {
    try {
      for (const entry of fs.readdirSync(cmdDir, { withFileTypes: true })) {
        if (entry.isDirectory()) out.binaries.push(entry.name);
      }
    } catch {}
  }
  return out;
}

function extractPythonContracts(projAbs) {
  const out = {};
  const pyproject = path.join(projAbs, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const text = fs.readFileSync(pyproject, 'utf8');
      const name = text.match(/^\s*name\s*=\s*['"]([^'"]+)['"]/m);
      const desc = text.match(/^\s*description\s*=\s*['"]([^'"]+)['"]/m);
      if (name) out.name = name[1];
      if (desc) out.description = desc[1];
    } catch {}
  }
  return out;
}

function extractK8sContracts(projAbs) {
  const out = { services: [], images: [] };
  // Chart.yaml metadata
  try {
    const chart = fs.readFileSync(path.join(projAbs, 'Chart.yaml'), 'utf8');
    const name = chart.match(/^\s*name:\s*([^\n#]+)/m);
    const desc = chart.match(/^\s*description:\s*([^\n#]+)/m);
    if (name) out.name = name[1].trim();
    if (desc) out.description = desc[1].trim();
  } catch {}
  // Walk YAML files for kind: Service / Deployment + image: refs.
  walkShallow(projAbs, projAbs, 4, (rel) => {
    if (!/\.(ya?ml)$/.test(rel)) return;
    try {
      const text = fs.readFileSync(path.join(projAbs, rel), 'utf8');
      // Service names from `kind: Service` blocks
      const blocks = text.split(/^---\s*$/m);
      for (const block of blocks) {
        if (/^\s*kind:\s*Service\b/m.test(block)) {
          const name = block.match(/^\s*name:\s*([^\n#]+)/m);
          if (name) out.services.push(name[1].trim());
        }
      }
      // Image refs
      for (const m of text.matchAll(/^\s*image:\s*['"]?([^\s'"]+)['"]?/gm)) {
        const img = m[1].replace(/^\{\{.*?\}\}$/, '').trim();
        if (img && !img.startsWith('{{')) out.images.push(img);
      }
    } catch {}
  });
  out.services = uniqueStrings(out.services).slice(0, 12);
  out.images = uniqueStrings(out.images).slice(0, 12);
  return out;
}

function extractDockerContracts(projAbs, project) {
  const out = { images: [] };
  try {
    fs.readFileSync(path.join(projAbs, 'Dockerfile'), 'utf8');
    // Derive image name: sibling package.json#name or project.dir basename.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projAbs, 'package.json'), 'utf8'));
      if (pkg.name) out.images.push(pkg.name);
    } catch {}
    if (!out.images.length) out.images.push(project.name);
  } catch {}
  return out;
}

function extractProtoContracts(projAbs) {
  const out = { services: [] };
  walkShallow(projAbs, projAbs, 3, (rel) => {
    if (!rel.endsWith('.proto')) return;
    try {
      const text = fs.readFileSync(path.join(projAbs, rel), 'utf8');
      for (const m of text.matchAll(/^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        out.services.push(m[1]);
      }
    } catch {}
  });
  out.services = uniqueStrings(out.services).slice(0, 12);
  return out;
}

function walkShallow(dir, root, depth, onFile) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkShallow(full, root, depth - 1, onFile);
    else if (entry.isFile()) onFile(path.relative(root, full));
  }
}

function uniqueStrings(list) {
  return [...new Set(list.map(String).filter(Boolean))];
}

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
