import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAggregateSummaryTexts,
  firstSentenceOfChild,
  decisionGroupKeys,
  discoverPackages,
  groupSummariesByPackage,
  readDirReadmeLead,
  readTopLevelExports,
  buildPackageSummary,
  buildRepoSummary,
  buildFleetSummary,
  extractProjectContracts
} from '../scripts/aggregate.mjs';
import { extractCodeIntent } from '../scripts/chunk.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-agg-test-'));
}

// ---------- extractCodeIntent (V3) ----------

test('extractCodeIntent: file-level JSDoc wins', () => {
  const text = '/** Handles auth lease lifecycle. */\nexport function foo() {}';
  assert.equal(extractCodeIntent(text), 'Handles auth lease lifecycle.');
});

test('extractCodeIntent: falls back to first export JSDoc', () => {
  const text = "import x from 'y';\n\n/** Verifies a session token. */\nexport function verify() {}";
  assert.equal(extractCodeIntent(text), 'Verifies a session token.');
});

test('extractCodeIntent: falls back to leading // comments', () => {
  const text = '// Connects the pool with retry.\n// Uses BRAIN_POOL_SIZE.\nfunction connect() {}';
  assert.equal(extractCodeIntent(text), 'Connects the pool with retry. Uses BRAIN_POOL_SIZE.');
});

test('extractCodeIntent: empty when nothing to extract', () => {
  assert.equal(extractCodeIntent('function noop() {}'), '');
});

test('extractCodeIntent: strips JSDoc @tags', () => {
  const text = '/**\n * Does the thing.\n * @param x foo\n * @returns y\n */\nexport function thing() {}';
  assert.equal(extractCodeIntent(text), 'Does the thing.');
});

// ---------- firstSentenceOfChild (V2) ----------

test('firstSentenceOfChild: skips boilerplate, returns first real sentence', () => {
  const record = {
    text: '# foo.ts\nFile: lib/foo.ts\nHandles billing checkout. Returns 200.\nExports/symbols: a, b'
  };
  assert.equal(firstSentenceOfChild(record), 'Handles billing checkout.');
});

test('firstSentenceOfChild: caps at 180 chars', () => {
  const long = 'x '.repeat(120) + 'end.';
  const record = { text: `# t\n${long}` };
  assert.ok(firstSentenceOfChild(record).length <= 181);
});

test('firstSentenceOfChild: empty when only boilerplate', () => {
  const record = { text: '# foo\nFile: a\nNo exported symbols detected.\nNo headings detected.' };
  assert.equal(firstSentenceOfChild(record), '');
});

// ---------- buildAggregateSummaryTexts (V2) ----------

test('buildAggregateSummaryTexts: includes intent line per child', () => {
  const children = [
    { file: 'a.ts', heading: 'a.ts', text: '# a.ts\nHandles auth.\nExports: foo', symbols: ['foo'] },
    { file: 'b.ts', heading: 'b.ts', text: '# b.ts\nHandles billing.\nExports: bar', symbols: ['bar'] }
  ];
  const { text, embeddingText } = buildAggregateSummaryTexts({ title: 'lib module', key: 'lib', children });
  assert.ok(embeddingText.includes('# lib module'));
  assert.ok(embeddingText.includes('Handles auth.'));
  assert.ok(embeddingText.includes('Handles billing.'));
  assert.ok(embeddingText.includes('Exports: foo, bar') || embeddingText.includes('Exports: bar, foo'));
  // text is the verbose human-readable concat
  assert.ok(text.includes('## a.ts'));
  assert.ok(text.includes('## b.ts'));
});

test('buildAggregateSummaryTexts: caps embeddingText for huge groups', () => {
  const children = Array.from({ length: 30 }, (_, i) => ({
    file: `x${i}.ts`,
    heading: `x${i}.ts`,
    text: `# x${i}\n` + 'word '.repeat(200),
    symbols: [`sym${i}`]
  }));
  const { embeddingText } = buildAggregateSummaryTexts({ title: 't', key: 'k', children });
  assert.ok(embeddingText.length <= 1100, `expected ≤1100 chars, got ${embeddingText.length}`);
});

test('buildAggregateSummaryTexts: notes child overflow when count > sliceCap and content fits', () => {
  const children = Array.from({ length: 25 }, (_, i) => ({
    file: `x${i}.ts`,
    heading: `x${i}.ts`,
    text: `# x${i}\nShort.`,
    symbols: []
  }));
  const { embeddingText } = buildAggregateSummaryTexts({ title: 't', key: 'k', children });
  assert.ok(embeddingText.includes('+5 more'));
});

test('buildAggregateSummaryTexts: includes README lead paragraph when provided', () => {
  const { embeddingText } = buildAggregateSummaryTexts({
    title: 'pkg',
    key: 'pkg',
    readmeLeadParagraph: 'This package handles payments.',
    children: [{ file: 'a.ts', heading: 'a.ts', text: '# a\nOne.', symbols: [] }]
  });
  assert.ok(embeddingText.includes('Readme: This package handles payments.'));
});

// ---------- decisionGroupKeys (V4) ----------

test('decisionGroupKeys: emits both module and feature when set', () => {
  assert.deepEqual(decisionGroupKeys({ module: 'auth', feature: 'login' }), [
    { kind: 'module', key: 'auth' },
    { kind: 'feature', key: 'login' }
  ]);
});

test('decisionGroupKeys: empty when neither set', () => {
  assert.deepEqual(decisionGroupKeys({}), []);
});

// ---------- discoverPackages + buildPackageSummary (V1) ----------

test('discoverPackages: finds packages/* and apps/* with package.json', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'packages', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'foo', 'package.json'), '{"name":"@x/foo"}');
  fs.mkdirSync(path.join(root, 'packages', 'no-pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'web', 'package.json'), '{"name":"web"}');

  const dirs = discoverPackages(root);
  assert.deepEqual(dirs.sort(), ['apps/web', 'packages/foo']);
});

test('discoverPackages: honors custom globs', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'libs', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'libs', 'a', 'package.json'), '{"name":"a"}');
  assert.deepEqual(discoverPackages(root, ['libs/*']), ['libs/a']);
});

test('readDirReadmeLead: returns first paragraph, skips headings + frontmatter', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'pkg', 'README.md'),
    '---\ntitle: x\n---\n# Heading\n\nFirst real paragraph here.\n\nSecond.'
  );
  assert.equal(readDirReadmeLead(root, 'pkg'), 'First real paragraph here.');
});

test('readDirReadmeLead: returns empty when no README', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  assert.equal(readDirReadmeLead(root, 'pkg'), '');
});

test('readTopLevelExports: parses named, function, class, * re-exports', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'pkg', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'pkg', 'src', 'index.ts'),
    "export { foo, bar as baz } from './a';\nexport function qux() {}\nexport class Zap {}\nexport * from './rest';"
  );
  const exports = readTopLevelExports(root, 'pkg');
  assert.ok(exports.includes('foo'));
  assert.ok(exports.includes('baz'));
  assert.ok(exports.includes('qux'));
  assert.ok(exports.includes('Zap'));
  assert.ok(exports.some(name => name.startsWith('*from:rest')));
});

test('buildPackageSummary: synthesizes embeddingText from package.json + children', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'packages', 'billing', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'billing', 'package.json'),
    JSON.stringify({
      name: '@acme/billing',
      description: 'Handles invoices and payment links.',
      keywords: ['billing', 'payments'],
      dependencies: { stripe: '^1.0.0' }
    })
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'billing', 'src', 'index.ts'),
    'export function chargeCard() {}'
  );

  const result = buildPackageSummary({
    root,
    pkgDir: 'packages/billing',
    childSummaries: [{ file: 'packages/billing/src/index.ts', heading: 'index.ts', text: '# index.ts\nCharges a customer.', symbols: ['chargeCard'] }]
  });
  assert.ok(result);
  assert.equal(result.name, '@acme/billing');
  assert.ok(result.embeddingText.includes('# @acme/billing package'));
  assert.ok(result.embeddingText.includes('Description: Handles invoices and payment links.'));
  assert.ok(result.embeddingText.includes('Keywords: billing, payments'));
  assert.ok(result.embeddingText.includes('chargeCard'));
  assert.ok(result.embeddingText.includes('Deps: stripe'));
});

test('buildPackageSummary: returns null when package.json missing', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'packages', 'empty'), { recursive: true });
  assert.equal(buildPackageSummary({ root, pkgDir: 'packages/empty', childSummaries: [] }), null);
});

// ---------- groupSummariesByPackage (V1) ----------

// ---------- buildRepoSummary / extractProjectContracts (F2) ----------

test('extractProjectContracts: Node project pulls name + description + deps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-repo-test-'));
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'package.json'), JSON.stringify({
    name: '@x/backend',
    description: 'Auth + billing API.',
    dependencies: { express: '^4', pg: '^8' }
  }));
  const c = extractProjectContracts(root, { name: 'backend', dir: 'backend', kinds: ['node'] });
  assert.equal(c.name, '@x/backend');
  assert.equal(c.description, 'Auth + billing API.');
  assert.ok(c.deps.includes('express'));
  assert.ok(c.deps.includes('pg'));
});

test('extractProjectContracts: Go project pulls module name + cmd binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-repo-test-'));
  fs.mkdirSync(path.join(root, 'workers', 'cmd', 'consumer'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workers', 'cmd', 'migrator'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workers', 'go.mod'), 'module github.com/acme/workers\n\nrequire (\n\tgithub.com/lib/pq v1.10.0\n)\n');
  const c = extractProjectContracts(root, { name: 'workers', dir: 'workers', kinds: ['go'] });
  assert.equal(c.name, 'github.com/acme/workers');
  assert.deepEqual(c.binaries.sort(), ['consumer', 'migrator']);
});

test('extractProjectContracts: K8s project pulls service names + image refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-repo-test-'));
  fs.mkdirSync(path.join(root, 'k8s', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'k8s', 'Chart.yaml'), 'name: orchestration\ndescription: All deployments.\n');
  fs.writeFileSync(path.join(root, 'k8s', 'templates', 'svc.yaml'), [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: backend',
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: web',
    '          image: ghcr.io/acme/backend:1.2'
  ].join('\n'));
  const c = extractProjectContracts(root, { name: 'k8s', dir: 'k8s', kinds: ['helm'] });
  assert.equal(c.name, 'orchestration');
  assert.ok(c.services.includes('backend'));
  assert.ok(c.images.includes('ghcr.io/acme/backend:1.2'));
});

test('buildRepoSummary: produces text + embeddingText, caps at 1100 chars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-repo-test-'));
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'package.json'), JSON.stringify({
    name: '@x/backend',
    description: 'Auth + billing API.',
    dependencies: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`dep-${i}`, '^1'])) // many deps
  }));
  fs.writeFileSync(path.join(root, 'backend', 'README.md'), 'The backend serves user auth, billing, and event publishing.');
  const project = { name: 'backend', dir: 'backend', kinds: ['node'] };
  const result = buildRepoSummary({
    root, project,
    childSummaries: Array.from({ length: 8 }, (_, i) => ({
      file: `backend/src/file-${i}.ts`,
      heading: `file-${i}.ts`,
      text: `# file-${i}.ts\nDoes thing ${i}.`,
      symbols: [`sym${i}`]
    }))
  });
  assert.ok(result);
  assert.equal(result.name, '@x/backend');
  assert.ok(result.embeddingText.includes('# @x/backend project'));
  assert.ok(result.embeddingText.includes('Description: Auth + billing API.'));
  assert.ok(result.embeddingText.includes('Readme: The backend serves'));
  assert.ok(result.embeddingText.includes('Files:'));
  assert.ok(result.embeddingText.length <= 1100);
});

// ---------- buildFleetSummary (F4) ----------

test('buildFleetSummary: produces text + embeddingText capped at 1100 chars', () => {
  const projects = [
    { name: 'backend', kinds: ['node', 'docker'] },
    { name: 'workers', kinds: ['python'] },
    { name: 'k8s', kinds: ['helm'] }
  ];
  const repoSummaries = [
    { project: 'backend', heading: 'backend', text: '# backend project\nHandles API + auth.\nExports: a, b', id: 'r1' },
    { project: 'workers', heading: 'workers', text: '# workers project\nProcesses background jobs.', id: 'r2' },
    { project: 'k8s', heading: 'k8s', text: '# k8s project\nDeploys backend + workers.', id: 'r3' }
  ];
  const edgeRecords = [
    { edgeFrom: 'k8s', edgeTo: 'backend', edgeKind: 'k8s-image', id: 'e1' },
    { edgeFrom: 'k8s', edgeTo: 'workers', edgeKind: 'k8s-image', id: 'e2' },
    { edgeFrom: 'backend', edgeTo: 'workers', edgeKind: 'pubsub', id: 'e3' }
  ];
  const result = buildFleetSummary({ projects, repoSummaries, edgeRecords });
  assert.ok(result.embeddingText.length <= 1100);
  assert.ok(result.embeddingText.includes('Projects (3): backend, workers, k8s'));
  assert.ok(result.embeddingText.includes('Handles API'));
  assert.ok(result.embeddingText.includes('k8s → backend via k8s-image'));
  assert.ok(result.embeddingText.includes('backend → workers via pubsub'));
});

test('buildFleetSummary: empty edge list omits Edges section', () => {
  const result = buildFleetSummary({
    projects: [{ name: 'a', kinds: ['node'] }, { name: 'b', kinds: ['go'] }],
    repoSummaries: [],
    edgeRecords: []
  });
  assert.ok(!result.embeddingText.includes('Edges'));
});

test('groupSummariesByPackage: assigns by longest-prefix match, ignores non-summary', () => {
  const records = [
    { file: 'packages/foo/src/a.ts', isSummary: true, type: 'code-summary' },
    { file: 'packages/foo-extra/src/b.ts', isSummary: true, type: 'code-summary' },
    { file: 'packages/foo/src/a.ts', isSummary: false, type: 'code' }, // body chunk, skip
    { file: 'session.md', isSummary: true, type: 'session' } // session, skip
  ];
  const groups = groupSummariesByPackage(records, ['packages/foo', 'packages/foo-extra']);
  assert.equal(groups.get('packages/foo')?.length, 1);
  assert.equal(groups.get('packages/foo-extra')?.length, 1);
});
