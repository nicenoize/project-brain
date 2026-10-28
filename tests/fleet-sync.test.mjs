import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const scripts = path.resolve('scripts');

function fleet() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sync-'));
  for (const [name, marker] of [['alpha', 'package.json'], ['beta', 'go.mod']]) {
    fs.mkdirSync(path.join(root, name, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, name, marker), '{}');
    fs.writeFileSync(path.join(root, name, 'docs', 'a.md'), `# ${name}\n\nwidgets\n`);
  }
  fs.mkdirSync(path.join(root, '.project-brain'));
  fs.writeFileSync(path.join(root, 'README.md'), '# fleet\n');
  return root;
}

const run = (root, script, args = [], env = {}) => spawnSync(process.execPath, [path.join(scripts, script), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, BRAIN_EMBED_PROVIDER: 'none', BRAIN_QUIET: '1', BRAIN_ROOT: root, ...env }
});

test('a freshly indexed fleet is up to date for brain-sync (it lists the same files as the indexer)', () => {
  const root = fleet();
  assert.equal(run(root, 'brain-index.mjs').status, 0);
  const out = run(root, 'brain-sync.mjs', ['--no-block']).stdout;
  assert.match(out, /index is up to date/, out);
});

test('brain-sync leaves a rebuild to the foreground: model change or too many files', () => {
  const root = fleet();
  run(root, 'brain-index.mjs');
  fs.appendFileSync(path.join(root, 'alpha', 'docs', 'a.md'), 'more\n');
  const big = run(root, 'brain-sync.mjs', ['--no-block'], { BRAIN_SYNC_BG_MAX_FILES: '0' });
  assert.match(big.stdout, /not in the background — 1 files changed/);
  const manifest = path.join(root, '.project-brain', 'index_manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), model: 'Xenova/all-MiniLM-L6-v2' }));
  fs.appendFileSync(path.join(root, 'alpha', 'docs', 'a.md'), 'again\n');
  const model = run(root, 'brain-sync.mjs', ['--no-block']);
  assert.match(model.stdout, /embedding model changed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.project-brain', '.sync-state.json'), 'utf8')).action, 'skip');
});
