/**
 * brain-draft — the contract under test is mostly a NEGATIVE one: the draft may
 * state measured facts and must never state intent. So alongside the "does it
 * contain the real file list / the real importers" assertions there is a
 * denylist of rationale phrasing that must never appear in generated output,
 * and an assertion that `## Why it is this way` is left deliberately empty.
 *
 * Fixture: a scripted polyglot git repo (mjs + py + css) with a known import
 * cycle, one importer outside the drafted area, one ADR pointing at it, and
 * fixed commit dates so `--now` makes every run byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseAreaSpec, areaMatcher, areaAliases, citedPaths,
  gatherFacts, renderDraft, replacementSummary, draftBanner, WHY_PROMPT
} from '../scripts/brain-draft.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'scripts', 'brain-draft.mjs');
const NOW = '2026-06-01T00:00:00Z';

/**
 * Phrasing that asserts intent, rationale or design goals. None of it may ever
 * be produced by a generator that only measured a file tree.
 */
const INTENT_DENYLIST = [
  'designed to', 'in order to', 'the purpose', 'allows us', 'allowing us',
  'responsible for', 'aims to', 'intended to', 'we chose', 'we decided',
  'this module handles', 'makes it easy', 'ensures that', 'so that we'
];

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function git(cwd, args, extraEnv = {}) {
  const stamp = '2026-05-20T10:00:00Z';
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp,
      ...extraEnv
    }
  });
  return r;
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

/** A small polyglot repo: `pay/**` is the area a draft is asked about. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-draft-'));

  write(root, 'pay/index.mjs', [
    "import Stripe from 'stripe';",
    "import { charge } from './charge.mjs';",
    "import { refund } from './refund.mjs';",
    'export function pay(amount) {',
    '  if (amount > 0) {',
    '    return charge(amount);',
    '  }',
    '  return refund(-amount);',
    '}',
    'export const client = new Stripe();'
  ].join('\n') + '\n');

  // charge <-> refund is a real import cycle strictly inside the area.
  write(root, 'pay/charge.mjs', [
    "import { refund } from './refund.mjs';",
    'export function charge(n) { return refund(n) + n; }'
  ].join('\n') + '\n');
  write(root, 'pay/refund.mjs', [
    "import { charge } from './charge.mjs';",
    'export function refund(n) { return charge ? n : 0; }'
  ].join('\n') + '\n');

  write(root, 'pay/ledger.py', [
    'import os',
    'from . import totals',
    '',
    'def entry(n):',
    '    return os.getpid() + n'
  ].join('\n') + '\n');
  write(root, 'pay/totals.py', 'def total(rows):\n    return sum(rows)\n');
  write(root, 'pay/pay.css', '.pay { color: red; }\n');

  // The only importer from OUTSIDE the area — the measured public surface.
  write(root, 'app/main.mjs', [
    "import { pay } from '../pay/index.mjs';",
    "import { fmt } from './util.mjs';",
    'export const run = (n) => fmt(pay(n));'
  ].join('\n') + '\n');
  write(root, 'app/util.mjs', 'export const fmt = (n) => String(n);\n');

  write(root, '.project-brain/decisions/0001-idempotent-charges.md', [
    '---',
    'title: Idempotent charges',
    'status: canonical',
    'layer: decision',
    'module: pay',
    'date: 2026-05-01',
    '---',
    '',
    '# 0001 — Idempotent charges',
    '',
    '## Context',
    'Retries were double-charging.'
  ].join('\n') + '\n');

  write(root, '.project-brain/modules/app.md', [
    '---',
    'title: app module',
    'status: canonical',
    'layer: architecture',
    'module: app',
    'date: 2026-05-01',
    'globs: app/**',
    '---',
    '',
    '# app module',
    '',
    'The shell.'
  ].join('\n') + '\n');

  write(root, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2) + '\n');

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'seed the fixture repo']);
  // A second commit touching only the area, so the history facts are non-trivial.
  write(root, 'pay/charge.mjs', fs.readFileSync(path.join(root, 'pay/charge.mjs'), 'utf8') + 'export const VERSION = 2;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'bump charge version'], {
    GIT_AUTHOR_DATE: '2026-05-25T10:00:00Z', GIT_COMMITTER_DATE: '2026-05-25T10:00:00Z'
  });
  return root;
}

function runDraft(root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_ROOT: root, BRAIN_QUIET: '1' }
  });
}

/** The body of one `## heading` section, up to the next heading or rule. */
function sectionOf(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  assert.notEqual(start, -1, `section ${heading} is missing`);
  const rest = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]) || lines[i].trim() === '---') break;
    rest.push(lines[i]);
  }
  return rest.join('\n').trim();
}

// ---------------------------------------------------------------------------
// pure units
// ---------------------------------------------------------------------------

test('parseAreaSpec: a directory becomes dir/**, a glob is kept, a file stays exact', () => {
  const isDir = (p) => p === 'ui' || p === 'scripts/edges';
  assert.deepEqual(parseAreaSpec('ui', isDir), { spec: 'ui', glob: 'ui/**', slug: 'ui', kind: 'dir' });
  assert.deepEqual(parseAreaSpec('./ui/', isDir), { spec: 'ui', glob: 'ui/**', slug: 'ui', kind: 'dir' });
  assert.equal(parseAreaSpec('scripts/edges', isDir).slug, 'scripts-edges');
  assert.equal(parseAreaSpec('scripts/brain-*.mjs', isDir).kind, 'glob');
  assert.equal(parseAreaSpec('scripts/common.mjs', isDir).glob, 'scripts/common.mjs');
  assert.equal(parseAreaSpec('', isDir), null);
  assert.equal(parseAreaSpec('/etc/passwd', isDir), null);
  assert.equal(parseAreaSpec('../secrets', isDir), null);
});

test('areaMatcher: the emitted glob claims exactly the files the draft listed', () => {
  const match = areaMatcher('pay/**');
  assert.equal(match('pay/index.mjs'), true);
  assert.equal(match('pay/sub/deep.mjs'), true);
  assert.equal(match('payments/index.mjs'), false);
  assert.equal(match('app/main.mjs'), false);
});

test('areaAliases: widens to the names an ADR module: field plausibly uses', () => {
  const aliases = areaAliases({ glob: 'scripts/edges/**', slug: 'scripts-edges' });
  assert.equal(aliases.has('edges'), true);
  assert.equal(aliases.has('scripts/edges'), true);
  assert.equal(aliases.has('scripts-edges'), true);
});

test('citedPaths: pulls path tokens out of a record body', () => {
  const paths = citedPaths('See `pay/index.mjs` and app/main.mjs, plus nothing.');
  assert.equal(paths.includes('pay/index.mjs'), true);
  assert.equal(paths.includes('app/main.mjs'), true);
});

test('gatherFacts is pure: identical inputs produce identical facts', () => {
  const input = {
    area: { spec: 'pay', glob: 'pay/**', slug: 'pay', kind: 'dir' },
    files: ['pay/a.mjs', 'app/b.mjs'],
    texts: new Map([['pay/a.mjs', 'export const a = 1;\n'], ['app/b.mjs', "import './../pay/a.mjs';\n"]]),
    graph: { nodes: [], edges: [{ from: 'app/b.mjs', to: 'pay/a.mjs', kind: 'from', confidence: 1 }], external: [], coverage: {} },
    commits: [],
    now: Date.parse(NOW),
    moduleRecords: [],
    decisions: []
  };
  assert.deepEqual(gatherFacts(input), gatherFacts(input));
  assert.equal(gatherFacts(input).publicSurface.exposedFiles, 1);
});

test('replacementSummary counts what --force would destroy', () => {
  const existing = [
    '---', 'title: pay module', 'status: canonical', 'module: pay', 'date: 2026-01-01', '---',
    '', '# pay module', '', 'Written by a human who knew why.', '', '## Shape', '', 'Two files.'
  ].join('\n');
  const summary = replacementSummary(existing, '.project-brain/modules/pay.md');
  assert.match(summary, /Would replace \.project-brain\/modules\/pay\.md/);
  assert.match(summary, /status: canonical/);
  assert.match(summary, /pay module · Shape/);
  assert.match(summary, /word\(s\) of authored text/);
});

// ---------------------------------------------------------------------------
// end-to-end: the draft's content
// ---------------------------------------------------------------------------

test('draft states the real file list, the real importers and the real cycle', () => {
  const root = makeRepo();
  const r = runDraft(root, ['module', 'pay', '--now', NOW]);
  assert.equal(r.status, 0, r.stderr);
  const md = r.stdout;

  // (a) the real file list — every area file, and nothing from outside it
  for (const file of ['pay/index.mjs', 'pay/charge.mjs', 'pay/refund.mjs', 'pay/ledger.py', 'pay/totals.py', 'pay/pay.css']) {
    assert.match(md, new RegExp(file.replace('.', '\\.')), `${file} missing from the draft`);
  }
  assert.equal(md.includes('app/util.mjs'), false, 'a file outside the area leaked into the draft');

  // (b) the real importer from outside the area is named as the public surface
  const surface = sectionOf(md, '## What imports it');
  assert.match(surface, /app\/main\.mjs/);
  assert.match(surface, /pay\/index\.mjs/);
  assert.equal(/charge\.mjs/.test(surface.split('\n').slice(0, 6).join('\n')), false,
    'only files actually imported from outside belong in the surface table');

  // (c) the in-area cycle is reported
  const cyclesSection = sectionOf(md, '## Import cycles inside the area');
  assert.match(cyclesSection, /pay\/charge\.mjs/);
  assert.match(cyclesSection, /pay\/refund\.mjs/);
  assert.match(cyclesSection, /→/);

  // (d) external specifiers are reported, not dropped
  assert.match(md, /`stripe`/);

  // (e) history facts come from the fixture's commits
  const history = sectionOf(md, '## History facts');
  assert.match(history, /Ada/);
  assert.match(history, /2026-05-25/);
  assert.match(history, /bump charge version/);

  // (f) the ADR whose module: frontmatter points here is linked
  const decisions = sectionOf(md, '## Related decisions');
  assert.match(decisions, /\[\[0001-idempotent-charges\]\]/);
  assert.match(decisions, /frontmatter module: pay/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('draft invents no rationale: the Why section is empty and intent phrasing never appears', () => {
  const root = makeRepo();
  const r = runDraft(root, ['module', 'pay', '--now', NOW]);
  assert.equal(r.status, 0, r.stderr);
  const md = r.stdout;

  // The one section a generator must refuse to fill.
  assert.equal(sectionOf(md, '## Why it is this way'), WHY_PROMPT);
  assert.match(md, /## Why it is this way/);

  const lower = md.toLowerCase();
  for (const phrase of INTENT_DENYLIST) {
    assert.equal(lower.includes(phrase), false, `draft asserts intent with "${phrase}"`);
  }
  // "purpose"/"rationale"/"why we" in any form would be a claim about intent.
  assert.equal(/\bpurpose\b/i.test(md), false);
  assert.equal(/\brationale\b/i.test(md), false);

  // The banner that hands ownership to the reader is present, dated, once.
  assert.equal(md.split(draftBanner('2026-06-01')).length - 1, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test('frontmatter is status: draft, with a globs line that claims the same files', () => {
  const root = makeRepo();
  const r = runDraft(root, ['module', 'pay', '--now', NOW]);
  const head = r.stdout.split('---')[1];
  assert.match(head, /^status: draft$/m);
  assert.match(head, /^module: pay$/m);
  assert.match(head, /^globs: pay\/\*\*$/m);
  assert.match(head, /^date: 2026-06-01$/m);
  assert.equal(/status: canonical/.test(r.stdout), false, 'a draft must never claim canonical status');

  // The emitted glob really does claim the files the draft listed.
  const match = areaMatcher('pay/**');
  assert.equal(match('pay/index.mjs'), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('determinism: same repo + injected date → byte-identical draft', () => {
  const root = makeRepo();
  const a = runDraft(root, ['module', 'pay', '--now', NOW]);
  const b = runDraft(root, ['module', 'pay', '--now', NOW]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(Buffer.byteLength(a.stdout), Buffer.byteLength(b.stdout));
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// end-to-end: --out ownership rules
// ---------------------------------------------------------------------------

test('--out writes the record; a second --out refuses to clobber without --force', () => {
  const root = makeRepo();
  const dest = path.join(root, '.project-brain', 'modules', 'pay.md');

  const first = runDraft(root, ['module', 'pay', '--now', NOW, '--out']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(dest), true);
  assert.match(first.stdout, /Wrote \.project-brain\/modules\/pay\.md/);
  assert.match(fs.readFileSync(dest, 'utf8'), /^status: draft$/m);

  // A human adopts it: writes the WHY, flips the status, deletes the banner.
  const adopted = fs.readFileSync(dest, 'utf8')
    .replace('status: draft', 'status: canonical')
    .replace(WHY_PROMPT, 'Charges are split from refunds to keep the retry path safe.');
  fs.writeFileSync(dest, adopted, 'utf8');

  const second = runDraft(root, ['module', 'pay', '--now', NOW, '--out']);
  assert.notEqual(second.status, 0, '--out must refuse to overwrite an authored record');
  assert.match(second.stderr, /Would replace \.project-brain\/modules\/pay\.md/);
  assert.match(second.stderr, /status: canonical/);
  assert.match(second.stderr, /--force/);
  assert.match(fs.readFileSync(dest, "utf8"), /retry path/, 'the authored record was modified despite the refusal');

  const forced = runDraft(root, ['module', 'pay', '--now', NOW, '--out', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Would replace/, '--force must still print what it destroyed');
  assert.equal(/retry path/.test(fs.readFileSync(dest, "utf8")), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('stdout stays pipe-clean: the draft only, chatter on stderr', () => {
  const root = makeRepo();
  const r = runDraft(root, ['module', 'pay', '--now', NOW]);
  assert.match(r.stdout, /^---\ntitle: pay module\n/);
  assert.equal(r.stdout.includes('[brain:draft]'), false);
  assert.match(r.stderr, /\[brain:draft\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('--json carries the same facts the markdown states', () => {
  const root = makeRepo();
  const r = runDraft(root, ['module', 'pay', '--now', NOW, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.area.glob, 'pay/**');
  assert.equal(j.files.count, 6);
  assert.equal(j.publicSurface.exposedFiles, 1);
  assert.equal(j.publicSurface.rows[0].file, 'pay/index.mjs');
  assert.deepEqual(j.publicSurface.rows[0].importers, ['app/main.mjs']);
  assert.equal(j.cycles.inside.length >= 1, true);
  assert.equal(j.decisions[0].name, '0001-idempotent-charges');
  assert.equal(j.history.areaCommits, 2);
  assert.equal(j.markdown.includes('## Why it is this way'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an area an existing record already claims is reported as overlap, not silently redrawn', () => {
  const root = makeRepo();
  const r = runDraft(root, ['module', 'app', '--now', NOW]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Overlap: `\.project-brain\/modules\/app\.md`/);
  assert.match(r.stdout, /already claims 2 of the 2 file\(s\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses unknown kinds and empty areas with an actionable message', () => {
  const root = makeRepo();
  const kind = runDraft(root, ['feature', 'pay']);
  assert.notEqual(kind.status, 0);
  assert.match(kind.stderr, /Only `module` exists today/);

  const empty = runDraft(root, ['module', 'nope']);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /no file matches/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('renderDraft on an area with no history says so instead of printing zeros', () => {
  const facts = gatherFacts({
    area: { spec: 'pay', glob: 'pay/**', slug: 'pay', kind: 'dir' },
    files: ['pay/a.mjs'],
    texts: new Map([['pay/a.mjs', 'export const a = 1;\n']]),
    graph: { nodes: [], edges: [], external: [], coverage: {} },
    commits: [],
    now: Date.parse(NOW),
    moduleRecords: [],
    decisions: []
  });
  const md = renderDraft(facts);
  assert.match(sectionOf(md, '## History facts'), /No commit history readable/);
  assert.match(sectionOf(md, '## Related decisions'), /No record in/);
  assert.equal(sectionOf(md, '## Why it is this way'), WHY_PROMPT);
  const lower = md.toLowerCase();
  for (const phrase of INTENT_DENYLIST) assert.equal(lower.includes(phrase), false, phrase);
});
