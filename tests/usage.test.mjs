import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  usageCmdFromScript,
  buildUsageRecord,
  parseUsageLog,
  commandUniverseFromPackageScripts,
  summarizeUsage
} from '../scripts/usage.mjs';
import { appendUsageRecord } from '../scripts/common.mjs';

// ---------------------------------------------------------------------------
// usageCmdFromScript — derive the command name from a script path
// ---------------------------------------------------------------------------

test('usageCmdFromScript: strips brain- prefix and .mjs, lowercases', () => {
  assert.equal(usageCmdFromScript('/a/b/scripts/brain-search.mjs'), 'search');
  assert.equal(usageCmdFromScript('brain-session-digest.mjs'), 'session-digest');
  assert.equal(usageCmdFromScript('/x/Brain-Health.MJS'), 'health');
});

test('usageCmdFromScript: returns "" for non-brain / worker / test entry points', () => {
  assert.equal(usageCmdFromScript(''), '');
  assert.equal(usageCmdFromScript(undefined), '');
  assert.equal(usageCmdFromScript('/x/embed.mjs'), '');
  assert.equal(usageCmdFromScript('/x/aggregate.mjs'), '');
  assert.equal(usageCmdFromScript('/x/node_modules/.bin/mocha'), '');
});

// ---------------------------------------------------------------------------
// buildUsageRecord — coercion + defaults
// ---------------------------------------------------------------------------

test('buildUsageRecord: keeps the five documented fields', () => {
  const rec = buildUsageRecord({ cmd: 'search', ts: '2026-07-10T00:00:00.000Z', exitCode: 0, stdoutBytes: 120, durationMs: 42 });
  assert.deepEqual(rec, {
    cmd: 'search',
    ts: '2026-07-10T00:00:00.000Z',
    exitCode: 0,
    stdoutBytes: 120,
    durationMs: 42
  });
});

test('buildUsageRecord: coerces/defaults bad inputs, never negative', () => {
  const rec = buildUsageRecord({ cmd: 'x', exitCode: '1', stdoutBytes: -5, durationMs: 3.7 });
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.stdoutBytes, 0);
  assert.equal(rec.durationMs, 4); // rounded
  assert.equal(typeof rec.ts, 'string');
  assert.ok(rec.ts.length > 0);
});

test('buildUsageRecord: empty/undefined arg yields a safe record', () => {
  const rec = buildUsageRecord();
  assert.equal(rec.cmd, '');
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.stdoutBytes, 0);
  assert.equal(rec.durationMs, 0);
});

// ---------------------------------------------------------------------------
// parseUsageLog — tolerant JSONL parse
// ---------------------------------------------------------------------------

test('parseUsageLog: skips blank and malformed lines, keeps valid records', () => {
  const blob = [
    '{"cmd":"search","ts":"2026-07-10T00:00:00.000Z","exitCode":0}',
    '',
    'not json',
    '{"no_cmd":true}',
    '{"cmd":"health","ts":"2026-07-10T01:00:00.000Z","exitCode":1}'
  ].join('\n');
  const recs = parseUsageLog(blob);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.cmd), ['search', 'health']);
});

test('parseUsageLog: empty/undefined input yields []', () => {
  assert.deepEqual(parseUsageLog(''), []);
  assert.deepEqual(parseUsageLog(undefined), []);
});

// ---------------------------------------------------------------------------
// commandUniverseFromPackageScripts — deduped, sorted, aliases collapse
// ---------------------------------------------------------------------------

test('commandUniverseFromPackageScripts: extracts brain-*.mjs, dedupes aliases, sorts', () => {
  const scripts = {
    'brain:search': 'node skills/project-brain/scripts/brain-search.mjs',
    'brain:symbol': 'node skills/project-brain/scripts/brain-search.mjs --type code --symbol',
    'brain:health': 'node scripts/brain-health.mjs',
    'test': 'node --test',
    'lint': 'eslint .'
  };
  assert.deepEqual(commandUniverseFromPackageScripts(scripts), ['health', 'search']);
});

test('commandUniverseFromPackageScripts: empty/undefined yields []', () => {
  assert.deepEqual(commandUniverseFromPackageScripts(), []);
  assert.deepEqual(commandUniverseFromPackageScripts({}), []);
});

// ---------------------------------------------------------------------------
// summarizeUsage — window filtering, per-command aggregation, never-used
// ---------------------------------------------------------------------------

test('summarizeUsage: aggregates counts, errors, avgs; sorts by count desc', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z');
  const records = [
    { cmd: 'search', ts: '2026-07-10T00:00:00.000Z', exitCode: 0, stdoutBytes: 100, durationMs: 10 },
    { cmd: 'search', ts: '2026-07-09T00:00:00.000Z', exitCode: 1, stdoutBytes: 300, durationMs: 30 },
    { cmd: 'health', ts: '2026-07-08T00:00:00.000Z', exitCode: 0, stdoutBytes: 50, durationMs: 5 }
  ];
  const s = summarizeUsage(records, { now, windowDays: 30, commands: ['search', 'health', 'ask'] });
  assert.equal(s.totalInWindow, 3);
  assert.equal(s.totalAllTime, 3);
  assert.equal(s.perCommand[0].cmd, 'search');
  assert.equal(s.perCommand[0].count, 2);
  assert.equal(s.perCommand[0].errors, 1);
  assert.equal(s.perCommand[0].avgStdoutBytes, 200);
  assert.equal(s.perCommand[0].avgDurationMs, 20);
  assert.deepEqual(s.neverUsed, ['ask']);
  assert.equal(s.universeSize, 3);
});

test('summarizeUsage: excludes records older than the window', () => {
  const now = Date.parse('2026-07-10T00:00:00.000Z');
  const records = [
    { cmd: 'search', ts: '2026-07-01T00:00:00.000Z', exitCode: 0 }, // in window
    { cmd: 'old', ts: '2026-05-01T00:00:00.000Z', exitCode: 0 } // >30d out
  ];
  const s = summarizeUsage(records, { now, windowDays: 30, commands: ['search', 'old'] });
  assert.equal(s.totalInWindow, 1);
  assert.equal(s.totalAllTime, 2);
  assert.deepEqual(s.perCommand.map((c) => c.cmd), ['search']);
  assert.deepEqual(s.neverUsed, ['old']); // out-of-window counts as never-used-in-window
});

test('summarizeUsage: undated records count as in-window (never hide usage)', () => {
  const s = summarizeUsage([{ cmd: 'search' }], { commands: ['search'] });
  assert.equal(s.totalInWindow, 1);
  assert.deepEqual(s.neverUsed, []);
});

test('summarizeUsage: empty records → all commands never-used', () => {
  const s = summarizeUsage([], { commands: ['search', 'health'] });
  assert.equal(s.totalInWindow, 0);
  assert.deepEqual(s.neverUsed, ['health', 'search']);
});

// ---------------------------------------------------------------------------
// appendUsageRecord (common.mjs) — append-only, fail-silent, sidecar
// ---------------------------------------------------------------------------

test('appendUsageRecord: appends one JSONL line per call, round-trips via parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-usage-'));
  const log = path.join(dir, '.usage.jsonl');
  try {
    assert.equal(appendUsageRecord(buildUsageRecord({ cmd: 'search', exitCode: 0 }), log), true);
    assert.equal(appendUsageRecord(buildUsageRecord({ cmd: 'health', exitCode: 1 }), log), true);
    const recs = parseUsageLog(fs.readFileSync(log, 'utf8'));
    assert.equal(recs.length, 2);
    assert.deepEqual(recs.map((r) => r.cmd), ['search', 'health']);
    // one line per record, trailing newline
    assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendUsageRecord: fail-silent on an unwritable path (returns false, no throw)', () => {
  const bad = path.join(os.tmpdir(), 'brain-usage-nope', 'x', 'y');
  // Point at a path whose parent is a file, so mkdir/append cannot succeed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-usage-'));
  const asFile = path.join(dir, 'afile');
  fs.writeFileSync(asFile, 'x');
  try {
    const ok = appendUsageRecord(buildUsageRecord({ cmd: 'search' }), path.join(asFile, 'child.jsonl'));
    assert.equal(ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  void bad;
});
