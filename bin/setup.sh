#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if [ ! -d "skills/project-brain" ]; then
  echo "ERROR: expected skill at skills/project-brain"
  echo "Copy, symlink, mount, or checkout the project-brain package at skills/project-brain first."
  exit 1
fi

# SKILL.md is lean; its detail lives in skills/project-brain/references/*.md (#26).
# Those files ship inside the package checkout above — whatever brings SKILL.md
# into skills/project-brain/ MUST bring references/ with it. brain:health (run at
# the end of this script) verifies the reference bundle actually landed.

# --yes: setup.sh is the explicit "install everything" entry point — apply the
# whole plan without per-group prompts (run setup-package.mjs --dry-run first
# if you want to review the plan).
node skills/project-brain/scripts/setup-package.mjs --yes
npm install
npm run brain:init
npm run brain:install-hooks

# The search index is opt-in (ADR 0039): hooks keep it fresh only with
# BRAIN_INDEX=1, and only then does setup build the first one. A hard failure
# here usually means a misconfigured embedder or store; surface it.
if [ "${BRAIN_INDEX:-}" = "1" ] && ! npm run brain:index; then
  echo "WARN: brain:index failed. Review the output above; re-run with --force after fixing config."
  exit 1
fi

npm run brain:health

echo ""
echo "Project Brain setup complete."
echo "Next agent command:"
echo "Use the project-brain skill. Audit this repository, ingest the master plan if present, update context_index, infer modules/features, and mark uncertain facts as Needs Review."
