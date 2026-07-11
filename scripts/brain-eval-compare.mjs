/**
 * Paired bootstrap comparison between two brain:eval report JSONs (written
 * with --out). Pairs cases by query, resamples case indices with replacement,
 * and reports Δ (B − A) with 95% percentile CIs for hit@K and MRR. This is the
 * required gate for retrieval changes: ship default-ON only when the CI on the
 * hard subset excludes 0 (see docs/eval-methodology.md — n≤42 point estimates
 * were misleading in both directions during the bge-small experiment).
 *
 * Usage:
 *   npm run brain:eval:compare -- baseline.json variant.json [--hard-only]
 *     [--resamples 10000] [--seed 42]
 */
import fs from 'node:fs';
import { peekOption } from './common.mjs';
import { pairCases, pairedBootstrap, perClassDeltas, round, avg } from './eval-lib.mjs';

const args = process.argv.slice(2);
const files = args.filter(arg => /\.json$/i.test(arg));
if (files.length !== 2) {
  console.error('Usage: brain:eval:compare -- <baseline.json> <variant.json> [--hard-only] [--resamples N] [--seed N]');
  process.exit(1);
}
const hardOnly = args.includes('--hard-only');
const resamples = Number(peekOption(process.argv, '--resamples') || 10000);
const seed = Number(peekOption(process.argv, '--seed') || 42);

const [reportA, reportB] = files.map(loadReport);
const { pairsA, pairsB, cases } = pairCases(reportA, reportB, { hardOnly });
const stats = pairedBootstrap(pairsA, pairsB, { resamples, seed });

// Per-class point-estimate deltas orient WHICH hard class moved (issue #33).
// Only meaningful when the run carries the hard subset, so gate on --hard-only.
const byClass = hardOnly ? perClassDeltas(reportA, reportB, { hardOnly }) : undefined;

console.log(JSON.stringify({
  baseline: { file: files[0], hitAtK: round(avg(pairsA.map(p => p.hit))), mrr: round(avg(pairsA.map(p => p.reciprocalRank))) },
  variant: { file: files[1], hitAtK: round(avg(pairsB.map(p => p.hit))), mrr: round(avg(pairsB.map(p => p.reciprocalRank))) },
  hardOnly,
  cases,
  ...stats,
  ...(byClass ? { byClass } : {}),
  verdict: stats.hit.significant || stats.mrr.significant
    ? 'SIGNIFICANT — 95% CI excludes 0'
    : 'not significant — difference is within noise at this sample size'
}, null, 2));

function loadReport(file) {
  if (!fs.existsSync(file)) {
    console.error(`No such report: ${file} (generate with: npm run brain:eval -- --out ${file})`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(report.results)) {
    console.error(`${file} has no per-case results array — re-run brain:eval with --out (not a hand-trimmed summary).`);
    process.exit(1);
  }
  return report;
}
