import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import protoSchema from '../../scripts/edges/proto-schema.mjs';
import grpcClient from '../../scripts/edges/grpc-client.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-grpc-test-')); }
function write(p, c) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
async function consume(it) { const a = []; for await (const v of it) a.push(v); return a; }
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

test('proto-schema: cross-project import emits high-confidence edge', async () => {
  const root = tmp();
  write(path.join(root, 'shared-schemas', 'auth.proto'), 'syntax = "proto3";\nservice Auth { rpc Login(LoginRequest) returns (LoginReply); }\n');
  write(path.join(root, 'backend', 'service.proto'), 'syntax = "proto3";\nimport "auth.proto";\nservice Backend { rpc Whoami(Empty) returns (User); }\n');

  const projects = [
    { name: 'shared-schemas', dir: 'shared-schemas', kinds: ['proto'] },
    { name: 'backend', dir: 'backend', kinds: ['proto'] }
  ];
  const ctx = ctxFor(root, projects);
  const edges = await consume(protoSchema.detect(ctx));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'backend');
  assert.equal(edges[0].to, 'shared-schemas');
  assert.equal(edges[0].kind, 'proto-schema');
  assert.equal(edges[0].confidence, 'high');

  const services = ctx.facts.get('grpcServices');
  assert.equal(services.get('Auth'), 'shared-schemas');
  assert.equal(services.get('Backend'), 'backend');
});

test('grpc-client: TS new XxxClient() resolves against grpcServices', async () => {
  const root = tmp();
  write(path.join(root, 'shared-schemas', 'auth.proto'), 'syntax = "proto3";\nservice AuthService { rpc Ping(Empty) returns (Empty); }\n');
  write(path.join(root, 'frontend', 'src', 'app.ts'), [
    'import { AuthServiceClient } from "./gen/auth";',
    'const client = new AuthServiceClient("https://auth.svc");',
    'client.ping({});'
  ].join('\n'));
  write(path.join(root, 'frontend', 'package.json'), '{"name":"frontend"}');

  const projects = [
    { name: 'shared-schemas', dir: 'shared-schemas', kinds: ['proto'] },
    { name: 'frontend', dir: 'frontend', kinds: ['node'] }
  ];
  const ctx = ctxFor(root, projects);
  await consume(protoSchema.detect(ctx)); // populates grpcServices
  const edges = await consume(grpcClient.detect(ctx));

  assert.ok(edges.some(e => e.from === 'frontend' && e.to === 'shared-schemas' && e.kind === 'grpc-call'));
});
