/**
 * init-plan — PURE planning core for the Project Brain installer.
 *
 * Computes a structured plan of every change setup-package.mjs would make to
 * the HOST repo, without making any of them. The shell (setup-package.mjs)
 * prints this plan, asks for consent when a human is attached, and applies it;
 * `--dry-run` stops after printing (docs/strategy-agent-ops.md, ADR 0028).
 *
 * Plan shape — an array of change groups:
 *   { id: 'package-scripts',  group: 'package.json scripts',      changes: [{ key, from, to }] }
 *   { id: 'package-deps',     group: 'package.json dependencies', changes: [{ field, key, from, to }] }
 *   { id: 'gitignore',        group: '.gitignore',                changes: [{ entry, action }], next }
 *   { id: 'templates',        group: 'templates',                 changes: [{ file, src, action: 'copy'|'skip-exists' }] }
 *   { id: 'claude-settings',  group: 'claude-settings',           summary, skip }
 *   { id: 'cursor-hooks',     group: 'cursor-hooks',              summary, installer }
 *
 * Purity contract: the plan* functions below take plain data and return plain
 * data — no fs, no env, no prompts. computeInitPlan() is the only function
 * that touches the filesystem, and it only READS (never writes). The merge
 * helpers from common.mjs mutate their argument, so we run them on a deep
 * copy and diff against the original.
 *
 * House rules: no new npm dependencies; lib imports only (common.mjs and the
 * exported pure helpers of setup-claude-settings.mjs — its module top level
 * has no side effects).
 */
import fs from 'node:fs';
import path from 'node:path';
import { mergePackageScripts, mergePackageDeps } from './common.mjs';
import { computeSettingsDrift } from './setup-claude-settings.mjs';

/** .gitignore entries the installer appends when absent (order preserved). */
export const GITIGNORE_ENTRIES = [
  '.project-brain/vector-db/',
  '.project-brain/index_manifest.json',
  '.project-brain/search_index.json',
  '.project-brain/runner-logs/',
  '.project-brain/runners/',
  '.worktrees/'
];

/** Template files copied into the host repo only when the destination is absent. */
export const TEMPLATE_COPIES = [
  {
    src: 'skills/project-brain/templates/PULL_REQUEST_TEMPLATE.md',
    dest: '.github/PULL_REQUEST_TEMPLATE.md'
  },
  {
    src: 'skills/project-brain/templates/github-workflows/project-brain.yml',
    dest: '.github/workflows/project-brain.yml'
  }
];

/** Default package.json skeleton used when the host has none (same as the old installer). */
export const DEFAULT_PACKAGE = { private: true, type: 'module', scripts: {} };

/**
 * PURE. Diff what mergePackageScripts/mergePackageDeps WOULD change on the
 * host package.json. `pkgRaw` is the parsed host package.json, or null/undefined
 * when the file does not exist (the default skeleton is used, as before).
 *
 * @returns {{ exists: boolean, scripts: object, dependencies: object }}
 *   two plan groups plus an `exists` flag (false ⇒ the file will be created).
 */
export function planPackageJson(pkgRaw) {
  const exists = pkgRaw != null;
  const base = exists ? pkgRaw : DEFAULT_PACKAGE;
  // The merge helpers mutate in place — compute on a deep copy, diff after.
  const merged = mergePackageScripts(mergePackageDeps(structuredClone(base)));

  const scriptChanges = [];
  for (const [key, to] of Object.entries(merged.scripts ?? {})) {
    const from = base.scripts?.[key];
    if (from !== to) scriptChanges.push({ key, from: from ?? null, to });
  }

  const depChanges = [];
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [key, to] of Object.entries(merged[field] ?? {})) {
      const from = base[field]?.[key];
      if (from !== to) depChanges.push({ field, key, from: from ?? null, to });
    }
  }

  return {
    exists,
    scripts: { id: 'package-scripts', group: 'package.json scripts', changes: scriptChanges },
    dependencies: { id: 'package-deps', group: 'package.json dependencies', changes: depChanges }
  };
}

/**
 * PURE. Plan the .gitignore appends. Reproduces the installer's exact append
 * semantics (substring check, newline handling) and returns the resulting
 * text as `next` so apply is a plain write.
 *
 * @param {string} ignoreText current .gitignore content ('' when absent)
 * @param {string[]} entries  entries to ensure (defaults to GITIGNORE_ENTRIES)
 */
export function planGitignore(ignoreText = '', entries = GITIGNORE_ENTRIES) {
  let next = ignoreText;
  const changes = [];
  for (const entry of entries) {
    if (next.includes(entry)) {
      changes.push({ entry, action: 'skip-exists' });
    } else {
      next += `${next.endsWith('\n') || next === '' ? '' : '\n'}${entry}\n`;
      changes.push({ entry, action: 'append' });
    }
  }
  return { id: 'gitignore', group: '.gitignore', changes, next };
}

/**
 * PURE. Plan the template copies. `existingDests` is the set (or array) of
 * destination paths that already exist in the host — those are skipped, never
 * overwritten (same as the old installer).
 */
export function planTemplates(existingDests = [], copies = TEMPLATE_COPIES) {
  const have = new Set(existingDests);
  const changes = copies.map(({ src, dest }) => ({
    file: dest,
    src,
    action: have.has(dest) ? 'skip-exists' : 'copy'
  }));
  return { id: 'templates', group: 'templates', changes };
}

/**
 * PURE. Summarize what the additive .claude/settings.json merge would add,
 * using computeSettingsDrift (also pure). Honors the documented bypass
 * (PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1) via the `skip` flag the caller
 * derives from env.
 *
 * @param {{ skip?: boolean, templateExists?: boolean, installed?: object, recommended?: object }} opts
 */
export function planClaudeSettings({ skip = false, templateExists = true, installed = {}, recommended = {} } = {}) {
  let summary;
  if (skip) {
    summary = 'skipped (PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS=1)';
  } else if (!templateExists) {
    summary = 'settings template not found; sync will be skipped';
  } else {
    const d = computeSettingsDrift(installed, recommended);
    summary = d.drift
      ? `additive merge into .claude/settings.json (hooks:+${d.hookDrift} allow:+${d.allowDrift}; user entries preserved)`
      : 'up to date (.claude/settings.json already carries the recommended wiring)';
  }
  return { id: 'claude-settings', group: 'claude-settings', summary, skip };
}

/**
 * PURE. Summarize the cursor-hooks install step. `installer` is the resolved
 * installer path ('' when none was found — the step is then a no-op).
 */
export function planCursorHooks(installer = '') {
  return {
    id: 'cursor-hooks',
    group: 'cursor-hooks',
    installer,
    summary: installer
      ? `run ${installer} (merge templates/cursor/hooks.json into .cursor/hooks.json)`
      : 'no cursor-hooks installer found; skipped'
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the cursor-hooks installer exactly like the old installer did:
 * package checkout first, canonical-repo layout second.
 */
export function resolveCursorHookInstaller(cwd = process.cwd()) {
  const candidates = [
    'skills/project-brain/scripts/install-cursor-hooks.mjs',
    'scripts/install-cursor-hooks.mjs'
  ];
  return candidates.find((p) => fs.existsSync(path.join(cwd, p))) ?? '';
}

/**
 * Compute the full install plan for the host repo at `cwd`. READ-ONLY: this
 * function performs fs reads but never writes, prompts, or spawns.
 *
 * @param {{ cwd?: string, env?: object }} opts
 * @returns {object[]} array of change groups (see module header for shape)
 */
export function computeInitPlan({ cwd = process.cwd(), env = process.env } = {}) {
  const pkgPath = path.join(cwd, 'package.json');
  // Deliberately throw on malformed JSON (like the old installer) rather than
  // silently planning to replace a corrupt package.json with the skeleton.
  const pkgRaw = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : null;
  const pkgPlan = planPackageJson(pkgRaw);

  const ignorePath = path.join(cwd, '.gitignore');
  const ignoreText = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const gitignore = planGitignore(ignoreText);

  const existingDests = TEMPLATE_COPIES
    .map(({ dest }) => dest)
    .filter((dest) => fs.existsSync(path.join(cwd, dest)));
  const templates = planTemplates(existingDests);

  const settingsTemplate = path.join(
    cwd, 'skills', 'project-brain', 'templates', 'claude-code', 'settings.recommended.json'
  );
  const claudeSettings = planClaudeSettings({
    skip: env.PROJECT_BRAIN_SKIP_CLAUDE_SETTINGS === '1',
    templateExists: fs.existsSync(settingsTemplate),
    installed: readJsonSafe(path.join(cwd, '.claude', 'settings.json')) ?? {},
    recommended: readJsonSafe(settingsTemplate) ?? {}
  });

  const cursorHooks = planCursorHooks(resolveCursorHookInstaller(cwd));

  return [pkgPlan.scripts, pkgPlan.dependencies, gitignore, templates, claudeSettings, cursorHooks];
}
