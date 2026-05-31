import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACK_PATH = path.resolve(here, '..', 'scripts', 'brain-pack.mjs');

const mod = await import(`file://${PACK_PATH}`);

test('buildAgentPreamble names the agent and includes the query', () => {
  const text = mod.buildAgentPreamble('claude', 'auth flow rework');
  assert.match(text, /# Agent Priming — claude/);
  assert.match(text, /"auth flow rework"/);
  assert.match(text, /Check active_state\.md first/);
  assert.match(text, /Search before grepping/);
});

test('buildAgentPreamble handles empty query', () => {
  const text = mod.buildAgentPreamble('cursor', '');
  assert.match(text, /no query/);
});

test('agentPrimerRank weighs decisions and edges highest', () => {
  const decision = { type: 'decision' };
  const edge = { type: 'cross-project-edge' };
  const modSummary = { isModuleSummary: true };
  const session = { type: 'session' };
  const body = { type: 'code' };

  assert.ok(mod.agentPrimerRank(decision) > mod.agentPrimerRank(edge));
  assert.ok(mod.agentPrimerRank(edge) > mod.agentPrimerRank(modSummary));
  assert.ok(mod.agentPrimerRank(modSummary) > mod.agentPrimerRank(session));
  assert.ok(mod.agentPrimerRank(session) > mod.agentPrimerRank(body));
});

test('prioritizeAgentPrimerRecords reorders by rank then by score', () => {
  const records = [
    { id: 'a', type: 'code', score: 0.9 },
    { id: 'b', type: 'decision', score: 0.5 },
    { id: 'c', type: 'cross-project-edge', score: 0.4 },
    { id: 'd', type: 'session', score: 0.6 },
    { id: 'e', type: 'decision', score: 0.7 }
  ];
  const sorted = mod.prioritizeAgentPrimerRecords(records);
  // Decisions (rank 5) come first, ordered by score descending
  assert.equal(sorted[0].id, 'e');
  assert.equal(sorted[1].id, 'b');
  // Then cross-project-edge (rank 4)
  assert.equal(sorted[2].id, 'c');
  // Then session (rank 2)
  assert.equal(sorted[3].id, 'd');
  // Then plain code (rank 0)
  assert.equal(sorted[4].id, 'a');
});
