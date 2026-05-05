#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
mkdir -p .git/hooks
for hook in skills/project-brain/templates/hooks/*; do
  name="$(basename "$hook")"
  cp "$hook" ".git/hooks/$name"
  chmod +x ".git/hooks/$name"
done
echo "Installed Project Brain Git hooks."
