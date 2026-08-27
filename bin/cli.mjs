#!/usr/bin/env node
/**
 * project-brain CLI dispatcher (ADR 0028, docs/strategy-agent-ops.md).
 *
 * Maps public verbs (`project-brain status`, `project-brain guard`, …) onto the
 * existing scripts/brain-*.mjs commands, plus an `x <script>` escape hatch for
 * every other script. Command scripts execute argv at module top level, so we
 * never import them — each verb re-spawns node on the target script with
 * stdio inherited and the exit code propagated. Script paths resolve relative
 * to this file (import.meta.url), which works for npm install, npm link, and
 * the symlinked-skill checkout alike.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// Public verb → script. `doctor` → brain-repair is provisional (final naming
// pending the rename decision in ADR 0028).
const VERBS = {
  init: { script: 'brain-init.mjs', desc: 'Set up the brain in this repo (dirs, seed docs, first index)' },
  status: { script: 'brain-health.mjs', desc: 'Health check: index freshness, settings drift, footprint' },
  lease: { script: 'brain-lease.mjs', desc: 'Claim/release work leases for parallel agents' },
  work: { script: 'brain-work.mjs', desc: 'Start/finish a unit of work against the active state' },
  brief: { script: 'brain-brief.mjs', desc: 'Generate a task brief from the brain' },
  grill: { script: 'brain-grill.mjs', desc: 'Adversarial pre-implementation review of a plan' },
  handoff: { script: 'brain-handoff.mjs', desc: 'Write a session handoff for the next agent' },
  guard: { script: 'brain-guard.mjs', desc: 'Pre-commit/CI guard: branch policy, link-check, security gates' },
  doctor: { script: 'brain-repair.mjs', desc: 'Diagnose and repair a broken brain (index/store recovery)' },
  search: { script: 'brain-search.mjs', desc: 'Semantic + keyword search over the indexed repo' },
  ask: { script: 'brain-ask.mjs', desc: 'Ask a question, get retrieved context' },
  serve: { script: 'brain-serve.mjs', desc: 'Local Control Room: state, leases, intel — 127.0.0.1 only' }
};
const ADVANCED_VERBS = {
  mcp: { script: 'brain-mcp.mjs', desc: 'MCP server over stdio for any agent host (--print-config to install)' },
  orchestrate: { script: 'brain-orchestrate.mjs', desc: 'Multi-agent orchestration (advanced)' },
  migrate: { script: 'brain-migrate.mjs', desc: 'Convert a symlink/skill-mode install to CLI mode' }
};

function listScripts() {
  try {
    return fs.readdirSync(SCRIPTS_DIR)
      .filter((f) => f.startsWith('brain-') && f.endsWith('.mjs'))
      .map((f) => f.slice('brain-'.length, -'.mjs'.length))
      .sort();
  } catch {
    return [];
  }
}

function run(scriptFile, args) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptFile);
  if (!fs.existsSync(scriptPath)) {
    process.stderr.write(`project-brain: script not found: ${scriptPath}\n`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: { ...process.env, BRAIN_INVOKED_VIA: 'cli' }
  });
  if (r.error) {
    process.stderr.write(`project-brain: failed to spawn ${scriptFile}: ${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  const pad = (s) => s.padEnd(11);
  const lines = [
    'project-brain — local semantic project brain for agent workflows',
    '',
    'Usage: project-brain <verb> [args...]',
    '',
    'Verbs:'
  ];
  for (const [verb, { desc }] of Object.entries(VERBS)) lines.push(`  ${pad(verb)} ${desc}`);
  lines.push('', 'Advanced:');
  for (const [verb, { desc }] of Object.entries(ADVANCED_VERBS)) lines.push(`  ${pad(verb)} ${desc}`);
  lines.push(`  ${pad('x <script>')} Run any scripts/brain-<script>.mjs directly (escape hatch)`);
  lines.push('', 'Options:');
  lines.push(`  ${pad('--help')} Show this help`);
  lines.push(`  ${pad('--version')} Print the package version`);
  lines.push('', 'Pass verb-specific flags after the verb, e.g. `project-brain search "auth flow" --top 5`.');
  console.log(lines.join('\n'));
}

const argv = process.argv.slice(2);
const first = argv[0];

if (!first || first === '--help' || first === '-h' || first === 'help') {
  printHelp();
  process.exit(0);
}

if (first === '--version' || first === '-v') {
  console.log(readVersion());
  process.exit(0);
}

if (first === 'x') {
  const name = argv[1];
  const rest = argv.slice(2);
  if (!name) {
    process.stderr.write('project-brain x: missing script name.\nAvailable scripts:\n');
    for (const s of listScripts()) process.stderr.write(`  ${s}\n`);
    process.exit(1);
  }
  // Accept `x guard`, `x brain-guard`, and `x brain-guard.mjs` alike.
  const bare = name.replace(/^brain-/, '').replace(/\.mjs$/, '');
  const scriptFile = `brain-${bare}.mjs`;
  if (!fs.existsSync(path.join(SCRIPTS_DIR, scriptFile))) {
    process.stderr.write(`project-brain x: no such script "${name}" (looked for scripts/${scriptFile}).\nAvailable scripts:\n`);
    for (const s of listScripts()) process.stderr.write(`  ${s}\n`);
    process.exit(1);
  }
  run(scriptFile, rest);
}

const entry = VERBS[first] || ADVANCED_VERBS[first];
if (!entry) {
  const known = [...Object.keys(VERBS), ...Object.keys(ADVANCED_VERBS)].join(', ');
  process.stderr.write(
    `project-brain: unknown verb "${first}".\n` +
    `Known verbs: ${known}, or \`x <script>\` for any scripts/brain-*.mjs.\n` +
    'Run `project-brain --help` for details.\n'
  );
  process.exit(1);
}

run(entry.script, argv.slice(1));
