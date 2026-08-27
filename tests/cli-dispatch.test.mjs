/**
 * CLI dispatcher tests (bin/cli.mjs, ADR 0028) + findRoot root-resolution
 * coverage in scripts/common.mjs.
 *
 * The dispatcher re-spawns node on scripts/brain-*.mjs (never imports them),
 * so these tests exercise it the same way: spawnSync against throwaway
 * mkdtemp fixtures. findRoot is additionally covered end-to-end by spawning a
 * probe script from a SUBDIR of a brain-enabled fixture and asserting ROOT
 * resolves to the fixture root, not the cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRoot } from '../scripts/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'bin', 'cli.mjs');
const COMMON = path.resolve(here, '..', 'scripts', 'common.mjs');

const PUBLIC_VERBS = ['init', 'status', 'lease', 'work', 'brief', 'grill', 'handoff', 'guard', 'doctor', 'search', 'ask'];

function runCli(args, opts = {}) {
  // Strip CI PR context (GITHUB_*_REF) and any BRAIN_ROOT so fixtures are
  // hermetic — same rationale as tests/brain-guard-security.test.mjs.
  const inherited = { ...process.env };
  delete inherited.GITHUB_BASE_REF;
  delete inherited.GITHUB_HEAD_REF;
  delete inherited.BRAIN_ROOT;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...opts,
    env: { ...inherited, ...(opts.env || {}) }
  });
}

/** Brain-enabled git fixture with the four required brain files + one commit. */
function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  for (const name of ['context_index.md', 'active_state.md', 'product_plan.md', 'repo_context.md']) {
    fs.writeFileSync(path.join(cwd, '.project-brain', name), `# ${name}\n`);
  }
  execSync('git init --quiet', { cwd });
  execSync('git config user.email t@example.com', { cwd });
  execSync('git config user.name Tester', { cwd });
  execSync('git checkout -q -b feature/1-test', { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# test\n');
  execSync('git add README.md .project-brain', { cwd });
  execSync('git -c commit.gpgsign=false commit -q -m "chore(brain): init"', { cwd });
  return cwd;
}

test('cli --help exits 0 and lists the public verbs', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, r.stderr);
  for (const verb of PUBLIC_VERBS) {
    assert.match(r.stdout, new RegExp(`^\\s{2}${verb}\\b`, 'm'), `help should list "${verb}"`);
  }
  // Tiered help: advanced verbs and the escape hatch appear after the public tier.
  assert.match(r.stdout, /Advanced:/);
  assert.match(r.stdout, /orchestrate/);
  assert.match(r.stdout, /x <script>/);
  assert.ok(r.stdout.indexOf('Advanced:') > r.stdout.indexOf('  init'), 'public verbs come before the advanced tier');
});

test('cli with no args prints help and exits 0', () => {
  const r = runCli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: project-brain <verb>/);
});

test('cli --version prints the package.json version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
  const r = runCli(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('unknown verb exits nonzero with a helpful message', () => {
  const r = runCli(['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown verb "frobnicate"/);
  assert.match(r.stderr, /guard/, 'error should list the known verbs');
  assert.match(r.stderr, /--help/);
});

test('x with a nonexistent script exits nonzero and lists available scripts', () => {
  const r = runCli(['x', 'no-such-script-xyz']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no such script "no-such-script-xyz"/);
  assert.match(r.stderr, /^\s{2}guard$/m, 'listing should include the guard script');
});

test('x guard spawns brain-guard.mjs in a fixture repo', () => {
  const cwd = makeRepo();
  const r = runCli(['x', 'guard'], { cwd });
  // Any exit code is fine — we assert the guard actually ran: it always prints
  // either "Project Brain guard passed." or "Project Brain errors:/warnings:".
  assert.match(r.stdout + r.stderr, /Project Brain/, `guard output missing.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
});

test('findRoot: ROOT resolves to the fixture root when a script runs from a subdir', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-root-')));
  fs.mkdirSync(path.join(root, '.project-brain'), { recursive: true });
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const probe = path.join(root, 'probe.mjs');
  fs.writeFileSync(probe, `import { ROOT } from ${JSON.stringify(pathToFileURL(COMMON).href)};\nconsole.log(ROOT);\n`);
  const inherited = { ...process.env };
  delete inherited.BRAIN_ROOT;
  const r = spawnSync(process.execPath, [probe], { cwd: sub, encoding: 'utf8', env: inherited });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), root);
});

test('findRoot unit: .project-brain wins, .git is the fallback, bare dirs keep cwd semantics', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-findroot-')));

  // .project-brain ancestor wins from a nested start dir.
  const brainRoot = path.join(base, 'brainy');
  fs.mkdirSync(path.join(brainRoot, '.project-brain'), { recursive: true });
  const brainSub = path.join(brainRoot, 'a', 'b');
  fs.mkdirSync(brainSub, { recursive: true });
  assert.equal(findRoot(brainSub), brainRoot);

  // No .project-brain anywhere up the chain → nearest .git wins.
  const gitRoot = path.join(base, 'gitty');
  fs.mkdirSync(path.join(gitRoot, '.git'), { recursive: true });
  const gitSub = path.join(gitRoot, 'src');
  fs.mkdirSync(gitSub, { recursive: true });
  assert.equal(findRoot(gitSub), gitRoot);

  // Neither marker (tmp fixtures) → the start dir itself, as before.
  const bare = path.join(base, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  assert.equal(findRoot(bare), bare);
});

test('findRoot unit: BRAIN_ROOT env overrides discovery', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-envroot-')));
  const prev = process.env.BRAIN_ROOT;
  process.env.BRAIN_ROOT = dir;
  try {
    assert.equal(findRoot('/'), dir);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_ROOT;
    else process.env.BRAIN_ROOT = prev;
  }
});

/* The workspace case that made this rule necessary: a folder with a brain in
   it, holding unrelated cloned repos. Every one of them used to resolve to the
   wrapper, so `health-calibrate` inside a 666-commit repo silently reported the
   wrapper's 33 commits — a complete, well-formatted answer about the wrong
   repository. A `.git` DIRECTORY now stops the climb; a `.git` FILE (worktree,
   submodule — the same project seen from elsewhere) still does not. */
test('findRoot unit: a nested independent repo wins over an outer .project-brain', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-nested-')));
  fs.mkdirSync(path.join(base, '.project-brain'), { recursive: true });

  // An unrelated clone sitting inside the brain-enabled workspace.
  const clone = path.join(base, 'vendor-repo');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const cloneSub = path.join(clone, 'src', 'deep');
  fs.mkdirSync(cloneSub, { recursive: true });
  assert.equal(findRoot(cloneSub), clone, 'nested repo must be measured as itself');
  assert.equal(findRoot(clone), clone);

  // A worktree/submodule pointer is the SAME project — it keeps climbing so
  // brain state stays at the parent root (brain:orchestrate depends on this).
  const wt = path.join(base, 'worktree-a');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(base, '.git', 'worktrees', 'a')}\n`);
  assert.equal(findRoot(wt), base, 'worktree must resolve to the brain root');

  // A plain subdirectory of the workspace still resolves to the workspace.
  const plain = path.join(base, 'notes');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(findRoot(plain), base);
});

/* Ordering guard: with no .project-brain anywhere, the nearest independent repo
   still wins over an outer one — nesting alone must not reach past a repo. */
test('findRoot unit: nearest .git directory wins over an outer .git directory', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-nestgit-')));
  fs.mkdirSync(path.join(base, '.git'), { recursive: true });
  const inner = path.join(base, 'inner');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  const innerSub = path.join(inner, 'pkg');
  fs.mkdirSync(innerSub, { recursive: true });
  assert.equal(findRoot(innerSub), inner);
});
