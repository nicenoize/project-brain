import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProjects, projectKindsForDir, findProjectForFile, isFleetMode } from '../scripts/projects.mjs';

function tmpFleet() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fleet-test-'));
}

function mkProject(root, name, files) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('projectKindsForDir detects Node, Go, Python, Helm, Docker, proto', () => {
  const root = tmpFleet();
  mkProject(root, 'multi', {
    'package.json': '{}',
    'go.mod': 'module x',
    'pyproject.toml': '',
    'Chart.yaml': '',
    'Dockerfile': '',
    'svc.proto': ''
  });
  const kinds = projectKindsForDir(path.join(root, 'multi'));
  for (const k of ['node', 'go', 'python', 'helm', 'docker', 'proto']) {
    assert.ok(kinds.includes(k), `expected kind ${k}, got ${kinds}`);
  }
});

test('discoverProjects finds sibling projects with markers', () => {
  const root = tmpFleet();
  mkProject(root, 'backend', { 'package.json': '{"name":"@x/backend"}' });
  mkProject(root, 'workers', { 'go.mod': 'module workers' });
  mkProject(root, 'k8s', { 'Chart.yaml': '' });
  mkProject(root, 'docs', { 'README.md': '# docs' }); // no marker -> skip
  const projects = discoverProjects(root);
  assert.deepEqual(projects.map(p => p.name), ['backend', 'k8s', 'workers']);
  assert.ok(projects.find(p => p.name === 'backend').kinds.includes('node'));
  assert.ok(projects.find(p => p.name === 'workers').kinds.includes('go'));
  assert.ok(projects.find(p => p.name === 'k8s').kinds.includes('helm'));
});

test('discoverProjects detects .git and README presence', () => {
  const root = tmpFleet();
  mkProject(root, 'app', {
    'package.json': '{}',
    'README.md': '# app',
    '.git/HEAD': 'ref: refs/heads/main'
  });
  const projects = discoverProjects(root);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].git, true);
  assert.equal(projects[0].hasReadme, true);
});

test('discoverProjects: BRAIN_FLEET_PROJECTS whitelist', () => {
  const root = tmpFleet();
  mkProject(root, 'backend', { 'package.json': '{}' });
  mkProject(root, 'workers', { 'go.mod': 'module workers' });
  process.env.BRAIN_FLEET_PROJECTS = 'backend';
  try {
    const projects = discoverProjects(root);
    assert.deepEqual(projects.map(p => p.name), ['backend']);
  } finally {
    delete process.env.BRAIN_FLEET_PROJECTS;
  }
});

test('discoverProjects: BRAIN_FLEET_EXCLUDE blacklist', () => {
  const root = tmpFleet();
  mkProject(root, 'backend', { 'package.json': '{}' });
  mkProject(root, 'workers', { 'go.mod': 'module workers' });
  process.env.BRAIN_FLEET_EXCLUDE = 'workers';
  try {
    const projects = discoverProjects(root);
    assert.deepEqual(projects.map(p => p.name), ['backend']);
  } finally {
    delete process.env.BRAIN_FLEET_EXCLUDE;
  }
});

test('discoverProjects: BRAIN_FLEET_NESTED_DIRS descends into a container dir', () => {
  const root = tmpFleet();
  mkProject(root, 'backend', { 'go.mod': 'module backend' });
  // modules/ has no marker of its own -> invisible to the depth-1 scan.
  mkProject(root, 'modules/nmessenger', { 'go.mod': 'module x/nmessenger' });
  mkProject(root, 'modules/s3storage', { 'go.mod': 'module x/s3storage' });
  // default OFF: container stays invisible
  assert.deepEqual(discoverProjects(root).map(p => p.name), ['backend']);
  // opt-in via option
  const viaOpt = discoverProjects(root, { nested: 'modules' });
  assert.deepEqual(viaOpt.map(p => p.name), ['backend', 'nmessenger', 's3storage']);
  assert.equal(viaOpt.find(p => p.name === 'nmessenger').dir, 'modules/nmessenger');
  // opt-in via env
  process.env.BRAIN_FLEET_NESTED_DIRS = 'modules';
  try {
    assert.deepEqual(discoverProjects(root).map(p => p.name), ['backend', 'nmessenger', 's3storage']);
  } finally {
    delete process.env.BRAIN_FLEET_NESTED_DIRS;
  }
});

test('discoverProjects skips node_modules, skills, .git, hidden dirs', () => {
  const root = tmpFleet();
  mkProject(root, 'node_modules', { 'package.json': '{}' });
  mkProject(root, 'skills', { 'package.json': '{}' });
  mkProject(root, '.cache', { 'package.json': '{}' });
  mkProject(root, 'real', { 'package.json': '{}' });
  const projects = discoverProjects(root);
  assert.deepEqual(projects.map(p => p.name), ['real']);
});

test('discoverProjects returns [] when root has no subdirs', () => {
  const root = tmpFleet();
  assert.deepEqual(discoverProjects(root), []);
});

test('discoverProjects returns [] when no subdir has markers', () => {
  const root = tmpFleet();
  mkProject(root, 'just-docs', { 'README.md': '#' });
  assert.deepEqual(discoverProjects(root), []);
});

test('findProjectForFile longest-prefix match', () => {
  const projects = [
    { name: 'backend', dir: 'backend', kinds: ['node'] },
    { name: 'backend-shared', dir: 'backend-shared', kinds: ['node'] }
  ];
  assert.equal(findProjectForFile('backend/src/a.ts', projects)?.name, 'backend');
  assert.equal(findProjectForFile('backend-shared/lib/b.ts', projects)?.name, 'backend-shared');
  assert.equal(findProjectForFile('other/x', projects), null);
});

test('isFleetMode: 0/1 override, otherwise >=2 threshold', () => {
  process.env.BRAIN_FLEET_MODE = '0';
  assert.equal(isFleetMode([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), false);
  process.env.BRAIN_FLEET_MODE = '1';
  assert.equal(isFleetMode([]), true);
  delete process.env.BRAIN_FLEET_MODE;
  assert.equal(isFleetMode([{ name: 'a' }]), false);
  assert.equal(isFleetMode([{ name: 'a' }, { name: 'b' }]), true);
});
