/**
 * brain:skill-audit — vet a third-party agent skill BEFORE adopting it.
 *
 * The trust axis (decisions/0016-ecosystem-skill-axis-map.md): installing a skill
 * from the open ecosystem (caveman, drawio-skill, ponytail, improve, …) is a
 * supply-chain risk. This shells out to skillspector (if present) for a 0-100 risk
 * score and gates adoption. It is OPT-IN and degrades to a clear no-op when the
 * scanner isn't installed — never blocks a developer who chose not to install it.
 *
 * Usage:
 *   npm run brain:skill-audit -- ./path/to/skill        # scan a local skill dir/file
 *   npm run brain:skill-audit -- https://github.com/owner/skill
 *   flags: --max-risk N (default BRAIN_SKILL_MAX_RISK or 40) · --json · --no-cache
 *          --docker (force the Docker path) · --llm (skillspector semantic pass)
 *
 * Exit: 0 if risk <= threshold or unknown/absent; 1 if risk > threshold (gate).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeFlag, takeOption } from './common.mjs';
import { runSkillspectorScan } from './skillspector.mjs';

const DEFAULT_MAX_RISK = Number(process.env.BRAIN_SKILL_MAX_RISK || 40);

function usage() {
  return [
    'Usage:',
    '  npm run brain:skill-audit -- <path|url> [--max-risk N] [--json] [--no-cache] [--docker] [--llm]',
    '',
    'Scans a third-party skill with skillspector (if installed) and gates adoption on its risk score.',
    'Optional tool: install the skillspector CLI, set BRAIN_SKILLSPECTOR_BIN, or enable Docker with',
    'BRAIN_SKILLSPECTOR_DOCKER=1 (no local Python). Absent → audit is skipped, never an error.'
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) { console.log(usage()); process.exit(0); }
  const json = takeFlag(args, '--json');
  const noCache = takeFlag(args, '--no-cache');
  const llm = takeFlag(args, '--llm');
  if (takeFlag(args, '--docker')) process.env.BRAIN_SKILLSPECTOR_DOCKER = '1';
  const maxRisk = Number(takeOption(args, '--max-risk')) || DEFAULT_MAX_RISK;
  const target = args[0];
  if (!target) { process.stderr.write(`[brain:skill-audit] needs a path or URL\n${usage()}\n`); process.exit(1); }

  const res = runSkillspectorScan(target, { noCache, llm });

  if (res.skipped) {
    if (json) process.stdout.write(JSON.stringify({ target, skipped: res.skipped }, null, 2) + '\n');
    else process.stderr.write(`[brain:skill-audit] skipped — ${res.skipped}\n`);
    process.exit(0); // unavailable ≠ failure
  }

  const { score, severity, recommendation, raw } = res.result;
  if (json) {
    process.stdout.write(JSON.stringify({ target, ...res.result, cached: !!res.cached, maxRisk }, null, 2) + '\n');
  } else {
    process.stdout.write(`# Skill audit: ${target}${res.cached ? ' (cached)' : ''}\n`);
    process.stdout.write(`Risk: ${score == null ? 'unknown' : `${score}/100`}${severity ? ` (${severity})` : ''}\n`);
    if (recommendation) process.stdout.write(`Recommendation: ${recommendation}\n`);
    if (score == null) process.stdout.write(`\nCould not parse a numeric risk score — review raw scanner output:\n${raw}\n`);
  }

  if (score != null && score > maxRisk) {
    process.stderr.write(`[brain:skill-audit] risk ${score} > max ${maxRisk} — do not adopt without review.\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
