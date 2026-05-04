#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if [ ! -d "skills/project-brain" ]; then
  echo "ERROR: expected skill at skills/project-brain"
  echo "Copy the project-brain folder into skills/project-brain first."
  exit 1
fi

node skills/project-brain/scripts/setup-package.mjs
npm install
npm run brain:init
npm run brain:install-hooks
npm run brain:index || true
npm run brain:health

echo ""
echo "Project Brain setup complete."
echo "Next Claude command:"
echo "Use the project-brain skill. Audit this repository, ingest the master plan if present, update context_index, infer modules/features, and mark uncertain facts as Needs Review."
