/**
 * serve/docs.mjs — the Doc-Navigator endpoints: /api/map, /api/doc, /api/why.
 *
 * Intent-first, NOT an auto-generated wiki: every word served here was written
 * by a human or an agent into .project-brain. What the code adds is navigation
 * (record → files, file → record) and one measured honesty signal — where the
 * docs have fallen behind the commits. The matching vocabulary itself lives in
 * serve/records.mjs, which brain-answer.mjs imports so the ambient answer and
 * the Why drawer can never disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from './security.mjs';
import {
  CODE_EXT_RE, MAX_DOC_BYTES, MAX_ORPHAN_DIRS, MAX_WHY_HISTORY, ORPHAN_SCAN_DEPTH, SKIP_TOP_DIRS,
  decisionExcerpt, extractPaths, freshness, frontmatterTitle, globMatchesFile, inferModuleFromPath,
  liveMeta, moduleAliases, moduleGlobs, normPath, parseFrontmatter, resolveBrainDoc, staleDocDays,
  summarize, wikiLinks
} from './records.mjs';
import { commitsSafe } from './git.mjs';

// --- Doc-Navigator (/api/map, /api/doc, /api/why) ---
// Intent-first, NOT an auto-generated wiki: every word served here was
// written by a human or an agent into .project-brain. What the code adds is
// navigation (record → files, file → record) and one measured honesty
// signal — where the docs have fallen behind the commits.

/** Read one record folder (flat, .md only) into a working shape. Soft → []. */
export function docRecordsOf(api, kind) {
  const { root, brainDir } = api;
  const dir = path.join(brainDir, kind);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const abs = path.join(dir, e.name);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8').slice(0, MAX_DOC_BYTES); } catch { continue; }
    const { data, body } = parseFrontmatter(text);
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* soft */ }
    const name = e.name.replace(/\.md$/i, '');
    out.push({
      file: normPath(path.relative(root, abs)),
      name,
      title: frontmatterTitle(text) || name,
      module: String(data.module || '').trim(),
      data,
      body,
      mtimeMs,
      globs: kind === 'modules' ? moduleGlobs(data, body) : [],
      sources: kind === 'findings' ? findingSources(text) : []
    });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

/** Findings carry a nested `sources:` list the flat FM parser skips. */
function findingSources(text) {
  const out = [];
  const re = /^\s*-\s*path:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const p = normPath(m[1].trim().replace(/^["']|["']$/g, ''));
    if (p) out.push(p);
  }
  return out;
}

/**
 * Newest AUTHOR date among commits touching a matching file → epoch ms.
 * Scans the whole window and keeps the max rather than trusting log order:
 * git orders by committer date while `%aI` is the author date, and the two
 * disagree after any rebase/cherry-pick.
 */
function newestCommitMs(commits, matches) {
  let newest = null;
  for (const c of commits) {
    const t = Date.parse(c.dateIso);
    if (!Number.isFinite(t) || (newest !== null && t <= newest)) continue;
    if (!(c.files || []).some(matches)) continue;
    newest = t;
  }
  return newest;
}

/** Does a top-level dir hold source files at all? Bounded, never throws. */
function containsCode(dir, depth = 0) {
  if (depth > ORPHAN_SCAN_DEPTH) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_TOP_DIRS.has(e.name)) continue;
    if (e.isFile() && CODE_EXT_RE.test(e.name)) return true;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_TOP_DIRS.has(e.name)) continue;
    if (e.isDirectory() && containsCode(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

function topLevelCodeDirs(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_TOP_DIRS.has(e.name)) continue;
    if (containsCode(path.join(root, e.name))) dirs.push(e.name);
    if (dirs.length >= MAX_ORPHAN_DIRS) break;
  }
  return dirs.sort();
}

/**
 * One module row: the record's own facts plus the MEASURED staleness verdict.
 * `linked` counts the records pointing at this module (decisions/features/
 * findings), `commits` is the shared window both staleness signals read.
 */
function moduleRow(rec, { commits, linked, now, staleDays }) {
  const aliases = moduleAliases(rec.module || rec.name, rec.file);
  aliases.add(rec.name);
  if (rec.data.feature) aliases.add(String(rec.data.feature).trim());
  // The record's own last change: measured from git when the record is in
  // the commit window, else its mtime (a fresh clone has no history for it).
  const docMs = newestCommitMs(commits, (f) => normPath(f) === rec.file) ?? rec.mtimeMs;
  // The newest commit touching the code the record claims to describe.
  // Brain records are excluded so a doc edit can never mark itself stale.
  const codeMs = rec.globs.length
    ? newestCommitMs(commits, (f) => {
      const n = normPath(f);
      return !n.startsWith('.project-brain/') && rec.globs.some((g) => globMatchesFile(g, n));
    })
    : null;
  const ageDays = docMs == null ? null : Math.round(((now - docMs) / 86_400_000) * 10) / 10;
  const staleByAge = ageDays !== null && ageDays > staleDays;
  const staleByCode = docMs != null && codeMs != null && codeMs > docMs;
  return {
    name: rec.name,
    module: rec.module || rec.name,
    file: rec.file,
    title: rec.title,
    summary: summarize(rec.body),
    fileGlobs: rec.globs,
    decisionCount: linked(rec, aliases, 'decisions'),
    featureCount: linked(rec, aliases, 'features'),
    findingCount: linked(rec, aliases, 'findings'),
    stale: Boolean(staleByAge || staleByCode),
    // Honest about WHICH signal fired — "drifting from code" and "nobody
    // has touched this in months" are different problems for the reader.
    staleReason: staleByCode ? 'code-newer-than-doc' : staleByAge ? `older-than-${staleDays}d` : null,
    ageDays,
    lastDocChange: docMs != null ? new Date(docMs).toISOString() : null,
    lastCodeChange: codeMs != null ? new Date(codeMs).toISOString() : null
  };
}

/**
 * PURE. Top-level code areas no module record claims — the gap a generated
 * wiki hides by inventing a page for everything.
 */
function orphanCodeDirs(moduleRecs, dirs) {
  const claimedTops = new Set();
  for (const rec of moduleRecs) {
    for (const g of rec.globs) {
      const top = normPath(g).split('/')[0];
      if (top && !top.includes('*')) claimedTops.add(top);
    }
  }
  return dirs.filter((d) => !claimedTops.has(d));
}

export function apiMap(api, res) {
  const { root, brainDir } = api;
  const now = Date.now();
  const staleDays = staleDocDays();
  const moduleRecs = docRecordsOf(api, 'modules');
  const decisions = docRecordsOf(api, 'decisions');
  const features = docRecordsOf(api, 'features');
  const findings = docRecordsOf(api, 'findings');
  const insights = docRecordsOf(api, 'insights');
  const { commits, warning } = commitsSafe(root);

  const byKind = { decisions, features, findings };
  const linked = (rec, aliases, kind) => byKind[kind].filter((r) => r.module && aliases.has(r.module)).length;
  const modules = moduleRecs.map((rec) => moduleRow(rec, { commits, linked, now, staleDays }));
  const codeDirs = orphanCodeDirs(moduleRecs, topLevelCodeDirs(root));

  sendJson(res, 200, {
    modules,
    orphans: {
      codeDirs,
      reason: codeDirs.length
        ? 'top-level code directories no .project-brain/modules/*.md record names — the brain has no authored intent for them'
        : 'every top-level code directory is named by at least one module record',
      // No gap without a next command: brain-draft turns the structure into
      // a status:draft record whose "why" section is deliberately unwritten.
      action: codeDirs.length ? `project-brain x draft module ${codeDirs[0]}` : null
    },
    counts: {
      decisions: decisions.length,
      modules: moduleRecs.length,
      features: features.length,
      findings: findings.length,
      insights: insights.length
    },
    provenance: {
      basis: commits.length ? 'measured' : 'declared',
      source: '.project-brain records + git log',
      window: { commits: commits.length },
      staleDocDays: staleDays,
      note: 'records are authored, not generated; staleness is measured against commit history'
    },
    ...(warning ? { warning } : {}),
    ...freshness(path.join(brainDir, 'modules'))
  });
}

/** Outgoing links of one record: `[[wiki-links]]` + the paths it names. */
function docLinks(api, body, data) {
  const decisions = docRecordsOf(api, 'decisions');
  const modules = docRecordsOf(api, 'modules');
  const dById = new Map(decisions.map((r) => [r.name, r]));
  const mById = new Map(modules.map((r) => [r.name, r]));
  const outD = [];
  const outM = [];
  const seen = new Set();
  for (const id of wikiLinks(body)) {
    const d = dById.get(id);
    if (d && !seen.has(d.file)) { seen.add(d.file); outD.push({ file: d.file, id: d.name, title: d.title }); continue; }
    const m = mById.get(id);
    if (m && !seen.has(m.file)) { seen.add(m.file); outM.push({ file: m.file, name: m.name, title: m.title }); }
  }
  const fmModule = String(data.module || '').trim();
  if (fmModule) {
    const m = modules.find((r) => r.module === fmModule || r.name === fmModule);
    if (m && !seen.has(m.file)) { seen.add(m.file); outM.push({ file: m.file, name: m.name, title: m.title }); }
  }
  return { decisions: outD, modules: outM, files: extractPaths(body, { limit: 60 }) };
}

export function apiDoc(api, res, url) {
  const { root } = api;
  const rel = url.searchParams.get('file');
  const resolved = resolveBrainDoc(root, rel === null ? '' : rel);
  if (!resolved) {
    // Rejected BEFORE any filesystem read — traversal never touches disk.
    return sendJson(res, 400, {
      error: 'bad-request',
      hint: '?file= must be a repo-relative .md path inside .project-brain/'
    });
  }
  let raw;
  try { raw = fs.readFileSync(resolved, 'utf8'); }
  catch { return sendJson(res, 404, { error: 'not-found', file: normPath(rel || '') }); }
  const truncated = raw.length > MAX_DOC_BYTES;
  const text = truncated ? raw.slice(0, MAX_DOC_BYTES) : raw;
  const { data, body } = parseFrontmatter(text);
  const file = normPath(path.relative(root, resolved));
  sendJson(res, 200, {
    file,
    title: frontmatterTitle(text) || path.basename(file, '.md'),
    frontmatter: data,
    body,
    truncated,
    links: docLinks(api, body, data),
    ...freshness(resolved)
  });
}

export function apiWhy(api, res, url) {
  const { root } = api;
  const file = normPath(url.searchParams.get('file') || '');
  if (!file || file.length > 512 || file.includes('\0')) {
    return sendJson(res, 400, { error: 'bad-request', hint: '?file=<repo-relative code file> is required' });
  }
  const moduleRecs = docRecordsOf(api, 'modules');
  const owner = moduleRecs.find((r) => (r.globs || []).some((g) => globMatchesFile(g, file))) || null;
  const module = owner ? (owner.module || owner.name) : inferModuleFromPath(file);
  // Same alias widening brain:radar uses so a curated ADR module (`retrieval`)
  // still matches a path-inferred one (`scripts/retrieval`).
  const aliases = moduleAliases(module, file);
  if (owner) {
    aliases.add(owner.name);
    if (owner.module) aliases.add(owner.module);
    if (owner.data.feature) aliases.add(String(owner.data.feature).trim());
  }
  const decisions = docRecordsOf(api, 'decisions')
    .filter((d) => d.module && aliases.has(d.module))
    .map((d) => ({
      file: d.file,
      id: d.name,
      title: d.title,
      module: d.module,
      excerpt: decisionExcerpt(d.body)
    }));
  const findings = docRecordsOf(api, 'findings')
    .filter((f) => (f.module && aliases.has(f.module)) || f.sources.includes(file))
    .map((f) => ({
      file: f.file,
      slug: f.name,
      title: f.title,
      status: String(f.data.status || 'open').trim(),
      category: String(f.data.category || '').trim(),
      impact: Number(f.data.impact) || 0
    }));
  const { commits, warning } = commitsSafe(root);
  const history = [];
  for (const c of commits) {
    if (!(c.files || []).some((f) => normPath(f) === file)) continue;
    history.push({ hash: c.hash, subject: c.subject, dateIso: c.dateIso, author: c.author });
    if (history.length >= MAX_WHY_HISTORY) break;
  }
  const reason = decisions.length || findings.length
    ? null
    : owner
      ? `module ${module} owns this file, but no ADR or finding references it`
      : 'no module record or governing ADR covers this file — the brain has no authored intent for it yet';
  sendJson(res, 200, {
    file,
    module,
    moduleRecord: owner ? owner.file : null,
    decisions,
    findings,
    history,
    ...(reason ? { reason } : {}),
    ...(warning ? { warning } : {}),
    provenance: {
      basis: 'measured',
      source: '.project-brain records + git log',
      window: { commits: commits.length },
      matchedBy: owner ? 'module-record-glob' : 'path-heuristic'
    },
    ...liveMeta()
  });
}
