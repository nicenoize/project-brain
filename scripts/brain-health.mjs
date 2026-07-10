/**
 * Read-only health report for the local brain index.
 *
 * Checks the index for ghost paths (files missing on disk), drift
 * between the JSON mirror and the live store, stale root brain docs
 * (BRAIN_STALE_DOC_DAYS), and broken `lib/foo.ts`-style code refs
 * inside brain markdown (--check-brain-refs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, BRAIN_DIR, exists, read, JSON_INDEX, staleIndexFromRecords } from './common.mjs';

const KEY_BRAIN_FILES = ['context_index.md', 'repo_context.md', 'master_plan.md', 'active_state.md'];

function gitLastCommitMs(relFromRoot) {
  const r = spawnSync('git', ['log', '-1', '--format=%ct', '--', relFromRoot], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0 || !String(r.stdout || '').trim()) return null;
  const sec = Number(String(r.stdout).trim());
  return Number.isFinite(sec) ? sec * 1000 : null;
}

function formatAgeDays(ageDays) {
  if (!Number.isFinite(ageDays)) return '?';
  if (ageDays < 1) return `${Math.round(ageDays * 24)}h`;
  return `${Math.round(ageDays * 10) / 10}d`;
}

function brainDocFreshnessReport() {
  const staleDays = Number(process.env.BRAIN_STALE_DOC_DAYS || 0);
  const useStaleHeuristic = Number.isFinite(staleDays) && staleDays > 0;
  const entries = [];
  const warnings = [];

  for (const name of KEY_BRAIN_FILES) {
    const rel = `.project-brain/${name}`;
    const abs = path.join(BRAIN_DIR, name);
    if (!fs.existsSync(abs)) {
      entries.push({ file: rel, exists: false });
      continue;
    }
    const gitMs = gitLastCommitMs(rel);
    const mtimeMs = fs.statSync(abs).mtimeMs;
    const refMs = gitMs ?? mtimeMs;
    const source = gitMs ? 'git' : 'mtime';
    const ageDays = (Date.now() - refMs) / 86400000;
    entries.push({
      file: rel,
      exists: true,
      refIso: new Date(refMs).toISOString(),
      source,
      ageDays: Math.round(ageDays * 100) / 100
    });
    if (useStaleHeuristic && ageDays > staleDays) {
      warnings.push(`${rel} last touched ~${formatAgeDays(ageDays)} ago (>${staleDays}d, ${source})`);
    }
  }

  const pkgPath = path.join(ROOT, 'package.json');
  const rcPath = path.join(BRAIN_DIR, 'repo_context.md');
  let repoContextOlderThanPackage = false;
  if (fs.existsSync(pkgPath) && fs.existsSync(rcPath)) {
    const pkgM = fs.statSync(pkgPath).mtimeMs;
    const rcM = fs.statSync(rcPath).mtimeMs;
    if (rcM < pkgM) {
      repoContextOlderThanPackage = true;
      warnings.push(
        'repo_context.md is older than package.json (mtime). Refresh stack, scripts, and commands in repo_context when dependencies or scripts change.'
      );
    }
  }

  return { entries, warnings, staleDaysConfigured: useStaleHeuristic ? staleDays : 0, repoContextOlderThanPackage };
}

function scanProjectBrainMarkdownRefs() {
  const missing = [];
  const seen = new Set();
  const mdFiles = walkMarkdown(BRAIN_DIR);
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const abs of mdFiles) {
    const text = read(abs);
    let m;
    while ((m = linkRe.exec(text)) !== null) {
      const raw = m[1].trim().split(/\s+/)[0];
      if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
      const noAnchor = raw.replace(/#.*$/, '');
      if (!noAnchor || noAnchor.startsWith('//')) continue;
      const resolved = path.resolve(path.dirname(abs), decodeUriPath(noAnchor));
      if (!resolved.startsWith(path.resolve(ROOT))) continue;
      const rel = path.relative(ROOT, resolved);
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!fs.existsSync(resolved)) missing.push(rel);
    }
  }
  return { missing: missing.sort() };
}

function decodeUriPath(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function walkMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'vector-db') continue;
      out.push(...walkMarkdown(p));
    } else if (name.isFile() && name.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const strictStale = argv.includes('--strict-stale') || process.env.BRAIN_HEALTH_STRICT_STALE === '1';
const checkBrainRefs =
  argv.includes('--check-brain-refs') || process.env.BRAIN_HEALTH_CHECK_BRAIN_REFS === '1' || process.env.BRAIN_CHECK_BRAIN_REFS === '1';
const jsonOut = argv.includes('--json');

const isCanonicalPackage =
  fs.existsSync('SKILL.md') && fs.existsSync('scripts/brain-index.mjs') && fs.existsSync('templates/PULL_REQUEST_TEMPLATE.md');
const required = isCanonicalPackage
  ? ['SKILL.md', 'scripts/brain-index.mjs', 'scripts/brain-search.mjs', 'package.json']
  : [
      'skills/project-brain/SKILL.md',
      '.project-brain/context_index.md',
      '.project-brain/product_plan.md',
      '.project-brain/repo_context.md',
      '.project-brain/active_state.md',
      'package.json'
    ];

const missing = required.filter((p) => !fs.existsSync(p));
let layoutOk = missing.length === 0;

// SKILL.md ships lean; its detail lives in a bundled references/*.md set (#26).
// setup.sh (in-place checkout) and brain:update-skill (git ff-merge) carry these
// alongside SKILL.md — verify they actually landed. NON-FATAL on purpose: a
// consumer on an old checkout has SKILL.md but not yet the references, and should
// be nudged to update rather than have health fail (which would abort setup.sh).
const skillRoot = isCanonicalPackage ? '.' : 'skills/project-brain';
const REFERENCE_FILES = ['commands.md', 'workflows.md', 'retrieval-internals.md', 'tuning.md', 'fleet.md'];
const missingReferences = fs.existsSync(path.join(skillRoot, 'SKILL.md'))
  ? REFERENCE_FILES.map((f) => path.join(skillRoot, 'references', f)).filter((p) => !fs.existsSync(p))
  : [];
if (missingReferences.length && !jsonOut) {
  console.warn(
    `Project Brain: SKILL.md present but ${missingReferences.length} reference file(s) missing (` +
      missingReferences.map((p) => path.basename(p)).join(', ') +
      '). Run: npm run brain:update-skill'
  );
}

if (!fs.existsSync('.gitignore') || !fs.readFileSync('.gitignore', 'utf8').includes('.project-brain/vector-db/')) {
  if (!jsonOut) console.error('Missing .project-brain/vector-db/ in .gitignore');
  layoutOk = false;
}

let expiredSessionCount = 0;
let stale = { deleted: [], changed: [] };
let indexParseError = false;
let brainRefIssues = { missing: [] };
let activeStateMergeMarkers = false;
const docFresh = fs.existsSync(BRAIN_DIR) ? brainDocFreshnessReport() : { entries: [], warnings: [], staleDaysConfigured: 0, repoContextOlderThanPackage: false };

if (docFresh.warnings.length && !jsonOut) {
  for (const w of docFresh.warnings) console.warn(`Project Brain doc freshness: ${w}`);
}
if (docFresh.entries.some((e) => e.exists) && !jsonOut) {
  const parts = docFresh.entries
    .filter((e) => e.exists)
    .map((e) => `${path.basename(e.file)} ~${formatAgeDays(e.ageDays)} (${e.source})`);
  if (parts.length) console.log(`Brain root doc ages (git last commit, else mtime): ${parts.join('; ')}`);
}

if (fs.existsSync(path.join(BRAIN_DIR, 'active_state.md'))) {
  const active = read(path.join(BRAIN_DIR, 'active_state.md'));
  activeStateMergeMarkers = /^(<<<<<<<|=======|>>>>>>>)/m.test(active);
  if (activeStateMergeMarkers && !jsonOut) {
    const msg =
      'active_state.md contains unresolved merge conflict markers. Resolve conflicts (keep one coherent table), then run: npm run brain:sync';
    if (strictStale) console.error(msg);
    else console.warn(msg);
  }
}

if (exists(JSON_INDEX)) {
  try {
    const index = JSON.parse(read(JSON_INDEX));
    const expired = (index.records || []).filter(
      (r) => String(r.id || '').startsWith('session:') && r.expiresAt && Date.parse(r.expiresAt) < Date.now()
    );
    expiredSessionCount = expired.length;
    if (expiredSessionCount && !jsonOut) {
      console.warn(`Expired Project Brain session records found (${expiredSessionCount}). Run: npm run brain:session -- clean`);
    }
    stale = staleIndexFromRecords(index.records || []);
    if (stale.deleted.length && !jsonOut) {
      const sample = stale.deleted.slice(0, 5).join(', ');
      const more = stale.deleted.length > 5 ? ` (+${stale.deleted.length - 5} more)` : '';
      console.warn(`Project Brain index references deleted/missing files (${stale.deleted.length}). Run: npm run brain:sync`);
      console.warn(`  ghost paths sample: ${sample}${more}`);
    }
    if (stale.changed.length && !jsonOut) {
      const sample = stale.changed.slice(0, 5).join(', ');
      const more = stale.changed.length > 5 ? ` (+${stale.changed.length - 5} more)` : '';
      console.warn(`Project Brain index has stale content hashes (${stale.changed.length}). Run: npm run brain:sync`);
      console.warn(`  stale hash sample: ${sample}${more}`);
    }
  } catch {
    indexParseError = true;
    if (!jsonOut) console.warn('Project Brain: could not parse search_index.json for stale checks.');
  }
}

if (checkBrainRefs && fs.existsSync(BRAIN_DIR)) {
  brainRefIssues = scanProjectBrainMarkdownRefs();
  if (brainRefIssues.missing.length && !jsonOut) {
    const sample = brainRefIssues.missing.slice(0, 8).join('\n  - ');
    const more = brainRefIssues.missing.length > 8 ? `\n  (+${brainRefIssues.missing.length - 8} more)` : '';
    console.warn(
      `Project Brain: ${brainRefIssues.missing.length} markdown reference(s) point to missing paths under .project-brain/. Fix links or files, then re-index.\n  - ${sample}${more}`
    );
  }
}

const staleFail = Boolean(strictStale && (stale.deleted.length || stale.changed.length));
const refsFail = Boolean(strictStale && checkBrainRefs && brainRefIssues.missing.length);
const mergeFail = Boolean(strictStale && activeStateMergeMarkers);
const finalOk = layoutOk && !indexParseError && !staleFail && !refsFail && !mergeFail;

if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        ok: finalOk,
        missing,
        missingReferences,
        stale,
        strictStale,
        expiredSessionCount,
        indexParseError,
        activeStateMergeMarkers,
        brainRefs: { checked: checkBrainRefs, missing: brainRefIssues.missing },
        brainDocFreshness: docFresh.entries,
        docFreshnessWarnings: docFresh.warnings,
        repoContextOlderThanPackageJson: docFresh.repoContextOlderThanPackage
      },
      null,
      2
    )
  );
} else {
  if (staleFail) {
    console.error('Strict stale check failed: run npm run brain:sync (or npm run brain:maintain).');
  } else if (refsFail) {
    console.error('Strict check failed: broken .project-brain markdown references (see warnings above).');
  } else if (mergeFail) {
    console.error('Strict check failed: resolve active_state.md merge markers before continuing.');
  } else if (finalOk) {
    console.log('Project Brain health check passed.');
  }
}

process.exit(finalOk ? 0 : 1);
