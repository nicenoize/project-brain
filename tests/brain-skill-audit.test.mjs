import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseOutput, detectSkillspector, severityToScore } from '../scripts/skillspector.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_SCRIPT = path.resolve(here, '..', 'scripts', 'brain-skill-audit.mjs');

// ---------------------------------------------------------------------------
// Unit: pure parsing / detection
// ---------------------------------------------------------------------------

test('parseOutput extracts score/severity/recommendation from JSON', () => {
  const r = parseOutput(JSON.stringify({ risk_score: 80, severity: 'high', recommendation: 'do not install' }));
  assert.equal(r.score, 80);
  assert.equal(r.severity, 'HIGH');
  assert.equal(r.recommendation, 'do not install');
});

test('parseOutput scrapes a score and severity from non-JSON text', () => {
  const r = parseOutput('Risk score: 22\nSeverity: LOW\n');
  assert.equal(r.score, 22);
  assert.equal(r.severity, 'LOW');
});

test('parseOutput derives a score from severity when none is given', () => {
  const r = parseOutput(JSON.stringify({ severity: 'CRITICAL' }));
  assert.equal(r.score, severityToScore('CRITICAL'));
  assert.equal(r.severity, 'CRITICAL');
});

test('detectSkillspector honors BRAIN_SKILLSPECTOR_BIN without touching PATH', () => {
  assert.deepEqual(detectSkillspector({ BRAIN_SKILLSPECTOR_BIN: '/usr/local/bin/skillspector' }),
    { mode: 'cli', bin: '/usr/local/bin/skillspector' });
});

// ---------------------------------------------------------------------------
// Integration: fake scanner binary (deterministic, no real skillspector needed)
// ---------------------------------------------------------------------------

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-skillaudit-'));
  fs.mkdirSync(path.join(cwd, '.project-brain'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'myskill'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'myskill', 'SKILL.md'), '# a skill\n');
  return cwd;
}

function writeFakeScanner(cwd, json) {
  const p = path.join(cwd, 'fake-skillspector');
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${json}\nEOF\n`, { mode: 0o755 });
  return p;
}

function runAudit(cwd, args, env = {}) {
  return spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }
  });
}

test('passes (exit 0) when the scanner reports low risk', () => {
  const cwd = makeRepo();
  const bin = writeFakeScanner(cwd, JSON.stringify({ risk_score: 10, severity: 'LOW' }));
  const r = runAudit(cwd, ['myskill', '--json', '--no-cache'], { BRAIN_SKILLSPECTOR_BIN: bin });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.score, 10);
  assert.equal(out.severity, 'LOW');
});

test('blocks (exit 1) when risk exceeds the threshold', () => {
  const cwd = makeRepo();
  const bin = writeFakeScanner(cwd, JSON.stringify({ risk_score: 80, severity: 'HIGH', recommendation: 'no' }));
  const r = runAudit(cwd, ['myskill', '--max-risk', '40', '--no-cache'], { BRAIN_SKILLSPECTOR_BIN: bin });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /risk 80 > max 40/);
});

test('skips gracefully (exit 0) when the scanner is absent', () => {
  const cwd = makeRepo();
  // Point at a non-existent binary so spawn fails deterministically → skip, not error.
  const r = runAudit(cwd, ['myskill'], { BRAIN_SKILLSPECTOR_BIN: path.join(cwd, 'nope', 'skillspector') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipped/);
});
