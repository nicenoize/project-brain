import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import imageRegistry from '../../scripts/edges/image-registry.mjs';
import k8sImage from '../../scripts/edges/k8s-image.mjs';

function tmpFleet() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-edge-test-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function consume(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

function ctxFor(root, projects) {
  return {
    ROOT: root,
    projects,
    projectDirs: new Map(projects.map(p => [p.name, path.join(root, p.dir)])),
    dirtyProjects: new Set(),
    facts: new Map(),
    cache: null,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    signal: AbortSignal.timeout(5000)
  };
}

test('image-registry + k8s-image: helm chart referencing sibling Dockerfile resolves', async () => {
  const root = tmpFleet();
  write(path.join(root, 'backend', 'Dockerfile'), 'FROM node\n');
  write(path.join(root, 'backend', 'package.json'), '{"name":"@x/backend"}');
  write(path.join(root, 'k8s', 'Chart.yaml'), 'name: deploys\n');
  write(path.join(root, 'k8s', 'templates', 'app.yaml'), [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: web',
    '          image: ghcr.io/acme/backend:1.2'
  ].join('\n'));

  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node', 'docker'] },
    { name: 'k8s', dir: 'k8s', kinds: ['helm'] }
  ];
  const ctx = ctxFor(root, projects);
  await consume(imageRegistry.detect(ctx)); // populates facts
  const edges = await consume(k8sImage.detect(ctx));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'k8s');
  assert.equal(edges[0].to, 'backend');
  assert.equal(edges[0].kind, 'k8s-image');
  assert.equal(edges[0].confidence, 'high');
  assert.ok(edges[0].evidence[0].includes('k8s/templates/app.yaml'));
});

test('k8s-image: Helm template image with values.yaml resolves medium-confidence', async () => {
  const root = tmpFleet();
  write(path.join(root, 'worker', 'Dockerfile'), 'FROM python\n');
  write(path.join(root, 'worker', 'pyproject.toml'), '[project]\nname = "worker"\n');
  write(path.join(root, 'orchestration', 'Chart.yaml'), 'name: orch\n');
  write(path.join(root, 'orchestration', 'values.yaml'), 'image:\n  repository: worker\n  tag: latest\n');
  write(path.join(root, 'orchestration', 'templates', 'job.yaml'), [
    'kind: CronJob',
    'spec:',
    '  jobTemplate:',
    '    spec:',
    '      template:',
    '        spec:',
    '          containers:',
    '            - name: c',
    '              image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"'
  ].join('\n'));

  const projects = [
    { name: 'worker', dir: 'worker', kinds: ['python', 'docker'] },
    { name: 'orchestration', dir: 'orchestration', kinds: ['helm'] }
  ];
  const ctx = ctxFor(root, projects);
  await consume(imageRegistry.detect(ctx));
  const edges = await consume(k8sImage.detect(ctx));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'orchestration');
  assert.equal(edges[0].to, 'worker');
  assert.equal(edges[0].confidence, 'medium');
});

test('k8s-image: ignores self-deploy (same project owns image + chart)', async () => {
  const root = tmpFleet();
  write(path.join(root, 'svc', 'Dockerfile'), 'FROM node\n');
  write(path.join(root, 'svc', 'package.json'), '{"name":"svc"}');
  write(path.join(root, 'svc', 'Chart.yaml'), 'name: svc\n');
  write(path.join(root, 'svc', 'templates', 'app.yaml'), 'image: svc:1');

  const projects = [{ name: 'svc', dir: 'svc', kinds: ['node', 'docker', 'helm'] }];
  const ctx = ctxFor(root, projects);
  await consume(imageRegistry.detect(ctx));
  const edges = await consume(k8sImage.detect(ctx));

  assert.equal(edges.length, 0);
});
