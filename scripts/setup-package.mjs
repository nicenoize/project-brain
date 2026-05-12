import fs from 'node:fs';
import { read, write, mergePackageScripts, mergePackageDeps } from './common.mjs';

const packagePath = 'package.json';
let pkg = {};
if (fs.existsSync(packagePath)) {
  pkg = JSON.parse(read(packagePath));
} else {
  pkg = { private: true, type: 'module', scripts: {} };
}
pkg = mergePackageScripts(mergePackageDeps(pkg));
write(packagePath, JSON.stringify(pkg, null, 2) + '\n');

let ignore = read('.gitignore', '');
const entries = ['.project-brain/vector-db/', '.project-brain/index_manifest.json', '.project-brain/search_index.json', '.worktrees/'];
for (const entry of entries) {
  if (!ignore.includes(entry)) ignore += `${ignore.endsWith('\n') || ignore === '' ? '' : '\n'}${entry}\n`;
}
write('.gitignore', ignore);

if (!fs.existsSync('.github/PULL_REQUEST_TEMPLATE.md')) {
  fs.mkdirSync('.github', { recursive: true });
  fs.copyFileSync('skills/project-brain/templates/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE.md');
}

if (!fs.existsSync('.github/workflows/project-brain.yml')) {
  fs.mkdirSync('.github/workflows', { recursive: true });
  fs.copyFileSync('skills/project-brain/templates/github-workflows/project-brain.yml', '.github/workflows/project-brain.yml');
}

console.log('Updated package.json, .gitignore, PR template, and GitHub workflow.');

const { spawnSync } = await import('node:child_process');
const hookInstaller = fs.existsSync('skills/project-brain/scripts/install-cursor-hooks.mjs')
  ? 'skills/project-brain/scripts/install-cursor-hooks.mjs'
  : fs.existsSync('scripts/install-cursor-hooks.mjs')
    ? 'scripts/install-cursor-hooks.mjs'
    : '';
if (hookInstaller) {
  const r = spawnSync(process.execPath, [hookInstaller], { stdio: 'inherit', cwd: process.cwd() });
  if (r.status) console.warn('install-cursor-hooks exited', r.status);
}
