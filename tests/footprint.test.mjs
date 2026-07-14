import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  estimateTokens,
  measureFile,
  footprintWarnings,
  FOOTPRINT_THRESHOLDS
} from '../scripts/footprint.mjs';

// ---------------------------------------------------------------------------
// estimateTokens — the len/4 heuristic
// ---------------------------------------------------------------------------

test('estimateTokens: rounds bytes/4, guards non-numbers', () => {
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(4002), 1001); // rounds
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-5), 0);
  assert.equal(estimateTokens('nope'), 0);
  assert.equal(estimateTokens(undefined), 0);
});

// ---------------------------------------------------------------------------
// measureFile — byte size + token estimate, missing → exists:false
// ---------------------------------------------------------------------------

test('measureFile: measures an existing file, flags a missing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fp-'));
  const abs = path.join(dir, 'skill.md');
  fs.writeFileSync(abs, 'x'.repeat(4000));
  const m = measureFile(abs, 'skill.md');
  assert.equal(m.exists, true);
  assert.equal(m.bytes, 4000);
  assert.equal(m.tokens, 1000);

  const missing = measureFile(path.join(dir, 'nope.md'), 'nope.md');
  assert.deepEqual(missing, { file: 'nope.md', exists: false, bytes: 0, tokens: 0 });
});

// ---------------------------------------------------------------------------
// footprintWarnings — pure threshold evaluation
// ---------------------------------------------------------------------------

test('footprintWarnings: silent when everything is under threshold', () => {
  const fp = {
    skills: [{ file: 'SKILL.md', exists: true, bytes: 8000, tokens: 2000 }],
    activeState: { file: '.project-brain/active_state.md', exists: true, bytes: 400, tokens: 100 },
    hooks: [{ event: 'sessionstart', bytes: 0, tokens: 0 }]
  };
  assert.deepEqual(footprintWarnings(fp), []);
});

test('footprintWarnings: warns on a fat SKILL.md, a fat active_state, and a fat hook', () => {
  const fp = {
    skills: [{ file: 'SKILL.md', exists: true, bytes: 64531, tokens: 16133 }],
    // the real-consumer case: ~7.5k tokens cat'd raw on SessionStart (#21)
    activeState: { file: '.project-brain/active_state.md', exists: true, bytes: 30220, tokens: 7555 },
    hooks: [{ event: 'userpromptsubmit', bytes: 4000, tokens: 1000 }]
  };
  const w = footprintWarnings(fp);
  assert.equal(w.length, 3);
  assert.ok(w.some((m) => m.includes('SKILL.md') && m.includes('4000 warn')));
  assert.ok(w.some((m) => m.includes('active_state.md') && m.includes('600 warn')));
  assert.ok(w.some((m) => m.includes('userpromptsubmit') && m.includes('500 warn')));
});

test('footprintWarnings: a missing SKILL/active_state never warns', () => {
  const fp = {
    skills: [{ file: 'SKILL.md', exists: false, bytes: 0, tokens: 0 }],
    activeState: { file: '.project-brain/active_state.md', exists: false, bytes: 0, tokens: 0 },
    hooks: []
  };
  assert.deepEqual(footprintWarnings(fp), []);
});

test('FOOTPRINT_THRESHOLDS: documents the agreed warn budgets', () => {
  assert.equal(FOOTPRINT_THRESHOLDS.skillTokens, 4000);
  assert.equal(FOOTPRINT_THRESHOLDS.activeStateTokens, 600);
  assert.equal(FOOTPRINT_THRESHOLDS.hookTokens, 500);
});
