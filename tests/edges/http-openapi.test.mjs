import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import openapiSchema from '../../scripts/edges/openapi-schema.mjs';
import httpClient from '../../scripts/edges/http-client.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-http-test-')); }
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

test('openapi-schema: server URL feeds openapiServices', async () => {
  const root = tmp();
  write(path.join(root, 'backend', 'package.json'), '{"name":"backend"}');
  write(path.join(root, 'backend', 'openapi.yaml'), [
    'openapi: 3.0.3',
    'servers:',
    '  - url: https://api.example.com',
    '  - url: https://backend.svc.cluster.local'
  ].join('\n'));
  const projects = [{ name: 'backend', dir: 'backend', kinds: ['node'] }];
  const ctx = ctxFor(root, projects);
  await consume(openapiSchema.detect(ctx));
  const services = ctx.facts.get('openapiServices');
  assert.equal(services.get('https://api.example.com'), 'backend');
  assert.equal(services.get('https://backend.svc.cluster.local'), 'backend');
});

test('http-client: TS fetch hitting a sibling host resolves to medium-confidence', async () => {
  const root = tmp();
  write(path.join(root, 'backend', 'package.json'), '{"name":"backend"}');
  write(path.join(root, 'frontend', 'package.json'), '{"name":"frontend"}');
  write(path.join(root, 'frontend', 'src', 'app.ts'), [
    'const res = await fetch("https://backend.svc.example/api/users");',
    'await fetch("https://api.backend/api/health");'
  ].join('\n'));

  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node'] },
    { name: 'frontend', dir: 'frontend', kinds: ['node'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(httpClient.detect(ctx));
  assert.ok(edges.some(e => e.from === 'frontend' && e.to === 'backend' && e.confidence === 'medium'));
});

test('http-client: openapi-derived host yields high confidence', async () => {
  const root = tmp();
  write(path.join(root, 'backend', 'openapi.yaml'), 'servers:\n  - url: https://backend.svc\n');
  write(path.join(root, 'workers', 'main.py'), 'import requests\nrequests.get("https://backend.svc/queue")\n');

  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node'] },
    { name: 'workers', dir: 'workers', kinds: ['python'] }
  ];
  const ctx = ctxFor(root, projects);
  await consume(openapiSchema.detect(ctx));
  const edges = await consume(httpClient.detect(ctx));
  assert.ok(edges.some(e => e.from === 'workers' && e.to === 'backend' && e.confidence === 'high'));
});

test('http-client: localhost / 127.x is not emitted', async () => {
  const root = tmp();
  write(path.join(root, 'a', 'package.json'), '{"name":"a"}');
  write(path.join(root, 'a', 'src', 'app.ts'), 'fetch("http://localhost:3000/dev");');
  write(path.join(root, 'b', 'package.json'), '{"name":"b"}');

  const projects = [
    { name: 'a', dir: 'a', kinds: ['node'] },
    { name: 'b', dir: 'b', kinds: ['node'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(httpClient.detect(ctx));
  assert.equal(edges.length, 0);
});
