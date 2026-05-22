import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import packageDep from '../../scripts/edges/package-dep.mjs';
import goReplace from '../../scripts/edges/go-replace.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dep-test-')); }
function write(p, c) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
async function consume(it) { const a = []; for await (const v of it) a.push(v); return a; }
function ctxFor(root, projects) {
  return {
    ROOT: root, projects,
    projectDirs: new Map(projects.map(p => [p.name, path.join(root, p.dir)])),
    dirtyProjects: new Set(),
    facts: new Map(),
    cache: null,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    signal: AbortSignal.timeout(5000)
  };
}

test('package-dep: sibling internal dep emits high-confidence edge', async () => {
  const root = tmp();
  write(path.join(root, 'shared', 'package.json'), '{"name":"@acme/shared","version":"1.0.0"}');
  write(path.join(root, 'app', 'package.json'), '{"name":"@acme/app","dependencies":{"@acme/shared":"^1","react":"^18"}}');
  const projects = [
    { name: 'shared', dir: 'shared', kinds: ['node'] },
    { name: 'app', dir: 'app', kinds: ['node'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(packageDep.detect(ctx));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'app');
  assert.equal(edges[0].to, 'shared');
  assert.equal(edges[0].kind, 'package-dep');
  assert.equal(edges[0].confidence, 'high');
});

test('package-dep: external deps (react, etc.) do NOT produce edges', async () => {
  const root = tmp();
  write(path.join(root, 'app', 'package.json'), '{"name":"app","dependencies":{"react":"^18"}}');
  const projects = [{ name: 'app', dir: 'app', kinds: ['node'] }];
  const ctx = ctxFor(root, projects);
  const edges = await consume(packageDep.detect(ctx));
  assert.equal(edges.length, 0);
});

test('go-replace: ../sibling replace emits high-confidence edge', async () => {
  const root = tmp();
  write(path.join(root, 'lib', 'go.mod'), 'module github.com/acme/lib\n\ngo 1.21\n');
  write(path.join(root, 'service', 'go.mod'), [
    'module github.com/acme/service',
    '',
    'go 1.21',
    '',
    'require github.com/acme/lib v0.0.0',
    '',
    'replace github.com/acme/lib => ../lib'
  ].join('\n'));
  const projects = [
    { name: 'lib', dir: 'lib', kinds: ['go'] },
    { name: 'service', dir: 'service', kinds: ['go'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(goReplace.detect(ctx));
  const replaceEdge = edges.find(e => e.confidence === 'high');
  assert.ok(replaceEdge);
  assert.equal(replaceEdge.from, 'service');
  assert.equal(replaceEdge.to, 'lib');
});

test('go-replace: plain require of sibling module → medium', async () => {
  const root = tmp();
  write(path.join(root, 'lib', 'go.mod'), 'module github.com/acme/lib\n');
  write(path.join(root, 'svc', 'go.mod'), 'module github.com/acme/svc\n\nrequire github.com/acme/lib v0.0.1\n');
  const projects = [
    { name: 'lib', dir: 'lib', kinds: ['go'] },
    { name: 'svc', dir: 'svc', kinds: ['go'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(goReplace.detect(ctx));
  assert.ok(edges.some(e => e.from === 'svc' && e.to === 'lib' && e.confidence === 'medium'));
});
