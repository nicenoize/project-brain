/**
 * brain:lint — CLI shim over lint-intel.mjs, mirroring the git-intel.mjs ↔
 * brain-intel.mjs relationship: the library holds the logic and stays pure,
 * this file exists so `project-brain x lint` resolves (the escape hatch maps
 * `x <name>` → scripts/brain-<name>.mjs).
 *
 * We do NOT re-derive linting rules. ESLint, Ruff, golangci-lint, Clippy and
 * PHPStan already encode decades of work, and the empirical basis for
 * home-grown structural thresholds is weak. This consumes their SARIF and
 * adds the layer nobody has: which of 300 findings sit where a change
 * actually hurts.
 *
 * Usage: project-brain x lint [--json] [--limit N] [--sarif <path>] [--calibrate]
 */
import { main } from './lint-intel.mjs';

await main(process.argv.slice(2));
