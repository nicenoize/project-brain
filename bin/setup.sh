#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if [ ! -d "skills/project-brain" ]; then
  echo "ERROR: expected skill at skills/project-brain"
  echo "Copy, symlink, mount, or checkout the project-brain package at skills/project-brain first."
  exit 1
fi

node skills/project-brain/scripts/setup-package.mjs
npm install
npm run brain:init
npm run brain:install-hooks

# brain:index can legitimately fail on a fresh, empty repo with no source files,
# but a hard failure here usually means a misconfigured embedder or store and
# the user needs to see it. Surface non-zero exit codes rather than swallowing.
if ! npm run brain:index; then
  echo "WARN: brain:index failed. Review the output above; re-run with --force after fixing config."
  exit 1
fi

npm run brain:health

echo ""
echo "Project Brain setup complete."
echo "Next agent command:"
echo "Use the project-brain skill. Audit this repository, ingest the master plan if present, update context_index, infer modules/features, and mark uncertain facts as Needs Review."
