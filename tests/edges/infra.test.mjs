import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envVar from '../../scripts/edges/env-var.mjs';
import pubsub from '../../scripts/edges/pubsub.mjs';
import dbShared from '../../scripts/edges/db-shared.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-infra-test-')); }
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

test('env-var: shared DATABASE_URL → high-confidence edge', async () => {
  const root = tmp();
  write(path.join(root, 'backend', '.env.example'), 'DATABASE_URL=postgres://...\nLOG_LEVEL=info\n');
  write(path.join(root, 'workers', '.env.example'), 'DATABASE_URL=postgres://...\nLOG_LEVEL=info\n');
  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node'] },
    { name: 'workers', dir: 'workers', kinds: ['python'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(envVar.detect(ctx));
  const dbEdges = edges.filter(e => e.meta?.key === 'DATABASE_URL');
  assert.equal(dbEdges.length, 1);
  assert.equal(dbEdges[0].confidence, 'high');
  const logEdges = edges.filter(e => e.meta?.key === 'LOG_LEVEL');
  assert.equal(logEdges.length, 1);
  assert.equal(logEdges[0].confidence, 'low');
});

test('env-var: process.env.X + os.Getenv("X") both detected', async () => {
  const root = tmp();
  write(path.join(root, 'a', 'src', 'app.ts'), 'const x = process.env.KAFKA_BROKERS;\n');
  write(path.join(root, 'b', 'main.go'), 'package main\nimport "os"\nfunc main(){ os.Getenv("KAFKA_BROKERS") }\n');
  const projects = [
    { name: 'a', dir: 'a', kinds: ['node'] },
    { name: 'b', dir: 'b', kinds: ['go'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(envVar.detect(ctx));
  assert.ok(edges.some(e => e.meta?.key === 'KAFKA_BROKERS' && e.confidence === 'high'));
});

test('pubsub: kafka producer + consumer on same topic → edge', async () => {
  const root = tmp();
  write(path.join(root, 'backend', 'src', 'orders.ts'), 'await producer.send({ topic: "order.created", messages: [...] });\n');
  write(path.join(root, 'workers', 'handler.py'), 'consumer.subscribe(["order.created"])\n');
  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node'] },
    { name: 'workers', dir: 'workers', kinds: ['python'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(pubsub.detect(ctx));
  assert.ok(edges.some(e => e.from === 'backend' && e.to === 'workers' && e.kind === 'pubsub' && e.meta?.topic === 'order.created'));
});

test('pubsub: rabbit publish/consume same queue → edge', async () => {
  const root = tmp();
  write(path.join(root, 'producer', 'app.ts'), 'channel.publish("invoices.completed", buf);\n');
  write(path.join(root, 'consumer', 'app.ts'), 'channel.consume("invoices.completed", msg => {});\n');
  const projects = [
    { name: 'producer', dir: 'producer', kinds: ['node'] },
    { name: 'consumer', dir: 'consumer', kinds: ['node'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(pubsub.detect(ctx));
  assert.ok(edges.some(e => e.from === 'producer' && e.to === 'consumer' && e.meta?.topic === 'invoices.completed'));
});

test('db-shared: shared DATABASE_URL + same migration shape → high', async () => {
  const root = tmp();
  write(path.join(root, 'backend', '.env.example'), 'DATABASE_URL=postgres://...\n');
  fs.mkdirSync(path.join(root, 'backend', 'migrations'), { recursive: true });
  write(path.join(root, 'workers', '.env.example'), 'DATABASE_URL=postgres://...\n');
  fs.mkdirSync(path.join(root, 'workers', 'migrations'), { recursive: true });

  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node'] },
    { name: 'workers', dir: 'workers', kinds: ['python'] }
  ];
  const ctx = ctxFor(root, projects);
  await consume(envVar.detect(ctx)); // populate facts.envKeysByProject
  const edges = await consume(dbShared.detect(ctx));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].confidence, 'high');
  assert.equal(edges[0].meta?.envKey, 'DATABASE_URL');
});
