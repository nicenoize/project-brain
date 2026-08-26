/**
 * brain:brief — proactive pre-touch advisories (read-only).
 *
 * Everything else in the brain is pull (you ask). This is a *push*: before
 * you touch a set of files, surface what you should already know so the brain
 * taps you on the shoulder instead of waiting to be asked.
 *
 * For a target set of files (explicit --files, else the working tree's
 * changed files) it gathers advisories from EXISTING brain state:
 *   1. Active file leases / workstreams touching those files or their module.
 *   2. Governing ADRs (decisions) that reference those files or module.
 *   3. Cross-project edges where the touched project is the upstream owner
 *      (downstream consumers that may break).
 *   4. Recent sessions mentioning those files/modules (best-effort).
 *
 * Read-only: never mutates state. Exit 0 always for the plain run (advisory).
 * Reserve non-zero for --strict when a hard lease conflict exists (someone
 * else holds a lease on a file you're about to touch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT, BRAIN_DIR, read, exists, takeFlag, takeOption } from './common.mjs';
import { activeStateJson } from './active-state.mjs';
import { inferModule } from './infer.mjs';
import { targetMatchesFile, UnsupportedPatternError } from './lease-overlap.mjs';
import { fileURLToPath } from 'node:url';

const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');
const SESSIONS_DIR = path.join(BRAIN_DIR, 'sessions');

const SEV = { conflict: '🚨', warn: '⚠', adr: '📐', edge: '↯', session: '🕑' };

// ---------------------------------------------------------------------------
// Pure core (unit-testable without git / store / disk).
// ---------------------------------------------------------------------------

/** Inferred module for a file, reusing the indexer's path/frontmatter logic. */
function moduleOf(file) {
  return inferModule(file, {});
}

/**
 * Build the advisory report for a set of target files from already-loaded
 * brain state. Pure: no I/O. Callers pass leases/decisions/edges/sessions.
 *
 * @param {object} input
 * @param {string[]} input.files      target files (repo-relative)
 * @param {Array<{target,lockedBy,until,notes,project}>} [input.leases]
 * @param {Array<{taskId,owner,branch,scope,status,project}>} [input.workstreams]
 * @param {Array<{id,module,title,body,file}>} [input.decisions]
 * @param {Array<{from,to,kind,confidence}>} [input.edges]   cross-project edges
 * @param {string} [input.project]    this project's name (for edge direction)
 * @param {Array<{file,module,mentions}>} [input.sessions]
 * @param {string} [input.actor]      current actor (to ignore self-held leases)
 * @returns {{files,advisories,conflicts,summary}}
 */
export function buildBrief(input = {}) {
  const files = unique((input.files || []).map(normFile).filter(Boolean));
  const modules = unique(files.map(moduleOf).filter(Boolean));
  const leases = input.leases || [];
  const workstreams = input.workstreams || [];
  const decisions = input.decisions || [];
  const edges = input.edges || [];
  const sessions = input.sessions || [];
  const actor = (input.actor || '').trim();

  const advisories = [];
  const conflicts = [];

  // 1. Leases touching the target files or their module.
  for (const lease of leases) {
    const hit = filesMatchingTarget(files, modules, lease.target);
    if (!hit.length) continue;
    const owner = lease.lockedBy || 'unowned';
    const selfHeld = actor && owner === actor;
    const wsId = workstreamForLease(workstreams, lease);
    const wsNote = wsId ? ` (workstream ${wsId})` : '';
    const msg = `file ${hit.join(', ')} is leased by ${owner}${wsNote}` +
      (lease.until ? ` until ${lease.until}` : '');
    if (selfHeld) {
      advisories.push({ kind: 'lease', severity: 'warn', message: `${msg} — that's you`, files: hit });
    } else {
      // Hard conflict: someone else holds a lease on a file you're about to touch.
      const adv = { kind: 'lease', severity: 'conflict', message: msg, files: hit, lockedBy: owner };
      advisories.push(adv);
      conflicts.push(adv);
    }
  }

  // 2. Governing ADRs referencing the files or their module.
  for (const decision of decisions) {
    const reasons = decisionMatches(decision, files, modules);
    if (!reasons.length) continue;
    advisories.push({
      kind: 'adr',
      severity: 'info',
      message: `${decision.id || decision.file}: ${decision.title || ''}`.trim() +
        ` — governs ${reasons.join(', ')}`,
      decision: decision.id || decision.file,
      files: reasons
    });
  }

  // 3. Cross-project edges where this project is the upstream owner.
  const project = (input.project || '').trim();
  if (project) {
    for (const edge of edges) {
      if (edge.from !== project) continue; // downstream consumers only
      advisories.push({
        kind: 'edge',
        severity: 'info',
        message: `changing this may affect ${edge.to} via ${edge.kind}` +
          (edge.confidence ? ` (${edge.confidence})` : ''),
        downstream: edge.to,
        edgeKind: edge.kind
      });
    }
  }

  // 4. Recent sessions mentioning the files/modules (best-effort).
  for (const session of sessions) {
    const hits = (session.mentions || []).filter(m =>
      files.includes(normFile(m)) || modules.includes(m));
    if (!hits.length) continue;
    advisories.push({
      kind: 'session',
      severity: 'info',
      message: `recent session ${session.file} touched ${unique(hits).join(', ')}`,
      session: session.file
    });
  }

  return {
    files,
    modules,
    advisories,
    conflicts,
    summary: {
      total: advisories.length,
      conflicts: conflicts.length,
      byKind: countBy(advisories, a => a.kind)
    }
  };
}

/** Does a lease target (a file/glob, comma-list tolerated) hit any target file/module? */
function filesMatchingTarget(files, modules, target) {
  if (!target) return [];
  const parts = String(target).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const hits = [];
  for (const file of files) {
    for (const part of parts) {
      if (targetMatchesPath(part, file) || modules.some(m => targetMatchesPath(part, m))) {
        hits.push(file);
        break;
      }
    }
  }
  return unique(hits);
}

/**
 * Exact / dir-prefix / glob match, delegated to the canonical
 * lease-overlap.mjs semantics (strategy M3: one implementation, one truth —
 * identical to git-intel's risk scoring and the future server-side check).
 * Kept total for the advisory path: unsupported/legacy lease targets never
 * throw here, they simply don't match.
 */
const warnedLegacyTargets = new Set();

function targetMatchesPath(target, candidate) {
  try {
    return targetMatchesFile(target, candidate);
  } catch (error) {
    if (error instanceof UnsupportedPatternError) {
      // Legacy rows written under the pre-M3 matcher (backslashes, `?`,
      // braces) are invisible to every conflict check now — surface that
      // loudly once per target instead of failing silent (review finding).
      if (!warnedLegacyTargets.has(target)) {
        warnedLegacyTargets.add(target);
        console.error(
          `[brief] WARN: lease target '${target}' uses unsupported syntax and is IGNORED by ` +
          `conflict checks — re-create it (npm run brain:lease -- release/add) with the supported grammar.`
        );
      }
      return false;
    }
    throw error;
  }
}

/** Which target files/modules does this decision reference (by body/module mention)? */
function decisionMatches(decision, files, modules) {
  const reasons = [];
  const body = String(decision.body || '');
  for (const file of files) {
    if (body.includes(file)) reasons.push(file);
  }
  for (const module of modules) {
    if (!module) continue;
    // Exact frontmatter module match is always a strong signal.
    if (decision.module === module) {
      if (!reasons.includes(module)) reasons.push(module);
      continue;
    }
    // Body substring match only for *specific* modules (path-like, e.g.
    // "scripts/edges" or "lib/db"). A bare top-level dir name like "scripts"
    // appears in almost every decision body, so matching on it is noise.
    if (isSpecificModule(module) && body.includes(module)) {
      if (!reasons.includes(module)) reasons.push(module);
    }
  }
  return unique(reasons);
}

function workstreamForLease(workstreams, lease) {
  const owner = lease.lockedBy || '';
  const taskInNotes = (lease.notes || '').match(/task=([^\s]+)/);
  const taskId = taskInNotes ? taskInNotes[1] : '';
  for (const ws of workstreams) {
    if (taskId && ws.taskId === taskId) return ws.taskId;
    if (owner && ws.owner === owner) return ws.taskId;
  }
  return taskId || '';
}

/** A module is "specific" enough to match on if it's nested (has a `/`). */
function isSpecificModule(module) { return String(module || '').includes('/'); }

function normFile(f) { return String(f || '').trim().replace(/^\.\//, '').replace(/\\/g, '/'); }
function unique(a) { return [...new Set(a)]; }
function countBy(arr, fn) {
  const out = {};
  for (const x of arr) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

// ---------------------------------------------------------------------------
// I/O loaders (fail soft → empty).
// ---------------------------------------------------------------------------

/** Working-tree changed files via `git status --porcelain`; fails soft to []. */
function gitChangedFiles(root = ROOT) {
  try {
    return execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map(line => line.slice(3).trim())
      .filter(Boolean)
      // porcelain rename lines look like "old -> new"; keep the new path.
      .map(p => (p.includes(' -> ') ? p.split(' -> ').pop() : p));
  } catch { return []; }
}

/** Read governing ADRs from .project-brain/decisions/*.md; fails soft to []. */
function loadDecisions() {
  if (!exists(DECISIONS_DIR)) return [];
  const out = [];
  let entries;
  try { entries = fs.readdirSync(DECISIONS_DIR); } catch { return []; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(DECISIONS_DIR, name);
    const text = read(full);
    if (!text) continue;
    const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let module = '';
    let title = '';
    let body = text;
    if (fm) {
      body = fm[2] || '';
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^(module|title):\s*(.*)$/);
        if (m) { if (m[1] === 'module') module = m[2].trim(); else title = m[2].trim(); }
      }
    }
    if (!title) {
      const h = body.match(/^#\s+(.+)$/m);
      if (h) title = h[1].trim();
    }
    out.push({ id: name.replace(/\.md$/, ''), module, title, body, file: `.project-brain/decisions/${name}` });
  }
  return out;
}

/** Cross-project edges from the indexed store; fails soft to [] if no index. */
async function loadEdges() {
  try {
    const { openEmbedder } = await import('./embed.mjs');
    const { openStore } = await import('./store.mjs');
    const embedder = openEmbedder();
    const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
    const records = await store.getAll();
    await store.close?.();
    return records
      .filter(r => r.type === 'cross-project-edge')
      .map(r => ({ from: r.edgeFrom, to: r.edgeTo, kind: r.edgeKind, confidence: r.edgeConfidence }));
  } catch {
    return [];
  }
}

/** Recent session docs + the file/module mentions we can cheaply extract. */
function loadSessions(limit = 8) {
  if (!exists(SESSIONS_DIR)) return [];
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR)
      .filter(n => n.endsWith('.md') && !n.includes('__auto-compact__'))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch { return []; }
  const out = [];
  for (const name of names) {
    const text = read(path.join(SESSIONS_DIR, name));
    if (!text) continue;
    // Cheap mention extraction: code-pathish tokens in the body.
    const mentions = unique((text.match(/[\w./-]+\.[a-z]{2,4}\b/g) || [])
      .map(normFile)
      .filter(p => p.includes('/') || /\.[a-z]{2,4}$/.test(p)));
    out.push({ file: `.project-brain/sessions/${name}`, module: '', mentions });
  }
  return out;
}

/** Resolve this project's name from active_state workstreams (best-effort). */
function inferProjectName(workstreams, leases) {
  for (const ws of workstreams) if (ws.project) return ws.project;
  for (const l of leases) if (l.project) return l.project;
  return '';
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function renderText(brief) {
  const lines = [];
  lines.push(`# Pre-touch brief — ${brief.files.length} file(s)`);
  if (!brief.files.length) {
    lines.push('');
    lines.push('No target files (clean working tree, no --files). Nothing to flag.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push(`Files: ${brief.files.join(', ')}`);
  if (brief.modules.length) lines.push(`Modules: ${brief.modules.join(', ')}`);
  lines.push('');

  if (!brief.advisories.length) {
    lines.push('✅ Nothing to flag — no leases, ADRs, edges, or recent sessions touch these.');
    return lines.join('\n');
  }

  const groups = [
    ['Leases & workstreams', 'lease'],
    ['Governing ADRs', 'adr'],
    ['Downstream impact (cross-project edges)', 'edge'],
    ['Recent sessions', 'session']
  ];
  for (const [heading, kind] of groups) {
    const items = brief.advisories.filter(a => a.kind === kind);
    if (!items.length) continue;
    lines.push(`## ${heading}`);
    for (const a of items) {
      const glyph = a.severity === 'conflict' ? SEV.conflict
        : kind === 'lease' ? SEV.warn
        : kind === 'adr' ? SEV.adr
        : kind === 'edge' ? SEV.edge
        : SEV.session;
      lines.push(`- ${glyph} ${a.message}`);
    }
    lines.push('');
  }

  if (brief.conflicts.length) {
    lines.push(`🚨 ${brief.conflicts.length} hard lease conflict(s). Re-run with --strict to fail on these.`);
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint (skipped when imported for unit tests).
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) {
    console.log('Usage: npm run brain:brief -- [--files a.ts,b/c.go] [--branch X] [--strict] [--json]');
    return 0;
  }
  const json = takeFlag(args, '--json');
  const strict = takeFlag(args, '--strict');
  takeOption(args, '--branch'); // accepted for symmetry; advisory is branch-agnostic
  const filesOpt = takeOption(args, '--files');
  const actor = process.env.BRAIN_ACTOR || '';

  let files = (filesOpt || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!files.length) files = gitChangedFiles();

  let leases = [];
  let workstreams = [];
  try {
    const state = activeStateJson();
    leases = state.leases || [];
    workstreams = state.workstreams || [];
  } catch { /* fail soft */ }

  const decisions = loadDecisions();
  const edges = await loadEdges();
  const sessions = loadSessions();
  const project = inferProjectName(workstreams, leases);

  const brief = buildBrief({ files, leases, workstreams, decisions, edges, sessions, project, actor });

  if (json) {
    process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(brief) + '\n');
  }

  if (strict && brief.conflicts.length) {
    process.stderr.write(`[brain:brief] ${brief.conflicts.length} hard lease conflict(s) on files you're about to touch.\n`);
    return 2;
  }
  return 0;
}

// Only run the CLI when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[brain:brief] ${err.message || err}\n`);
    process.exit(1);
  });
}
