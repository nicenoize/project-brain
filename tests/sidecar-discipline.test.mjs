import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanSidecarViolations,
  SIDECAR_RECORDER_ALLOWLIST,
  RECORD_DIRS,
} from '../scripts/brain-lint-conventions.mjs';

const SCRIPTS_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'scripts');

test('flags a write to decisions/ via a path variable from outside a recorder', () => {
  const content = `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');
const dest = path.join(DECISIONS_DIR, '0001-foo.md');
writeFileSync(dest, body);
`;
  const v = scanSidecarViolations([{ path: 'scripts/rogue.mjs', content }]);
  assert.equal(v.length, 1);
  assert.match(v[0].snippet, /writeFileSync\(dest/);
});

test('flags a write to a findings/ path literal', () => {
  const content = `write(\`findings/\${slug}.md\`, doc);`;
  const v = scanSidecarViolations([{ path: 'scripts/rogue.mjs', content }]);
  assert.equal(v.length, 1);
});

test('does not flag a read of decisions/ (no write API)', () => {
  const content = `
const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');
const files = fs.readdirSync(DECISIONS_DIR);
for (const f of files) console.log(read(path.join(DECISIONS_DIR, f)));
`;
  assert.equal(scanSidecarViolations([{ path: 'scripts/reader.mjs', content }]).length, 0);
});

test('does not flag a sidecar write beside a record', () => {
  const content = `
const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');
const recordPath = path.join(DECISIONS_DIR, slug + '.md');   // read only
const sidecar = recordPath.replace(/\\.md$/, '.reflect.json');
writeFileSync(sidecar, JSON.stringify(overlay));
`;
  // The write targets `sidecar`, which is derived by string transform and is
  // not itself a tracked record-path variable — so it must not be flagged.
  assert.equal(scanSidecarViolations([{ path: 'scripts/reflect.mjs', content }]).length, 0);
});

test('does not flag a write to an unrelated folder that also reads decisions/', () => {
  const content = `
const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');
const recent = fs.readdirSync(DECISIONS_DIR);
const outPath = path.join(BRAIN_DIR, 'brief.md');
write(outPath, render(recent));
`;
  assert.equal(scanSidecarViolations([{ path: 'scripts/brief.mjs', content }]).length, 0);
});

test('does not flag property access that shares a record-var name (p.dir)', () => {
  const content = `
const dir = path.join(BRAIN_DIR, 'decisions');
const projRoot = p.dir === '.' ? ROOT : path.join(ROOT, p.dir);
const outPath = path.join(projRoot, 'HANDOFF.md');
write(outPath, doc);
`;
  assert.equal(scanSidecarViolations([{ path: 'scripts/handoff.mjs', content }]).length, 0);
});

test('allowlisted recorders are exempt', () => {
  const content = `
const DECISIONS_DIR = path.join(BRAIN_DIR, 'decisions');
const dest = path.join(DECISIONS_DIR, '0001-foo.md');
writeFileSync(dest, body);
`;
  const recorder = SIDECAR_RECORDER_ALLOWLIST[0];
  assert.equal(scanSidecarViolations([{ path: `scripts/${recorder}`, content }]).length, 0);
});

test('RECORD_DIRS covers decisions and findings', () => {
  assert.ok(RECORD_DIRS.includes('decisions'));
  assert.ok(RECORD_DIRS.includes('findings'));
});

test('the actual scripts/ tree is sidecar-clean (no false positives)', () => {
  const files = [];
  for (const name of fs.readdirSync(SCRIPTS_DIR)) {
    if (!name.endsWith('.mjs')) continue;
    files.push({ path: `scripts/${name}`, content: fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8') });
  }
  const v = scanSidecarViolations(files);
  assert.deepEqual(v, [], `expected no violations, got: ${JSON.stringify(v, null, 2)}`);
});
