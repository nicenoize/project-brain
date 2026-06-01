import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import k8sEnvInjection from '../../scripts/edges/k8s-env-injection.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-k8senv-test-')); }
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

test('k8s-env-injection: Go EnvVar injector → os.Getenv reader, directed', async () => {
  const root = tmp();
  write(path.join(root, 'operator', 'deploy.go'), [
    'package deploy',
    'func build() []corev1.EnvVar {',
    '  return []corev1.EnvVar{',
    '    {Name: "DEEPGRAM_API_KEY", Value: cfg.Key},',
    '    {Name: "SOURCE_LANGUAGE", Value: lang},',
    '    {Name: "TARGET_LANGUAGES", Value: tgt},',
    '    {Name: "KEYTERMS", Value: kt},',
    '  }',
    '}'
  ].join('\n'));
  write(path.join(root, 'provider', 'main.go'), [
    'package main',
    'func main() {',
    '  k := os.Getenv("DEEPGRAM_API_KEY")',
    '  l := os.Getenv("SOURCE_LANGUAGE")',
    '  t := os.Getenv("TARGET_LANGUAGES")',
    '  kt := os.Getenv("KEYTERMS")',
    '}'
  ].join('\n'));
  const projects = [
    { name: 'operator', dir: 'operator', kinds: ['go'] },
    { name: 'provider', dir: 'provider', kinds: ['go'] }
  ];
  const edges = await consume(k8sEnvInjection.detect(ctxFor(root, projects)));
  assert.equal(edges.length, 1);
  const e = edges[0];
  assert.equal(e.from, 'operator');           // directed: injector → reader
  assert.equal(e.to, 'provider');
  assert.equal(e.kind, 'k8s-env-injection');
  assert.equal(e.confidence, 'high');          // 4 shared keys
  assert.equal(e.meta.count, 4);
  assert.ok(e.evidence.some(ev => ev.startsWith('operator/')));  // both ends cited
  assert.ok(e.evidence.some(ev => ev.startsWith('provider/')));
});

test('k8s-env-injection: Helm env: block injector is detected', async () => {
  const root = tmp();
  write(path.join(root, 'chart', 'templates', 'deploy.yaml'), [
    'spec:',
    '  containers:',
    '    - name: app',
    '      env:',
    '        - name: API_HOST',
    '          value: x',
    '        - name: API_TOKEN',
    '          value: y',
    '  other: stuff'
  ].join('\n'));
  write(path.join(root, 'svc', 'app.go'), 'h := os.Getenv("API_HOST")\nt := os.Getenv("API_TOKEN")');
  const projects = [
    { name: 'chart', dir: 'chart', kinds: ['helm'] },
    { name: 'svc', dir: 'svc', kinds: ['go'] }
  ];
  const edges = await consume(k8sEnvInjection.detect(ctxFor(root, projects)));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'chart');
  assert.equal(edges[0].to, 'svc');
  assert.equal(edges[0].confidence, 'medium');  // 2 shared keys
});

test('k8s-env-injection: viper mapstructure + env struct tags count as reads', async () => {
  const root = tmp();
  write(path.join(root, 'operator', 'deploy.go'), [
    'x := []corev1.EnvVar{',
    '  {Name: "SOURCE_LANGUAGE"}, {Name: "TARGET_LANGUAGES"}, {Name: "CHANNEL_NAME"}, {Name: "KEYTERMS"},',
    '}'
  ].join('\n'));
  // Provider reads config via viper struct tags, not literal os.Getenv.
  write(path.join(root, 'provider', 'config.go'), [
    'type Config struct {',
    '  SourceLanguage  string `mapstructure:"source_language"`',
    '  TargetLanguages string `mapstructure:"target_languages"`',
    '  ChannelName     string `env:"CHANNEL_NAME"`',
    '  Keyterms        string `mapstructure:"keyterms"`',
    '}'
  ].join('\n'));
  const projects = [
    { name: 'operator', dir: 'operator', kinds: ['go'] },
    { name: 'provider', dir: 'provider', kinds: ['go'] }
  ];
  const edges = await consume(k8sEnvInjection.detect(ctxFor(root, projects)));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'operator');
  assert.equal(edges[0].to, 'provider');
  assert.equal(edges[0].confidence, 'high');   // 4 keys via tags
  assert.equal(edges[0].meta.count, 4);
});

test('k8s-env-injection: no edge when reader does not read injected keys', async () => {
  const root = tmp();
  write(path.join(root, 'operator', 'deploy.go'), 'x := corev1.EnvVar{Name: "ONLY_INJECTED"}');
  write(path.join(root, 'provider', 'main.go'), 'y := os.Getenv("SOMETHING_ELSE")');
  const projects = [
    { name: 'operator', dir: 'operator', kinds: ['go'] },
    { name: 'provider', dir: 'provider', kinds: ['go'] }
  ];
  const edges = await consume(k8sEnvInjection.detect(ctxFor(root, projects)));
  assert.equal(edges.length, 0);
});

test('k8s-env-injection: Name: literals outside EnvVar files are ignored', async () => {
  const root = tmp();
  // No "EnvVar" token in this file → Name: literal must not count as injection.
  write(path.join(root, 'operator', 'model.go'), 'type T struct{}\nv := Thing{Name: "NOT_AN_ENV"}');
  write(path.join(root, 'provider', 'main.go'), 'y := os.Getenv("NOT_AN_ENV")');
  const projects = [
    { name: 'operator', dir: 'operator', kinds: ['go'] },
    { name: 'provider', dir: 'provider', kinds: ['go'] }
  ];
  const edges = await consume(k8sEnvInjection.detect(ctxFor(root, projects)));
  assert.equal(edges.length, 0);
});
