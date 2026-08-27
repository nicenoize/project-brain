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
import { fileURLToPath } from 'node:url';
import { ROOT, BRAIN_DIR, exists, read, JSON_INDEX, USAGE_LOG, staleIndexFromRecords } from './common.mjs';
import { parseUsageLog, summarizeUsage, commandUniverseFromPackageScripts } from './usage.mjs';
import {
  measureFile,
  measureHook,
  measureAnswerHook,
  footprintWarnings,
  FOOTPRINT_THRESHOLDS,
  PACK_MAX_TOKENS_DEFAULT,
  BUDGETS
} from './footprint.mjs';
import { computeSettingsDrift } from './setup-claude-settings.mjs';

const HEALTH_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Context-footprint audit (decisions/0024): how many tokens the brain injects
 * into every session. Measures the SKILL.md variant(s), active_state.md (cat'd
 * raw on SessionStart), and the actual stdout of the route hooks (spawned).
 */
function contextFootprintReport() {
  const skills = [
    measureFile(path.join(ROOT, 'SKILL.md'), 'SKILL.md'),
    measureFile(path.join(ROOT, 'skills/project-brain/SKILL.md'), 'skills/project-brain/SKILL.md')
  ].filter((s) => s.exists);

  const activeState = measureFile(path.join(BRAIN_DIR, 'active_state.md'), '.project-brain/active_state.md');

  const routeScript = path.join(HEALTH_DIR, 'brain-route.mjs');
  const hooks = fs.existsSync(routeScript)
    ? ['sessionstart', 'userpromptsubmit'].map((ev) => measureHook(routeScript, ev, ROOT))
    : [];

  // The edit-time answer hook fires far more often than the session hooks, so
  // its per-injection cost belongs in the same audit (decisions/0024).
  const answerScript = path.join(HEALTH_DIR, 'brain-answer-hook.mjs');
  if (fs.existsSync(answerScript)) {
    const probe = ['SKILL.md', 'README.md', 'package.json']
      .map((f) => path.join(ROOT, f))
      .find((abs) => fs.existsSync(abs));
    if (probe) hooks.push(measureAnswerHook(answerScript, probe, ROOT));
  }

  const packDefaults = {
    BRAIN_PACK_MAX_TOKENS: Number(process.env.BRAIN_PACK_MAX_TOKENS) || PACK_MAX_TOKENS_DEFAULT
  };

  // budgets: the HARD CI numbers (tests/footprint-budget.test.mjs) — passing
  // them makes footprintWarnings also flag hard-budget breaches here.
  const fp = { skills, activeState, hooks, packDefaults, thresholds: FOOTPRINT_THRESHOLDS, budgets: BUDGETS };
  fp.warnings = footprintWarnings(fp, FOOTPRINT_THRESHOLDS);
  return fp;
}

function readJsonSafe(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Settings-drift audit (issue #34): `bin/update.sh` refreshes the skill scripts
 * but a consumer whose setup predates the ambient-routing wiring can end up with
 * current scripts and a stale `.claude/settings.json` — ADR 0023's routing hooks
 * installed as code but inert. Compare the host settings against the recommended
 * template and report which recommended hooks / allow-list entries are missing.
 * Non-fatal: a warning that nudges `npm run brain:update-skill` (additive merge,
 * user hooks preserved), consistent with the context-footprint discipline
 * (decisions/0024) this extends.
 */
function settingsDriftReport(root) {
  const templateAbs = path.join(ROOT, root, 'templates', 'claude-code', 'settings.recommended.json');
  const hostAbs = path.join(ROOT, '.claude', 'settings.json');
  if (!fs.existsSync(templateAbs)) {
    return { checked: false, hostExists: fs.existsSync(hostAbs), missingHooks: [], missingAllow: [], hookDrift: 0, allowDrift: 0, drift: false };
  }
  const recommended = readJsonSafe(templateAbs) ?? {};
  const hostExists = fs.existsSync(hostAbs);
  const installed = hostExists ? readJsonSafe(hostAbs) ?? {} : {};
  const d = computeSettingsDrift(installed, recommended);
  return { checked: true, hostExists, ...d };
}

/**
 * Usage-ledger audit (issue #32): the QUANTITY/footprint instrument that sits
 * next to the context-footprint (#21) and settings-drift (#34) sections above.
 * When BRAIN_USAGE_LOG=1, every brain:* invocation appends one JSONL line to
 * `.project-brain/.usage.jsonl` (the choke point in common.mjs). Here we read
 * it back read-only — per-command counts over a trailing 30d window and the
 * never-used list (commands in package.json that the ledger has never seen).
 *
 * Always safe to call: an absent/unreadable log yields zero counts with the
 * full command set as "never used". Reporting is independent of the write flag
 * so a ledger captured earlier still surfaces even if the flag is now off.
 */
function usageReport(windowDays = 30) {
  const pkg = readJsonSafe(path.join(ROOT, 'package.json')) ?? {};
  const universe = commandUniverseFromPackageScripts(pkg.scripts || {});
  const logExists = fs.existsSync(USAGE_LOG);
  const records = logExists ? parseUsageLog(read(USAGE_LOG)) : [];
  const summary = summarizeUsage(records, { windowDays, commands: universe });
  return {
    enabledNow: process.env.BRAIN_USAGE_LOG === '1',
    logExists,
    ...summary
  };
}

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
const footprint = contextFootprintReport();
const settingsDrift = settingsDriftReport(skillRoot);
const usage = usageReport();

if (docFresh.warnings.length && !jsonOut) {
  for (const w of docFresh.warnings) console.warn(`Project Brain doc freshness: ${w}`);
}
if (docFresh.entries.some((e) => e.exists) && !jsonOut) {
  const parts = docFresh.entries
    .filter((e) => e.exists)
    .map((e) => `${path.basename(e.file)} ~${formatAgeDays(e.ageDays)} (${e.source})`);
  if (parts.length) console.log(`Brain root doc ages (git last commit, else mtime): ${parts.join('; ')}`);
}

if (!jsonOut) {
  const fpParts = [];
  for (const s of footprint.skills) fpParts.push(`${path.basename(s.file)} ${s.bytes}B≈${s.tokens}tok`);
  if (footprint.activeState.exists) fpParts.push(`active_state.md ${footprint.activeState.bytes}B≈${footprint.activeState.tokens}tok`);
  for (const h of footprint.hooks) fpParts.push(`hook:${h.event} ${h.bytes}B≈${h.tokens}tok`);
  fpParts.push(`pack≤${footprint.packDefaults.BRAIN_PACK_MAX_TOKENS}tok`);
  console.log(`Context footprint (per-session injection, ~len/4 tokens): ${fpParts.join('; ')}`);
  for (const w of footprint.warnings) console.warn(`Project Brain context footprint: ${w}`);
}

if (!jsonOut) {
  if (usage.logExists) {
    const top = usage.perCommand
      .slice(0, 5)
      .map((c) => `${c.cmd}×${c.count}`)
      .join(', ');
    console.log(
      `Usage ledger (#32, last ${usage.windowDays}d): ${usage.totalInWindow} invocation(s) across ${usage.perCommand.length}/${usage.universeSize} command(s)` +
        (top ? `; top: ${top}` : '') +
        (usage.neverUsed.length ? `; never used (${usage.neverUsed.length}): ${usage.neverUsed.slice(0, 8).join(', ')}${usage.neverUsed.length > 8 ? ', …' : ''}` : '')
    );
  } else if (usage.enabledNow) {
    console.log('Usage ledger (#32): BRAIN_USAGE_LOG=1 but no invocations recorded yet.');
  }
}

// Only warn about drift when a host .claude/settings.json actually exists: an
// absent file is "not wired yet" (e.g. the canonical dev repo, or a fresh
// consumer before setup.sh), not silent drift of an installed-but-stale config
// — the club-ops case #34 targets. The JSON payload still reports the full diff.
if (settingsDrift.checked && settingsDrift.hostExists && settingsDrift.drift && !jsonOut) {
  if (settingsDrift.missingHooks.length) {
    const events = [...new Set(settingsDrift.missingHooks.map((h) => h.event))].join(', ');
    console.warn(
      `Project Brain settings drift: ${settingsDrift.missingHooks.length} recommended hook(s) not in .claude/settings.json (${events}) — ambient routing / session hooks are installed as code but INERT (issue #34). Run: npm run brain:update-skill (additive merge; your own hooks are preserved).`
    );
  }
  if (settingsDrift.missingAllow.length) {
    console.warn(
      `Project Brain settings drift: ${settingsDrift.missingAllow.length} recommended permission(s) missing from .claude/settings.json (${settingsDrift.missingAllow.join(', ')}). Run: npm run brain:update-skill.`
    );
  }
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
        repoContextOlderThanPackageJson: docFresh.repoContextOlderThanPackage,
        contextFootprint: footprint,
        settingsDrift,
        usage
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
