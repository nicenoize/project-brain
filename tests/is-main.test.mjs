import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../scripts/is-main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(here, '..', 'scripts');

test('isMainModule: equal through a symlink, false for another file or no argv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ismain-'));
  const target = path.join(dir, 'real.mjs');
  fs.writeFileSync(target, '');
  const link = path.join(dir, 'link.mjs');
  fs.symlinkSync(target, link);
  const url = pathToFileURL(target).href;
  assert.equal(isMainModule(url, target), true);
  assert.equal(isMainModule(url, link), true, 'argv[1] through a symlink is still this module');
  assert.equal(isMainModule(url, path.join(dir, 'other.mjs')), false);
  assert.equal(isMainModule(url, undefined), false, 'imported under a test runner / REPL');
});

// The field failure: a consumer vendors the skill as skills/project-brain → checkout,
// and every hook invoked through that path silently printed nothing.
test('scripts invoked through a symlinked directory actually run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-symlinked-'));
  const link = path.join(dir, 'scripts');
  fs.symlinkSync(SCRIPTS, link, 'dir');
  const r = spawnSync(process.execPath, [path.join(link, 'brain-outline.mjs'), path.join(SCRIPTS, 'is-main.mjs')], {
    encoding: 'utf8', env: { ...process.env, BRAIN_USAGE_LOG: '0' }
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /isMainModule/, 'the CLI ran and printed the outline');
});

test('no script compares argv[1] as a string any more', () => {
  const offenders = fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs') && f !== 'is-main.mjs' && f !== 'usage.mjs')
    .filter((f) => /(path\.resolve\(process\.argv\[1\]\)|=== process\.argv\[1\]|file:\/\/\$\{process\.argv\[1\]\})/
      .test(fs.readFileSync(path.join(SCRIPTS, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use isMainModule(import.meta.url) from is-main.mjs');
});
